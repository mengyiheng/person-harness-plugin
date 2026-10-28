/**
 * v2 配对：二维码解析 + register/redeem（协议 §2，协调服务器 REST）。
 * 二维码格式（PC 托盘"配对窗口"生成）：
 *   myapp://pair?ver=2&server=<host[:port]>&device=<PC设备ID>&code=<一次性配对码>
 */
import { http } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { PairCodeV2, RedeemResult, RegisterReq, RegisterResp, RedeemReq, PairSummary } from './Types';

interface HttpResp {
  status: number;
  body: string;
}

interface PairsResp {
  items?: Array<PairSummary>;
}

const TAG = 'HHPair2';

/** TLS 判定（v2.1）：9443/443 端口、或无端口的域名 → https/wss；其余（IP:9400 等）→ http/ws */
export function isTlsServer(server: string): boolean {
  if (server.endsWith(':443') || server.endsWith(':9443')) {
    return true;
  }
  if (server.indexOf(':') < 0 && server.indexOf('.') > 0 && !/^\d+\.\d+\.\d+\.\d+$/.test(server)) {
    return true;
  }
  return false;
}

export function httpUrlOf(server: string): string {
  return (isTlsServer(server) ? 'https://' : 'http://') + server;
}

export function wsUrlOf(server: string, path: string): string {
  return (isTlsServer(server) ? 'wss://' : 'ws://') + server + path;
}

export function parsePairCodeV2(raw: string): PairCodeV2 | null {
  if (raw.indexOf('myapp://pair') !== 0) {
    return null;
  }
  const q: string = raw.substring('myapp://pair'.length).replace(/^\?/, '');
  const params: Record<string, string> = {};
  q.split('&').forEach((kv: string) => {
    const idx: number = kv.indexOf('=');
    if (idx > 0) {
      params[decodeURIComponent(kv.substring(0, idx))] = decodeURIComponent(kv.substring(idx + 1));
    }
  });
  if (Number(params['ver'] ?? '0') !== 2) {
    return null;
  }
  const server: string = (params['server'] ?? '').trim();
  const code: string = (params['code'] ?? '').trim();
  const device: string = (params['device'] ?? '').trim();
  if (!server || !code) {
    return null;
  }
  const p: PairCodeV2 = { server: server, device: device, code: code };
  return p;
}

async function restPost(server: string, path: string, bodyJson: string,
  token: string): Promise<HttpResp> {
  const url: string = `${httpUrlOf(server)}${path}`;
  const req = http.createHttp();
  try {
    const header: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      header['Authorization'] = `Bearer ${token}`;
    }
    const resp = await req.request(url, {
      method: http.RequestMethod.POST,
      header: header,
      extraData: bodyJson,
      expectDataType: http.HttpDataType.STRING,
      usingCache: false,
      connectTimeout: 20000,
      readTimeout: 30000,
    });
    return { status: resp.responseCode, body: resp.result as string };
  } catch (e) {
    // 🔴 NetworkKit 的 BusinessError 只有 code+message（"Internal error" 无从排查）——全量带出
    let detail: string = '';
    try {
      detail = JSON.stringify(e);
    } catch (e2) {
      detail = '';
    }
    if (!detail || detail === '{}') {
      detail = String(e);
    }
    throw new Error(`HTTP POST ${path} 失败: ${detail}`);
  } finally {
    req.destroy();
  }
}

/** 注册本机身份（ed25519 公钥 spki der base64url），返回 deviceId/deviceToken（token 只下发一次） */
export async function registerDevice(server: string, name: string,
  publicKeyB64: string): Promise<RegisterResp> {
  const body: RegisterReq = { name: name, publicKey: publicKeyB64 };
  const resp = await restPost(server, '/api/v1/register', JSON.stringify(body), '');
  if (resp.status !== 200) {
    throw new Error(`注册失败 HTTP ${resp.status}`);
  }
  const parsed = JSON.parse(resp.body) as RegisterResp;
  if (!parsed.deviceId || !parsed.deviceToken) {
    throw new Error('注册响应缺少 deviceId/deviceToken');
  }
  return parsed;
}

/** 用手机凭证查自己的配对列表（取云端最新的 PC 显示名，设备页刷新用） */
export async function fetchPairs(server: string, credential: string): Promise<Array<PairSummary>> {
  const resp = await restPost(server, '/api/v1/pairs', '', credential);
  if (resp.status !== 200) {
    throw new Error(`pairs 查询失败 HTTP ${resp.status}`);
  }
  const parsed = JSON.parse(resp.body) as PairsResp;
  return parsed.items ?? new Array<PairSummary>();
}

/** 兑换配对码，拿 deviceCredential（pcr_ 前缀）与 PC 公钥（E2E 验签用） */
export async function redeemCode(server: string, code: string, deviceId: string,
  publicKeyB64: string): Promise<RedeemResult> {
  const body: RedeemReq = { code: code, deviceId: deviceId, publicKey: publicKeyB64 };
  const resp = await restPost(server, '/api/v1/redeem', JSON.stringify(body), '');
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('配对码无效或已过期，请在 PC 端重新生成');
  }
  if (resp.status !== 200) {
    throw new Error(`兑换失败 HTTP ${resp.status}`);
  }
  const parsed = JSON.parse(resp.body) as RedeemResult;
  if (!parsed.deviceCredential || !parsed.pair || !parsed.pair.pc || !parsed.pair.pc.publicKey) {
    throw new Error('兑换响应缺少凭证或 PC 公钥');
  }
  hilog.info(0x0000, TAG, 'redeem ok pairId=%{public}s pc=%{public}s',
    parsed.pair.pairId ?? '', parsed.pair.pc.name ?? '');
  return parsed;
}
