/**
 * E2E 加密 —— 《中继链路协议 v2.0》§5 的 ArkTS 实现
 *   身份：Ed25519 长期密钥（注册公钥，PC 侧配对时已交换）
 *   会话：每次 attach 临时 X25519，offer/accept/confirm 三步握手（互验签名）
 *   派生：HKDF-SHA256（salt=attachId 原始字节；info='hh-v2 pc->phone'/'hh-v2 phone->pc'）
 *   加密：AES-256-GCM，nonce = 4B LE 计数器 + 8B 随机盐，AAD = "attachId|streamId|type"
 * 与 PC 侧 companion-v2/src/e2e.mjs 参数逐字对齐，禁改。
 */
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { b64uEncode, b64uDecode, utf8, fromUtf8, concatBytes, u32be, u32le } from './B64u';
import { hmacSha256, sha256 } from './Sha256';

const TAG = 'HHE2E';
const HKDF_INFO_PC2PHONE: string = 'hh-v2 pc->phone';
const HKDF_INFO_PHONE2PC: string = 'hh-v2 phone->pc';

function blob(b: Uint8Array): cryptoFramework.DataBlob {
  const d: cryptoFramework.DataBlob = { data: b };
  return d;
}

/** Ed25519 身份密钥对：公钥 = SPKI DER 的 base64url（注册/配对格式），私钥 = PKCS8 DER base64url（持久化） */
export class IdentityKey {
  private priKey?: cryptoFramework.PriKey;
  pubKey?: cryptoFramework.PubKey;
  publicKeyB64: string = '';
  privatePkB64: string = '';

  async generate(): Promise<void> {
    let gen: cryptoFramework.AsyKeyGenerator;
    try {
      gen = cryptoFramework.createAsyKeyGenerator('Ed25519');
    } catch (e) {
      hilog.error(0x0000, TAG, 'createAsyKeyGenerator(Ed25519) 失败: %{public}s', String(e));
      throw new Error('create AsyKeyGenerator Ed25519 fail');
    }
    let pair: cryptoFramework.KeyPair;
    try {
      pair = await gen.generateKeyPair();
    } catch (e) {
      hilog.error(0x0000, TAG, 'Ed25519 generateKeyPair 失败: %{public}s', String(e));
      throw new Error('generateKeyPair Ed25519 fail');
    }
    this.priKey = pair.priKey;
    this.pubKey = pair.pubKey;
    this.publicKeyB64 = b64uEncode((await pair.pubKey.getEncoded()).data);
    this.privatePkB64 = b64uEncode((await pair.priKey.getEncoded()).data);
  }

  /** 从持久化恢复。部分机型 convertKey(私钥) 不回填 pubKey，所以公钥一并传入 */
  async loadFromPk(privatePkB64: string, publicKeyB64: string): Promise<void> {
    const gen = cryptoFramework.createAsyKeyGenerator('Ed25519');
    const pubBytes = publicKeyB64 ? b64uDecode(publicKeyB64) : null;
    const pair = await gen.convertKey(pubBytes ? blob(pubBytes) : null, blob(b64uDecode(privatePkB64)));
    this.priKey = pair.priKey;
    this.pubKey = pair.pubKey ?? null;
    this.publicKeyB64 = publicKeyB64 || b64uEncode((await pair.pubKey.getEncoded()).data);
    this.privatePkB64 = privatePkB64;
  }

  async sign(data: Uint8Array): Promise<string> {
    if (!this.priKey) {
      throw new Error('E2E: identity key not ready');
    }
    const signer = cryptoFramework.createSign('Ed25519');
    await signer.init(this.priKey);
    const sig: cryptoFramework.DataBlob = await signer.sign(blob(data));
    return b64uEncode(sig.data);
  }

