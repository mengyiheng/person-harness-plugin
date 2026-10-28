/**
 * v2 传输适配 + 身份加载 —— 对齐 ArkTS chat/V2Transport.ets。
 * 身份密钥全局一把，首用生成并持久化 {pub,pk} JSON；恢复失败重新生成（重扫码换新公钥）。
 */
package com.happyharness.app.relay

import android.util.Log
import com.happyharness.app.store.SecureStoreV2
import org.json.JSONObject

private const val TAG = "HHV2T"

private class IdentityStore(val pub: String, val pk: String) {
    fun toJson(): String = JSONObject().put("pub", pub).put("pk", pk).toString()
}

/** 身份密钥：全局一把，首用生成并自检；恢复失败则重新生成（对齐 ArkTS loadOrCreateIdentity） */
fun loadOrCreateIdentity(store: SecureStoreV2): IdentityKey {
    val key = IdentityKey()
    val raw = store.getV2IdentityPk()
    var pub = ""
    var pk = ""
    if (raw.isNotEmpty()) {
        try {
            val parsed = JSONObject(raw)
            pub = parsed.optString("pub")
            pk = parsed.optString("pk")
        } catch (e: Exception) {
            pk = raw // 兼容旧格式（裸私钥）
        }
    }
    if (pk.isEmpty()) {
        key.generate()
        key.selfTest()
        store.saveV2IdentityPk(IdentityStore(key.publicKeyB64, key.privatePkB64).toJson())
    } else {
        try {
            IdentityKey.loadFromPk(pk, pub).let { loaded ->
                key.privateKey = loaded.privateKey
                key.publicKey = loaded.publicKey
                key.publicKeyB64 = loaded.publicKeyB64
                key.privatePkB64 = loaded.privatePkB64
            }
            key.selfTest()
        } catch (e: Exception) {
            Log.w(TAG, "身份恢复失败，重新生成: $e")
            key.generate()
            key.selfTest()
            store.saveV2IdentityPk(IdentityStore(key.publicKeyB64, key.privatePkB64).toJson())
        }
    }
    return key
}
