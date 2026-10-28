/**
 * LocalProxy —— WebView 完整模式的本地回环代理（v2.1）。
 *
 * 职责：监听 127.0.0.1:9411，把 WebView 的全部流量转进 v2 E2E 隧道：
 *   - HTTP（静态资源 + /api/*）→ relay.httpCallBin（二进制安全，响应头透传）
 *   - WebSocket（/api/remote.mux）→ relay.openMux 文本帧双向透传
 * Cookie 由 companion 侧注入（自签 owner Cookie），App 本地零凭证、零登录态。
 *
 * 设计说明：
 *   - WebView 的 WS 无法被 onInterceptRequest 拦截 → 必须走真实本地 TCP 服务
 *   - HTTP 连接按 keep-alive 顺序处理（promise 链防并发错乱）
 *   - WS 帧解析处理掩码/分片长度/大帧（GUI mux 快照可达百 KB 级）
 */
import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { RelayClient, MuxChannel } from './RelayClient';
import { utf8, fromUtf8 } from './B64u';

const TAG = 'HHProxy';
const PORT = 9411;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const textEnc = new util.TextEncoder('utf-8');
const textDec = util.TextDecoder.create('utf-8');
const b64Helper = new util.Base64Helper();

const HOP_HEADERS: Array<string> = ['connection', 'transfer-encoding', 'keep-alive', 'content-length', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'host'];

function reasonOf(status: number): string {
  if (status === 200) { return 'OK'; }
  if (status === 101) { return 'Switching Protocols'; }
  if (status === 204) { return 'No Content'; }
  if (status === 301) { return 'Moved Permanently'; }
  if (status === 302) { return 'Found'; }
  if (status === 303) { return 'See Other'; }
  if (status === 304) { return 'Not Modified'; }
  if (status === 400) { return 'Bad Request'; }
  if (status === 401) { return 'Unauthorized'; }
  if (status === 403) { return 'Forbidden'; }
  if (status === 404) { return 'Not Found'; }
  if (status === 500) { return 'Internal Server Error'; }
  if (status === 502) { return 'Bad Gateway'; }
  return 'Status';
}

function bytesToAb(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.length);
}

function concat2(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) { return b; }
  if (b.length === 0) { return a; }
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

interface HttpReqInfo {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
  totalLen: number;
  wantUpgrade: boolean;
  wsKey: string;
}

/** 解析一条完整 HTTP 请求；数据不足返回 null（header 区全 ASCII，字符索引=字节索引） */
function parseHttp(buf: Uint8Array): HttpReqInfo | null {
  const headText: string = textDec.decodeToString(buf.subarray(0, Math.min(buf.length, 1 << 20)));
  const headerEnd: number = headText.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    return null;
  }
  const lines: Array<string> = headText.substring(0, headerEnd).split('\r\n');
  const reqLine: Array<string> = lines[0].split(' ');
  if (reqLine.length < 2) {
    return null;
  }
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx: number = lines[i].indexOf(':');
    if (idx > 0) {
      headers[lines[i].substring(0, idx).trim().toLowerCase()] = lines[i].substring(idx + 1).trim();
    }
  }
  const bodyStart: number = headerEnd + 4;
  const contentLen: number = Number(headers['content-length'] ?? '0');
  const totalLen: number = bodyStart + contentLen;
  if (buf.length < totalLen) {
    return null;
  }
  const req: HttpReqInfo = {
    method: reqLine[0],
    path: reqLine[1],
    headers: headers,
    body: buf.subarray(bodyStart, totalLen),
    totalLen: totalLen,
    wantUpgrade: (headers['upgrade'] ?? '').toLowerCase() === 'websocket',
    wsKey: headers['sec-websocket-key'] ?? ''
  };
  return req;
}

function buildHttpResponse(status: number, respHeaders: Record<string, string>, body: Uint8Array): Uint8Array {
  const parts: Array<string> = [`HTTP/1.1 ${status} ${reasonOf(status)}\r\n`];
  Object.keys(respHeaders).forEach((k: string) => {
    if (HOP_HEADERS.indexOf(k.toLowerCase()) < 0) {
      parts.push(`${k}: ${respHeaders[k]}\r\n`);
    }
  });
  parts.push(`Content-Length: ${body.length}\r\n`);
  parts.push('Connection: keep-alive\r\n\r\n');
  return concat2(textEnc.encodeInto(parts.join('')), body);
}

