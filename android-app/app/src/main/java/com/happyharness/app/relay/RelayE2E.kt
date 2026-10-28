/**
 * E2E 加密 —— 《中继链路协议 v2.0》§5 的 Kotlin 实现。
 * 对齐 ArkTS chat/RelayE2E.ets 与 PC 侧 companion-v2/src/e2e.mjs，参数逐字一致，禁改：
 *   身份：Ed25519 长期密钥（公钥 = SPKI DER 的 base64url）
 *   会话：每次 attach 临时 X25519，offer/accept/confirm 三步握手（互验签名）
 *   派生：HKDF-SHA256（salt = b64uDecode(attachId)；info = 'hh-v2 pc->phone' / 'hh-v2 phone->pc'）
 *   加密：AES-256-GCM，nonce = 4B LE 发送计数器 + 8B 随机盐，tag 16B 拼在 ct 尾部
 *   AAD  = "attachId|streamId|type"
 *
 * 密码学实现选型：minSdk 26，平台 JCA 的 X25519/Ed25519 要 API 33+ 才有，
 * 所以统一走 BouncyCastle（Lightweight provider），高版本机型同样用 BC 保证行为一致。
 */
package com.happyharness.app.relay

import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.Security
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object E2ECrypto {
    /** 显式触发 provider 注册（Android 静态 init 时机不可控，统一在入口调用） */
    fun ensureProvider() {}

    init {
        // BC 置顶：让 "X25519"/"Ed25519" 在 API 26 上也能解析（显式走 provider 保持全机型一致）
        if (Security.getProvider("BC") !is BouncyCastleProvider) {
            Security.removeProvider("BC")
            Security.insertProviderAt(BouncyCastleProvider(), 1)
        }
    }

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { SecureRandom().nextBytes(it) }

    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256", "BC")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /** HKDF-SHA256 extract+expand，单块 32B 输出（协议只用 32B，勿改） */
    fun hkdf256(ikm: ByteArray, salt: ByteArray, info: ByteArray): ByteArray {
        val prk = hmacSha256(salt, ikm)
        return hmacSha256(prk, B64u.concat(listOf(info, byteArrayOf(1))))
    }
}

/** transcript = len-prefix(u32be)(attachId ‖ selfEph ‖ peerEph)，防拼接歧义（与 e2e.mjs 一致） */
fun transcript(attachId: String, selfEphB64: String, peerEphB64: String): ByteArray {
    val a = B64u.decode(attachId)
    val s = B64u.decode(selfEphB64)
    val p = B64u.decode(peerEphB64)
    return B64u.concat(
        listOf(
            B64u.u32be(a.size), a,
            B64u.u32be(s.size), s,
            B64u.u32be(p.size), p
        )
    )
}

/** Ed25519 身份密钥对：公钥 = SPKI DER b64url（注册/配对格式），私钥 = PKCS8 DER b64url（持久化） */
class IdentityKey {
    var privateKey: PrivateKey? = null
    var publicKey: PublicKey? = null
    var publicKeyB64: String = ""
    var privatePkB64: String = ""

    companion object {
        /**
         * 从持久化恢复（公私钥都存都传，对齐 ArkTS：部分机型只给私钥不回填公钥，
         * 我们在持久化时就把 {pub,pk} JSON 一起写，公钥必传；缺失视为恢复失败由上层重新生成）。
         */
        fun loadFromPk(privatePkB64: String, publicKeyB64: String): IdentityKey {
            if (publicKeyB64.isEmpty()) throw IllegalArgumentException("identity 恢复缺少公钥")
            E2ECrypto.ensureProvider()
            val kf = KeyFactory.getInstance("Ed25519", "BC")
            val key = IdentityKey()
            key.privateKey = kf.generatePrivate(PKCS8EncodedKeySpec(B64u.decode(privatePkB64)))
            key.publicKey = kf.generatePublic(X509EncodedKeySpec(B64u.decode(publicKeyB64)))
            key.publicKeyB64 = publicKeyB64
            key.privatePkB64 = privatePkB64
            return key
        }
    }

    fun generate() {
        E2ECrypto.ensureProvider()
        val gen = KeyPairGenerator.getInstance("Ed25519", "BC")
        val pair = gen.generateKeyPair()
        privateKey = pair.private
        publicKey = pair.public
        publicKeyB64 = B64u.encode(pair.public.encoded)     // SPKI DER
        privatePkB64 = B64u.encode(pair.private.encoded)    // PKCS8 DER
    }

    fun sign(data: ByteArray): String {
        val pri = privateKey ?: throw IllegalStateException("E2E: identity key not ready")
        val signer = Signature.getInstance("Ed25519", "BC")
        signer.initSign(pri)
        signer.update(data)
        return B64u.encode(signer.sign())
    }

    /** 首次生成后的闭环自检：签名→验签 + 一次 E2EBox 加解密往返 */
    fun selfTest() {
        val data = B64u.utf8("hh-selftest")
        val sig = sign(data)
        val kf = KeyFactory.getInstance("Ed25519", "BC")
        val pub = kf.generatePublic(X509EncodedKeySpec(B64u.decode(publicKeyB64)))
        val verifier = Signature.getInstance("Ed25519", "BC")
        verifier.initVerify(pub)
        verifier.update(data)
        if (!verifier.verify(B64u.decode(sig))) {
            throw IllegalStateException("E2E selfTest: 签名验签失败")
        }
        val ephA = EphemeralKey().also { it.generate() }
        val ephB = EphemeralKey().also { it.generate() }
        val fakeAttach = B64u.encode(ByteArray(16))
        val boxA = E2EBox.createForTest(ephA, ephB.publicKeyB64, fakeAttach)
        val boxB = E2EBox.createForTest(ephB, ephA.publicKeyB64, fakeAttach, swap = true)
        val sealed = boxA.seal("t", "open", "ping")
        val plain = boxB.open("t", "open", sealed)
        if (plain != "ping") throw IllegalStateException("E2E selfTest: AES-GCM 往返失败")
    }
}

