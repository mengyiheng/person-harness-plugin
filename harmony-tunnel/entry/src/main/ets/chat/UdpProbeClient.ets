/**
 * UDP 直连：STUN 发现公网候选，经现有中继交换候选，SYN/ACK 验证双向可达。
 * 成功后复用同一 UDP socket 承载可靠 E2E 业务帧；失败不中断中继。
 */
import { socket, connection } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { util } from '@kit.ArkTS';
import { fromUtf8, utf8 } from './B64u';
import { ReliableUdpChannel, UdpFrame } from './ReliableUdpChannel';

const TAG: string = 'HHUdpProbe';
const COOKIE: number = 0x2112A442;
const DISCOVERY_MS: number = 1600;
const PROBE_INTERVAL_MS: number = 250;
const PROBE_LIFETIME_MS: number = 7000;

export interface UdpCandidate {
  ip: string;
  port: number;
}

export interface UdpControlFrame extends UdpFrame {
  probeId?: string;
  step?: string;
  candidates?: Array<UdpCandidate>;
}

// 跨 attach 的进程内有界历史，不写盘、不额外外发；每个公网 IP 最多保留 32 个映射。
const PEER_MAPPING_HISTORY: Map<string, Array<number>> = new Map();

function rememberMappingHistory(candidates: Array<UdpCandidate>): void {
  candidates.forEach((item: UdpCandidate): void => {
    if (!PEER_MAPPING_HISTORY.has(item.ip)) {
      if (PEER_MAPPING_HISTORY.size >= 8) {
        const oldest = PEER_MAPPING_HISTORY.keys().next();
        if (!oldest.done) {
          PEER_MAPPING_HISTORY.delete(oldest.value);
        }
      }
      PEER_MAPPING_HISTORY.set(item.ip, new Array<number>());
    }
    const history = PEER_MAPPING_HISTORY.get(item.ip) as Array<number>;
    if (!history.includes(item.port)) {
      history.push(item.port);
    }
    while (history.length > 32) {
      history.shift();
    }
  });
}

function mappingHistoryFor(candidates: Array<UdpCandidate>): Array<UdpCandidate> {
  const result: Array<UdpCandidate> = new Array<UdpCandidate>();
  candidates.forEach((item: UdpCandidate): void => {
    const history = PEER_MAPPING_HISTORY.get(item.ip) || new Array<number>();
    history.forEach((port: number): void => {
      result.push({ ip: item.ip, port: port });
    });
  });
  return result;
}

function bytesToAb(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer;
}

function getU16(input: Uint8Array, offset: number): number {
  return ((input[offset] & 0xFF) << 8) | (input[offset + 1] & 0xFF);
}

function getU32(input: Uint8Array, offset: number): number {
  return (((input[offset] & 0xFF) << 24) | ((input[offset + 1] & 0xFF) << 16) |
    ((input[offset + 2] & 0xFF) << 8) | (input[offset + 3] & 0xFF)) >>> 0;
}

function randomHex(): string {
  return util.generateRandomUUID().replace(/-/g, '');
}