/** SSE 流式响应头（无 Content-Length，chunked） */
function buildChunkedHead(status: number, respHeaders: Record<string, string>): Uint8Array {
  const parts: Array<string> = [`HTTP/1.1 ${status} ${reasonOf(status)}\r\n`];
  Object.keys(respHeaders).forEach((k: string) => {
    if (HOP_HEADERS.indexOf(k.toLowerCase()) < 0) {
      parts.push(`${k}: ${respHeaders[k]}\r\n`);
    }
  });
  parts.push('Transfer-Encoding: chunked\r\n');
  parts.push('Connection: keep-alive\r\n\r\n');
  return textEnc.encodeInto(parts.join(''));
}

/** 一个 HTTP chunk 分块（hex 长度 + 数据 + CRLF） */
function httpChunk(bytes: Uint8Array): Uint8Array {
  const prefix: Uint8Array = textEnc.encodeInto(bytes.length.toString(16) + '\r\n');
  return concat2(concat2(prefix, bytes), textEnc.encodeInto('\r\n'));
}

async function wsAcceptKey(key: string): Promise<string> {
  const md: cryptoFramework.Md = cryptoFramework.createMd('SHA1');
  await md.update({ data: textEnc.encodeInto(key + WS_GUID) });
  const digest: cryptoFramework.DataBlob = await md.digest();
  return b64Helper.encodeToStringSync(digest.data);
}

/** 服务端→客户端 WS 帧（不带掩码） */
function wsEncodeFrame(op: number, payload: Uint8Array): Uint8Array {
  const len: number = payload.length;
  let headerLen = 2;
  if (len >= 126 && len < 65536) {
    headerLen = 4;
  } else if (len >= 65536) {
    headerLen = 10;
  }
  const out: Uint8Array = new Uint8Array(headerLen + len);
  out[0] = 0x80 | op;
  if (len < 126) {
    out[1] = len;
  } else if (len < 65536) {
    out[1] = 126;
    out[2] = (len >> 8) & 0xFF;
    out[3] = len & 0xFF;
  } else {
    out[1] = 127;
    let v: number = len;
    for (let i = 9; i >= 2; i--) {
      out[i] = v & 0xFF;
      v = Math.floor(v / 256);
    }
  }
  out.set(payload, headerLen);
  return out;
}

interface WsFrameInfo {
  op: number;
  payload: Uint8Array;
}

/** 客户端（WebView）→ 服务端 WS 帧流式解析器（处理掩码与 16/64 位长度） */
class WsParser {
  private buf: Uint8Array = new Uint8Array(0);

  feed(data: Uint8Array): Array<WsFrameInfo> {
    this.buf = concat2(this.buf, data);
    const frames: Array<WsFrameInfo> = [];
    for (;;) {
      if (this.buf.length < 2) {
        break;
      }
      const op: number = this.buf[0] & 0x0F;
      const masked: boolean = (this.buf[1] & 0x80) !== 0;
      let len: number = this.buf[1] & 0x7F;
      let p = 2;
      if (len === 126) {
        if (this.buf.length < 4) {
          break;
        }
        len = (this.buf[2] << 8) | this.buf[3];
        p = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) {
          break;
        }
        len = 0;
        for (let i = 2; i < 10; i++) {
          len = len * 256 + this.buf[i];
        }
        p = 10;
      }
      let mask: Uint8Array | null = null;
      if (masked) {
        if (this.buf.length < p + 4) {
          break;
        }
        mask = this.buf.subarray(p, p + 4);
        p += 4;
      }
      if (this.buf.length < p + len) {
        break;
      }
      let payload: Uint8Array = this.buf.subarray(p, p + len);
      if (mask !== null) {
        const u: Uint8Array = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          u[i] = payload[i] ^ mask[i & 3];
        }
        payload = u;
      }
      const f: WsFrameInfo = { op: op, payload: payload };
      frames.push(f);
      this.buf = this.buf.subarray(p + len);
    }
    return frames;
  }
}

/** 单个 TCP 连接的状态 */
class ConnState {
  buf: Uint8Array = new Uint8Array(0);
  wsMode: boolean = false;
  wsParser: WsParser = new WsParser();
  mux: MuxChannel | null = null;
  busy: Promise<void> = Promise.resolve();
  closed: boolean = false;
}

export class LocalProxy {
  readonly relay: RelayClient;
  private server: socket.TCPSocketServer | null = null;
  private clients: Set<socket.TCPSocketConnection> = new Set();
  ready: boolean = false;
  url: string = '';

  constructor(relay: RelayClient) {
    this.relay = relay;
  }

