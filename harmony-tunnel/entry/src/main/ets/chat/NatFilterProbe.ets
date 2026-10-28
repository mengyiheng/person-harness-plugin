/**
 * RFC 5780 只读 NAT 过滤诊断：主 Binding 响应取得 OTHER-ADDRESS 后，
 * 分别请求服务器“同 IP 换端口”和“换 IP + 端口”回包，判断入站过滤。
 * 不申请端口映射、不改变聊天路由；结果仅写 DEBUG hilog。
 */
import { socket, connection } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { util } from '@kit.ArkTS';

const TAG: string = 'HHNatFilter';
const COOKIE: number = 0x2112A442;

export class NatFilterOffer {
  requestId: string;
  primary: Endpoint;
  alternate: Endpoint;

  constructor(requestId: string, primaryIp: string, primaryPort: number,
    alternateIp: string, alternatePort: number) {
    this.requestId = requestId;
    this.primary = { ip: primaryIp, port: primaryPort };
    this.alternate = { ip: alternateIp, port: alternatePort };
  }
}

interface NatFilterRequest {
  type: string;
  attachId: string;
  requestId: string;
  candidate?: Endpoint;
}

interface Endpoint {
  ip: string;
  port: number;
}

interface PendingProbe {
  server: string;
  mode: string;
  expectedIp: string;
  expectedPort: number;
}