  /** 首次生成后的闭环自检：SHA-256 已知向量 + 签名→验签 + 一次 E2EBox 加解密往返 */
  async selfTest(): Promise<void> {
    // SHA-256("abc") 已知向量（FIPS 180-4）
    const sha = sha256(utf8('abc'));
    let hex = '';
    sha.forEach((b: number) => {
      hex += (b < 16 ? '0' : '') + b.toString(16);
    });
    if (hex !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') {
      throw new Error('E2E selfTest: SHA-256 已知向量失败');
    }
    const data = utf8('hh-selftest');
    const sig = await this.sign(data);
    const gen = cryptoFramework.createAsyKeyGenerator('Ed25519');
    const pair = await gen.convertKey(blob(b64uDecode(this.publicKeyB64)), null);
    const verifier = cryptoFramework.createVerify('Ed25519');
    await verifier.init(pair.pubKey);
    const ok = await verifier.verify(blob(data), blob(b64uDecode(sig)));
    if (!ok) {
      throw new Error('E2E selfTest: 签名验签失败');
    }
    const ephA = new EphemeralKey();
    const ephB = new EphemeralKey();
    await ephA.generate();
    await ephB.generate();
    const fakeAttach = b64uEncode(new Uint8Array(16));
    const boxA = await E2EBox.createForTest(ephA, ephB.publicKeyB64, fakeAttach);
    const boxB = await E2EBox.createForTest(ephB, ephA.publicKeyB64, fakeAttach, true);
    const sealed = await boxA.seal('t', 'open', 'ping');
    const plain = await boxB.open('t', 'open', sealed);
    if (plain !== 'ping') {
      throw new Error('E2E selfTest: AES-GCM 往返失败');
    }
    hilog.info(0x0000, TAG, 'selfTest 通过（Ed25519 + X25519 + HKDF + AES-GCM 闭环）');
  }
}

/** len-prefix(attachId ‖ selfEph ‖ peerEph)，防拼接歧义（与 e2e.mjs transcript 一致） */
export function transcript(attachId: string, selfEphB64: string, peerEphB64: string): Uint8Array {
  const a = b64uDecode(attachId);
  const s = b64uDecode(selfEphB64);
  const p = b64uDecode(peerEphB64);
  return concatBytes([u32be(a.length), a, u32be(s.length), s, u32be(p.length), p]);
}

/** 验证对方（PC）Ed25519 签名。selfEph=验证方自己的临时公钥（transcript 第 3 段） */
export async function verifyE2E(pcPublicKeyB64: string, signatureB64: string,
  attachId: string, selfEphB64: string, peerEphB64: string): Promise<boolean> {
  try {
    const gen = cryptoFramework.createAsyKeyGenerator('Ed25519');
    const pair = await gen.convertKey(blob(b64uDecode(pcPublicKeyB64)), null);
    const verifier = cryptoFramework.createVerify('Ed25519');
    await verifier.init(pair.pubKey);
    return await verifier.verify(blob(transcript(attachId, selfEphB64, peerEphB64)),
      blob(b64uDecode(signatureB64)));
  } catch (e) {
    return false;
  }
}

/** X25519 临时密钥（每次 attach 生成，不入持久化） */
export class EphemeralKey {
  private priKey?: cryptoFramework.PriKey;
  publicKeyB64: string = '';

  async generate(): Promise<void> {
    let gen: cryptoFramework.AsyKeyGenerator;
    try {
      gen = cryptoFramework.createAsyKeyGenerator('X25519');
    } catch (e) {
      hilog.error(0x0000, TAG, 'createAsyKeyGenerator(X25519) 失败: %{public}s', String(e));
      throw new Error('create AsyKeyGenerator X25519 fail');
    }
    const pair = await gen.generateKeyPair();
    this.priKey = pair.priKey;
    this.publicKeyB64 = b64uEncode((await pair.pubKey.getEncoded()).data);
  }

  /** X25519 共享秘密（ECDH） */
  async sharedSecret(peerEphB64: string): Promise<Uint8Array> {
    if (!this.priKey) {
      throw new Error('E2E: ephemeral not ready');
    }
    const gen = cryptoFramework.createAsyKeyGenerator('X25519');
    const peer = await gen.convertKey(blob(b64uDecode(peerEphB64)), null);
    const agree = cryptoFramework.createKeyAgreement('X25519');
    const secret = await agree.generateSecret(this.priKey, peer.pubKey);
    return secret.data;
  }
}

// ---------------- HKDF-SHA256（extract + expand，单块 32B 输出） ----------------
// HMAC 用纯 TS 实现：部分机型 createSymKeyGenerator('HMAC256') 不可用（实测 Mate 80）

async function hmac(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(keyBytes, data);
}

async function hkdf256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return hmac(prk, concatBytes([info, new Uint8Array([1])]));
}

// ---------------- 会话加密盒 ----------------

export interface SealedPayload {
  nonce: string;
  ct: string;
}

class EncryptResult {
  out: Uint8Array;
  place: Uint8Array;
  tagAppendLen: number;

