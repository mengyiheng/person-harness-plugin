/**
 * v2 传输适配层：把中继链路包装成与 HarnessClient/HarnessStream 相同的使用面，
 * Index.ets 只需在构造处按设备类型二选一，其余调用点零改动。
 */
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { RelayClient, MuxChannel, HttpResult } from './RelayClient';
import { IdentityKey } from './RelayE2E';
import { SecureStore } from './SecureStore';
import { FollowFrame, FrameHandler, CloseHandler, IClient, IStream } from './Types';

const TAG = 'HHV2T';

const ERR_UNAUTHORIZED: string = 'ERR_UNAUTHORIZED';
const ERR_RPC: string = 'ERR_RPC';

interface RpcArgsWrap {
  args: Record<string, Object>;
}

interface RpcRequestBody {
  type: string;
  rpcId: string;
  method: string;
  payload: RpcArgsWrap;
}

interface PromptContent {
  type: string;
  text: string;
}

interface PromptRequest {
  requestId: string;
  sessionId: string;
  mode: string;
  content: Array<PromptContent>;
  clientTimeZone: string;
}

interface RpcErrorInner {
  message?: string;
}

interface RpcResultInner {
  ok?: boolean;
  value?: Object;
  error?: RpcErrorInner;
}

interface RpcShell {
  rpcId?: string;
  result?: RpcResultInner;
}

class IdentityStore {
  pub: string;
  pk: string;

  constructor(pub: string, pk: string) {
    this.pub = pub;
    this.pk = pk;
  }
}

/** 身份密钥：全局一把，首用生成并持久化（公钥+私钥 JSON）。
 *  恢复时公私钥都传给 convertKey：部分机型 convertKey(私钥) 不回填 pubKey（实测 Mate 80）。 */
export async function loadOrCreateIdentity(store: SecureStore): Promise<IdentityKey> {
  const key = new IdentityKey();
  const raw: string = await store.getV2IdentityPk();
  let pub = '';
  let pk = '';
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as IdentityStore;
      pub = parsed.pub ?? '';
      pk = parsed.pk ?? '';
    } catch (e) {
      pk = raw; // 兼容旧格式（裸私钥，无法恢复公钥则重新生成）
    }
  }
  if (!pk) {
    await key.generate();
    await key.selfTest();
    const st = new IdentityStore(key.publicKeyB64, key.privatePkB64);
    await store.saveV2IdentityPk(JSON.stringify(st));
  } else {
    try {
      await key.loadFromPk(pk, pub);
      await key.selfTest();
    } catch (e) {
      // 恢复失败（旧格式/机型 convertKey 不回填公钥）：重新生成身份。
      // 注意：若已用旧身份在服务器注册过，注册侧会拿到新公钥（设备 token 失效需重扫配对）。
      hilog.warn(0x0000, TAG, '身份恢复失败，重新生成: %{public}s', String(e));
      await key.generate();
      await key.selfTest();
      const st2 = new IdentityStore(key.publicKeyB64, key.privatePkB64);
      await store.saveV2IdentityPk(JSON.stringify(st2));
    }
  }
  return key;
}

/** 中继上的 harness 一元 RPC（HTTP 流承载），方法面与 HarnessClient 对齐 */
export class RelayHarnessClient implements IClient {
  private relay: RelayClient;

  constructor(relay: RelayClient) {
    this.relay = relay;
  }

  getRelay(): RelayClient {
    return this.relay;
  }

  private buildBody(endpoint: string, args: Object, param: string): string {
    const argsObj: Record<string, Object> = {};
    argsObj[param] = args;
    const wrap: RpcArgsWrap = { args: argsObj };
    const body: RpcRequestBody = {
      type: 'client-request',
      rpcId: util.generateRandomUUID(),
      method: endpoint,
      payload: wrap,
    };
    return JSON.stringify(body);
  }

  async rpc(endpoint: string, args: Object, param: string = 'request'): Promise<Object> {
    const body: string = this.buildBody(endpoint, args, param);
    const res = await this.relay.httpCall('POST', `/api/${endpoint}`, body);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${ERR_UNAUTHORIZED}: HTTP ${res.status}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${ERR_RPC}: HTTP ${res.status}`);
    }
    const parsed = JSON.parse(res.bodyText) as RpcShell;
    if (!parsed.result || parsed.result.ok !== true) {
      const msg: string = parsed.result?.error?.message ?? 'rpc failed';
      throw new Error(`${ERR_RPC}: ${msg}`);
    }
    const empty: Record<string, Object> = {};
    return parsed.result.value ?? (empty as Object);
  }

  async ping(): Promise<number> {
    const t0: number = Date.now();
    // 轻量传输层 ping（2026-10-26）：不再用 session/list（响应 ~500KB，堵死中继链路）。
    // /__ph/transport-ping 由 PC 插件直接应答，只回几十字节。
    const res: HttpResult = await this.relay.httpCall('GET', '/__ph/transport-ping', '');
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${ERR_RPC}: HTTP ${res.status}`);
    }
    return Date.now() - t0;
  }

  async checkHealth(): Promise<void> {
    const empty: Record<string, Object> = {};
    await this.rpc('session/list', empty as Object, '_request');
  }

  async createSession(cwd: string = ''): Promise<string> {
    const args: Record<string, Object> = {};
    if (cwd.trim()) {
      args['cwd'] = cwd.trim();
    }
    const value = await this.rpc('session/create', args as Object) as Record<string, Object>;
    const direct = value['sessionId'];
    if (typeof direct === 'string' && direct) {
      return direct;
    }
    const sess = value['session'] as Record<string, Object> | undefined;
    const nested = sess?.['sessionId'];
    if (typeof nested === 'string' && nested) {
      return nested;
    }
    throw new Error(`${ERR_RPC}: 响应中缺少 sessionId`);
  }

  async sendPrompt(sessionId: string, text: string): Promise<void> {
    const content: Array<PromptContent> = [{ type: 'text', text: text }];
    const req: PromptRequest = {
      requestId: util.generateRandomUUID(),
      sessionId: sessionId,
      mode: 'queue',
      content: content,
      clientTimeZone: 'Asia/Shanghai',
    };
    await this.rpc('session/prompt', req as Object);
  }

  getWsUrl(): string {
    return '';
  }

  getCookie(): string {
    return '';
  }
}

