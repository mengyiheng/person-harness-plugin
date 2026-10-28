/**
 * 中继 + UDP 直连连接层（协议 v2.0 §3-§6，手机侧）。
 * WS 控制隧道：hello → attached → e2e offer/accept/confirm；候选交换后密文业务帧优先走可靠 UDP。
 * UDP 失败按 udpId 去重并回传中继，WS 始终保持，不能用 UDP 入帧代替中继看门狗。
 *   - HTTP 一元调用：open(kind=http) + data(fin) → http-head + data* + close
 *   - WS 流：open(kind=ws, /api/remote.mux) → 101 → data 帧透明承载 mux 文本
 * 断线重连：指数退避 1→30s；重连后所有 stream 视为已死，经 onReset 通知上层重建。
 * 纪律：一切文本帧；E2E 首发必做；算法参数与 companion-v2/src/e2e.mjs 逐字对齐。
 */
import { webSocket } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { b64uEncode, b64uDecode, fromUtf8, utf8 } from './B64u';
import { IdentityKey, EphemeralKey, E2EBox, SealedPayload, verifyE2E, transcript } from './RelayE2E';
import { UdpProbeClient, UdpControlFrame, UdpCandidate } from './UdpProbeClient';
import { NatFilterProbe, NatFilterOffer } from './NatFilterProbe';
import { UdpFrame } from './ReliableUdpChannel';

const TAG = 'HHRelay';
const PING_INTERVAL_MS = 25000;
const RECONNECT_MAX_MS = 30000;
const HANDSHAKE_TIMEOUT_MS = 20000;

// ---------------- 帧（宽松接口，解析自 JSON） ----------------

interface PeerInfo {
  deviceId?: string;
  publicKey?: string;
}

interface BaseFrame extends UdpControlFrame {
  kind?: string;
  path?: string;
  method?: string;
  status?: number;
  headers?: Record<string, string>;
  data?: string;
  code?: string;
  reason?: string;
  requestId?: string;
  primary?: UdpCandidate;
  alternate?: UdpCandidate;
}

interface AttachedFrame extends BaseFrame {
  peer?: PeerInfo;
}

interface E2EFrame extends BaseFrame {
  step?: string;
  ephemeral?: string;
  signature?: string;
}

/** 密文内层包装：{rest:{...}} */
interface SealedInner {
  rest?: BaseFrame;
}

/** 密文外层（上线格式） */
interface SealedWire {
  type: string;
  attachId: string;
  streamId: string;
  fin?: boolean;
  e2e?: SealedPayload;
}

interface WSInfo {
  code?: number;
  reason?: string;
}

export interface HttpResult {
  status: number;
  bodyText: string;
}

/** 二进制安全 HTTP 响应（v2.1 WebView 完整模式：资源字节级透传 + 响应头） */
export interface HttpBinResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

type RelayResetHandler = (reason: string) => void;

// ---------------- 流等待器 ----------------

/** 一条中继业务流（phone 发起）：缓存事件，支持按谓词等待；可挂 sink 做逐帧流式消费（SSE） */
class RelayStream {
  streamId: string;
  sink: ((f: BaseFrame) => void) | null = null;
  private events: Array<BaseFrame> = new Array<BaseFrame>();
  private waiters: Array<(f: BaseFrame) => boolean> = new Array<(f: BaseFrame) => boolean>();
  private closed: boolean = false;

  constructor(streamId: string) {
    this.streamId = streamId;
  }

  push(f: BaseFrame): void {
    if (this.sink !== null) {
      this.sink(f);
    }
    if (f.type === 'close') {
      this.closed = true;
    }
    const next: Array<(f: BaseFrame) => boolean> = [];
    this.waiters.forEach((w: (f: BaseFrame) => boolean) => {
      if (!w(f)) {
        next.push(w);
      }
    });
    this.waiters = next;
    this.events.push(f);
  }

  /** 等到第一个满足谓词的帧（先查缓存），timeoutMs 超时 */
  wait(pred: (f: BaseFrame) => boolean, timeoutMs: number = 15000): Promise<BaseFrame> {
    const existing = this.events.find((e: BaseFrame) => pred(e));
    if (existing) {
      return Promise.resolve(existing as BaseFrame);
    }
    if (this.closed) {
      return Promise.reject(new Error(`stream ${this.streamId} 已关闭`));
    }
    return new Promise<BaseFrame>((resolve: (f: BaseFrame) => void,
      reject: (e: Error) => void) => {
      const timer = setTimeout(() => {
        reject(new Error(`stream 事件超时: ${this.streamId}`));
      }, timeoutMs);
      const w = (f: BaseFrame): boolean => {
        if (pred(f)) {
          clearTimeout(timer);
          resolve(f);
          return true;
        }
        return false;
      };
      this.waiters.push(w);
    });
  }

