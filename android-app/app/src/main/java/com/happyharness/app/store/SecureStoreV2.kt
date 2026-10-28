/**
 * 持久化存储 —— 对齐 ArkTS chat/SecureStore.ets（v2 部分）。
 * 设备元信息/激活标记存 SharedPreferences；身份私钥与 per-device 凭证存密钥级存储。
 *
 * TODO(安全加固)：当前凭证用 SharedPreferences 明文存（个人工具可接受），
 *   上架前替换为 androidx.security:security-crypto 的 EncryptedSharedPreferences，
 *   对齐 HarmonyOS 版 Asset Store 语义（含 Asset 写入失败 3 次重试 + 降级逻辑不再需要）。
 */
package com.happyharness.app.store

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject
import java.util.UUID

class DeviceMetaV2(
    val id: String,
    var name: String,
    val server: String,      // 协调服务器 host[:port]
    var pcDeviceId: String,  // PC 设备 ID
    val deviceId: String,    // 本机在服务器侧的设备 ID
    var seq: String = ""     // 设备编号（如 20261023-0008，设备页显示；旧版服务端可能不下发）
) {
    fun toJson(): String = JSONObject()
        .put("id", id).put("name", name).put("server", server)
        .put("pcDeviceId", pcDeviceId).put("deviceId", deviceId)
        .put("seq", seq)
        .toString()

    companion object {
        fun fromJson(s: String): DeviceMetaV2? = try {
            val o = JSONObject(s)
            DeviceMetaV2(
                o.getString("id"), o.getString("name"),
                o.getString("server"), o.getString("pcDeviceId"), o.getString("deviceId"),
                o.optString("seq")
            )
        } catch (e: Exception) {
            null
        }
    }
}

class SecureStoreV2(ctx: Context) {
    private val prefs: SharedPreferences = ctx.getSharedPreferences("hh_v2", Context.MODE_PRIVATE)
    private val secrets: SharedPreferences = ctx.getSharedPreferences("hh_v2_secrets", Context.MODE_PRIVATE)

    // ---------------- 身份密钥 ----------------

    fun saveV2IdentityPk(pk: String) {
        secrets.edit().putString("v2_identity_pk", pk).apply()
    }

    fun getV2IdentityPk(): String = secrets.getString("v2_identity_pk", "") ?: ""

    // ---------------- 凭证 ----------------

    fun saveV2Credential(id: String, cred: String) {
        secrets.edit().putString("v2_credential.$id", cred).apply()
    }

    fun getV2Credential(id: String): String = secrets.getString("v2_credential.$id", "") ?: ""

    // ---------------- 设备列表 ----------------

    fun saveV2Meta(meta: DeviceMetaV2) {
        val list = listV2Meta().filter { it.id != meta.id } + meta
        prefs.edit().putString("metas", "[" + list.joinToString(",") { it.toJson() } + "]").apply()
    }

    fun listV2Meta(): List<DeviceMetaV2> {
        val raw = prefs.getString("metas", "[]") ?: "[]"
        return try {
            val arr = org.json.JSONArray(raw)
            (0 until arr.length()).mapNotNull { DeviceMetaV2.fromJson(arr.getString(it)) }
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun setV2Active(id: String) {
        prefs.edit().putString("active", id).apply()
    }

    fun getV2Active(): String = prefs.getString("active", "") ?: ""

    fun removeV2(id: String) {
        secrets.edit().remove("v2_credential.$id").apply()
        val list = listV2Meta().filter { it.id != id }
        prefs.edit().putString("metas", "[" + list.joinToString(",") { it.toJson() } + "]").apply()
        if (getV2Active() == id) prefs.edit().putString("active", "").apply()
    }

    companion object {
        fun newDeviceId(): String = "v2_${UUID.randomUUID()}"
    }
}