const FOLLOW_MAX_MESSAGES = 4;
const FOLLOW_MIN_MESSAGES = 2;
const FOLLOW_MIN_TURNS = 1;

interface MuxAddress {
  kind: string;
  sessionId: string;
}

interface MuxTurnWindow {
  minMessages: number;
  minTurns: number;
}

interface MuxOpenRequest {
  address: MuxAddress;
  maxMessages: number;
  turnWindow: MuxTurnWindow;
}

interface MuxArgsWrap {
  request: MuxOpenRequest;
}

interface MuxPayload {
  args: MuxArgsWrap;
}

interface MuxOpenBody {
  type: string;
  streamId: string;
  endpoint: string;
  payload: MuxPayload;
}

interface MuxCloseBody {
  type: string;
  streamId: string;
}

/** 中继上的 session/follow：mux 通道承载，方法面与 HarnessStream 对齐 */
export class RelayFollow implements IStream {
  private relay: RelayClient;
  private mux?: MuxChannel;
  private opened: boolean = false;
  private currentSessionId: string = '';
  private followSeq: number = 0;
  private followStreamId: string = '';
  private lastOnFrame?: FrameHandler;
  private lastOnClose?: CloseHandler;

  constructor(relay: RelayClient) {
    this.relay = relay;
  }

  isOpen(): boolean {
    return this.opened && this.relay.isReady();
  }

  /** 中继重连成功后由 Index 调：自动重建 follow 流 */
  onRelayReady(): void {
    if (this.currentSessionId && this.lastOnFrame && this.lastOnClose) {
      hilog.info(0x0000, TAG, '中继恢复，重建 follow：%{public}s', this.currentSessionId);
      this.connect('', '', this.currentSessionId, this.lastOnFrame, this.lastOnClose)
        .catch((e: Error) => {
          hilog.warn(0x0000, TAG, 'follow 重建失败: %{public}s', e.message);
        });
    }
  }

  onRelayReset(): void {
    this.opened = false;
    this.mux = undefined;
  }

  openFollow(sessionId: string): boolean {
    if (!this.mux || !this.opened) {
      return false;
    }
    this.closeFollowStream();
    this.sendMuxOpen(sessionId);
    return true;
  }

  private closeFollowStream(): void {
    if (!this.mux) {
      return;
    }
    const closeBody: MuxCloseBody = { type: 'close', streamId: this.followStreamId };
    try {
      this.mux.send(JSON.stringify(closeBody));
    } catch (e) { /* 尽力而为 */ }
  }

  private sendMuxOpen(sessionId: string): void {
    if (!this.mux) {
      return;
    }
    this.followSeq += 1;
    this.followStreamId = `hh-${Date.now()}-${this.followSeq}`;
    const addr: MuxAddress = { kind: 'session', sessionId: sessionId };
    const win: MuxTurnWindow = { minMessages: FOLLOW_MIN_MESSAGES, minTurns: FOLLOW_MIN_TURNS };
    const req: MuxOpenRequest = {
      address: addr,
      maxMessages: FOLLOW_MAX_MESSAGES,
      turnWindow: win,
    };
    const wrap: MuxArgsWrap = { request: req };
    const payload: MuxPayload = { args: wrap };
    const openBody: MuxOpenBody = {
      type: 'open',
      streamId: this.followStreamId,
      endpoint: 'session/follow',
      payload: payload,
    };
    this.mux.send(JSON.stringify(openBody));
  }

  async connect(_wsUrl: string, _cookie: string, sessionId: string,
    onFrame: FrameHandler, onClose: CloseHandler): Promise<void> {
    if (!this.relay.isReady()) {
      throw new Error('ERR_NETWORK: 中继未就绪');
    }
    this.currentSessionId = sessionId;
    this.lastOnFrame = onFrame;
    this.lastOnClose = onClose;
    const mux = await this.relay.openMux((text: string): void => {
      try {
        const frame = JSON.parse(text) as FollowFrame;
        onFrame(frame);
      } catch (e) {
        hilog.error(0x0000, TAG, 'mux 帧解析失败: %{public}s', String(e));
      }
    }, (reason: string): void => {
      this.opened = false;
      this.mux = undefined;
      onClose(reason || '中继流已断开');
    });
    this.mux = mux;
    this.opened = true;
    this.sendMuxOpen(sessionId);
  }

  close(): void {
    this.closeFollowStream();
    if (this.mux) {
      this.mux.close();
      this.mux = undefined;
    }
    this.opened = false;
    this.currentSessionId = '';
  }
}