  dataChunks(): string {
    let s = '';
    this.events.forEach((e: BaseFrame) => {
      if (e.type === 'data' && e.data) {
        s += e.data;
      }
    });
    return s;
  }

  hasDataFin(): boolean {
    return this.events.find((e: BaseFrame) => e.type === 'data' && e.fin === true) !== undefined;
  }
}

/** mux 通道（承载 /api/remote.mux 文本帧） */
export class MuxChannel {
  clientId: string;
  onText: (text: string) => void;
  onDown: (reason: string) => void;
  private client: RelayClient;

  constructor(client: RelayClient, clientId: string, onText: (text: string) => void,
    onDown: (reason: string) => void) {
    this.client = client;
    this.clientId = clientId;
    this.onText = onText;
    this.onDown = onDown;
  }

  /** 发一条 mux 文本帧（自动 data+fin+base64url） */
  send(text: string): void {
    this.client.sendData(this.clientId, b64uEncode(utf8(text)), true);
  }

  /** 关闭通道 */
  close(): void {
    this.client.closeStream(this.clientId);
  }
}

export class RelayClient {
  private ws?: webSocket.WebSocket;
  private identity: IdentityKey;
  private credential: string;
  private relayUrl: string;
  private attachId: string = '';
  private pcPub: string = '';
  private peerEph: string = '';
  private eph?: EphemeralKey;
  private box?: E2EBox;
  private opened: boolean = false;
  private ready: boolean = false; // E2E 就绪
  private streams: Map<string, RelayStream> = new Map();
  private muxes: Map<string, MuxChannel> = new Map();
  private pingTimer: number = -1;
  private lastPongAt: number = 0; // 🔴 半开死链看门狗：最近一次收到对端任何帧的时间
  private reconnectTimer: number = -1;
  private backoffMs: number = 1000;
  private wantConnected: boolean = false;
  private readyHook?: () => void;
  private udpProbe?: UdpProbeClient;
  private udpIds: Set<string> = new Set();
  private udpIdOrder: Array<string> = new Array<string>();
  onReset?: RelayResetHandler;
  onReady?: () => void;
  onDirectChanged?: (direct: boolean, latencyMs?: number) => void;

  constructor(relayUrl: string, credential: string, identity: IdentityKey) {
    this.relayUrl = relayUrl;
    this.credential = credential;
    this.identity = identity;
  }

  isReady(): boolean {
    return this.ready;
  }

  isDirect(): boolean {
    return this.udpProbe?.isDirect() === true;
  }

  debugDropUdpTraffic(): void {
    this.udpProbe?.debugDropTraffic();
  }

  debugNatFilter(): void {
    if (!this.attachId) {
      hilog.warn(0x0000, TAG, 'NAT_FILTER 忽略：当前没有配对附着');
      return;
    }
    NatFilterProbe.run(this.attachId, (frame): void => this.sendRaw(JSON.stringify(frame)));
  }

  private clearDirect(notify: boolean = true): void {
    const probe = this.udpProbe;
    this.udpProbe = undefined;
    probe?.stop();
    this.udpIds.clear();
    this.udpIdOrder = new Array<string>();
    if (notify) {
      this.onDirectChanged?.(false, -1);
    }
  }

  private startUdpProbe(): void {
    this.clearDirect(false);
    if (!this.attachId) {
      return;
    }
    const probe = new UdpProbeClient(this.attachId,
      (frame: UdpControlFrame): void => this.sendRaw(JSON.stringify(frame)),
      (frame: UdpFrame): void => {
        if (this.udpProbe === probe) {
          this.onFrameText(JSON.stringify(frame), true);
        }
      },
      (direct: boolean, latencyMs?: number): void => {
        if (this.udpProbe === probe) {
          this.onDirectChanged?.(direct, latencyMs ?? -1);
        }
      },
      (pending: Array<UdpFrame>): void => {
        if (this.udpProbe !== probe) {
          return;
        }
        pending.forEach((frame: UdpFrame): void => this.sendRaw(JSON.stringify(frame)));
      });
    this.udpProbe = probe;
    probe.start().catch((e: Error): void => {
      if (this.udpProbe === probe) {
        hilog.warn(0x0000, TAG, 'UDP 探针异常（保留中继）: %{public}s', e.message);
        this.clearDirect();
      }
    });
  }

