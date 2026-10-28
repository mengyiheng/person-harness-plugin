/**
 * 轻量可靠 UDP：与 PC/Android 共用 HHR1 协议。
 * 14B 头：HHR1 | type u8 | reserved u8 | messageId u32BE | fragmentIndex u16BE | fragmentCount u16BE。
 * 业务帧仍由原 E2E 加密；本层只负责分片、ACK、重传、保序与失败回放。
 */
import { concatBytes, fromUtf8, utf8 } from './B64u';
import { SealedPayload } from './RelayE2E';

const HEADER: number = 14;
const PAYLOAD: number = 1000;
const DATA: number = 1;
const ACK: number = 2;
const PING: number = 3;
const PONG: number = 4;
const MAX_IN_FLIGHT: number = 4;
const RETRANSMIT_MS: number = 400;
const MAX_RETRIES: number = 30;
const KEEPALIVE_MS: number = 2000;
const IDLE_MS: number = 12000;

export interface UdpFrame {
  type: string;
  attachId?: string;
  streamId?: string;
  fin?: boolean;
  udpId?: string;
  e2e?: SealedPayload;
}

interface OutMessage {
  id: number;
  frame: UdpFrame;
  chunks: Array<Uint8Array>;
  acked: Array<boolean>;
  lastSent: Array<number>;
  retries: Array<number>;
}

interface InMessage {
  chunks: Array<Uint8Array | null>;
  received: number;
}

function putU16(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 8) & 0xFF;
  out[offset + 1] = value & 0xFF;
}

function putU32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xFF;
  out[offset + 1] = (value >>> 16) & 0xFF;
  out[offset + 2] = (value >>> 8) & 0xFF;
  out[offset + 3] = value & 0xFF;
}

function getU16(input: Uint8Array, offset: number): number {
  return ((input[offset] & 0xFF) << 8) | (input[offset + 1] & 0xFF);
}

function getU32(input: Uint8Array, offset: number): number {
  return (((input[offset] & 0xFF) << 24) | ((input[offset + 1] & 0xFF) << 16) |
    ((input[offset + 2] & 0xFF) << 8) | (input[offset + 3] & 0xFF)) >>> 0;
}

function header(type: number, messageId: number, fragmentIndex: number,
  fragmentCount: number, length: number): Uint8Array {
  const out = new Uint8Array(HEADER + length);
  out[0] = 72;
  out[1] = 72;
  out[2] = 82;
  out[3] = 49;
  out[4] = type;
  out[5] = 0;
  putU32(out, 6, messageId);
  putU16(out, 10, fragmentIndex);
  putU16(out, 12, fragmentCount);
  return out;
}

export class ReliableUdpChannel {
  private channelId: string;
  private sendPacket: (packet: Uint8Array) => void;
  private onFrame: (frame: UdpFrame) => void;
  private onFail: (pending: Array<UdpFrame>) => void;
  private log: (message: string) => void;
  private active: boolean = true;
  private nextMessageId: number = 1;
  private nextReceiveId: number = 1;
  private pending: Map<number, OutMessage> = new Map();
  private queue: Array<UdpFrame> = new Array<UdpFrame>();
  private incoming: Map<number, InMessage> = new Map();
  private completed: Map<number, UdpFrame> = new Map();
  private lastReceived: number = Date.now();
  private retransmitTimer: number = -1;
  private keepaliveTimer: number = -1;

  constructor(channelId: string, sendPacket: (packet: Uint8Array) => void,
    onFrame: (frame: UdpFrame) => void, onFail: (pending: Array<UdpFrame>) => void,
    log: (message: string) => void) {
    this.channelId = channelId;
    this.sendPacket = sendPacket;
    this.onFrame = onFrame;
    this.onFail = onFail;
    this.log = log;
    this.retransmitTimer = setInterval(() => this.retransmit(), 200);
    this.keepaliveTimer = setInterval(() => this.keepalive(), KEEPALIVE_MS);
  }

  isActive(): boolean {
    return this.active;
  }

  send(frame: UdpFrame): boolean {
    if (!this.active) {
      return false;
    }
    this.queue.push(frame);
    this.pump();
    return true;
  }

  private pump(): void {
    while (this.active && this.pending.size < MAX_IN_FLIGHT && this.queue.length > 0) {
      const original = this.queue.shift() as UdpFrame;
      const id = this.nextMessageId++;
      const frame = JSON.parse(JSON.stringify(original)) as UdpFrame;
      if (!frame.udpId) {
        frame.udpId = `${this.channelId}:${id}`;
      }
      const bytes = utf8(JSON.stringify(frame));
      const count = Math.ceil(bytes.length / PAYLOAD);
      if (count <= 0 || count > 65535) {
        this.log(`UDP 业务帧大小不支持: ${bytes.length}`);
        continue;
      }
      const chunks = new Array<Uint8Array>();
      for (let index = 0; index < count; index++) {
        chunks.push(bytes.subarray(index * PAYLOAD, Math.min(bytes.length, (index + 1) * PAYLOAD)));
      }
      const message: OutMessage = {
        id: id,
        frame: frame,
        chunks: chunks,
        acked: new Array<boolean>(count).fill(false),
        lastSent: new Array<number>(count).fill(0),
        retries: new Array<number>(count).fill(0)
      };
      this.pending.set(id, message);
      for (let index = 0; index < count; index++) {
        this.sendFragment(message, index);
      }
    }
  }