  constructor(out: Uint8Array, place: Uint8Array, tagAppendLen: number) {
    this.out = out;
    this.place = place;
    this.tagAppendLen = tagAppendLen;
  }
}

export class E2EBox {
  private sendKey: Uint8Array;
  private recvKey: Uint8Array;
  private attachId: string;
  private sendCount: number = 0;

  private constructor(sendKey: Uint8Array, recvKey: Uint8Array, attachId: string) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.attachId = attachId;
  }

  /** 手机侧固定角色：发送用 phone->pc 密钥，接收用 pc->phone 密钥 */
  static async create(eph: EphemeralKey, peerEphB64: string, attachId: string): Promise<E2EBox> {
    const ikm = await eph.sharedSecret(peerEphB64);
    const salt = b64uDecode(attachId);
    const pcToPhone = await hkdf256(ikm, salt, utf8(HKDF_INFO_PC2PHONE));
    const phoneToPc = await hkdf256(ikm, salt, utf8(HKDF_INFO_PHONE2PC));
    return new E2EBox(phoneToPc, pcToPhone, attachId);
  }

  /** 自检用：双方各自派生。swap=true 的一侧（接收方）send/recv 对调 */
  static async createForTest(eph: EphemeralKey, peerEphB64: string, attachId: string,
    swap: boolean = false): Promise<E2EBox> {
    const ikm = await eph.sharedSecret(peerEphB64);
    const salt = b64uDecode(attachId);
    const ab = await hkdf256(ikm, salt, utf8('hh-v2 a->b'));
    const ba = await hkdf256(ikm, salt, utf8('hh-v2 b->a'));
    return swap ? new E2EBox(ba, ab, attachId) : new E2EBox(ab, ba, attachId);
  }

  private aad(streamId: string, type: string): Uint8Array {
    return utf8(`${this.attachId}|${streamId}|${type}`);
  }

  private async randomBytes(n: number): Promise<Uint8Array> {
    const rand = cryptoFramework.createRandom();
    const d: cryptoFramework.DataBlob = await rand.generateRandom(n);
    return d.data;
  }

  private async cipherKey(raw: Uint8Array): Promise<cryptoFramework.Key> {
    const gen = cryptoFramework.createSymKeyGenerator('AES256');
    return await gen.convertKey(blob(raw));
  }

  private static cipherAlgo: string = '';
  private static tagPlaceLen: number = 0; // 加密方向 authTag 占位长度（机型差异：12/16）
  private static recvTagLen: number = 0;  // 解密方向 tag 长度自适应缓存

  /** 鸿蒙 GCM 的 padding 参数机型有差异：优先 PKCS7（官方示例写法），回退 NO_PADDING */
  private static createGcmCipher(): cryptoFramework.Cipher {
    if (E2EBox.cipherAlgo !== '') {
      return cryptoFramework.createCipher(E2EBox.cipherAlgo);
    }
    const candidates: Array<string> = ['AES256|GCM|PKCS7', 'AES256|GCM|NO_PADDING'];
    for (let i = 0; i < candidates.length; i++) {
      try {
        const c = cryptoFramework.createCipher(candidates[i]);
        E2EBox.cipherAlgo = candidates[i];
        hilog.info(0x0000, TAG, 'GCM cipher 使用 %{public}s', candidates[i]);
        return c;
      } catch (e) {
        hilog.warn(0x0000, TAG, 'createCipher(%{public}s) 失败: %{public}s', candidates[i], String(e));
      }
    }
    throw new Error('create AES-GCM cipher fail (all variants)');
  }

  /** 加密核心：authTag 占位长度自适应（12/16），确定后缓存。
   *  鸿蒙 GCM 加密输出的 tag 可能在尾部拼接（tagAppendLen>0），
   *  也可能回填进传入的 authTag 占位缓冲（tagAppendLen=0，取 place）。 */
  private async encryptRaw(key: cryptoFramework.Key, nonce: Uint8Array, aad: Uint8Array,
    plaintext: Uint8Array): Promise<EncryptResult> {
    const placeLens: Array<number> = E2EBox.tagPlaceLen > 0 ? [E2EBox.tagPlaceLen] : [16, 12];
    let lastErr: string = '';
    for (let i = 0; i < placeLens.length; i++) {
      const place = new Uint8Array(placeLens[i]);
      const cipher = E2EBox.createGcmCipher();
      const gcm: cryptoFramework.GcmParamsSpec = {
        algName: 'GcmParamsSpec',
        iv: blob(nonce),
        aad: blob(aad),
        authTag: blob(place),
      };
      try {
        await cipher.init(cryptoFramework.CryptoMode.ENCRYPT_MODE, key, gcm);
        const out = (await cipher.doFinal(blob(plaintext))).data;
        const probing: boolean = placeLens.length > 1; // 首次探测才记日志（降噪：逐帧打印曾冲爆 hilog 缓冲）
        E2EBox.tagPlaceLen = placeLens[i];
        if (out.length > plaintext.length) {
          const tagAppendLen = out.length - plaintext.length;
          if (probing) {
            hilog.info(0x0000, TAG, 'GCM 加密：tag 拼在尾部 %{public}dB', tagAppendLen);
          }
          return new EncryptResult(out, place, tagAppendLen);
        }
        // 输出只有密文：tag 回填在占位缓冲里
        if (probing) {
          hilog.info(0x0000, TAG, 'GCM 加密：tag 在占位缓冲 %{public}dB', placeLens[i]);
        }
        return new EncryptResult(out, place, 0);
      } catch (e) {
        lastErr = String(e);
        hilog.warn(0x0000, TAG, 'doFinal(加密, tag占位%{public}d) 失败: %{public}s', placeLens[i], lastErr);
      }
    }
    throw new Error('GCM encrypt doFinal failed: ' + lastErr);
  }

  /** 加密一帧明文（JSON 文本）；返回的 ct 尾部拼 16B tag（协议定义，与 PC 侧 e2e.mjs 一致） */
  async seal(streamId: string, type: string, plaintext: string): Promise<SealedPayload> {
    this.sendCount += 1;
    const nonce = concatBytes([u32le(this.sendCount), await this.randomBytes(8)]);
    const key = await this.cipherKey(this.sendKey);
    const plain = utf8(plaintext);
    const er = await this.encryptRaw(key, nonce, this.aad(streamId, type), plain);
    const out = er.out;
    const place = er.place;
    const tagAppendLen = er.tagAppendLen;
    let ctOnly: Uint8Array;
    let tag: Uint8Array;
    if (tagAppendLen > 0) {
      ctOnly = out.slice(0, out.length - tagAppendLen);
      tag = out.slice(out.length - tagAppendLen);
    } else {
      ctOnly = out;
      tag = place;
    }
    if (tag.length !== 16) {
      hilog.error(0x0000, TAG, 'GCM tag 长度 %{public}d ≠ 16，需与 PC 侧对齐！', tag.length);
    }
    return { nonce: b64uEncode(nonce), ct: b64uEncode(concatBytes([ctOnly, tag])) };
  }

  /** 解密一帧；sealed 来自 {nonce, ct}，ct 尾部 16B 为 GCM tag */
  async open(streamId: string, type: string, sealed: SealedPayload): Promise<string> {
    const raw = b64uDecode(sealed.ct);
    if (raw.length < 16) {
      throw new Error('E2E: ct too short');
    }
    const key = await this.cipherKey(this.recvKey);
    const iv = blob(b64uDecode(sealed.nonce));
    const aad = blob(this.aad(streamId, type));
    // tag 长度自适应：优先 16B（协议），失败试 12B
    const tagLens: Array<number> = E2EBox.recvTagLen > 0 ? [E2EBox.recvTagLen] : [16, 12];
    let lastErr: string = '';
    for (let i = 0; i < tagLens.length; i++) {
      const tagLen = tagLens[i];
      const ctOnly = raw.slice(0, raw.length - tagLen);
      const tag = raw.slice(raw.length - tagLen);
      const cipher = E2EBox.createGcmCipher();
      const gcm: cryptoFramework.GcmParamsSpec = {
        algName: 'GcmParamsSpec',
        iv: iv,
        aad: aad,
        authTag: blob(tag),
      };
      try {
        await cipher.init(cryptoFramework.CryptoMode.DECRYPT_MODE, key, gcm);
        const out = (await cipher.doFinal(blob(ctOnly))).data;
        E2EBox.recvTagLen = tagLen;
        return fromUtf8(out);
      } catch (e) {
        lastErr = String(e);
        hilog.warn(0x0000, TAG, 'doFinal(解密, tag%{public}d) 失败: %{public}s', tagLen, lastErr);
      }
    }
    throw new Error('GCM decrypt doFinal failed: ' + lastErr);
  }
}