  // ---------------- 连接生命周期 ----------------

  /** 建立隧道并完成 E2E 握手；resolve = E2E 就绪。断线自动重连（指数退避）。 */
  async start(): Promise<void> {
    this.wantConnected = true;
    await this.connectOnce();
  }

  stop(): void {
    hilog.warn(0x0000, TAG, '⭐ RelayClient.stop() 被调用（定位 12 秒自杀循环，2026-10-24）');
    this.wantConnected = false;
    if (this.reconnectTimer >= 0) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = -1;
    }
    this.stopPing();
    this.clearDirect();
    this.killStreams('本地主动断开');
    this.ready = false;
    this.opened = false;
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      try {
        ws.close();
      } catch (e) { /* 忽略 */ }
    }
  }

  private async connectOnce(): Promise<void> {
    if (!this.wantConnected) {
      return;
    }
    this.clearDirect();
    this.killStreams('重连');
    this.ready = false;
    this.box = undefined;
    this.peerEph = '';
    const ws = webSocket.createWebSocket();
    this.ws = ws;
    let failed = false;
    return new Promise<void>((resolve: () => void, reject: (e: Error) => void) => {
      const timer = setTimeout(() => {
        if (!failed) {
          failed = true;
          reject(new Error('ERR_TIMEOUT: 中继连接/E2E 握手超时'));
          try { ws.close(); } catch (e) { /* 忽略 */ }
          this.scheduleReconnect();
        }
      }, HANDSHAKE_TIMEOUT_MS);
      // E2E 就绪钩子：ready 置位时（可能无新入帧）结束握手等待
      this.readyHook = (): void => {
        if (!failed) {
          failed = true;
          clearTimeout(timer);
          this.backoffMs = 1000;
          this.startPing();
          resolve();
        }
      };
      ws.on('open', (_err: Object, _v: Object) => {
        this.opened = true;
        const hello: BaseFrame = { type: 'hello' };
        this.sendRaw(JSON.stringify(hello));
      });
      ws.on('message', (_err: Object, data: string | ArrayBuffer) => {
        let text: string;
        if (typeof data === 'string') {
          text = data;
        } else if (data instanceof ArrayBuffer) {
          text = fromUtf8(new Uint8Array(data));
        } else {
          return;
        }
        this.onFrameText(text);
      });
      ws.on('close', (err: Object) => {
        const wasReady: boolean = this.ready;
        this.opened = false;
        this.ready = false;
        this.stopPing();
        this.clearDirect();
        this.killStreams('中继连接断开');
        hilog.warn(0x0000, TAG, '隧道关闭 code=%{public}d wasReady=%{public}d',
          ((err ?? {}) as WSInfo).code ?? 0, wasReady ? 1 : 0);
        if (!failed) {
          failed = true;
          clearTimeout(timer);
          reject(new Error('ERR_NETWORK: 中继连接被关闭'));
        } else if (wasReady && this.wantConnected) {
          this.onReset?.('中继连接断开');
        }
        this.scheduleReconnect();
      });
      ws.on('error', (err: Object) => {
        let detail: string = '';
        try {
          detail = JSON.stringify(err);
        } catch (e) {
          detail = String(err);
        }
        hilog.error(0x0000, TAG, '隧道 WS 错误详情: %{public}s', detail);
      });
      const header: Record<string, string> = { 'Authorization': `Bearer ${this.credential}` };
      hilog.info(0x0000, TAG, 'connect 开始: %{public}s', this.relayUrl);
      ws.connect(this.relayUrl, { header: header }).catch((e: Object) => {
        let detail: string = '';
        try {
          detail = JSON.stringify(e);
        } catch (e2) {
          detail = String(e);
        }
        hilog.error(0x0000, TAG, 'connect() reject 详情: %{public}s', detail);
        if (!failed) {
          failed = true;
          clearTimeout(timer);
          reject(new Error(`ERR_NETWORK: 中继 WS 握手失败（${String(e)}）`));
        }
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.wantConnected || this.reconnectTimer >= 0) {
      return;
    }
    hilog.info(0x0000, TAG, '%{public}dms 后重连中继', this.backoffMs);
    const delay: number = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = -1;
      this.connectOnce().catch((e: Error) => {
        hilog.warn(0x0000, TAG, '重连失败: %{public}s', e.message);
      });
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.lastPongAt = Date.now();
    this.pingTimer = setInterval(() => {
      if (this.opened) {
        // 🔴 半开 TCP 看门狗（2026-10-26）：超过 2 个 ping 周期 + 5s 没有任何入帧，
        // 判定死链，主动 close 走既有 close handler → onReset + scheduleReconnect
        if (Date.now() - this.lastPongAt > PING_INTERVAL_MS * 2 + 5000) {
          hilog.warn(0x0000, TAG, 'pong 超时（%{public}dms 无入帧），判定半开死链，强制重连',
            Date.now() - this.lastPongAt);
          this.ready = false;
          this.stopPing();
          this.killStreams('pong 超时，判定死链');
          this.onReset?.('中继链路失去响应');
          try { this.ws?.close(); } catch (e) { /* 忽略 */ }
          return;
        }
        const ping: BaseFrame = { type: 'ping' };
        this.sendRaw(JSON.stringify(ping));
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer >= 0) {
      clearInterval(this.pingTimer);
      this.pingTimer = -1;
    }
  }

  private killStreams(reason: string): void {
    this.streams.clear();
    const muxes = this.muxes;
    this.muxes = new Map();
    muxes.forEach((m: MuxChannel) => {
      m.onDown(reason);
    });
  }

  // ---------------- 帧收发 ----------------

  private sendRaw(text: string): void {
    // 仅当前 attach 的 E2E 密文业务帧优先走 UDP；候选、握手、ping 等控制帧保留中继。
    try {
      const frame = JSON.parse(text) as BaseFrame;
      if (frame.e2e && frame.attachId === this.attachId && this.udpProbe?.send(frame) === true) {
        return;
      }
    } catch (e) { /* 非 JSON 交给原 WS 错误路径 */ }
    const ws = this.ws;
    if (!ws || !this.opened) {
      return;
    }
    try {
      ws.send(text).catch((e: Object) => {
        hilog.error(0x0000, TAG, '帧发送失败: %{public}s（主动断开触发重连）', String(e));
        this.ready = false;
        try { this.ws?.close(); } catch (e2) { /* 忽略 */ }
      });
    } catch (e) {
      hilog.error(0x0000, TAG, '帧发送异常: %{public}s', String(e));
    }
  }

  private sendChain: Promise<void> = Promise.resolve(); // 密文帧发送队列：保证 FIFO（异步 seal 可能乱序）

  // 接收帧解密队列：保证按到达顺序 dispatch（异步 open 可能乱序，2026-10-23 修复）
  private openChain: Promise<void> = Promise.resolve();

  /** 密文业务帧：明文={rest:业务帧}（不含 attachId/e2e），封包 {type,attachId,streamId,fin?,e2e} */
  private sendSealed(frame: BaseFrame): void {
    if (!this.box || !frame.attachId) {
      hilog.error(0x0000, TAG, 'sendSealed 前置不满足（box/attachId）');
      return;
    }
    const streamId: string = frame.streamId ?? '-';
    const inner: SealedInner = { rest: frame };
    const box = this.box;
    const attachId = frame.attachId;
    const fin = frame.fin === true;
    this.sendChain = this.sendChain
      .then(() => box.seal(streamId, frame.type, JSON.stringify(inner)))
      .then((sealed: SealedPayload) => {
        const wire: SealedWire = { type: frame.type, attachId: attachId, streamId: streamId };
        if (fin) {
          wire.fin = true;
        }
        wire.e2e = sealed;
        this.sendRaw(JSON.stringify(wire));
      })
      .catch((e: Error) => {
        hilog.error(0x0000, TAG, 'seal 失败: %{public}s', e.message);
      });
  }

  private onFrameText(text: string, fromUdp: boolean = false): void {
    let frame: BaseFrame;
    try {
      frame = JSON.parse(text) as BaseFrame;
    } catch (e) {
      hilog.warn(0x0000, TAG, '非 JSON 帧（丢弃）: %{public}s', text.slice(0, 60));
      return;
    }
    if (frame.udpId) {
      if (this.udpIds.has(frame.udpId)) {
        return;
      }
      this.udpIds.add(frame.udpId);
      this.udpIdOrder.push(frame.udpId);
      if (this.udpIdOrder.length > 4096) {
        const oldest = this.udpIdOrder.shift();
        if (oldest) {
          this.udpIds.delete(oldest);
        }
      }
    }
    if (!fromUdp) {
      this.lastPongAt = Date.now(); // WS 入帧才证明中继活着，UDP 业务不能掩盖半开 WS。
    }
    if (frame.type === 'hello-ack' || frame.type === 'pong' ||
      frame.type === 'punch-ok' || frame.type === 'punch-revert') {
      return;
    }
    if (frame.type === 'error') {
      hilog.error(0x0000, TAG, '中继错误帧: %{public}s', text.slice(0, 120));
      return;
    }
    if (frame.type === 'detach') {
      hilog.warn(0x0000, TAG, '对端离开: %{public}s', frame.reason ?? '');
      this.ready = false;
      this.clearDirect();
      this.killStreams('对端已断开');
      this.onReset?.('电脑端已断开');
      // 🔴 detach 后主动断开走重连（2026-10-26）：否则 hello 只发一次，PC 回来后手机永不再附着
      this.stopPing();
      try { this.ws?.close(); } catch (e) { /* 忽略 */ }
      return;
    }
    if (frame.type === 'attached') {
      const att = frame as AttachedFrame;
      this.attachId = frame.attachId ?? '';
      this.pcPub = att.peer?.publicKey ?? '';
      hilog.info(0x0000, TAG, '已附着 attachId=%{public}s pcPubLen=%{public}d',
        this.attachId, this.pcPub.length);
      this.startUdpProbe();
      this.beginE2E();
      return;
    }
    if (frame.type === 'udp-candidate') {
      this.udpProbe?.onPeer(frame);
      return;
    }
    if (frame.type === 'nat-filter-offer') {
      if (frame.requestId && frame.primary && frame.alternate) {
        NatFilterProbe.onOffer(new NatFilterOffer(frame.requestId, frame.primary.ip, frame.primary.port,
          frame.alternate.ip, frame.alternate.port));
      }
      return;
    }
    if (frame.type === 'e2e') {
      this.onE2EFrame(frame as E2EFrame);
      return;
    }
    // 业务帧（密文）
    if (this.box && frame.e2e) {
      const streamId: string = frame.streamId ?? '-';
      // 🔴 接收保序（2026-10-23 修复）：box.open 是异步硬件调用，多帧并发完成顺序不保证，
      //    大响应（80KB+ = 多个 48KB 块）一旦乱序 dispatch，拼接即乱码 →
      //    "unexpected object in json" / 快照解析失败 / 无缓存会话打不开。
      //    与发送侧 sendChain 同款链式队列：按到达顺序串行解密+分发。
      const box = this.box;
      const f = frame;
      this.openChain = this.openChain
        .then((): Promise<string> => box.open(streamId, f.type, f.e2e as SealedPayload))
        .then((plain: string) => {
          const inner = JSON.parse(plain) as SealedInner;
          const rest: BaseFrame = inner.rest ?? { type: f.type };
          const biz: BaseFrame = rest;
          biz.type = f.type;
          biz.streamId = f.streamId;
          if (f.fin === true) {
            biz.fin = true;
          }
          this.dispatchBiz(biz);
        })
        .catch((e: Error) => {
          hilog.error(0x0000, TAG, '解密失败 type=%{public}s: %{public}s', f.type, e.message);
        });
      return;
    }
    hilog.warn(0x0000, TAG, '未知/未加密帧 type=%{public}s（丢弃）', frame.type);
  }

  private dispatchBiz(f: BaseFrame): void {
    const streamId: string = f.streamId ?? '-';
    if (f.type === 'data') {
      const mux = this.muxes.get(streamId);
      if (mux && f.data) {
        mux.onText(fromUtf8(b64uDecode(f.data)));
        return;
      }
    }
    if (f.type === 'close') {
      const mux = this.muxes.get(streamId);
      if (mux) {
        this.muxes.delete(streamId);
        mux.onDown(f.reason ?? '流已关闭');
        return;
      }
    }
    const st = this.streams.get(streamId);
    if (st) {
      st.push(f);
    } else if (f.type !== 'close') {
      // close 可能晚于本地流清理（无害竞态），其余才值得告警
      hilog.warn(0x0000, TAG, '无主流的帧 streamId=%{public}s type=%{public}s', streamId, f.type);
    }
  }

  // ---------------- E2E 握手 ----------------

  private beginE2E(): void {
    this.eph = new EphemeralKey();
    // 🔴 竞态修复（2026-10-23 E2E 卡点）：插件的 offer 可能在 eph.generate()（异步硬件调用）
    //    完成前到达。此前若 this.eph 未创建会被静默丢弃；若已创建但 publicKeyB64 还是 ''，
    //    会发出 ephemeral='' 的畸形 accept（对端验签能过但派生密钥必炸）。
    //    现在把 generate 期间到达的 e2e 帧排队，generate 完成后按序回放。
    this.pendingE2E = [];
    const eph = this.eph;
    eph.generate().then(() => {
      if (this.eph !== eph) {
        return; // 期间发生了重连，本代 eph 作废
      }
      const queued: Array<E2EFrame> = this.pendingE2E ?? [];
      this.pendingE2E = undefined;
      const offer: E2EFrame = { type: 'e2e', step: 'offer', ephemeral: eph.publicKeyB64 };
      offer.attachId = this.attachId;
      hilog.info(0x0000, TAG, 'eph 就绪，e2e offer 发送（queued=%{public}d）', queued.length);
      this.sendRaw(JSON.stringify(offer));
      queued.forEach((f: E2EFrame) => this.onE2EFrame(f));
    }).catch((e: Error) => {
      hilog.error(0x0000, TAG, 'E2E 初始化失败（X25519 不支持？）: %{public}s', e.message);
    });
  }

  private pendingE2E?: Array<E2EFrame>;

  private onE2EFrame(frame: E2EFrame): void {
    hilog.info(0x0000, TAG, 'e2e %{public}s 帧（eph=%{public}d ephPubLen=%{public}d peerEphLen=%{public}d）',
      frame.step ?? '?', this.eph ? 1 : 0, this.eph?.publicKeyB64.length ?? -1,
      (frame.ephemeral ?? '').length);
    if (!this.eph) {
      return;
    }
    if (this.eph.publicKeyB64 === '' && this.pendingE2E) {
      // eph 还在生成：先排队，generate 完成后回放（见 beginE2E）
      this.pendingE2E.push(frame);
      hilog.info(0x0000, TAG, 'e2e 帧先排队（eph 未就绪）');
      return;
    }
    const step: string = frame.step ?? '';
    if (step === 'offer') {
      this.peerEph = frame.ephemeral ?? '';
      this.identity.sign(transcript(this.attachId, this.eph.publicKeyB64, this.peerEph))
        .then((sig: string) => {
          const accept: E2EFrame = {
            type: 'e2e', step: 'accept', ephemeral: this.eph?.publicKeyB64 ?? '', signature: sig,
          };
          accept.attachId = this.attachId;
          this.sendRaw(JSON.stringify(accept));
        }).catch((e: Error) => {
          hilog.error(0x0000, TAG, 'accept 签名失败: %{public}s', e.message);
        });
      return;
    }
    if (step === 'accept') {
      const pcEph: string = frame.ephemeral ?? '';
      this.peerEph = pcEph;
      verifyE2E(this.pcPub, frame.signature ?? '', this.attachId, pcEph, this.eph.publicKeyB64)
        .then((ok: boolean) => {
          if (!ok) {
            hilog.error(0x0000, TAG,
              'PC 侧 accept 验签失败: pcPubLen=%{public}d sigLen=%{public}d pcEphLen=%{public}d myEphLen=%{public}d',
              this.pcPub.length, (frame.signature ?? '').length, pcEph.length, this.eph?.publicKeyB64.length ?? -1);
            return;
          }
          return this.identity.sign(
            transcript(this.attachId, this.eph?.publicKeyB64 ?? '', this.peerEph)
          ).then((sig: string) => {
            const confirm: E2EFrame = { type: 'e2e', step: 'confirm', signature: sig };
            confirm.attachId = this.attachId;
            this.sendRaw(JSON.stringify(confirm));
            return E2EBox.create(this.eph as EphemeralKey, this.peerEph, this.attachId);
          });
        })
        .then((box?: E2EBox) => {
          if (!box) {
            return;
          }
          this.box = box;
          this.ready = true;
          hilog.info(0x0000, TAG, 'E2E 就绪（accept 验签通过，confirm 已发）');
          this.onReady?.();
          this.readyHook?.();
          this.readyHook = undefined;
        })
        .catch((e: Error) => {
          hilog.error(0x0000, TAG, 'E2E accept 处理异常: %{public}s', e.message);
        });
      return;
    }
    if (step === 'confirm') {
      // PC 签的是 transcript(attachId, pcEph, phoneEph)
      verifyE2E(this.pcPub, frame.signature ?? '', this.attachId,
        this.peerEph, this.eph.publicKeyB64)
        .then((ok: boolean) => {
          hilog.info(0x0000, TAG, 'confirm 验签=%{public}d', ok ? 1 : 0);
        });
      return;
    }
  }

  // ---------------- 业务 API ----------------

  private sendOpen(frame: BaseFrame): void {
    frame.attachId = this.attachId;
    this.sendSealed(frame);
  }

  sendData(streamId: string, data: string, fin: boolean): void {
    const f: BaseFrame = { type: 'data' };
    f.streamId = streamId;
    f.data = data;
    if (fin) {
      f.fin = true;
    }
    this.sendOpen(f);
  }

  closeStream(streamId: string): void {
    this.muxes.delete(streamId);
    this.streams.delete(streamId);
    const f: BaseFrame = { type: 'close' };
    f.streamId = streamId;
    this.sendOpen(f);
  }

  /** HTTP 一元调用（等价参考实现 phoneRpc）：返回 {status, bodyText}；E2E 未就绪直接抛错
   *  headTimeoutMs/dataTimeoutMs 可覆盖默认 15s/30s（文件分块传输等慢请求用长超时） */
  async httpCall(method: string, path: string, bodyJson: string,
    headTimeoutMs: number = 15000, dataTimeoutMs: number = 30000): Promise<HttpResult> {
    if (!this.ready || !this.box) {
      throw new Error('ERR_NETWORK: 中继未就绪（E2E 握手未完成）');
    }
    const sid: string = `h${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const st = new RelayStream(sid);
    this.streams.set(sid, st);
    const open: BaseFrame = { type: 'open' };
    open.streamId = sid;
    open.kind = 'http';
    open.method = method;
    open.path = path;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    open.headers = headers;
    this.sendOpen(open);
    // 空 body 不能走 b64uEncode(utf8(''))：Base64Helper 对零长 Uint8Array 抛
    // "Parameter error... length greater than zero"（2026-10-26 transport-ping 红灯根因）。
    // 与 httpCallBin 同口径：空 body 直接发空串 data 帧（fin=true）触发对端 flush。
    if (bodyJson) {
      this.sendData(sid, b64uEncode(utf8(bodyJson)), true);
    } else {
      this.sendData(sid, '', true);
    }
    const head = await st.wait((e: BaseFrame): boolean => e.type === 'http-head', headTimeoutMs);
    while (!st.hasDataFin()) {
      await st.wait((e: BaseFrame): boolean => e.type === 'data' && e.fin === true, dataTimeoutMs);
    }
    this.closeStream(sid);
    const result: HttpResult = { status: head.status ?? 0, bodyText: fromUtf8(b64uDecode(st.dataChunks())) };
    return result;
  }

  /** 二进制安全 HTTP 调用（v2.1 WebView 完整模式用）：
   *  静态资源（JS/图片/字体）必须字节级透传，Content-Type 从响应头带回。
   *  fin 等待上限 120s：隧道侧大资源（MB 级分块）传输可能超过常规 30s。 */
  async httpCallBin(method: string, path: string, bodyBytes: Uint8Array | null,
    contentType: string): Promise<HttpBinResult> {
    if (!this.ready || !this.box) {
      throw new Error('ERR_NETWORK: 中继未就绪（E2E 握手未完成）');
    }
    const sid: string = `h${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const st = new RelayStream(sid);
    this.streams.set(sid, st);
    const open: BaseFrame = { type: 'open' };
    open.streamId = sid;
    open.kind = 'http';
    open.method = method;
    open.path = path;
    const headers: Record<string, string> = {};
    if (bodyBytes !== null && contentType) {
      headers['content-type'] = contentType;
    }
    open.headers = headers;
    this.sendOpen(open);
    if (bodyBytes !== null && bodyBytes.length > 0) {
      this.sendData(sid, b64uEncode(bodyBytes), true);
    } else {
      this.sendData(sid, '', true);
    }
    const head = await st.wait((e: BaseFrame): boolean => e.type === 'http-head', 30000);
    while (!st.hasDataFin()) {
      await st.wait((e: BaseFrame): boolean => e.type === 'data' && e.fin === true, 120000);
    }
    this.closeStream(sid);
    const resHeaders: Record<string, string> = head.headers ?? {};
    const result: HttpBinResult = {
      status: head.status ?? 0,
      headers: resHeaders,
      body: b64uDecode(st.dataChunks())
    };
    return result;
  }

  /** 流式 HTTP 调用（2026-10-24，opencode SSE 用）：逐帧回调不缓冲。
   *  onHead 收到响应头（一次），onChunk 收到每个数据块（字节级，可能多次），
   *  Promise 在 close 帧后 resolve。SSE 长连接的 close 可能很久才来（或永不来，直到断开）。 */
  async httpCallStream(method: string, path: string, bodyBytes: Uint8Array | null,
    contentType: string,
    onHead: (status: number, headers: Record<string, string>) => void,
    onChunk: (bytes: Uint8Array) => void): Promise<void> {
    if (!this.ready || !this.box) {
      throw new Error('ERR_NETWORK: 中继未就绪（E2E 握手未完成）');
    }
    const sid: string = `h${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const st = new RelayStream(sid);
    let headSent: boolean = false;
    st.sink = (f: BaseFrame): void => {
      if (f.type === 'http-head' && !headSent) {
        headSent = true;
        onHead(f.status ?? 0, f.headers ?? {});
        return;
      }
      if (f.type === 'data' && f.data) {
        onChunk(b64uDecode(f.data));
      }
    };
    this.streams.set(sid, st);
    const open: BaseFrame = { type: 'open' };
    open.streamId = sid;
    open.kind = 'http';
    open.method = method;
    open.path = path;
    const headers: Record<string, string> = {};
    if (bodyBytes !== null && contentType) {
      headers['content-type'] = contentType;
    }
    open.headers = headers;
    this.sendOpen(open);
    if (bodyBytes !== null && bodyBytes.length > 0) {
      this.sendData(sid, b64uEncode(bodyBytes), true);
    } else {
      this.sendData(sid, '', true);
    }
    // 🔴 先等响应头（30s 超时，2026-10-26）：死链/上游无响应时尽快抛错，
    // 让 LocalProxy 的 502 自愈页生效，否则 WebView 请求永久挂起（假死主通道）
    const headOrEnd: BaseFrame = await st.wait((e: BaseFrame): boolean =>
      e.type === 'http-head' || e.type === 'close' || e.type === 'error', 30000)
      .catch((e: Error): BaseFrame => {
        this.closeStream(sid);
        throw new Error('ERR_TIMEOUT: 上游响应头超时（30s）');
      });
    if (headOrEnd.type !== 'http-head') {
      this.closeStream(sid);
      throw new Error(`ERR_NETWORK: 上游未返回响应头即结束（${headOrEnd.type}）`);
    }
    // close 帧（或 PC 侧 error 帧）才结束；SSE 期间长时间无帧属正常，不设短超时
    const end: BaseFrame = await st.wait((e: BaseFrame): boolean =>
      e.type === 'close' || e.type === 'error', 12 * 3600 * 1000);
    this.closeStream(sid);
    if (end.type === 'error') {
      throw new Error(`上游流错误: ${end.code ?? ''} ${end.reason ?? ''}`);
    }
  }

  /** 打开 mux 通道（默认 /api/remote.mux；第三方 target 的 WS 透传按原始 path）；resolve = 升级成功（101） */
  async openMux(onText: (text: string) => void, onDown: (reason: string) => void,
    path: string = '/api/remote.mux'): Promise<MuxChannel> {
    if (!this.ready || !this.box) {
      throw new Error('ERR_NETWORK: 中继未就绪（E2E 握手未完成）');
    }
    const sid: string = `w${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const st = new RelayStream(sid);
    this.streams.set(sid, st);
    const open: BaseFrame = { type: 'open' };
    open.streamId = sid;
    open.kind = 'ws';
    open.path = path;
    const headers: Record<string, string> = {};
    open.headers = headers;
    this.sendOpen(open);
    const head = await st.wait((e: BaseFrame): boolean => e.type === 'http-head');
    if ((head.status ?? 0) !== 101) {
      this.closeStream(sid);
      throw new Error(`mux 升级失败 HTTP ${head.status ?? 0}`);
    }
    const ch = new MuxChannel(this, sid, onText, onDown);
    this.muxes.set(sid, ch);
    return ch;
  }
}