  start(): Promise<string> {
    // 端口被占自动向后尝试（旧实例后台保活时占着 9411，新实例静默回退原生列表的元凶）
    const tryPort = (port: number): Promise<string> => {
      return new Promise<string>((resolve: (u: string) => void, reject: (e: Error) => void) => {
        const server: socket.TCPSocketServer = socket.constructTCPSocketServerInstance();
        server.on('connect', (client: socket.TCPSocketConnection) => {
          this.onConnect(client);
        });
        const addr: socket.NetAddress = { address: '127.0.0.1', port: port, family: 1 };
        server.listen(addr, (err: Error) => {
          if (err) {
            reject(new Error('listen ' + port + ' 失败: ' + err.message));
            return;
          }
          this.server = server;
          this.ready = true;
          this.url = `http://127.0.0.1:${port}/`;
          hilog.info(0x0000, TAG, '本地代理已监听 %{public}s', this.url);
          resolve(this.url);
        });
      });
    };
    const attempt = (idx: number): Promise<string> => {
      return tryPort(PORT + idx).catch((e: Error): Promise<string> => {
        if (idx >= 4) {
          return Promise.reject(e);
        }
        return attempt(idx + 1);
      });
    };
    return attempt(0);
  }

  /** 统一发送出口：SocketSendOptions 需显式类型（arkts-no-untyped-obj-literals） */
  private rawSend(client: socket.TCPSocketConnection, bytes: Uint8Array): void {
    const ab: ArrayBuffer = bytesToAb(bytes);
    const opt: socket.TCPSendOptions = { data: ab };
    client.send(opt);
  }

  stop(): void {
    this.ready = false;
    // 🔴 server.close() 只停监听，不杀已接受连接：keep-alive 的旧连接会继续由
    //    本（即将作废的）代理对象服务，绑着已 stop 的 relay → 全部请求"中继未就绪"。
    //    换 relay 重激活时必须把存量连接一并掐断，让 WebView 重连到新代理。
    this.clients.forEach((c: socket.TCPSocketConnection) => {
      try {
        c.close();
      } catch (e) {
        // 已断开的连接忽略
      }
    });
    this.clients.clear();
    try {
      this.server?.close();
    } catch (e) {
      // 忽略
    }
    this.server = null;
  }

  private onConnect(client: socket.TCPSocketConnection): void {
    hilog.info(0x0000, TAG, '新 TCP 连接');
    this.clients.add(client);
    const st: ConnState = new ConnState();
    const proxy: LocalProxy = this;
    client.on('message', (info: socket.SocketMessageInfo) => {
      st.buf = concat2(st.buf, new Uint8Array(info.message));
      if (st.wsMode) {
        proxy.handleWsBytes(client, st);
        return;
      }
      // HTTP 模式：顺序处理（防 keep-alive 流水线并发错乱）
      st.busy = st.busy.then((): Promise<void> => proxy.pumpHttp(client, st));
      st.busy.catch((e: Error) => {
        hilog.warn(0x0000, TAG, 'HTTP 处理异常: %{public}s', e.message);
      });
    });
    client.on('close', () => {
      proxy.clients.delete(client);
      st.closed = true;
      if (st.mux) {
        st.mux.close();
        st.mux = null;
      }
    });
    client.on('error', () => {
      proxy.clients.delete(client);
      st.closed = true;
      if (st.mux) {
        st.mux.close();
        st.mux = null;
      }
    });
  }

  /** 逐条解析并转发 buf 里的完整 HTTP 请求 */
  private async pumpHttp(client: socket.TCPSocketConnection, st: ConnState): Promise<void> {
    for (;;) {
      if (st.closed || st.wsMode) {
        return;
      }
      const req: HttpReqInfo | null = parseHttp(st.buf);
      if (!req) {
        return;
      }
      st.buf = st.buf.subarray(req.totalLen);
      if (req.wantUpgrade) {
        await this.upgradeWs(client, st, req);
        return;
      }
      await this.forwardHttp(client, st, req);
    }
  }

