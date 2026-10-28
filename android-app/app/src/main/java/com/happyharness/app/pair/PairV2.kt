/**
 * v2 配对：二维码解析 + register/redeem（协议 §2，协调服务器 REST）—— 对齐 ArkTS chat/PairV2.ets。
 * 二维码格式（PC 托盘"配对窗口"生成）：
 *   myapp://pair?ver=2&server=<host[:port]>&device=<PC设备ID>&code=<一次性配对码>
 * 远程登录（网页扫码）：
 *   myapp://remote-login?server=<host[:port]>&pc=<PC设备ID>&id=<linkId>
 */
package com.happyharness.app.pair

import android.util.Log
import com.happyharness.app.relay.B64u
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

private const val TAG = "HHPair2"

class PairCodeV2(val server: String, val device: String, val code: String)

class RegisterResp(val deviceId: String, val deviceToken: String)

class RedeemResult(val deviceCredential: String, val pair: JSONObject)

class PairSummary(val json: JSONObject) {
    val pairId: String get() = json.optString("pairId")
    val pcDeviceId: String get() = json.optJSONObject("pc")?.optString("deviceId") ?: ""
    val pcName: String get() = json.optJSONObject("pc")?.optString("name") ?: ""
    /** 设备编号（如 20261023-0008；旧版服务端可能不下发 → 空串） */
    val pcSeq: String get() = json.optJSONObject("pc")?.optString("seq") ?: ""
}

/** TLS 判定：9443/443 端口、或无端口的域名 → https/wss；其余（IP:9400 等）→ http/ws */
fun isTlsServer(server: String): Boolean {
    if (server.endsWith(":443") || server.endsWith(":9443")) return true
    if (!server.contains(':') && server.contains('.') && !Regex("^\\d+\\.\\d+\\.\\d+\\.\\d+$").matches(server)) {
        return true
    }
    return false
}

fun httpUrlOf(server: String): String = (if (isTlsServer(server)) "https://" else "http://") + server

fun wsUrlOf(server: String, path: String): String = (if (isTlsServer(server)) "wss://" else "ws://") + server + path

/** 解析 myapp://pair?ver=2 码；格式不符返回 null */
fun parsePairCodeV2(raw: String): PairCodeV2? {
    val prefix = "myapp://pair"
    if (!raw.startsWith(prefix)) return null
    val params = parseQuery(raw.substring(prefix.length))
    if (params["ver"]?.toIntOrNull() != 2) return null
    val server = (params["server"] ?: "").trim()
    val code = (params["code"] ?: "").trim()
    val device = (params["device"] ?: "").trim()
    if (server.isEmpty() || code.isEmpty()) return null
    return PairCodeV2(server, device, code)
}

/** 通用 query 解析（myapp:// 各深链共用） */
fun parseQuery(afterScheme: String): Map<String, String> {
    val q = afterScheme.replace(Regex("^\\?"), "")
    val params = HashMap<String, String>()
    q.split("&").forEach { kv ->
        val idx = kv.indexOf('=')
        if (idx > 0) {
            params[
                java.net.URLDecoder.decode(kv.substring(0, idx), "UTF-8")
            ] = java.net.URLDecoder.decode(kv.substring(idx + 1), "UTF-8")
        }
    }
    return params
}

private val client = OkHttpClient.Builder()
    .connectTimeout(20, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .build()

private fun restPost(server: String, path: String, bodyJson: String, token: String): Pair<Int, String> {
    val url = "${httpUrlOf(server)}$path"
    val builder = Request.Builder().url(url)
        .post(bodyJson.toRequestBody("application/json".toMediaType()))
    if (token.isNotEmpty()) {
        builder.header("Authorization", "Bearer $token")
    }
    try {
        client.newCall(builder.build()).execute().use { resp ->
            val body = resp.body?.string() ?: ""
            return Pair(resp.code, body)
        }
    } catch (e: Exception) {
        throw RuntimeException("HTTP POST $path 失败: $e")
    }
}

/** 注册本机身份（ed25519 公钥 spki der base64url），返回 deviceId/deviceToken（token 只下发一次） */
fun registerDevice(server: String, name: String, publicKeyB64: String): RegisterResp {
    val body = JSONObject().put("name", name).put("publicKey", publicKeyB64)
    val (status, bodyText) = restPost(server, "/api/v1/register", body.toString(), "")
    if (status != 200) throw RuntimeException("注册失败 HTTP $status")
    val parsed = JSONObject(bodyText)
    val deviceId = parsed.optString("deviceId")
    val deviceToken = parsed.optString("deviceToken")
    if (deviceId.isEmpty() || deviceToken.isEmpty()) {
        throw RuntimeException("注册响应缺少 deviceId/deviceToken")
    }
    return RegisterResp(deviceId, deviceToken)
}

/** 用手机凭证查自己的配对列表（取云端最新的 PC 显示名，设备页刷新用） */
fun fetchPairs(server: String, credential: String): List<PairSummary> {
    val (status, body) = restPost(server, "/api/v1/pairs", "", credential)
    if (status != 200) throw RuntimeException("pairs 查询失败 HTTP $status")
    val items = JSONObject(body).optJSONArray("items") ?: return emptyList()
    return (0 until items.length()).map { PairSummary(items.getJSONObject(it)) }
}

/** 兑换配对码，拿 deviceCredential（pcr_ 前缀）与 PC 公钥（E2E 验签用） */
fun redeemCode(server: String, code: String, deviceId: String, publicKeyB64: String): RedeemResult {
    val body = JSONObject()
        .put("code", code)
        .put("deviceId", deviceId)
        .put("publicKey", publicKeyB64)
    val (status, bodyText) = restPost(server, "/api/v1/redeem", body.toString(), "")
    if (status == 401 || status == 403) {
        throw RuntimeException("配对码无效或已过期，请在 PC 端重新生成")
    }
    if (status != 200) throw RuntimeException("兑换失败 HTTP $status")
    val parsed = JSONObject(bodyText)
    val cred = parsed.optString("deviceCredential")
    val pair = parsed.optJSONObject("pair")
    val pcPub = pair?.optJSONObject("pc")?.optString("publicKey") ?: ""
    if (cred.isEmpty() || pair == null || pcPub.isEmpty()) {
        throw RuntimeException("兑换响应缺少凭证或 PC 公钥")
    }
    Log.i(TAG, "redeem ok pairId=${pair.optString("pairId")} pc=${pair.optJSONObject("pc")?.optString("name")}")
    return RedeemResult(cred, pair)
}