function stunRequest(): Uint8Array {
  const out = new Uint8Array(20);
  out[0] = 0;
  out[1] = 1;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0x21;
  out[5] = 0x12;
  out[6] = 0xA4;
  out[7] = 0x42;
  const random = randomHex();
  for (let i = 0; i < 12; i++) {
    out[8 + i] = Number.parseInt(random.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function parseStunAddress(packet: Uint8Array): UdpCandidate | null {
  if (packet.length < 20 || getU16(packet, 0) !== 0x0101 || getU32(packet, 4) !== COOKIE) {
    return null;
  }
  const declared = getU16(packet, 2);
  const end = Math.min(packet.length, 20 + declared);
  let offset = 20;
  while (offset + 4 <= end) {
    const type = getU16(packet, offset);
    const length = getU16(packet, offset + 2);
    const value = offset + 4;
    if (value + length > end) {
      break;
    }
    if (length >= 8 && (type === 0x0020 || type === 0x0001) && packet[value + 1] === 0x01) {
      const port = getU16(packet, value + 2) ^ (type === 0x0020 ? 0x2112 : 0);
      const raw = (getU32(packet, value + 4) ^ (type === 0x0020 ? COOKIE : 0)) >>> 0;
      const ip = `${(raw >>> 24) & 255}.${(raw >>> 16) & 255}.${(raw >>> 8) & 255}.${raw & 255}`;
      return { ip: ip, port: port };
    }
    offset = value + length + ((4 - (length % 4)) % 4);
  }
  return null;
}

export class UdpProbeClient {
  private attachId: string;
  private sendRelay: (frame: UdpControlFrame) => void;
  private onFrame: (frame: UdpFrame) => void;
  private onDirect: (direct: boolean, latencyMs?: number) => void;
  private onDown: (pending: Array<UdpFrame>) => void;
  private probeId: string = randomHex().substring(0, 24);
  private candidates: Map<string, UdpCandidate> = new Map();
  private peerCandidates: Array<UdpCandidate> = new Array<UdpCandidate>();
  private peerProbeId: string = '';
  private udp?: socket.UDPSocket;
  private reliable?: ReliableUdpChannel;
  private remote?: UdpCandidate;
  private dead: boolean = false;
  private synSeen: boolean = false;
  private ackSeen: boolean = false;
  private dropTrafficForTest: boolean = false;
  private advertiseTimer: number = -1;
  private probeStartTimer: number = -1;
  private probeTimer: number = -1;
  private stopTimer: number = -1;
  private lastSynAt: number = 0;
  private synTicks: number = 0;

  constructor(attachId: string, sendRelay: (frame: UdpControlFrame) => void,
    onFrame: (frame: UdpFrame) => void, onDirect: (direct: boolean, latencyMs?: number) => void,
    onDown: (pending: Array<UdpFrame>) => void) {
    this.attachId = attachId;
    this.sendRelay = sendRelay;
    this.onFrame = onFrame;
    this.onDirect = onDirect;
    this.onDown = onDown;
  }

  async start(): Promise<void> {
    const udp = socket.constructUDPSocketInstance();
    this.udp = udp;
    udp.on('message', (info: socket.SocketMessageInfo): void => {
      if (this.udp === udp) {
        this.onMessage(new Uint8Array(info.message), info.remoteInfo.address, info.remoteInfo.port);
      }
    });
    udp.on('error', (err: Object): void => {
      hilog.warn(0x0000, TAG, 'UDP socket 错误: %{public}s', JSON.stringify(err));
    });
    try {
      await udp.bind({ address: '0.0.0.0', port: 0, family: 1 });
      if (this.dead || this.udp !== udp) {
        await udp.close();
        return;
      }
      const local = await udp.getLocalAddress();
      hilog.info(0x0000, TAG, 'UDP 探针启动 local=%{public}d probe=%{public}s',
        local.port, this.probeId.substring(0, 8));
      this.resolveAndSend(udp, 'stun.l.google.com', 19302, 'google');
      this.resolveAndSend(udp, 'stun.miwifi.com', 3478, 'miwifi');
      this.resolveAndSend(udp, 'stun.freeswitch.org', 3478, 'freeswitch');
      this.advertiseTimer = setTimeout(() => this.advertise(), DISCOVERY_MS);
      this.probeStartTimer = setTimeout(() => {
        if (!this.dead) {
          this.probeTimer = setInterval(() => this.sendSyn(), PROBE_INTERVAL_MS);
        }
      }, DISCOVERY_MS + 100);
      this.stopTimer = setTimeout(() => this.stop(), PROBE_LIFETIME_MS);
    } catch (e) {
      hilog.warn(0x0000, TAG, 'UDP 探针启动失败: %{public}s', (e as Error).message);
      this.stop();
    }
  }

  private resolveAndSend(udp: socket.UDPSocket, host: string, port: number, name: string): void {
    connection.getAddressesByName(host).then((addresses: Array<socket.NetAddress>): Promise<void> => {
      if (this.dead || this.udp !== udp) {
        return Promise.resolve();
      }
      const address = addresses.find((item: socket.NetAddress): boolean => item.family === 1);
      if (!address) {
        throw new Error('没有 IPv4 地址');
      }
      return udp.send({ data: bytesToAb(stunRequest()), address: { address: address.address, port: port, family: 1 } });
    }).catch((e: Object): void => {
      hilog.warn(0x0000, TAG, 'UDP STUN %{public}s 发送失败: %{public}s', name, String(e));
    });
  }

  private advertise(): void {
    if (this.dead) {
      return;
    }
    const list = Array.from(this.candidates.values());
    if (list.length === 0) {
      hilog.warn(0x0000, TAG, 'UDP 探针未获得 STUN 公网候选');
      return;
    }
    hilog.info(0x0000, TAG, 'UDP 候选 %{public}s', this.candidateText(list));
    this.sendRelay({ type: 'udp-candidate', attachId: this.attachId, probeId: this.probeId, candidates: list });
  }

  onPeer(frame: UdpControlFrame): void {
    if (this.dead || frame.attachId !== this.attachId || !frame.probeId || !frame.candidates) {
      return;
    }
    const list = new Array<UdpCandidate>();
    frame.candidates.forEach((item: UdpCandidate): void => {
      if (item && item.ip && Number.isInteger(item.port) && item.port > 0 && item.port <= 65535) {
        list.push({ ip: item.ip, port: item.port });
      }
    });
    this.peerProbeId = frame.probeId;
    this.peerCandidates = list;
    rememberMappingHistory(list);
    hilog.info(0x0000, TAG, 'UDP 对端候选 %{public}s', list.length > 0 ? this.candidateText(list) : '空');
  }

  private candidateText(list: Array<UdpCandidate>): string {
    return list.map((item: UdpCandidate): string => `${item.ip}:${item.port}`).join(', ');
  }

  private onMessage(packet: Uint8Array, ip: string, port: number): void {
    if (this.dead || this.dropTrafficForTest) {
      return;
    }
    const channel = this.reliable;
    const remote = this.remote;
    if (channel && remote && remote.ip === ip && remote.port === port && channel.handlePacket(packet)) {
      return;
    }
    const mapped = parseStunAddress(packet);
    if (mapped) {
      this.candidates.set(`${mapped.ip}:${mapped.port}`, mapped);
      return;
    }
    let frame: UdpControlFrame;
    try {
      frame = JSON.parse(fromUtf8(packet)) as UdpControlFrame;
    } catch (e) {
      return;
    }
    if (frame.type !== 'udp-probe' || frame.attachId !== this.attachId || !frame.probeId) {
      return;
    }
    if (frame.step === 'syn') {
      if (!this.peerProbeId || frame.probeId !== this.peerProbeId) {
        return;
      }
      if (!this.synSeen) {
        this.synSeen = true;
        hilog.info(0x0000, TAG, 'UDP 探针收到对端 SYN（入站可达）source=%{public}s:%{public}d', ip, port);
      }
      this.sendFrame({ type: 'udp-probe', attachId: this.attachId, probeId: frame.probeId, step: 'ack' }, ip, port);
      return;
    }
    if (frame.step === 'ack' && frame.probeId === this.probeId) {
      const latency = this.lastSynAt > 0 ? Math.max(0, Date.now() - this.lastSynAt) : -1;
      if (!this.ackSeen) {
        this.ackSeen = true;
        hilog.info(0x0000, TAG, 'UDP 探针双向成功 ✅ source=%{public}s:%{public}d rtt=%{public}dms', ip, port, latency);
      }
      this.establish(ip, port, latency);
    }
  }

  private establish(ip: string, port: number, latencyMs: number): void {
    if (this.dead || this.reliable || !this.udp) {
      return;
    }
    this.remote = { ip: ip, port: port };
    this.clearProbeTimers();
    const channel = new ReliableUdpChannel(`phone-${this.probeId.substring(0, 16)}`,
      (packet: Uint8Array): void => {
        const remote = this.remote;
        if (!this.dead && remote) {
          this.sendBytes(packet, remote.ip, remote.port);
        }
      },
      this.onFrame,
      (pending: Array<UdpFrame>): void => {
        if (this.reliable !== channel) {
          return;
        }
        this.reliable = undefined;
        this.onDirect(false, -1);
        this.sendRelay({ type: 'punch-revert', attachId: this.attachId });
        this.onDown(pending);
        this.stop();
      },
      (message: string): void => hilog.warn(0x0000, TAG, '%{public}s', message));
    this.reliable = channel;
    hilog.info(0x0000, TAG, 'UDP 业务直连建立 ✅ remote=%{public}s:%{public}d', ip, port);
    this.sendRelay({ type: 'punch-ok', attachId: this.attachId });
    this.onDirect(true, latencyMs);
  }

  isDirect(): boolean {
    return this.reliable?.isActive() === true;
  }

  send(frame: UdpFrame): boolean {
    return this.reliable?.send(frame) === true;
  }

  private mappingPredictionTargets(maxDistance: number = 4): Array<UdpCandidate> {
    const byIp: Map<string, Array<number>> = new Map();
    const observed = this.peerCandidates.concat(mappingHistoryFor(this.peerCandidates));
    observed.forEach((item: UdpCandidate): void => {
      const ports = byIp.get(item.ip) || new Array<number>();
      if (!ports.includes(item.port)) {
        ports.push(item.port);
      }
      byIp.set(item.ip, ports);
    });
    const result: Map<string, UdpCandidate> = new Map();
    byIp.forEach((ports: Array<number>, ip: string): void => {
      ports.sort((a: number, b: number): number => a - b);
      for (let i = 0; i + 1 < ports.length; i++) {
        const step = ports[i + 1] - ports[i];
        if (step < 1 || step > 16384) {
          continue;
        }
        for (let distance = 1; distance <= maxDistance; distance++) {
          const predicted: Array<number> = [ports[i] - step * distance, ports[i + 1] + step * distance];
          predicted.forEach((port: number): void => {
            if (port > 0 && port <= 65535) {
              result.set(`${ip}:${port}`, { ip: ip, port: port });
            }
          });
        }
      }
    });
    return Array.from(result.values());
  }

  private sendSyn(): void {
    if (this.dead || this.reliable || !this.peerProbeId) {
      return;
    }
    this.lastSynAt = Date.now();
    const frame: UdpControlFrame = {
      type: 'udp-probe', attachId: this.attachId, probeId: this.probeId, step: 'syn'
    };
    this.peerCandidates.forEach((target: UdpCandidate): void => {
      this.sendFrame(frame, target.ip, target.port);
    });
    const tick = this.synTicks++;
    if (tick < 4) {
      if (tick === 0) {
        hilog.info(0x0000, TAG, 'UDP SYN 发出 targets=%{public}s', this.candidateText(this.peerCandidates));
      }
      return;
    }
    if (tick === 4) {
      hilog.info(0x0000, TAG, 'UDP 正常候选未打通，启动双端协同端口预测（近端 ±96，历史映射 %{public}d 项，步长外推 4 步）', mappingHistoryFor(this.peerCandidates).length);
    }
    // 与电脑一致：优先发送由多次 STUN 映射推导的候选，再有界轮换附近端口。
    this.mappingPredictionTargets().forEach((target: UdpCandidate): void => {
      this.sendFrame(frame, target.ip, target.port);
    });
    const start = (tick - 4) * 8;
    this.peerCandidates.forEach((target: UdpCandidate): void => {
      for (let i = 0; i < 8; i++) {
        const step = start + i;
        const magnitude = Math.floor(step / 2) + 1;
        if (magnitude > 96) {
          continue;
        }
        const port = target.port + (step % 2 === 0 ? magnitude : -magnitude);
        if (port > 0 && port <= 65535) {
          this.sendFrame(frame, target.ip, port);
        }
      }
    });
  }

  private sendFrame(frame: UdpControlFrame, ip: string, port: number): void {
    this.sendBytes(utf8(JSON.stringify(frame)), ip, port);
  }

  private sendBytes(bytes: Uint8Array, ip: string, port: number): void {
    const udp = this.udp;
    if (this.dead || this.dropTrafficForTest || !udp) {
      return;
    }
    try {
      udp.send({ data: bytesToAb(bytes), address: { address: ip, port: port, family: 1 } })
        .catch((e: Object): void => {
          hilog.warn(0x0000, TAG, 'UDP 发送失败 %{public}s:%{public}d: %{public}s', ip, port, String(e));
        });
    } catch (e) {
      hilog.warn(0x0000, TAG, 'UDP 发送异常 %{public}s:%{public}d: %{public}s', ip, port, String(e));
    }
  }

  /** 真机故障注入：只丢弃 UDP 双向流量，WS 中继保持，验证可靠层自然超时回落。 */
  debugDropTraffic(): void {
    if (this.dead || !this.reliable) {
      hilog.warn(0x0000, TAG, 'DEBUG UDP 故障注入忽略：当前没有业务直连');
      return;
    }
    this.dropTrafficForTest = true;
    hilog.warn(0x0000, TAG, 'DEBUG UDP 故障注入：丢弃双向 UDP 流量，中继保持');
  }

  private clearProbeTimers(): void {
    if (this.advertiseTimer >= 0) {
      clearTimeout(this.advertiseTimer);
      this.advertiseTimer = -1;
    }
    if (this.probeStartTimer >= 0) {
      clearTimeout(this.probeStartTimer);
      this.probeStartTimer = -1;
    }
    if (this.probeTimer >= 0) {
      clearInterval(this.probeTimer);
      this.probeTimer = -1;
    }
    if (this.stopTimer >= 0) {
      clearTimeout(this.stopTimer);
      this.stopTimer = -1;
    }
  }

  stop(): void {
    if (this.dead) {
      return;
    }
    this.dead = true;
    this.clearProbeTimers();
    this.reliable?.stop();
    this.reliable = undefined;
    const udp = this.udp;
    this.udp = undefined;
    if (udp) {
      try {
        udp.off('message');
        udp.off('error');
        udp.close().catch((): void => {});
      } catch (e) { /* 已关闭 */ }
    }
    if (!this.ackSeen) {
      hilog.warn(0x0000, TAG, 'UDP 探针结束：双向未成功（synSeen=%{public}d）', this.synSeen ? 1 : 0);
    }
  }
}