  private sendFragment(message: OutMessage, index: number): void {
    if (!this.active || message.acked[index]) {
      return;
    }
    const chunk = message.chunks[index];
    const packet = header(DATA, message.id, index, message.chunks.length, chunk.length);
    packet.set(chunk, HEADER);
    message.lastSent[index] = Date.now();
    this.sendPacket(packet);
  }

  private control(type: number, messageId: number = 0, fragmentIndex: number = 0): void {
    if (!this.active) {
      return;
    }
    this.sendPacket(header(type, messageId, fragmentIndex, 0, 0));
  }

  handlePacket(packet: Uint8Array): boolean {
    if (!this.active || packet.length < HEADER || packet[0] !== 72 || packet[1] !== 72 ||
      packet[2] !== 82 || packet[3] !== 49) {
      return false;
    }
    this.lastReceived = Date.now();
    const type = packet[4] & 0xFF;
    const messageId = getU32(packet, 6);
    const fragmentIndex = getU16(packet, 10);
    const fragmentCount = getU16(packet, 12);
    if (type === PING) {
      this.control(PONG);
      return true;
    }
    if (type === PONG) {
      return true;
    }
    if (type === ACK) {
      const pending = this.pending.get(messageId);
      if (!pending || fragmentIndex >= pending.chunks.length) {
        return true;
      }
      pending.acked[fragmentIndex] = true;
      if (pending.acked.every((acked: boolean): boolean => acked)) {
        this.pending.delete(messageId);
        this.pump();
      }
      return true;
    }
    if (type !== DATA || fragmentCount <= 0 || fragmentIndex >= fragmentCount || fragmentCount > 4096) {
      return true;
    }
    if (messageId < this.nextReceiveId || this.completed.has(messageId)) {
      this.control(ACK, messageId, fragmentIndex);
      return true;
    }
    let incoming = this.incoming.get(messageId);
    if (!incoming) {
      incoming = { chunks: new Array<Uint8Array | null>(fragmentCount).fill(null), received: 0 };
      this.incoming.set(messageId, incoming);
    }
    if (incoming.chunks.length !== fragmentCount) {
      this.incoming.delete(messageId);
      return true;
    }
    if (incoming.chunks[fragmentIndex] === null) {
      incoming.chunks[fragmentIndex] = packet.slice(HEADER);
      incoming.received++;
    }
    this.control(ACK, messageId, fragmentIndex);
    if (incoming.received === fragmentCount) {
      this.incoming.delete(messageId);
      try {
        const chunks = new Array<Uint8Array>();
        incoming.chunks.forEach((chunk: Uint8Array | null): void => {
          if (chunk !== null) {
            chunks.push(chunk);
          }
        });
        const frame = JSON.parse(fromUtf8(concatBytes(chunks))) as UdpFrame;
        this.completed.set(messageId, frame);
      } catch (e) {
        this.log(`UDP 业务帧解码失败: ${(e as Error).message}`);
      }
      this.deliverOrdered();
    }
    return true;
  }

  private deliverOrdered(): void {
    while (this.completed.has(this.nextReceiveId)) {
      const frame = this.completed.get(this.nextReceiveId) as UdpFrame;
      this.completed.delete(this.nextReceiveId);
      this.nextReceiveId++;
      this.onFrame(frame);
    }
  }

  private retransmit(): void {
    if (!this.active) {
      return;
    }
    const now = Date.now();
    let failed = false;
    this.pending.forEach((message: OutMessage): void => {
      if (failed) {
        return;
      }
      for (let index = 0; index < message.chunks.length; index++) {
        if (message.acked[index] || now - message.lastSent[index] < RETRANSMIT_MS) {
          continue;
        }
        message.retries[index]++;
        if (message.retries[index] > MAX_RETRIES) {
          failed = true;
          this.fail(`UDP 分片重传超限 msg=${message.id} fragment=${index}`);
          return;
        }
        this.sendFragment(message, index);
      }
    });
  }

  private keepalive(): void {
    if (!this.active) {
      return;
    }
    if (Date.now() - this.lastReceived > IDLE_MS) {
      this.fail('UDP 直连空闲超时');
      return;
    }
    this.control(PING);
  }

  private fail(reason: string): void {
    if (!this.active) {
      return;
    }
    const frames = new Array<UdpFrame>();
    const pending = Array.from(this.pending.values());
    pending.sort((a: OutMessage, b: OutMessage): number => a.id - b.id);
    pending.forEach((message: OutMessage): void => {
      frames.push(message.frame);
    });
    this.queue.forEach((frame: UdpFrame): void => {
      frames.push(frame);
    });
    this.log(`UDP 可靠通道失败：${reason}，回落中继（待回放 ${frames.length} 帧）`);
    this.stop();
    this.onFail(frames);
  }

  stop(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    if (this.retransmitTimer >= 0) {
      clearInterval(this.retransmitTimer);
      this.retransmitTimer = -1;
    }
    if (this.keepaliveTimer >= 0) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = -1;
    }
    this.pending.clear();
    this.queue = new Array<UdpFrame>();
    this.incoming.clear();
    this.completed.clear();
  }
}