  private async forwardHttp(client: socket.TCPSocketConnection, st: ConnState, req: HttpReqInfo): Promise<void> {
    try {
      const hasBody: boolean = req.body.length > 0;
      // 🔴 流式透传（2026-10-24，opencode SSE）：/global/event 等 text/event-stream 是
      //    永不结束的长连接——攒完整响应会让 WebView 的事件流永久挂住（UI 无实时更新）。
      //    SSE 响应改 chunked 边收边发；普通响应保持缓冲（Content-Length 语义不变）。
      const chunks: Array<Uint8Array> = new Array<Uint8Array>();
      let streaming: boolean = false;
      let bufferedStatus: number = 0;
      let bufferedHeaders: Record<string, string> = {};
      await this.relay.httpCallStream(
        req.method,
        req.path,
        hasBody ? req.body : null,
        hasBody ? (req.headers['content-type'] ?? 'application/octet-stream') : '',
        (status: number, headers: Record<string, string>): void => {
          const ct: string = (headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase();
          if (ct.indexOf('text/event-stream') >= 0 && !st.closed) {
            streaming = true;
            this.rawSend(client, buildChunkedHead(status, headers));
          } else {
            bufferedStatus = status;
            bufferedHeaders = headers;
          }
        },
        (bytes: Uint8Array): void => {
          if (st.closed) {
            return;
          }
          if (streaming) {
            this.rawSend(client, httpChunk(bytes));
          } else {
            chunks.push(bytes);
          }
        });
      if (st.closed) {
        return;
      }
      if (streaming) {
        this.rawSend(client, textEnc.encodeInto('0\r\n\r\n')); // chunked 结束
        hilog.info(0x0000, TAG, 'HTTP(SSE-fin) %{public}s %{public}s', req.method, req.path);
        return;
      }
      let body: Uint8Array = new Uint8Array(0);
      chunks.forEach((c: Uint8Array) => {
        body = concat2(body, c);
      });
      this.rawSend(client, buildHttpResponse(bufferedStatus, bufferedHeaders, body));
      hilog.info(0x0000, TAG, 'HTTP %{public}s %{public}s → %{public}d (%{public}d B)',
        req.method, req.path, bufferedStatus, body.length);
    } catch (e) {
      hilog.warn(0x0000, TAG, '转发失败 %{public}s %{public}s: %{public}s', req.method, req.path, (e as Error).message);
      if (!st.closed) {
        // 🔴 自愈错误页（2026-10-24 事故：断窗期 502 被 WebView 缓存，中继恢复后页面永远僵死，用户只能杀 App）
        //    meta refresh 3s：中继恢复后页面自动重载，无需用户干预
        const html: string = '<meta http-equiv="refresh" content="3">'
          + '<p style="font-family:system-ui;padding:24px;color:#444">⚠️ 连接中断（'
          + (e as Error).message + '）… 3 秒后自动重试</p>';
        const body: Uint8Array = utf8(html);
        this.rawSend(client, buildHttpResponse(502, { 'Content-Type': 'text/html; charset=utf-8' }, body));
      }
    }
  }

  private async upgradeWs(client: socket.TCPSocketConnection, st: ConnState, req: HttpReqInfo): Promise<void> {
    if (!req.wsKey) {
      this.rawSend(client, buildHttpResponse(400, { 'Content-Type': 'text/plain' }, utf8('missing ws key')));
      return;
    }
    try {
      const accept: string = await wsAcceptKey(req.wsKey);
      // 回显客户端请求的 subprotocol（若请求带 Sec-WebSocket-Protocol 而服务端不回选，
      // 浏览器规范要求直接掐断连接——GUI 客户端可能带协议头）
      const proto: string = req.headers['sec-websocket-protocol'] ?? '';
      let respText: string =
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n`;
      if (proto) {
        respText += `Sec-WebSocket-Protocol: ${proto.split(',')[0].trim()}\r\n`;
      }
      respText += '\r\n';
      // 打开隧道侧 mux（按原始 path 透传：dsh GUI=/api/remote.mux，第三方 target 的 WS=/t/<name>/...），
      // 文本帧双向透传
      const mux = await this.relay.openMux((text: string): void => {
        if (!st.closed) {
          this.rawSend(client, wsEncodeFrame(1, utf8(text)));
        }
      }, (reason: string): void => {
        hilog.info(0x0000, TAG, 'mux 下行断开: %{public}s', reason);
        if (!st.closed) {
          this.rawSend(client, wsEncodeFrame(8, utf8('relay closed')));
          try { client.close(); } catch (e) { /* 忽略 */ }
        }
      }, req.path);
      st.mux = mux;
      st.wsMode = true;
      this.rawSend(client, utf8(respText));
      hilog.info(0x0000, TAG, 'WS 升级完成 %{public}s → mux', req.path);
      // 升级前 buf 里可能已带 WS 帧（浏览器紧跟发帧）
      this.handleWsBytes(client, st);
    } catch (e) {
      hilog.error(0x0000, TAG, 'WS 升级失败: %{public}s', (e as Error).message);
      if (!st.closed) {
        this.rawSend(client, buildHttpResponse(502, { 'Content-Type': 'text/plain' }, utf8('ws upgrade failed')));
      }
    }
  }

  private handleWsBytes(client: socket.TCPSocketConnection, st: ConnState): void {
    const frames: Array<WsFrameInfo> = st.wsParser.feed(st.buf);
    st.buf = new Uint8Array(0);
    frames.forEach((f: WsFrameInfo) => {
      if (st.mux === null) {
        return;
      }
      if (f.op === 1 || f.op === 2) {
        st.mux.send(fromUtf8(f.payload));
      } else if (f.op === 8) {
        st.mux.close();
        st.mux = null;
        try { client.close(); } catch (e) { /* 忽略 */ }
      } else if (f.op === 9) {
        this.rawSend(client, wsEncodeFrame(10, f.payload));
      }
    });
  }
}