interface ServerResult {
  primary: boolean;
  supported: boolean;
  changePort: boolean;
  changeIpPort: boolean;
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

function stunRequest(changeFlags: number): Uint8Array {
  const out = new Uint8Array(changeFlags > 0 ? 28 : 20);
  out[1] = 1;
  out[4] = 0x21;
  out[5] = 0x12;
  out[6] = 0xA4;
  out[7] = 0x42;
  if (changeFlags > 0) {
    out[3] = 8;
    out[21] = 3;
    out[23] = 4;
    out[27] = changeFlags;
  }
  const random = randomHex();
  for (let i = 0; i < 12; i++) {
    out[8 + i] = Number.parseInt(random.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function transactionId(packet: Uint8Array): string {
  let out = '';
  for (let i = 8; i < 20; i++) {
    out += packet[i].toString(16).padStart(2, '0');
  }
  return out;
}

function addressAttribute(packet: Uint8Array, wanted: number, xor: boolean = false): Endpoint | null {
  if (packet.length < 20 || getU16(packet, 0) !== 0x0101 || getU32(packet, 4) !== COOKIE) {
    return null;
  }
  const end = Math.min(packet.length, 20 + getU16(packet, 2));
  let offset = 20;
  while (offset + 4 <= end) {
    const type = getU16(packet, offset);
    const length = getU16(packet, offset + 2);
    const value = offset + 4;
    if (value + length > end) {
      break;
    }
    if (type === wanted && length >= 8 && packet[value + 1] === 0x01) {
      const mask: Uint8Array = new Uint8Array([0x21, 0x12, 0xA4, 0x42]);
      return {
        ip: `${packet[value + 4] ^ (xor ? mask[0] : 0)}.${packet[value + 5] ^ (xor ? mask[1] : 0)}.` +
          `${packet[value + 6] ^ (xor ? mask[2] : 0)}.${packet[value + 7] ^ (xor ? mask[3] : 0)}`,
        port: getU16(packet, value + 2) ^ (xor ? 0x2112 : 0)
      };
    }
    offset = value + length + ((4 - (length % 4)) % 4);
  }
  return null;
}

export class NatFilterProbe {
  private static running: boolean = false;
  private static active?: NatFilterProbe;
  private udp?: socket.UDPSocket;
  private pending: Map<string, PendingProbe> = new Map();
  private results: Map<string, ServerResult> = new Map();
  private attachId: string;
  private sendRelay: (frame: NatFilterRequest) => void;
  private requestId: string = randomHex().substring(0, 16);
  private offer?: NatFilterOffer;
  private selfCandidate?: Endpoint;

  constructor(attachId: string, sendRelay: (frame: NatFilterRequest) => void) {
    this.attachId = attachId;
    this.sendRelay = sendRelay;
  }

  static run(attachId: string, sendRelay: (frame: NatFilterRequest) => void): void {
    if (NatFilterProbe.running) {
      hilog.warn(0x0000, TAG, 'NAT_FILTER 已在运行，忽略重复触发');
      return;
    }
    NatFilterProbe.running = true;
    const probe = new NatFilterProbe(attachId, sendRelay);
    NatFilterProbe.active = probe;
    probe.execute().catch((e: Object): void => {
      hilog.warn(0x0000, TAG, 'NAT_FILTER 执行失败: %{public}s', String(e));
    }).finally((): void => {
      probe.close();
      NatFilterProbe.active = undefined;
      NatFilterProbe.running = false;
    });
  }

  static onOffer(frame: NatFilterOffer): void {
    const active = NatFilterProbe.active;
    if (active && active.requestId === frame.requestId) {
      active.offer = frame;
    }
  }

  private result(name: string): ServerResult {
    const existing = this.results.get(name);
    if (existing) {
      return existing;
    }
    const created: ServerResult = { primary: false, supported: false, changePort: false, changeIpPort: false };
    this.results.set(name, created);
    return created;
  }

  private async execute(): Promise<void> {
    const udp = socket.constructUDPSocketInstance();
    this.udp = udp;
    udp.on('message', (info: socket.SocketMessageInfo): void => {
      this.onMessage(new Uint8Array(info.message), info.remoteInfo.address, info.remoteInfo.port);
    });
    await udp.bind({ address: '0.0.0.0', port: 0, family: 1 });
    const local = await udp.getLocalAddress();
    hilog.info(0x0000, TAG, 'NAT_FILTER 开始 local=%{public}d（RFC 5780，只读）', local.port);
    await this.discoverSelf();
    this.sendRelay({
      type: 'nat-filter-request', attachId: this.attachId, requestId: this.requestId, candidate: this.selfCandidate
    });
    const deadline = Date.now() + 6000;
    while (!this.offer && Date.now() < deadline) {
      await this.sleep(100);
    }
    if (this.offer) {
      hilog.info(0x0000, TAG, 'NAT_FILTER 收到电脑双候选 primary=%{public}s:%{public}d alternate=%{public}s:%{public}d',
        this.offer.primary.ip, this.offer.primary.port, this.offer.alternate.ip, this.offer.alternate.port);
      await this.probeServer('pc-peer', this.offer.primary.ip, this.offer.primary.port);
    } else {
      hilog.warn(0x0000, TAG, 'NAT_FILTER 等待电脑候选超时，仅尝试公共服务');
    }
    await this.probeServer('internetcalls', 'stun.internetcalls.com', 3478);
    await this.probeServer('voipstunt', 'stun.voipstunt.com', 3478);
    await this.sleep(1800);
    this.results.forEach((result: ServerResult, name: string): void => {
      let filtering = 'unknown-no-rfc5780-server';
      if (result.changeIpPort) {
        filtering = 'endpoint-independent';
      } else if (result.changePort) {
        filtering = name === 'own-relay' || name === 'pc-peer' ? 'same-ip-port-change-pass' : 'address-dependent';
      } else if (result.supported) {
        filtering = 'address-and-port-dependent-or-blocked';
      }
      hilog.info(0x0000, TAG,
        'NAT_FILTER_RESULT server=%{public}s primary=%{public}d rfc5780=%{public}d changePort=%{public}d changeIpPort=%{public}d filtering=%{public}s',
        name, result.primary ? 1 : 0, result.supported ? 1 : 0, result.changePort ? 1 : 0,
        result.changeIpPort ? 1 : 0, filtering);
    });
    hilog.info(0x0000, TAG, 'NAT_FILTER 完成');
  }

  private async discoverSelf(): Promise<void> {
    try {
      const addresses = await connection.getAddressesByName('stun.l.google.com');
      const address = addresses.find((item: socket.NetAddress): boolean => item.family === 1);
      if (!address) {
        hilog.warn(0x0000, TAG, 'NAT_FILTER 手机候选发现无 IPv4 地址');
        return;
      }
      const server: Endpoint = { ip: address.address, port: 19302 };
      const request = stunRequest(0);
      this.pending.set(transactionId(request), {
        server: 'self', mode: 'self', expectedIp: server.ip, expectedPort: server.port
      });
      this.send(request, server);
      setTimeout((): void => this.send(request, server), 300);
      await this.sleep(1400);
      if (this.selfCandidate) {
        hilog.info(0x0000, TAG, 'NAT_FILTER 手机候选=%{public}s:%{public}d',
          this.selfCandidate.ip, this.selfCandidate.port);
      } else {
        hilog.warn(0x0000, TAG, 'NAT_FILTER 手机候选发现超时');
      }
    } catch (e) {
      hilog.warn(0x0000, TAG, 'NAT_FILTER 手机候选发现失败: %{public}s', (e as Error).message);
    }
  }

  private async probeServer(name: string, host: string, port: number): Promise<void> {
    const result = this.result(name);
    try {
      const addresses = await connection.getAddressesByName(host);
      const address = addresses.find((item: socket.NetAddress): boolean => item.family === 1);
      if (!address) {
        hilog.warn(0x0000, TAG, 'NAT_FILTER %{public}s 无 IPv4 地址', name);
        return;
      }
      const primary: Endpoint = { ip: address.address, port: port };
      const request = stunRequest(0);
      const id = transactionId(request);
      this.pending.set(id, { server: name, mode: 'primary', expectedIp: primary.ip, expectedPort: primary.port });
      this.send(request, primary);
      setTimeout((): void => this.send(request, primary), 300);
      await this.sleep(1400);
      if (!result.supported) {
        hilog.warn(0x0000, TAG, 'NAT_FILTER %{public}s 无 RFC 5780 OTHER-ADDRESS，无法分类', name);
        return;
      }
      const other = this.otherAddresses.get(name) as Endpoint;
      const sameIpOnly = name === 'own-relay' || name === 'pc-peer';
      const changePort = stunRequest(0x02);
      this.pending.set(transactionId(changePort), {
        server: name, mode: 'changePort', expectedIp: primary.ip, expectedPort: other.port
      });
      const changeIpPort = stunRequest(0x06);
      if (!sameIpOnly) {
        this.pending.set(transactionId(changeIpPort), {
          server: name, mode: 'changeIpPort', expectedIp: other.ip, expectedPort: other.port
        });
      }
      this.send(changePort, primary);
      if (!sameIpOnly) {
        this.send(changeIpPort, primary);
      }
      setTimeout((): void => {
        this.send(changePort, primary);
        if (!sameIpOnly) {
          this.send(changeIpPort, primary);
        }
      }, 300);
      hilog.info(0x0000, TAG, 'NAT_FILTER %{public}s 已发送换端口请求 sameIpOnly=%{public}d other=%{public}s:%{public}d',
        name, sameIpOnly ? 1 : 0, other.ip, other.port);
      await this.sleep(1200);
    } catch (e) {
      hilog.warn(0x0000, TAG, 'NAT_FILTER %{public}s 失败: %{public}s', name, (e as Error).message);
    }
  }

  private otherAddresses: Map<string, Endpoint> = new Map();

  private onMessage(packet: Uint8Array, ip: string, port: number): void {
    if (packet.length < 20 || getU16(packet, 0) !== 0x0101) {
      return;
    }
    const pending = this.pending.get(transactionId(packet));
    if (!pending || pending.expectedIp !== ip || pending.expectedPort !== port) {
      return;
    }
    if (pending.mode === 'self') {
      const candidate = addressAttribute(packet, 0x0020, true) || addressAttribute(packet, 0x0001);
      if (candidate) {
        this.selfCandidate = candidate;
      }
      return;
    }
    const result = this.result(pending.server);
    if (pending.mode === 'primary') {
      result.primary = true;
      const other = addressAttribute(packet, 0x8023) || addressAttribute(packet, 0x0005);
      if (other) {
        result.supported = true;
        this.otherAddresses.set(pending.server, other);
        hilog.info(0x0000, TAG, 'NAT_FILTER %{public}s 主响应成功 other=%{public}s:%{public}d',
          pending.server, other.ip, other.port);
      }
      return;
    }
    if (pending.mode === 'changePort' && !result.changePort) {
      result.changePort = true;
      hilog.info(0x0000, TAG, 'NAT_FILTER %{public}s 同 IP 换端口回包通过 source=%{public}s:%{public}d',
        pending.server, ip, port);
    }
    if (pending.mode === 'changeIpPort' && !result.changeIpPort) {
      result.changeIpPort = true;
      hilog.info(0x0000, TAG, 'NAT_FILTER %{public}s 换 IP+端口回包通过 source=%{public}s:%{public}d',
        pending.server, ip, port);
    }
  }

  private send(request: Uint8Array, endpoint: Endpoint): void {
    this.udp?.send({ data: bytesToAb(request), address: { address: endpoint.ip, port: endpoint.port, family: 1 } })
      .catch((e: Object): void => {
        hilog.warn(0x0000, TAG, 'NAT_FILTER 发送失败: %{public}s', String(e));
      });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve: () => void): void => {
      setTimeout(resolve, ms);
    });
  }

  private close(): void {
    const udp = this.udp;
    this.udp = undefined;
    if (udp) {
      try {
        udp.off('message');
        udp.close().catch((): void => {});
      } catch (e) { /* 已关闭 */ }
    }
  }
}
