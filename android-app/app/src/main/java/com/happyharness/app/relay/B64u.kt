/**
 * base64url / 字节工具 —— 对齐 ArkTS chat/B64u.ets。
 * 协议所有 b64 字段都是 base64url（无 padding）。
 */
package com.happyharness.app.relay

import android.util.Base64
import java.nio.charset.StandardCharsets

object B64u {
    /** base64url 无 padding 编码（Android Base64.URL_SAFE + NO_WRAP + NO_PADDING） */
    fun encode(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    /** base64url 解码；兼容带 padding / 标准字母表输入 */
    fun decode(s: String): ByteArray {
        val cleaned = s.trim().replace('-', '+').replace('_', '/')
        val padded = cleaned + "=".repeat((4 - cleaned.length % 4) % 4)
        return Base64.decode(padded, Base64.DEFAULT)
    }

    fun utf8(s: String): ByteArray = s.toByteArray(StandardCharsets.UTF_8)

    fun fromUtf8(b: ByteArray): String = String(b, StandardCharsets.UTF_8)

    fun concat(parts: List<ByteArray>): ByteArray {
        val total = parts.sumOf { it.size }
        val out = ByteArray(total)
        var off = 0
        for (p in parts) {
            System.arraycopy(p, 0, out, off, p.size)
            off += p.size
        }
        return out
    }

    /** 大端 u32 */
    fun u32be(v: Int): ByteArray = byteArrayOf(
        ((v ushr 24) and 0xFF).toByte(),
        ((v ushr 16) and 0xFF).toByte(),
        ((v ushr 8) and 0xFF).toByte(),
        (v and 0xFF).toByte()
    )

    /** 小端 u32 */
    fun u32le(v: Int): ByteArray = byteArrayOf(
        (v and 0xFF).toByte(),
        ((v ushr 8) and 0xFF).toByte(),
        ((v ushr 16) and 0xFF).toByte(),
        ((v ushr 24) and 0xFF).toByte()
    )
}