/** 验证对方（PC）Ed25519 签名。selfEph = 验证方自己的临时公钥（transcript 第 3 段）。 */
fun verifyE2E(
    pcPublicKeyB64: String,
    signatureB64: String,
    attachId: String,
    selfEphB64: String,
    peerEphB64: String
): Boolean {
    return try {
        E2ECrypto.ensureProvider()
        val kf = KeyFactory.getInstance("Ed25519", "BC")
        val pub = kf.generatePublic(X509EncodedKeySpec(B64u.decode(pcPublicKeyB64)))
        val verifier = Signature.getInstance("Ed25519", "BC")
        verifier.initVerify(pub)
        verifier.update(transcript(attachId, selfEphB64, peerEphB64))
        verifier.verify(B64u.decode(signatureB64))
    } catch (e: Exception) {
        false
    }
}

/** X25519 临时密钥（每次 attach 生成，不入持久化） */
class EphemeralKey {
    var privateKey: PrivateKey? = null
    var publicKey: PublicKey? = null
    var publicKeyB64: String = ""

    fun generate() {
        E2ECrypto.ensureProvider()
        val gen = KeyPairGenerator.getInstance("X25519", "BC")
        val pair = gen.generateKeyPair()
        privateKey = pair.private
        publicKey = pair.public
        publicKeyB64 = B64u.encode(pair.public.encoded) // SPKI DER
    }

    /** X25519 共享秘密（ECDH） */
    fun sharedSecret(peerEphB64: String): ByteArray {
        val pri = privateKey ?: throw IllegalStateException("E2E: ephemeral not ready")
        val kf = KeyFactory.getInstance("X25519", "BC")
        val peer = kf.generatePublic(X509EncodedKeySpec(B64u.decode(peerEphB64)))
        val agree = KeyAgreement.getInstance("X25519", "BC")
        agree.init(pri)
        agree.doPhase(peer, true)
        return agree.generateSecret()
    }
}

class SealedPayload(val nonce: String, val ct: String)

/** 会话加密盒：手机侧固定角色 —— 发送用 phone->pc 密钥，接收用 pc->phone 密钥 */
class E2EBox private constructor(
    private val sendKey: ByteArray,
    private val recvKey: ByteArray,
    private val attachId: String
) {
    private var sendCount = 0

    companion object {
        private const val HKDF_INFO_PC2PHONE = "hh-v2 pc->phone"
        private const val HKDF_INFO_PHONE2PC = "hh-v2 phone->pc"

        fun create(eph: EphemeralKey, peerEphB64: String, attachId: String): E2EBox {
            val ikm = eph.sharedSecret(peerEphB64)
            val salt = B64u.decode(attachId)
            val pcToPhone = E2ECrypto.hkdf256(ikm, salt, B64u.utf8(HKDF_INFO_PC2PHONE))
            val phoneToPc = E2ECrypto.hkdf256(ikm, salt, B64u.utf8(HKDF_INFO_PHONE2PC))
            return E2EBox(sendKey = phoneToPc, recvKey = pcToPhone, attachId = attachId)
        }

        /** 自检用：info 换成 a->b / b->a */
        fun createForTest(eph: EphemeralKey, peerEphB64: String, attachId: String, swap: Boolean = false): E2EBox {
            val ikm = eph.sharedSecret(peerEphB64)
            val salt = B64u.decode(attachId)
            val ab = E2ECrypto.hkdf256(ikm, salt, B64u.utf8("hh-v2 a->b"))
            val ba = E2ECrypto.hkdf256(ikm, salt, B64u.utf8("hh-v2 b->a"))
            return if (swap) E2EBox(ba, ab, attachId) else E2EBox(ab, ba, attachId)
        }
    }

    private fun aad(streamId: String, type: String): ByteArray =
        B64u.utf8("$attachId|$streamId|$type")

    /** 加密一帧明文；返回 ct = 密文 ‖ 16B GCM tag（协议定义，与 PC 侧一致） */
    fun seal(streamId: String, type: String, plaintext: String): SealedPayload {
        sendCount += 1
        val nonce = B64u.concat(listOf(B64u.u32le(sendCount), E2ECrypto.randomBytes(8)))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding", "BC")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(sendKey, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad(streamId, type))
        val out = cipher.doFinal(B64u.utf8(plaintext)) // javax 输出 = ct ‖ tag(16)
        return SealedPayload(B64u.encode(nonce), B64u.encode(out))
    }

    /** 解密一帧；sealed 来自 {nonce, ct}，ct 尾部 16B 为 GCM tag */
    fun open(streamId: String, type: String, sealed: SealedPayload): String {
        val raw = B64u.decode(sealed.ct)
        if (raw.size < 16) throw IllegalArgumentException("E2E: ct too short")
        // 🔴 JCA/BC 的 AES/GCM 解密要求输入 = 密文‖tag 整段（doFinal 自行剥 tag 校验）。
        //   旧实现手动剥掉尾部 16B 再传入，BC 视为输入短于 tag 长度 → "data too short"（2026-10-27 真机定罪）。
        val cipher = Cipher.getInstance("AES/GCM/NoPadding", "BC")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(recvKey, "AES"),
            GCMParameterSpec(128, B64u.decode(sealed.nonce))
        )
        cipher.updateAAD(aad(streamId, type))
        val plain = cipher.doFinal(raw)
        return B64u.fromUtf8(plain)
    }
}
