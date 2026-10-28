/**
 * Person Harness 协议类型定义（v4 实测版，探测脚本 probe-shapes*.cjs 验证）
 * 所有 JSON.parse 结果都显式断言到这里的接口，避免 any。
 */

/** 会话摘要（session/list items 元素——实测无 title 字段） */
export interface SessionItem {
  sessionId: string;
  updatedAt?: number;
  agentAvailable?: boolean;
  formatStatus?: string;
  running?: boolean;
  blank?: boolean;
  cwd?: string;
}

/** 服务端一元 RPC 响应外壳 */
export interface RpcResultError {
  code?: string;
  message?: string;
}

export interface RpcResult {
  ok: boolean;
  value?: Object;
  error?: RpcResultError;
}

export interface ServerResponse {
  type: string;
  rpcId: string;
  result: RpcResult;
}

/** session/list 的 value */
export interface SessionListValue {
  items?: Array<SessionItem>;
}

/** 聊天消息（App 内部模型） */
export interface ChatMessage {
  id: string;
  role: string; // 'user' | 'assistant'
  text: string;
  streaming: boolean;
  seq?: number; // harness 事件 seq，用于去重/替换
  ord?: number; // 内部插入序：无 seq 的乐观消息按插入顺序排在末尾（不落协议，仅缓存 JSON 携带）
}

/** follow 帧：文本块 */
export interface ContentBlock {
  type?: string;
  text?: string;
}

/** v4 流事件：event.data 载荷宽松处理 */
export interface StreamEvent {
  type?: string;
  seq?: number;
  time?: number;
  data?: Record<string, Object>;
}

/** v4 记录：{type:'event', event:{...}} */
export interface StreamRecord {
  type?: string;
  event?: StreamEvent;
}

export interface SnapshotHeader {
  id?: string;
  cwd?: string;
  createdAt?: number;
}

/** follow snapshot（value 层）：完整历史 records + cursor */
export interface FollowSnapshot {
  header?: SnapshotHeader;
  cursor?: number;
  records?: Array<StreamRecord>;
}

/** follow 帧外壳：{type:'item', streamId, value:{...}} */
export interface FollowFrame {
  type: string;
  streamId?: string;
  value?: Object;
}

/** 已配对设备（一台 PC）元信息，JSON 存 preferences */
export interface DeviceMeta {
  id: string;
  name: string;     // 显示名（MagicDNS 首段，可改）
  host: string;
  port: number;
  basePath: string; // 例如 "/h"（companion 代理）或 ""（直连 harness）
}

/** 配对信息 */
export interface PairInfo {
  host: string;
  port: number;
  basePath: string; // 例如 "/h"（companion 代理）或 ""（直连 harness）
  cookie: string;   // 完整 Cookie 串：dsh-auth-<hash>=v2.xxx 或裸 key
  token: string;    // launch token（WS 断开致 Cookie 失效时自动重铸，harness 重启后同样失效）
}

/** session/page 请求（标题提炼用） */
export interface PageAddress {
  kind: string;
  sessionId: string;
}

export interface PageTurnWindow {
  minMessages: number;
  minTurns: number;
}

export interface PageRequest {
  address: PageAddress;
  throughSeq: number;
  /** 向前翻页：只取此 seq 之前的消息（"加载更早"用） */
  beforeSeq?: number;
  maxMessages: number;
  turnWindow: PageTurnWindow;
}

export interface PageArgs {
  request: PageRequest;
}

// ================= v2 中继配对（协议 v2.0） =================

/** 二维码 myapp://pair?ver=2 解析结果 */
export interface PairCodeV2 {
  server: string; // 协调服务器 host[:port]
  device: string; // PC 设备 ID（提示用）
  code: string;   // 一次性配对码
}

export interface RegisterReq {
  name: string;
  publicKey: string;
}

export interface RegisterResp {
  deviceId: string;
  deviceToken: string;
}

export interface RedeemReq {
  code: string;
  deviceId: string;
  publicKey: string;
}

export interface PairPcInfo {
  deviceId: string;
  name: string;
  publicKey: string;
  seq?: string; // 设备编号（如 20261023-0008），旧版服务端可能不下发
}

export interface PairPhoneInfo {
  deviceId: string;
  seq?: string;
}

export interface PairInner {
  pairId: string;
  pc: PairPcInfo;
  phone: PairPhoneInfo;
}

export interface RedeemResult {
  deviceCredential: string;
  pair: PairInner;
}

/** /api/v1/pairs 列表项（设备页刷新 PC 显示名用） */
export interface PairSummary {
  pairId: string;
  pc: PairPcInfo;
  phone?: PairPhoneInfo;
  createdAt?: number;
}

/** v2 设备元信息（一台 PC = 一条） */
export interface DeviceMetaV2 {
  id: string;         // 本地设备条目 id
  name: string;       // PC 显示名
  server: string;     // 协调服务器 host[:port]
  pcDeviceId: string; // PC 设备 ID
  deviceId: string;   // 本机在服务器侧的设备 ID
  seq?: string;       // 设备编号（设备页显示，云端 /api/v1/pairs 刷新；可能缺省）
}

// ================= 传输无关接口（v1 直连 / v2 中继共用） =================

export type FrameHandler = (frame: FollowFrame) => void;
export type CloseHandler = (reason: string) => void;

export interface IClient {
  ping(): Promise<number>;
  rpc(endpoint: string, args: Object, param?: string): Promise<Object>;
  checkHealth(): Promise<void>;
  createSession(cwd?: string): Promise<string>;
  sendPrompt(sessionId: string, text: string): Promise<void>;
  getWsUrl(): string;
  getCookie(): string;
}

export interface IStream {
  isOpen(): boolean;
  openFollow(sessionId: string): boolean;
  connect(wsUrl: string, cookie: string, sessionId: string, onFrame: FrameHandler,
    onClose: CloseHandler): Promise<void>;
  close(): void;
}
