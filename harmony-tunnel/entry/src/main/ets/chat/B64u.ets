/**
 * base64url 与字节工具（协议 v2.0 全部密钥/签名/密文均用 base64url）。
 * ArkTS 的 util.Base64 只产标准 base64，这里做 URL-safe 转换。
 */
import { util } from '@kit.ArkTS';

export function utf8(s: string): Uint8Array {
  const enc = new util.TextEncoder('utf-8');
  return enc.encodeInto(s);
}

export function fromUtf8(b: Uint8Array): string {
  const dec = util.TextDecoder.create('utf-8');
  return dec.decodeToString(b);
}

function toB64uChars(std: string): string {
  return std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromB64uChars(b64u: string): string {
  let s = b64u.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (s.length % 4)) % 4;
  for (let i = 0; i < pad; i++) {
    s += '=';
  }
  return s;
}

/** 标准 base64 → base64url */
export function b64ToB64u(std: string): string {
  return toB64uChars(std);
}

export function b64uEncode(bytes: Uint8Array): string {
  const helper = new util.Base64Helper();
  return toB64uChars(helper.encodeToStringSync(bytes));
}

export function b64uDecode(s: string): Uint8Array {
  const helper = new util.Base64Helper();
  return helper.decodeSync(fromB64uChars(s));
}

export function concatBytes(parts: Array<Uint8Array>): Uint8Array {
  let total = 0;
  parts.forEach((p: Uint8Array) => {
    total += p.length;
  });
  const out = new Uint8Array(total);
  let off = 0;
  parts.forEach((p: Uint8Array) => {
    out.set(p, off);
    off += p.length;
  });
  return out;
}

/** 4 字节大端长度前缀（E2E transcript 用：len-prefix(attachId‖己方eph‖对方eph)） */
export function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (n >>> 24) & 0xFF;
  out[1] = (n >>> 16) & 0xFF;
  out[2] = (n >>> 8) & 0xFF;
  out[3] = n & 0xFF;
  return out;
}

/** 4 字节小端（AES-GCM nonce 计数器） */
export function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = n & 0xFF;
  out[1] = (n >>> 8) & 0xFF;
  out[2] = (n >>> 16) & 0xFF;
  out[3] = (n >>> 24) & 0xFF;
  return out;
}
