/**
 * Happy Harness 主界面（安卓版）—— 功能对齐 ArkTS pages/Index.ets 的 v2.1 完整模式形态。
 *
 * 视图状态机（对齐 ArkTS this.view）：
 *   pair   —— 配对页：手动配对码输入（扫码 TODO，见 README）
 *   wait   —— v2 等待/重连页（v2 无原生会话列表形态）
 *   web    —— WebView 完整模式：本地代理 → E2E 隧道 → companion → dsh 完整 GUI，
 *             左侧叠悬浮状态条（协调/中继双灯 + 刷新/配对/设备，可收起为圆点）
 *   devices —— 设备选择页
 *   rlpick  —— 远程登录授权：多台电脑选择页
 *
 * deep link（intent-filter myapp://）：
 *   myapp://pair?ver=2&server=..&device=..&code=..        → pairV2Flow
 *   myapp://remote-login?server=..&pc=..&id=..            → remoteLinkFlow（approve 走隧道 POST）
 *   myapp://remote-link?from=..&id=..                     → remoteLinkFlow（PC-to-PC）
 */
package com.happyharness.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.happyharness.app.pair.PairCodeV2
import com.happyharness.app.pair.httpUrlOf
import com.happyharness.app.pair.isTlsServer
import com.happyharness.app.pair.parsePairCodeV2
import com.happyharness.app.pair.parseQuery
import com.happyharness.app.pair.fetchPairs
import com.happyharness.app.pair.redeemCode
import com.happyharness.app.pair.registerDevice
import com.happyharness.app.pair.wsUrlOf
import com.happyharness.app.relay.LocalProxy
import com.happyharness.app.relay.NatFilterProbe
import com.happyharness.app.relay.RelayClient
import com.happyharness.app.relay.loadOrCreateIdentity
import com.happyharness.app.service.TunnelService
import com.happyharness.app.store.DeviceMetaV2
import com.happyharness.app.store.SecureStoreV2
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

private const val TAG = "HHIndex"
private const val DEFAULT_SERVER = "8.137.177.62:9400"
// 授权端点对齐最新 ArkTS（2026-10-25 源码 /__ph/*，勿回退旧 /__happy/*）
private const val REMOTE_LOGIN_APPROVE_PATH = "/__ph/remote-login/approve"
private const val REMOTE_LINK_APPROVE_PATH = "/__ph/remote-link/approve"

/** 用户点按下载蒙皮请求暂停：循环在块边界抛出，走"可续传"收尾（不弹错误） */
private class DownloadPausedSignal : RuntimeException("__paused__")

class MainActivity : AppCompatActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var store: SecureStoreV2

    // 扫码（对齐 ArkTS scanPair：v2 配对码 / myapp://remote-link|remote-login 二维码）
    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        val raw = result.contents
        if (raw.isNullOrBlank()) {
            setPairStatus("扫码取消或失败，请重试")
        } else {
            handleScan(raw)
        }
    }

    private fun startScan() {
        if (pairing) return
        val options = ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt("对准电脑上显示的二维码")
            setBeepEnabled(false)
            setOrientationLocked(false)
        }
        scanLauncher.launch(options)
    }

    /** 扫码结果分发（对齐 ArkTS scanPair：配对码优先，其次远程链接） */
    private fun handleScan(raw: String) {
        val text = raw.trim()
        val v2code = parsePairCodeV2(text)
        if (v2code != null) {
            scope.launch { pairV2Flow(v2code) }
            return
        }
        when {
            text.startsWith("myapp://remote-link") ->
                remoteLinkFlow(android.net.Uri.parse(text), REMOTE_LINK_APPROVE_PATH)
            text.startsWith("myapp://remote-login") ->
                remoteLinkFlow(android.net.Uri.parse(text), REMOTE_LOGIN_APPROVE_PATH)
            else -> setPairStatus("仅支持 v2 配对码或远程链接二维码")
        }
    }

    // ---- 状态（对齐 ArkTS @State）----
    private var viewState = "pair" // pair | wait | web | devices | rlpick
    private var v2meta: DeviceMetaV2? = null
    private var relay: RelayClient? = null
    private var debugUdpFaultRegistered = false
    private val debugUdpFaultReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (!BuildConfig.DEBUG) return
            when (intent?.action) {
                "com.happyharness.app.debug.UDP_LINK_DOWN" -> relay?.debugDropUdpTraffic()
                "com.happyharness.app.debug.NAT_FILTER_PROBE" -> NatFilterProbe.start()
            }
        }
    }
    private var localProxy: LocalProxy? = null
    private var webIntent = false
    private var connLost = false
    private var pairing = false
    private var overlayOpen = true
    // ---- 连接质量（对齐 ArkTS latencyMs / 直连 / 中转，2026-10-26）----
    private var latencyMs = -1               // -1 测速中，-2 失败，其余=毫秒
    private var latencyTimer: java.util.Timer? = null
    @Volatile private var directOk = false   // 直连灯：PunchClient 实际直连状态
    private var relayOkNow = false           // 中转灯：隧道 WS+E2E 实时状态
    private var rlCandidates: List<DeviceMetaV2> = emptyList()
    private var rlPendingId = ""
    private var rlPendingPath = REMOTE_LOGIN_APPROVE_PATH

    // ---- 断链恢复自动刷新 WebView（对齐 ArkTS 989-1010，2026-10-26）----
    private var relayDownSince = 0L          // relayOk 由 true→false 时刻（0=未断）

    // ---- 单文件下载：断点续传（对齐 ArkTS 146-152）----
    private var dlItemPath = ""              // 当前下载项的完整源路径（'' = 无）
    private var dlText = ""                  // 进度文案（下载中 / 中断可续传提示）
    private var dlResume = false             // 中断可续传（点击同一项触发续传）
    private var dlName = ""                  // 续传元数据：文件名
    private var dlTotal = 0L                 // 续传元数据：总字节数
    private var dlTarget = ""                // 续传元数据：本地目标（应用沙箱绝对路径）

    // ---- 下载蒙皮（对齐鸿蒙 2026-10-27：文件项本身显示进度，点按暂停/续传）----
    private var dlActive = false             // 下载进行中（列表项渲染成进度蒙皮）
    @Volatile private var dlPauseReq = false // 点按蒙皮置位，下一块边界生效
    private var dlRowText: TextView? = null  // 蒙皮上的进度文案（渲染时绑定）
    private var dlRowBar: ProgressBar? = null// 蒙皮上的进度条

    // ---- 窗口实况（对齐 ArkTS toolsLive，2026-10-27 移植）----
    private class LiveWindowItem(val hwnd: String, val title: String, val w: Int, val h: Int, val minimized: Boolean)
    private var liveWindows: List<LiveWindowItem> = emptyList()
    private var liveHwnd = ""
    private var liveTitle = ""
    private var liveFrameB64 = ""
    private var liveFrames = 0
    private var liveRunning = false
    @Volatile private var liveBusy = false   // 上一帧未返回时跳过本轮，防请求叠加
    private var liveTimer: java.util.Timer? = null
    private var liveImg: ImageView? = null
    private var liveStatText: TextView? = null

    // ---- 资料检索（对齐 ArkTS toolsData，2026-10-27 移植）----
    private class DataSearchItem(val path: String, val name: String, val size: Long, val mtime: Long, val hits: List<String>)
    private var dsQuery = ""
    private var dsResults: List<DataSearchItem> = emptyList()
    private var dsIndexed = -1L              // 已索引文件数（-1=未知）
    private var dsReadBack = "toolsData"     // 内容查看页返回目标
    private var dsInput: EditText? = null    // 检索输入框（渲染时绑定）

    // ---- 批量下载断点续传（对齐 ArkTS 154-156）----
    private var batchLeft = 0                // 中断后剩余文件数（>0 显示续传条）
    private var batchFiles: List<BatchFile> = emptyList() // 批量任务清单（持久化恢复）
    private var batchIndex = 0               // 下一个待取文件下标

    // ---- UI ----
    private lateinit var root: FrameLayout
    private lateinit var webWebView: WebView
    private lateinit var webProgress: ProgressBar
    private lateinit var overlayPanel: LinearLayout
    private lateinit var overlayDot: View
    private lateinit var directDot: View
    private lateinit var relayDot: View
    private lateinit var latencyText: TextView
    private lateinit var statusText: TextView
    private lateinit var container: FrameLayout
    private var statusTimer: java.util.Timer? = null

    // ---------------- 生命周期 ----------------

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        com.happyharness.app.relay.E2ECrypto.ensureProvider() // 触发 BC provider 注册
        store = SecureStoreV2(this)
        buildUi()
        // 🔴 冷启动清一次 WebView 缓存（2026-10-27）：前端资产哈希名不变时，
        //    旧缓存里的坏文件会一直命中（SyntaxError 白屏）；清掉后重拉降级版
        webWebView.clearCache(true)
        setContentView(root)
        dlLoadJob() // 恢复中断的下载任务（单文件标记续传 / 批量显示续传条）
        if (BuildConfig.DEBUG) {
            ContextCompat.registerReceiver(
                this,
                debugUdpFaultReceiver,
                IntentFilter().apply {
                    addAction("com.happyharness.app.debug.UDP_LINK_DOWN")
                    addAction("com.happyharness.app.debug.NAT_FILTER_PROBE")
                },
                ContextCompat.RECEIVER_EXPORTED
            )
            debugUdpFaultRegistered = true
        }
        initFlow()
        handleDeepLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    override fun onStart() {
        super.onStart()
        TunnelService.stop(this)
    }

    override fun onStop() {
        // 只在真正进入后台时保活；扫码、配对授权等短暂 onPause 不启动服务，
        // 避免 startForegroundService 与立即 stopService 竞争导致进程崩溃。
        try { TunnelService.start(this) } catch (e: Exception) {
            Log.w(TAG, "前台服务启动失败（通知权限？）: ${e.message}")
        }
        super.onStop()
    }

    override fun onDestroy() {
        statusTimer?.cancel()
        latencyTimer?.cancel()
        liveTimer?.cancel()
        if (debugUdpFaultRegistered) {
            runCatching { unregisterReceiver(debugUdpFaultReceiver) }
            debugUdpFaultRegistered = false
        }
        localProxy?.stop()
        relay?.stop()
        scope.cancel()
        webWebView.destroy()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // 对齐 ArkTS onBackPress：子页面返回留驻，web/pair 兜底
        when (viewState) {
            "devices", "rlpick" -> {
                gotoWebOrWait()
            }
            "tools", "toolsClip", "toolsShot" -> {
                gotoWebOrWait()
            }
            "toolsLive", "toolsLiveFrame" -> {
                if (liveFullscreen) {
                    liveFullscreen = false
                    renderLiveFrame()
                } else {
                    stopLiveLoop()
                    showToolsLive()
                }
            }
            "toolsData" -> {
                gotoWebOrWait()
            }
            "toolsDataRead" -> {
                if (dsReadBack == "toolsFiles") renderToolsFiles() else showToolsData()
            }
            "toolsFiles" -> {
                // 系统返回 = 直接退出工具子页回上一级界面（逐级回目录由页内 ‹ 按钮负责，对齐 ArkTS）
                gotoWebOrWait()
            }
            "pair" -> {
                if (webIntent) gotoWebOrWait() else super.onBackPressed()
            }
            else -> super.onBackPressed()
        }
    }

    // ---------------- 启动流 ----------------

    /** 启动：读 v2 设备列表，有则恢复上次激活的设备，无则进配对页（v2 设备优先，对齐 initFlow） */
    private fun initFlow() {
        scope.launch {
            val metas = try { store.listV2Meta() } catch (e: Exception) { emptyList() }
            val active = store.getV2Active()
            var meta = metas.firstOrNull { it.id == active } ?: metas.firstOrNull()
            if (meta != null) {
                val cred = store.getV2Credential(meta.id)
                if (cred.isNotEmpty()) {
                    activateV2(meta, cred)
                    return@launch
                }
            }
            showPair()
        }
    }

    // ---------------- 深链（remote-login / pair） ----------------

    private fun handleDeepLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "myapp") return
        Log.i(TAG, "deep link: $uri")
        when {
            uri.toString().startsWith("myapp://pair") -> {
                val code = parsePairCodeV2(uri.toString())
                if (code != null) {
                    scope.launch { pairV2Flow(code) }
                } else {
                    toast("配对码格式不完整（需 ver=2）")
                }
            }
            uri.toString().startsWith("myapp://remote-login") -> {
                remoteLinkFlow(uri, REMOTE_LOGIN_APPROVE_PATH)
            }
            uri.toString().startsWith("myapp://remote-link") -> {
                remoteLinkFlow(uri, REMOTE_LINK_APPROVE_PATH)
            }
        }
    }

    /**
     * V4 远程登录授权（对齐 ArkTS remoteLinkFlow）：
     * remote-login：参数 server/pc/id —— 候选 = 本机配对 ∩ 同 server（V4.2 按人显示）；
     * 多台弹选择页，单台直接确认。remote-link：参数 from/id —— 精确匹配 from 的 PC。
     */
    private fun remoteLinkFlow(uri: Uri, approvePath: String) {
        val params = parseQuery(uri.toString().substringAfter("myapp://" + uri.host, uri.toString()))
        // 兜底：直接从 uri query 取
        fun p(k: String): String = params[k] ?: uri.getQueryParameter(k) ?: ""
        val from = p("from").ifEmpty { p("pc") }
        val server = p("server")
        val linkId = p("id")
        val isLogin = approvePath.contains("remote-login")
        if (linkId.isEmpty() || (isLogin && server.isEmpty())) {
            toast("远程登录二维码内容不完整")
            return
        }
        scope.launch {
            val metas = store.listV2Meta()
            if (isLogin) {
                val candidates = metas.filter { it.server == server && (from.isEmpty() || it.pcDeviceId == from) }
                if (candidates.isEmpty()) {
                    toast("本机没有该服务器上的电脑配对（先配对那台电脑）")
                    return@launch
                }
                if (candidates.size == 1) {
                    remoteLinkApprove(candidates[0], linkId, approvePath)
                } else {
                    rlCandidates = candidates
                    rlPendingId = linkId
                    rlPendingPath = approvePath
                    showRlPick()
                }
            } else {
                val meta = metas.firstOrNull { it.pcDeviceId == from }
                if (meta == null) {
                    toast("未找到该电脑的配对（需先在本机配对过那台电脑）")
                    return@launch
                }
                remoteLinkApprove(meta, linkId, approvePath)
            }
        }
    }

    /** V4 远程登录授权执行：选择授权时长（临时/长期，对齐 2026-10-25 ArkTS）→ 连目标 PC → 经 E2E 发授权 */
    private suspend fun remoteLinkApprove(target: DeviceMetaV2, linkId: String, approvePath: String) {
        val isLogin = approvePath.contains("remote-login")
        val kindText = if (isLogin) "在网页上远程登录" else "远程登录"
        // 授权跟随目标（对齐 ArkTS 651-685，2026-10-26）：授权时长选择**之前**，
        // 经 relay 拉 /__ph/targets 取该电脑的可选 agent 目标；>1 个时弹单选菜单；
        // 取消 = 整体拒绝授权；旧插件无该端点 → 回落 'dsh' 直达（兼容，不报错）
        var agentTarget = "dsh"
        try {
            val r0 = relay
            if (r0 != null && r0.isReady()) {
                val tr = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    r0.httpCall("POST", "/__ph/targets", "{}")
                }
                val parsedT = JSONObject(tr.bodyText)
                val list = parsedT.optJSONArray("targets")
                if (list != null && list.length() > 1) {
                    val names = ArrayList<String>()
                    val map = HashMap<String, String>()
                    for (i in 0 until list.length()) {
                        val t = list.getJSONObject(i)
                        val label = t.optString("label", t.optString("name", "dsh")).ifBlank { "dsh" }
                        names.add(label)
                        map[label] = t.optString("name", "dsh").ifBlank { "dsh" }
                    }
                    val shown = names.take(6).toTypedArray()
                    val chosen = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                        suspendCancellableCoroutine<Int> { cont ->
                            var settled = false
                            val dlg = AlertDialog.Builder(this@MainActivity)
                                .setTitle("授权进入哪个界面？")
                                .setItems(shown) { d, which ->
                                    if (!settled) { settled = true; if (cont.isActive) cont.resumeWith(Result.success(which)); d.dismiss() }
                                }
                                .setNegativeButton("取消", null)
                                .setOnDismissListener {
                                    if (!settled) {
                                        settled = true
                                        if (cont.isActive) cont.resumeWith(Result.success(-1))
                                    }
                                }
                                .show()
                        }
                    }
                    if (chosen < 0) {
                        toast("已拒绝本次远程登录")
                        setStatus("已拒绝远程登录授权")
                        return
                    }
                    agentTarget = map[shown[chosen]] ?: "dsh"
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "/__ph/targets 不可用，回落 dsh: ${e.message}")
            agentTarget = "dsh"
        }
        val kindText2 = if (agentTarget != "dsh") "（界面：$agentTarget）" else ""
        // 授权时长选择：临时（浏览器本次使用）/ 长期（该浏览器 30 天） / 取消=拒绝
        val mode = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
            suspendCancellableCoroutine<String> { cont ->
                var settled = false
                val dialog = AlertDialog.Builder(this@MainActivity)
                    .setTitle("远程登录授权")
                    .setMessage("允许浏览器$kindText「${target.name}」$kindText2？\n\n临时授权：仅本次使用（约 2 小时内有效）\n长期授权：该浏览器 30 天内免扫码")
                    .setPositiveButton("临时授权", null)
                    .setNegativeButton("长期授权", null)
                    .setOnDismissListener {
                        if (!settled) {
                            settled = true
                            if (cont.isActive) cont.resumeWith(Result.success(""))
                        }
                    }
                    .show()
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                    if (!settled) { settled = true; if (cont.isActive) cont.resumeWith(Result.success("temp")); dialog.dismiss() }
                }
                dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener {
                    if (!settled) { settled = true; if (cont.isActive) cont.resumeWith(Result.success("long")); dialog.dismiss() }
                }
            }
        }
        if (mode.isEmpty()) {
            toast("已拒绝本次远程登录")
            return
        }
        doApprove(target, linkId, approvePath, mode, agentTarget)
    }

    private suspend fun doApprove(target: DeviceMetaV2, linkId: String, approvePath: String, mode: String, agentTarget: String = "dsh") {
        // 连到目标 PC（若当前不是它）
        if (v2meta?.id != target.id || relay == null || !relay!!.isReady()) {
            val cred = store.getV2Credential(target.id)
            if (cred.isEmpty()) {
                toast("该电脑的凭证缺失，请删除设备后重新配对")
                return
            }
            activateV2(target, cred)
        }
        // 等中继就绪
        for (i in 0 until 60) {
            if (relay?.isReady() == true) break
            delay(500)
        }
        val r = relay
        if (r == null || !r.isReady()) {
            toast("中继未就绪，远程登录授权失败（稍后重试）")
            return
        }
        try {
            setStatus("正在发送远程登录授权…")
            // body 对齐 ArkTS：remote-login={id,mode,target}；remote-link={id,from,mode,target}
            val body = if (approvePath.contains("remote-login")) {
                JSONObject().put("id", linkId).put("mode", mode)
            } else {
                JSONObject().put("id", linkId).put("from", target.pcDeviceId).put("mode", mode)
            }.put("target", agentTarget)
            val res = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                r.httpCall("POST", approvePath, body.toString())
            }
            var msg = "授权失败（HTTP ${res.status}）"
            var ok = false
            try {
                val parsed = JSONObject(res.bodyText)
                if (parsed.optBoolean("ok")) {
                    ok = true
                    msg = "✅ 已授权，请在电脑网页上等待自动进入"
                } else {
                    msg = "授权被拒：" + parsed.optString("error", "未知原因")
                }
            } catch (e: Exception) {}
            setStatus(msg)
            // 🔴 结果必须 toast 醒目提示（2026-10-24 事故：失败只写状态行被用户完全忽略）
            toast(if (ok) "✅ 已授权，请在电脑网页查看" else msg)
            Log.i(TAG, "remote-link approve: HTTP ${res.status} ${res.bodyText.take(80)}")
        } catch (e: Exception) {
            setStatus("授权请求失败: ${e.message}")
            toast("❌ 授权请求失败: ${e.message}")
        }
    }

    // ---------------- v2 配对 ----------------

    /**
     * ver=2 配对入口：注册本机身份 → 兑换配对码 → 连中继（对齐 pairV2Flow）。
     * 🔴 匹配键 = server + pcDeviceId（多台 PC 配对互相覆盖的修复）；
     * 🔴 扫码 = 重新配对：始终兑换新码更新凭证，失败才回退旧凭证。
     */
    private suspend fun pairV2Flow(code: PairCodeV2) {
        if (pairing) return
        pairing = true
        setPairStatus("v2 配对中…")
        try {
            val identity = loadOrCreateIdentity(store)
            val existing = store.listV2Meta()
            var meta = existing.firstOrNull {
                code.device.isNotEmpty() && it.server == code.server && it.pcDeviceId == code.device
            }
            var credential: String
            if (meta == null) {
                // 🔴 阻塞 HTTP 必须切 IO（主线程网络 = NetworkOnMainThreadException，2026-10-27 真机定罪）
                val reg = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    registerDevice(code.server, "android-phone", identity.publicKeyB64)
                }
                val r = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    redeemCode(code.server, code.code, reg.deviceId, identity.publicKeyB64)
                }
                // 兑换结果反查（手动码路径）：已是本 PC 的旧配对 → 更新凭证，不新建条目
                val hit = existing.firstOrNull { it.server == code.server && it.pcDeviceId == r.pair.optJSONObject("pc")?.optString("deviceId") }
                if (hit != null) {
                    val pc = r.pair.optJSONObject("pc")
                    val pcName = pc?.optString("name") ?: ""
                    if (pcName.isNotBlank()) hit.name = pcName
                    if (!pc?.optString("seq").isNullOrBlank()) hit.seq = pc?.optString("seq") ?: ""
                    store.saveV2Meta(hit)
                    store.saveV2Credential(hit.id, r.deviceCredential)
                    meta = hit
                    credential = r.deviceCredential
                } else {
                    val pc = r.pair.optJSONObject("pc")
                    val m = DeviceMetaV2(
                        id = SecureStoreV2.newDeviceId(),
                        name = (pc?.optString("name") ?: "").ifBlank { code.device },
                        server = code.server,
                        pcDeviceId = pc?.optString("deviceId") ?: "",
                        deviceId = reg.deviceId,
                        seq = pc?.optString("seq") ?: ""
                    )
                    store.saveV2Meta(m)
                    store.saveV2Credential(m.id, r.deviceCredential)
                    meta = m
                    credential = r.deviceCredential
                }
            } else {
                val m = meta
                try {
                    val r = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                        redeemCode(code.server, code.code, m.deviceId, identity.publicKeyB64)
                    }
                    credential = r.deviceCredential
                    val pc = r.pair.optJSONObject("pc")
                    m.pcDeviceId = pc?.optString("deviceId") ?: m.pcDeviceId
                    val pcName = pc?.optString("name") ?: ""
                    if (pcName.isNotBlank()) m.name = pcName
                    if (!pc?.optString("seq").isNullOrBlank()) m.seq = pc?.optString("seq") ?: ""
                    store.saveV2Meta(m)
                    store.saveV2Credential(m.id, credential)
                } catch (e: Exception) {
                    Log.w(TAG, "新码兑换失败，回退旧凭证: ${e.message}")
                    credential = store.getV2Credential(m.id)
                    if (credential.isEmpty()) {
                        throw RuntimeException("本地凭证缺失且新码兑换失败，请重新生成二维码")
                    }
                }
            }
            store.setV2Active(meta.id)
            setPairStatus("v2 配对成功，连接中继…")
            activateV2(meta, credential)
        } catch (e: Exception) {
            Log.e(TAG, "v2 配对失败: ${e.message}", e)   // 完整堆栈定位（2026-10-27 data too short 排查）
            setPairStatus("v2 配对失败：${stripCode(e.message ?: "$e")}")
        } finally {
            pairing = false
        }
    }

    /** 手动配对码（免扫码，对齐 manualPair）：服务器沿用已存 v2 设备的地址，否则默认值 */
    private fun manualPair() {
        val code = pairCodeInput.text.toString().trim().uppercase()
        if (code.length < 4) {
            setPairStatus("配对码太短")
            return
        }
        var server = DEFAULT_SERVER
        val metas = store.listV2Meta()
        if (metas.isNotEmpty()) server = metas.last().server
        scope.launch { pairV2Flow(PairCodeV2(server, "", code)) }
    }

    // ---------------- 激活 v2 设备 ----------------

    /** 激活 v2 设备：建中继连接，成功后进 WebView 完整模式（对齐 activateV2）。
     *  🔴 重激活前必须停旧 relay 与旧 LocalProxy（僵尸代理坑，交接 §1.2）：
     *     LocalProxy.stop() 会掐断全部存量 keep-alive 连接，WebView 自动重连到新代理。 */
    private suspend fun activateV2(meta: DeviceMetaV2, credential: String) {
        relay?.stop()
        relay = null
        localProxy?.stop()
        localProxy = null

        v2meta = meta
        val identity = loadOrCreateIdentity(store)
        val newRelay = RelayClient(wsUrlOf(meta.server, "/api/v1/tunnel"), credential, identity)
        relay = newRelay
        directOk = false
        newRelay.onDirectChanged = { direct ->
            directOk = direct
            Log.i(TAG, if (direct) "业务传输切换为 P2P 直连" else "业务传输使用中继")
        }
        newRelay.onReset = { reason ->
            connLost = true
            runOnUiThread { setStatus("$reason，自动重连中…") }
        }
        newRelay.onReady = {
            connLost = false
            runOnUiThread {
                setStatus("")
                // v2 无原生形态：重连成功后自动回 WebView 完整模式
                if (webIntent) startWeb()
            }
        }
        webIntent = true
        connLost = false
        runOnUiThread {
            showWait()
            setStatus("正在连接中继…")
        }
        try {
            newRelay.start()
            startWeb()
        } catch (e: Exception) {
            // 首连失败不放弃：relay 内部指数退避重连，onReady 后自动恢复
            connLost = true
            runOnUiThread {
                showWait()
                setStatus("中继连接中：${stripCode(e.message ?: "")}（自动重试）")
            }
        }
    }

    /** v2.1 WebView 完整模式：拉起本地回环代理 → WebView 加载 dsh 完整 GUI。
     *  🔴 并发互斥（对齐 ArkTS webStarting，2026-10-24 多设备切换掉线根因之二）：
     *  onReady 与 activateV2 本体并发各调一次 → 两个重建互相踩。in-flight 时直接返回。 */
    private var webStarting = false
    private var webUrl = ""
    private fun startWeb() {
        if (webStarting) return
        webStarting = true
        try {
            val r = relay
            if (r == null || !r.isReady()) {
                showWait(); setStatus("连接电脑中：中继未就绪")
                return
            }
            val lp = localProxy
            if (lp == null || !lp.ready || lp.relay !== r) {
                // 代理未建/已停/绑的不是当前 relay（换代遗留）→ 一律重建
                lp?.stop()
                val newProxy = LocalProxy(r)
                newProxy.start()
                localProxy = newProxy
            }
            // 🔴 重连恢复：URL 不变走 reload（吃到 WebView 缓存，避免 2.7MB 前端资产在
            //    ~20KB/s 隧道上下反复重下导致"永远加载不完"）；仅换设备/首次进入才换新 ?r= URL
            val sameProxyUrl = webUrl.startsWith(localProxy!!.url + "?r=")
            if (sameProxyUrl) {
                runOnUiThread {
                    showWeb()
                    webWebView.reload()
                }
                Log.i(TAG, "中继恢复，WebView 缓存重载: $webUrl")
            } else {
                // 🔴 URL 加一次性参数：换设备/重新配对后强制 WebView 重载（对齐 ArkTS ?r= 修复）
                webUrl = localProxy!!.url + "?r=" + System.currentTimeMillis()
                runOnUiThread {
                    showWeb()
                    webWebView.loadUrl(webUrl)
                    webProgress.visibility = View.VISIBLE
                }
                Log.i(TAG, "进入 WebView 完整模式: $webUrl")
            }
            startStatusLoop()
        } catch (e: Exception) {
            Log.w(TAG, "WebView 模式启动失败，等待页待命: ${e.message}")
            showWait()
            setStatus("连接电脑中：${e.message}")
        } finally {
            webStarting = false
        }
    }

    // ---------------- 悬浮状态条 ----------------

    /** 中转灯 = 隧道 WS+E2E 实时状态；灯色按延迟（对齐 ArkTS startStatusLoop + pathLightColor，2026-10-26） */
    private fun startStatusLoop() {
        if (statusTimer != null) return
        val tick = object : java.util.TimerTask() {
            override fun run() {
                val relayOk = relay?.isReady() == true
                relayOkNow = relayOk
                // 断链超 20s 后恢复 → 自动刷新 WebView（对齐 ArkTS 989-1010，2026-10-26）：
                // 重连成功只救活了隧道，GUI 里挂死的请求要等超时才逐个恢复，体验"假死"；
                // 断链恢复后立即 reload 一次，GUI 一次到位
                val nowMs = System.currentTimeMillis()
                var autoReload = false
                if (relayOk) {
                    if (relayDownSince > 0) {
                        val outage = nowMs - relayDownSince
                        relayDownSince = 0
                        if (outage > 20000 && viewState == "web") autoReload = true
                    }
                } else if (relayDownSince == 0L) {
                    relayDownSince = nowMs
                }
                runOnUiThread {
                    directDot.setBackgroundColor(pathLightColor(directOk))
                    relayDot.setBackgroundColor(pathLightColor(relayOk))
                    overlayDot.setBackgroundColor(pathLightColor(relayOk))
                    if (autoReload) {
                        Log.i(TAG, "中继恢复，自动刷新 WebView")
                        webWebView.reload()
                    }
                }
            }
        }
        statusTimer = java.util.Timer()
        statusTimer?.schedule(tick, 0, 5000)
        startLatencyLoop()
    }

    /** 直连/中转灯颜色：未建立=灰；已建立按延迟 绿<300ms / 橙 300~3000ms / 红>3000ms 或故障（对齐 pathLightColor） */
    private fun pathLightColor(ok: Boolean): Int {
        if (!ok) return Color.parseColor("#8A8F9E")
        if (latencyMs == -2) return Color.parseColor("#D93026")
        if (latencyMs < 0) return Color.parseColor("#22C55E") // 延迟未知但链路已通：先绿
        if (latencyMs < 300) return Color.parseColor("#22C55E")
        if (latencyMs < 3000) return Color.parseColor("#E67E22")
        return Color.parseColor("#D93026")
    }

    /** 每 30s 轻量传输层 ping（/__ph/transport-ping 只回几十字节；旧 session/list ~500KB 会堵隧道，对齐 ArkTS 2026-10-26） */
    private fun startLatencyLoop() {
        if (latencyTimer != null) return
        val task = object : java.util.TimerTask() {
            override fun run() {
                val r = relay ?: return
                scope.launch {
                    try {
                        val t0 = System.currentTimeMillis()
                        val res = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                            r.httpCall("GET", "/__ph/transport-ping", "")
                        }
                        if (res.status in 200..299) latencyMs = (System.currentTimeMillis() - t0).toInt()
                        else latencyMs = -2
                    } catch (e: Exception) {
                        latencyMs = -2
                    }
                    runOnUiThread {
                        latencyText.text = if (latencyMs == -2) "异常"
                        else if (latencyMs < 0) "测速中" else "${latencyMs}ms"
                        latencyText.setTextColor(if (latencyMs in 0..299) Color.parseColor("#22C55E") else Color.WHITE)
                        relayDot.setBackgroundColor(pathLightColor(relayOkNow))
                        overlayDot.setBackgroundColor(pathLightColor(relayOkNow))
                    }
                }
            }
        }
        latencyTimer = java.util.Timer()
        latencyTimer?.schedule(task, 500, 30000)
    }

    /** 协调服务器连通性：用配对凭证直调云端 /api/v1/pairs（200=通） */
    private fun checkCoordSync(): Boolean {
        val meta = v2meta ?: return false
        val cred = store.getV2Credential(meta.id)
        if (cred.isEmpty()) return false
        val client = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
            .build()
        return try {
            val req = Request.Builder()
                .url("${httpUrlOf(meta.server)}/api/v1/pairs")
                .header("Authorization", "Bearer $cred")
                .get()
                .build()
            client.newCall(req).execute().use { it.code == 200 }
        } catch (e: Exception) {
            false
        }
    }

    // ---------------- 视图切换 ----------------

    private fun gotoWebOrWait() {
        if (webIntent && localProxy?.ready == true) showWeb() else if (webIntent) showWait() else showPair()
    }

    private fun stripCode(msg: String): String {
        val idx = msg.indexOf(": ")
        return if (idx > 0 && msg.substring(0, idx).startsWith("ERR_")) msg.substring(idx + 2) else msg
    }

    private fun toast(msg: String) {
        runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }
    }

    private fun setStatus(msg: String) {
        statusText.text = msg
        statusText.visibility = if (msg.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun setPairStatus(msg: String) {
        runOnUiThread { setStatus(msg) }
    }

    // ---------------- UI 构建（程序化视图，零布局 XML） ----------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildUi() {
        root = FrameLayout(this)

        // WebView 层
        webWebView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.allowFileAccess = false
            settings.javaScriptCanOpenWindowsAutomatically = true
            // 🔴 移动端视口自适应（2026-10-27，对齐 ArkWeb 默认行为）：
            //    不开这两项时 WebView 按桌面宽度渲染，dsh 前端的 viewport 声明不生效 → 界面像缩小版桌面页
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            // MIUI 系统字体缩放会传导进 WebView（界面忽大忽小），锁定 100%
            settings.textZoom = 100
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    webProgress.visibility = View.GONE
                    Log.i(TAG, "WebView 页面加载完成")
                }
                override fun onReceivedError(view: WebView?, req: WebResourceRequest?, err: WebResourceError?) {
                    if (req?.isForMainFrame == true) {
                        Log.e(TAG, "WebView 主帧错误: ${err?.description}")
                    }
                }
            }
        }
        webProgress = ProgressBar(this).apply { visibility = View.GONE }

        // 悬浮状态条（v2.1 竖版，对齐 ArkTS statusOverlay 2026-10-26）：
        // 上灯=直连(P2P，安卓端打洞接入前恒灰)、下灯=中转(中继隧道)；灯色按延迟 绿<300/橙<3000/红故障
        overlayPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0x991A1A1A.toInt())
            setPadding(dp(8), dp(8), dp(8), dp(8))
            gravity = Gravity.CENTER_HORIZONTAL

            fun dotRow(label: String, withLatency: Boolean = false): Pair<LinearLayout, View> {
                val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
                val dot = View(context).apply {
                    layoutParams = LinearLayout.LayoutParams(dp(9), dp(9))
                    setBackgroundColor(Color.parseColor("#8A8F9E"))
                }
                row.addView(dot)
                row.addView(TextView(context).apply {
                    text = label; setTextColor(Color.WHITE); textSize = 8f
                    layoutParams = LinearLayout.LayoutParams(-2, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(4) }
                })
                if (withLatency) {
                    latencyText = TextView(context).apply {
                        text = "测速中"; setTextColor(Color.WHITE); textSize = 8f
                    }
                    row.addView(latencyText)
                }
                row.layoutParams = LinearLayout.LayoutParams(-2, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8) }
                return row to dot
            }
            val (directRow, dDot) = dotRow("直连")
            val (relayRow, rDot) = dotRow("中转", withLatency = true)
            directDot = dDot
            relayDot = rDot
            addView(directRow)
            addView(relayRow)

            fun smallBtn(label: String, onClick: () -> Unit): TextView =
                TextView(context).apply {
                    text = label; setTextColor(Color.WHITE); textSize = 10f
                    setPadding(dp(2), dp(5), dp(2), dp(5))
                    setOnClickListener { onClick() }
                }
            addView(smallBtn("刷新") {
                runOnUiThread { webWebView.reload() }
            })
            addView(smallBtn("配对") { showPair() })
            addView(smallBtn("Agent") { showDevices() })
            addView(smallBtn("工具") { showTools() })
            addView(TextView(context).apply {
                text = "✕"; setTextColor(0xFFFFFF99.toInt()); textSize = 10f
                setPadding(dp(2), dp(3), dp(2), dp(3))
                setOnClickListener { collapseOverlay() }
            })
        }

        overlayDot = View(this).apply {
            layoutParams = FrameLayout.LayoutParams(dp(25), dp(25))
            setBackgroundColor(0x661A1A1A.toInt())
            visibility = View.GONE
            setOnClickListener { expandOverlay() }
        }

        // 状态文本（等待页/配对页共用）
        statusText = TextView(this).apply {
            setTextColor(Color.parseColor("#6B6F80")); textSize = 14f
            gravity = Gravity.CENTER
            setPadding(dp(24), 0, dp(24), 0)
        }

        container = FrameLayout(this)
        root.addView(container, FrameLayout.LayoutParams(-1, -1))
    }

    private fun collapseOverlay() {
        overlayOpen = false
        overlayPanel.visibility = View.GONE
        overlayDot.visibility = View.VISIBLE
    }

    private fun expandOverlay() {
        overlayOpen = true
        overlayDot.visibility = View.GONE
        overlayPanel.visibility = View.VISIBLE
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun clearContainer() {
        container.removeAllViews()
        // 🔴 共享视图（statusText 等）随旧页面挂在被移除的子树里，但 parent 引用仍在——
        //    不摘下来就 addView 会抛 "child already has a parent"（2026-10-27 配对成功后白屏定罪）
        detach(statusText)
        detach(webWebView)
        detach(webProgress)
    }

    private fun detach(v: View) {
        (v.parent as? android.view.ViewGroup)?.removeView(v)
    }

    private fun showPair() {
        viewState = "pair"
        clearContainer()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(16), dp(32), dp(16))
        }
        col.addView(TextView(this).apply {
            text = "智枢"
            textSize = 24f; gravity = Gravity.CENTER; setTypeface(null, android.graphics.Typeface.BOLD)
            setTextColor(Color.parseColor("#1A1A1A"))
            layoutParams = LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(8) }
        })
        col.addView(TextView(this).apply {
            text = "使用手机访问你电脑上的 DeepSeek harness"
            textSize = 13f; gravity = Gravity.CENTER
            setTextColor(Color.parseColor("#6B6F80"))
            layoutParams = LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(18) }
        })
        // 主入口：扫码配对（对齐 ArkTS pairView 的 PRIMARY 圆角大按钮）
        col.addView(Button(this).apply {
            text = if (pairing) "配对中…" else "扫描二维码配对"
            isEnabled = !pairing
            setTextColor(Color.WHITE); textSize = 16f
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(Color.parseColor("#4D6BFE"))
                cornerRadius = dp(23).toFloat()
            }
            setOnClickListener { startScan() }
        }, LinearLayout.LayoutParams(-1, dp(46)).apply { bottomMargin = dp(14) })
        // 手动配对码（v2.1 免扫码入口，行内输入 + 圆角小按钮）
        val manualRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        pairCodeInput = EditText(this).apply {
            hint = "输入配对码（如 1A2B3C4D5E）"
            textSize = 14f
            typeface = android.graphics.Typeface.MONOSPACE
            layoutParams = LinearLayout.LayoutParams(0, dp(44)).apply { weight = 1f; marginEnd = dp(8) }
        }
        manualRow.addView(pairCodeInput)
        manualRow.addView(Button(this).apply {
            text = "配对"
            setTextColor(Color.WHITE)
            isEnabled = false
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(Color.parseColor("#1A1A1A"))
                cornerRadius = dp(22).toFloat()
            }
            setOnClickListener { manualPair() }
            layoutParams = LinearLayout.LayoutParams(dp(84), dp(44))
        })
        pairCodeInput.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) {
                (manualRow.getChildAt(1) as? Button)?.isEnabled =
                    !pairing && (s?.toString()?.trim()?.length ?: 0) >= 4
            }
        })
        col.addView(manualRow, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(14) })
        // 配对说明卡片（文案对齐 ArkTS pairView）
        val helpCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#F7F8FA"))
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }
        fun helpLine(text: String, size: Int, bold: Boolean) {
            helpCard.addView(TextView(this).apply {
                this.text = text; textSize = size.toFloat()
                if (bold) setTypeface(null, android.graphics.Typeface.BOLD)
                setTextColor(if (bold) Color.parseColor("#1A1A1A") else Color.parseColor("#6B6F80"))
                layoutParams = LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(6) }
            })
        }
        helpLine("配对说明", 14, true)
        helpLine("方式一：PC 对话框输入 /ph pair，把 6 位配对码填到上方输入框", 12, false)
        helpLine("方式二：在 PC 上打开配对工具，扫描二维码", 12, false)
        helpLine("配对一次长期有效；提示授权过期时重新配对即可", 12, false)
        col.addView(helpCard, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) })
        col.addView(Button(this).apply {
            text = "设备列表"
            setOnClickListener { showDevices() }
        })
        col.addView(statusText, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(16) })
        val scroll = ScrollView(this).apply { addView(col) }
        container.addView(scroll, FrameLayout.LayoutParams(-1, -1))
    }

    private lateinit var pairCodeInput: EditText

    private fun showWait() {
        viewState = "wait"
        clearContainer()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(16), dp(24), dp(16))
        }
        col.addView(TextView(this).apply {
            text = "⏳"; textSize = 48f; gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(12) })
        col.addView(TextView(this).apply {
            text = v2meta?.name ?: "电脑"
            textSize = 20f; gravity = Gravity.CENTER
            setTextColor(Color.parseColor("#1A1A1A"))
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(8) })
        col.addView(statusText, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(24) })
        col.addView(Button(this).apply {
            text = "重试连接"
            setOnClickListener {
                val m = v2meta
                scope.launch {
                    if (m == null) showPair()
                    else {
                        val c = store.getV2Credential(m.id)
                        if (c.isNotEmpty()) activateV2(m, c) else showPair()
                    }
                }
            }
        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        col.addView(Button(this).apply {
            text = "切换设备 / 配对"
            setOnClickListener { showDevices() }
        })
        container.addView(col, FrameLayout.LayoutParams(-1, -1))
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWeb() {
        viewState = "web"
        clearContainer()
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(webProgress, LinearLayout.LayoutParams(-1, dp(4)))
        col.addView(webWebView, LinearLayout.LayoutParams(-1, 0, 1f))
        container.addView(col, FrameLayout.LayoutParams(-1, -1))
        // 悬浮条叠加
        container.addView(overlayPanel, FrameLayout.LayoutParams(-2, -2).apply {
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            marginStart = dp(6)
        })
        container.addView(overlayDot, FrameLayout.LayoutParams(dp(25), dp(25)).apply {
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            marginStart = dp(8)
        })
        if (overlayOpen) {
            overlayPanel.visibility = View.VISIBLE
            overlayDot.visibility = View.GONE
        } else {
            overlayPanel.visibility = View.GONE
            overlayDot.visibility = View.VISIBLE
        }
    }

    private fun showDevices() {
        viewState = "devices"
        clearContainer()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        col.addView(TextView(this).apply {
            text = "已配对的电脑"
            textSize = 18f
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(12) })
        val metas = store.listV2Meta()
        if (metas.isEmpty()) {
            col.addView(TextView(this).apply {
                text = "还没有配对设备，先完成配对"
                textSize = 13f; setTextColor(Color.parseColor("#6B6F80"))
            })
        }
        metas.forEach { m ->
            val item = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(Color.parseColor("#F7F8FA"))
                setPadding(dp(12), dp(12), dp(12), dp(12))
                setOnClickListener {
                    scope.launch {
                        val c = store.getV2Credential(m.id)
                        if (c.isNotEmpty()) activateV2(m, c) else toast("该设备凭证缺失，请重新配对")
                    }
                }
            }
            item.addView(TextView(this).apply {
                text = m.name; textSize = 15f; setTextColor(Color.parseColor("#1A1A1A"))
            })
            // 设备编号（云端下发才有；如 #20261023-0008，对齐 ArkTS 设备页）
            if (m.seq.isNotBlank()) {
                item.addView(TextView(this).apply {
                    text = "#${m.seq}"; textSize = 11f; setTextColor(Color.parseColor("#9AA0B0"))
                })
            }
            item.addView(TextView(this).apply {
                text = "${m.server} · ${m.pcDeviceId}"
                textSize = 11f; setTextColor(Color.parseColor("#9AA0B0"))
            })
            // 云端刷新显示名 + 设备编号（对齐 openDevices 的 fetchPairs 刷新）
            scope.launch {
                try {
                    val cred = store.getV2Credential(m.id)
                    if (cred.isNotEmpty()) {
                        val hit = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                            fetchPairs(m.server, cred).firstOrNull { it.pcDeviceId == m.pcDeviceId }
                        }
                        hit?.let { p ->
                            var changed = false
                            if (p.pcName.isNotBlank() && p.pcName != m.name) {
                                m.name = p.pcName; changed = true
                            }
                            // 设备编号：云端下发则记录（旧版服务端无此字段，容错保留原值）
                            if (p.pcSeq.isNotBlank() && p.pcSeq != m.seq) {
                                m.seq = p.pcSeq; changed = true
                            }
                            if (changed) {
                                store.saveV2Meta(m)
                                runOnUiThread { showDevices() } // 重渲染（简单起见整页重建）
                            }
                        }
                    }
                } catch (e: Exception) { /* 显示名刷新失败不影响 */ }
            }
            col.addView(item, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        }
        col.addView(Button(this).apply {
            text = "扫码添加 Agent"
            setOnClickListener { startScan() }
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12); bottomMargin = dp(8) })
        col.addView(Button(this).apply {
            text = "＋ 手动输入配对码"
            setOnClickListener { showPair() }
        }, LinearLayout.LayoutParams(-1, -2))
        col.addView(Button(this).apply {
            text = "‹ 返回"
            setOnClickListener { gotoWebOrWait() }
        })
        container.addView(ScrollView(this).apply { addView(col) }, FrameLayout.LayoutParams(-1, -1))
    }

    private fun showRlPick() {
        viewState = "rlpick"
        clearContainer()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        col.addView(TextView(this).apply {
            text = "选择要登录的电脑"; textSize = 18f
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(8) })
        col.addView(TextView(this).apply {
            text = "网页请求远程登录，本机在该服务器上配对过多台电脑，请选择授权目标。"
            textSize = 12f; setTextColor(Color.parseColor("#6B6F80"))
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(12) })
        rlCandidates.forEach { m ->
            val item = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(Color.parseColor("#F7F8FA"))
                setPadding(dp(12), dp(12), dp(12), dp(12))
                setOnClickListener {
                    val id = rlPendingId
                    val path = rlPendingPath
                    // 🔴 批准完成前不切界面（2026-10-24 事故：先切走导致授权失败完全不可见），
                    //    完成后由 toast 提示，再回 web/wait
                    scope.launch {
                        // remoteLinkApprove 为挂起函数：等授权流程整体走完（含用户选择/请求）再切页
                        remoteLinkApprove(m, id, path)
                        gotoWebOrWait()
                    }
                }
            }
            item.addView(TextView(this).apply { text = m.name; textSize = 15f })
            item.addView(TextView(this).apply {
                text = m.server; textSize = 11f; setTextColor(Color.parseColor("#9AA0B0"))
            })
            col.addView(item, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        }
        col.addView(Button(this).apply {
            text = "‹ 取消"
            setOnClickListener { gotoWebOrWait() }
        })
        container.addView(ScrollView(this).apply { addView(col) }, FrameLayout.LayoutParams(-1, -1))
    }

    // ================================================================
    // 工具页（2026-10-24/25 新增，对齐 ArkTS tools/toolsFiles/toolsClip/toolsShot）：
    // 文件互传 / 剪贴板 / 截图 —— 全部经 relay.httpCall 与 PC 插件 /__ph/* 端点通信（E2E 加密）
    // ================================================================

    /** 工具页：电脑文件列表项（/__ph/files/list 的 items 元素，对齐 ToolFileItem） */
    private class ToolFileItem(
        val name: String,
        val dir: Boolean,
        val size: Long,
        val mtime: Long,
        val path: String = "",   // 快捷项/盘符项的完整路径（普通项 = toolPath + name 现算）
        val quick: Boolean = false
    )

    /** 多选传送的选中项（对齐 SelItem） */
    private class SelItem(val path: String, val name: String, val dir: Boolean, val size: Long)

    /** 批量任务清单元素（对齐 TreeFile：源路径 / 相对名 / 字节数） */
    private class BatchFile(val path: String, val rel: String, val size: Long)

    // ---- 下载任务持久化（SharedPreferences 'hh_dljob'：key 'job'=单文件，'batch'=批量）----

    private fun dlPrefs() = getSharedPreferences("hh_dljob", MODE_PRIVATE)

    /** 单文件续传任务持久化（失败静默，不阻塞下载流程） */
    private fun dlSaveJob(full: String) {
        try {
            dlPrefs().edit()
                .putString("job", JSONObject()
                    .put("path", full).put("name", dlName).put("total", dlTotal)
                    .put("target", dlTarget).toString())
                .apply()
        } catch (e: Exception) { /* 持久化失败不影响本次下载 */ }
    }

    private fun dlClearJob() {
        try { dlPrefs().edit().remove("job").apply() } catch (e: Exception) { /* 忽略 */ }
    }

    /** 批量任务进度持久化（对齐 batchSaveJob/batchClearJob） */
    private fun batchSaveJob() {
        try {
            val arr = org.json.JSONArray()
            batchFiles.forEach { f -> arr.put(JSONObject().put("path", f.path).put("rel", f.rel).put("size", f.size)) }
            dlPrefs().edit()
                .putString("batch", JSONObject().put("files", arr).put("i", batchIndex + 1).toString())
                .apply()
        } catch (e: Exception) { /* 持久化失败不阻塞 */ }
    }

    private fun batchClearJob() {
        try { dlPrefs().edit().remove("batch").apply() } catch (e: Exception) { /* 忽略 */ }
    }

    /** 启动时恢复中断的下载任务（单文件→标记续传；批量→batchLeft>0 显示续传条） */
    private fun dlLoadJob() {
        try {
            val prefs = dlPrefs()
            // 批量任务恢复（key='batch'，独立于单文件任务）
            val rawB = prefs.getString("batch", "") ?: ""
            if (rawB.isNotEmpty()) {
                val bj = JSONObject(rawB)
                val arr = bj.optJSONArray("files")
                val idx = bj.optInt("i", 0)
                if (arr != null && arr.length() > 0 && idx < arr.length()) {
                    val list = ArrayList<BatchFile>()
                    for (i in 0 until arr.length()) {
                        val m = arr.getJSONObject(i)
                        list.add(BatchFile(m.optString("path"), m.optString("rel"), m.optLong("size", 0)))
                    }
                    batchFiles = list
                    batchIndex = maxOf(0, idx)
                    batchLeft = list.size - batchIndex
                }
            }
            // 单文件任务恢复：只还原元数据，等用户进 toolsFiles 点同一文件触发续传
            val raw = prefs.getString("job", "") ?: ""
            if (raw.isNotEmpty()) {
                val j = JSONObject(raw)
                dlName = j.optString("name")
                dlTotal = j.optLong("total", 0)
                dlTarget = j.optString("target")
                dlItemPath = j.optString("path")
                dlResume = dlName.isNotEmpty() && dlTotal > 0
                dlText = if (dlResume) "⏸ 下载中断，点此续传" else ""
            }
        } catch (e: Exception) { /* 恢复失败当无任务 */ }
    }

    /** 工具页状态行就地刷新（下载分块循环里避免整页重建） */
    private fun updateToolStatusView() {
        container.findViewWithTag<TextView>("toolStatusView")?.let { it.text = toolStatus }
        // 文件项下方进度行（对齐 ArkTS dlText 显示在 dlItemPath 项下）
        container.findViewWithTag<TextView>("dlText")?.let {
            it.text = dlText
            it.visibility = if (dlText.isEmpty()) View.GONE else View.VISIBLE
        }
    }

    // ---- 工具页状态（对齐 ArkTS @State）----
    private var toolFiles: List<ToolFileItem> = emptyList()
    private var toolPath: String = ""            // '' = 用户主目录；'__quick__'；'__drives__'
    private var toolStatus: String = ""
    private var toolBusy = false
    private var selMode = false
    private var selItems: MutableList<SelItem> = mutableListOf()

    /** 工具统一 httpCall：JSON 请求 → 解析响应；非 2xx 或带 error 字段则抛错（对齐 toolCall） */
    private suspend fun toolCall(path: String, body: String): JSONObject {
        val r = relay ?: throw RuntimeException("未连接")
        if (!r.isReady()) throw RuntimeException("ERR_NETWORK: 中继未就绪（E2E 握手未完成）")
        val res = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            r.httpCall("POST", path, body)
        }
        val parsed = try {
            JSONObject(res.bodyText)
        } catch (e: Exception) {
            throw RuntimeException("响应不是 JSON（HTTP ${res.status}）")
        }
        if (res.status >= 400 || parsed.has("error")) {
            throw RuntimeException(parsed.optString("error", "HTTP ${res.status}"))
        }
        return parsed
    }

    /** 工具页错误提示：状态条 + toast，绝不抛出（对齐 toolFail） */
    private fun toolFail(prefix: String, e: Exception) {
        val msg = stripCode(e.message ?: "$e")
        toolStatus = "$prefix：$msg"
        setStatus(toolStatus)
        toast(toolStatus)
        Log.w(TAG, "工具 $prefix: $msg")
    }

    private fun fmtSize(n: Long): String = when {
        n < 1024 -> "$n B"
        n < 1024 * 1024 -> String.format("%.1f KB", n / 1024.0)
        else -> String.format("%.1f MB", n / 1024.0 / 1024.0)
    }

    private fun parentOf(p: String): String {
        val cut = maxOf(p.lastIndexOf('\\'), p.lastIndexOf('/'))
        return if (cut > 2) p.substring(0, cut) else ""
    }

    /** 列表项完整路径（快捷项自带 path；普通项 = toolPath\name；盘符项 = name，对齐 fullPathOf） */
    private fun fullPathOf(item: ToolFileItem): String {
        if (item.quick || toolPath == "__drives__" || toolPath == "__quick__") {
            return if (item.path.isNotEmpty()) item.path else item.name
        }
        return if (toolPath.isNotEmpty()) "$toolPath\\${item.name}" else item.name
    }

    /** 工具主页：三张入口卡片（对齐 toolsView） */
    private fun showTools() {
        viewState = "tools"
        clearContainer()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        col.addView(TextView(this).apply {
            text = "工具"; textSize = 18f
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(4) })
        col.addView(TextView(this).apply {
            text = "与「${v2meta?.name ?: "电脑"}」互传文件 / 同步剪贴板 / 截屏（E2E 加密）"
            textSize = 12f; setTextColor(Color.parseColor("#6B6F80"))
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(12) })

        fun card(icon: String, title: String, desc: String, onClick: () -> Unit): LinearLayout {
            return LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), dp(16), dp(16), dp(16))
                setBackgroundColor(Color.parseColor("#F7F8FA"))
                setOnClickListener { onClick() }
                addView(TextView(this@MainActivity).apply { text = icon; textSize = 26f })
                addView(TextView(this@MainActivity).apply { text = title; textSize = 15f })
                addView(TextView(this@MainActivity).apply {
                    text = desc; textSize = 11f; setTextColor(Color.parseColor("#6B6F80"))
                })
            }
        }
        col.addView(card("📁", "文件互传", "浏览电脑文件并下载 / 上传手机文件（1GB 兜底）") {
            toolPath = ""; toolFiles = emptyList(); toolStatus = ""
            renderToolsFiles()
            scope.launch { loadToolDir("__quick__") }
        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        col.addView(card("📋", "剪贴板", "手机与电脑之间复制粘贴文本") {
            showToolsClip()
        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        col.addView(card("🖼️", "截图", "截取电脑屏幕并保存") {
            showToolsShot()
        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        col.addView(card("🖥️", "窗口实况", "实时查看电脑窗口画面，点击画面回传点击") {
            liveWindows = emptyList(); liveHwnd = ""; liveTitle = ""; liveFrames = 0
            liveRunning = false; toolStatus = ""
            showToolsLive()
            scope.launch { loadLiveWindows() }
        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        col.addView(card("🔎", "资料检索", "搜索电脑上已索引的文档并查看内容") {
            dsQuery = ""; dsResults = emptyList(); toolStatus = ""
            showToolsData()
            scope.launch { dataLoadSources() }
        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        col.addView(TextView(this).apply {
            text = toolStatus; textSize = 12f; setTextColor(Color.parseColor("#6B6F80"))
        })
        col.addView(Button(this).apply {
            text = "‹ 返回"
            setOnClickListener { gotoWebOrWait() }
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
        container.addView(ScrollView(this).apply { addView(col) }, FrameLayout.LayoutParams(-1, -1))
    }

    /** 浏览电脑目录：'__quick__'=快捷起始页；'' = 用户主目录；'__drives__' = 盘符列表（对齐 loadToolDir） */
    private suspend fun loadToolDir(path: String) {
        if (toolBusy) return
        toolBusy = true
        toolStatus = "加载目录中…"
        selMode = false
        selItems.clear()
        try {
            val parsed = toolCall("/__ph/files/list", JSONObject().put("path", path).toString())
            if (path == "__quick__") {
                val items = ArrayList<ToolFileItem>()
                val quick = parsed.optJSONArray("quick")
                if (quick != null) {
                    for (i in 0 until quick.length()) {
                        val m = quick.getJSONObject(i)
                        if (m.optBoolean("exists") != true) continue // 电脑上没有的入口不显示
                        items.add(ToolFileItem(m.optString("name"), true, 0, 0, m.optString("path"), quick = true))
                    }
                }
                toolPath = "__quick__"
                toolFiles = items
                toolStatus = ""
                withContextMain { renderToolsFiles() }
                return
            }
            if (path == "__drives__") {
                val items = ArrayList<ToolFileItem>()
                val roots = parsed.optJSONArray("roots")
                if (roots != null) {
                    for (i in 0 until roots.length()) {
                        val m = roots.getJSONObject(i)
                        items.add(ToolFileItem(m.optString("path"), true, 0, 0))
                    }
                }
                toolPath = "__drives__"
                toolFiles = items
                toolStatus = if (items.isEmpty()) "（未枚举到磁盘）" else ""
                withContextMain { renderToolsFiles() }
                return
            }
            val items = ArrayList<ToolFileItem>()
            val raw = parsed.optJSONArray("items")
            if (raw != null) {
                for (i in 0 until raw.length()) {
                    val m = raw.getJSONObject(i)
                    items.add(
                        ToolFileItem(
                            m.optString("name"), m.optBoolean("dir"),
                            m.optLong("size", 0), m.optLong("mtime", 0)
                        )
                    )
                }
            }
            toolPath = parsed.optString("path", path)
            toolFiles = items
            toolStatus = if (items.isEmpty()) "（空目录）" else ""
            withContextMain { renderToolsFiles() }
        } catch (e: Exception) {
            toolFail("读取目录失败", e)
        } finally {
            toolBusy = false
        }
    }

    private suspend fun withContextMain(block: () -> Unit) {
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) { block() }
    }

    /** 工具页文件列表渲染（含多选/上传/新建文件夹操作条，对齐 toolsFilesView） */
    private fun renderToolsFiles() {
        viewState = "toolsFiles"
        clearContainer()
        dlRowText = null
        dlRowBar = null
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(8), dp(16), dp(16))
        }
        // 标题行：‹（盘符根/快捷/盘符列表=回工具主页，否则回上级）
        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val navRoot = toolPath == "__quick__" || toolPath == "__drives__" ||
            Regex("^[a-zA-Z]:\\\\?$").matches(toolPath)
        head.addView(Button(this).apply {
            text = "‹"
            setOnClickListener {
                if (navRoot) showTools()
                else scope.launch { loadToolDir(parentOf(toolPath)) }
            }
        }, LinearLayout.LayoutParams(dp(48), -2))
        head.addView(TextView(this).apply {
            text = if (toolPath.isEmpty()) "电脑文件（主目录）" else
                (if (toolPath == "__quick__") "快捷入口" else
                    (if (toolPath == "__drives__" || navRoot) "此电脑" else toolPath))
            textSize = 14f
            layoutParams = LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = dp(4) }
        })
        col.addView(head)
        col.addView(TextView(this).apply {
            tag = "toolStatusView"
            text = toolStatus; textSize = 12f; setTextColor(Color.parseColor("#6B6F80"))
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(4) })

        // 单文件下载进度/续传提示行（显示在状态行下，对齐 ArkTS dlText）
        col.addView(TextView(this).apply {
            tag = "dlText"
            text = dlText
            textSize = 12f
            setTextColor(Color.parseColor(if (dlResume) "#D48806" else "#4D6BFE"))
            visibility = if (dlText.isEmpty()) View.GONE else View.VISIBLE
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(4) })

        // 批量取回中断续传条（对齐 ArkTS 2543-2559）：App 重启后仍在，点「继续」接着取
        if (batchLeft > 0 && !toolBusy) {
            val bar = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setBackgroundColor(Color.parseColor("#FFF7E6"))
                setPadding(dp(8), dp(8), dp(8), dp(8))
            }
            bar.addView(TextView(this).apply {
                text = "⏸ 批量取回中断，还剩 $batchLeft 个文件（点右侧继续）"
                textSize = 12f; setTextColor(Color.parseColor("#D48806"))
                layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
            })
            bar.addView(Button(this).apply {
                text = "继续"; textSize = 12f
                setOnClickListener { scope.launch { resumeBatch() } }
            })
            col.addView(bar, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        }

        // 操作条
        val ops = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        fun opBtn(label: String, onClick: () -> Unit): Button = Button(this).apply {
            text = label; textSize = 12f; setOnClickListener { onClick() }
        }
        ops.addView(opBtn(if (selMode) "退出多选" else "多选") {
            selMode = !selMode
            if (!selMode) selItems.clear()
            renderToolsFiles()
        })
        ops.addView(opBtn("上传") { pickAndUpload() })
        if (!navRoot && toolPath != "__quick__" && toolPath != "__drives__") {
            ops.addView(opBtn("新建文件夹") { showMkdirDialog() })
        }
        col.addView(ops, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })

        // 多选状态 + 批量下载按钮
        if (selMode) {
            col.addView(TextView(this).apply {
                text = "已选 ${selItems.size} 项"
                textSize = 12f; setTextColor(Color.parseColor("#4D6BFE"))
            })
            col.addView(Button(this).apply {
                text = "⬇ 批量下载所选"
                isEnabled = selItems.isNotEmpty()
                setOnClickListener { scope.launch { batchDownload() } }
            }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        }

        // 文件列表
        toolFiles.forEach { item ->
            val full = fullPathOf(item)
            // 🔴 下载蒙皮（对齐鸿蒙 2026-10-27）：正在下载/可续传的文件项本身变成进度条，
            //    点按 = 暂停（进行中） / 续传（已暂停）
            if (!item.dir && !selMode && full == dlItemPath && (dlActive || dlResume)) {
                val prow = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(12), dp(10), dp(12), dp(10))
                    setBackgroundColor(Color.parseColor("#4D6BFE"))
                    setOnClickListener {
                        if (dlActive) {
                            dlPauseReq = true
                            dlRowText?.text = "⏸ 正在暂停…"
                        } else if (dlResume) {
                            scope.launch { resumeDownload(full) }
                        }
                    }
                }
                prow.addView(TextView(this).apply {
                    text = (if (dlActive) "⬇ " else "⏸ ") + item.name
                    textSize = 14f; setTextColor(Color.WHITE)
                })
                dlRowBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
                    max = 10000
                    progress = 0
                    progressTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
                }
                prow.addView(dlRowBar, LinearLayout.LayoutParams(-1, dp(6)).apply { topMargin = dp(4); bottomMargin = dp(2) })
                dlRowText = TextView(this).apply {
                    text = if (dlActive) "准备下载…（点按暂停）" else "⏸ 已暂停，点按续传"
                    textSize = 11f; setTextColor(Color.WHITE)
                }
                prow.addView(dlRowText)
                col.addView(prow, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(4) })
                return@forEach
            }
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
                setBackgroundColor(Color.parseColor(
                    if (selMode && selItems.any { it.path == full }) "#EEF1FF" else "#F7F8FA"
                ))
                setOnClickListener { scope.launch { onToolFileTap(item) } }
            }
            if (selMode) {
                row.addView(TextView(this).apply {
                    text = if (selItems.any { it.path == full }) "☑" else "☐"; textSize = 16f
                }, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = dp(8) })
            }
            val vc = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            vc.addView(TextView(this).apply {
                text = (if (item.dir) "📁 " else "📄 ") + item.name; textSize = 14f
            })
            if (!item.dir && item.size > 0) {
                vc.addView(TextView(this).apply {
                    text = fmtSize(item.size); textSize = 10f; setTextColor(Color.parseColor("#9AA0B0"))
                })
            }
            row.addView(vc, LinearLayout.LayoutParams(0, -2, 1f))
            col.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(4) })
        }
        col.addView(Button(this).apply {
            text = "‹ 返回工具"
            setOnClickListener { showTools() }
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        container.addView(ScrollView(this).apply { addView(col) }, FrameLayout.LayoutParams(-1, -1))
    }

    /** 点击列表项：选择模式=勾选；快捷页/盘符页=进入；文件夹=进入；文件=下载到手机（对齐 onToolFileTap） */
    private suspend fun onToolFileTap(item: ToolFileItem) {
        if (selMode) {
            val full = fullPathOf(item)
            val existing = selItems.firstOrNull { it.path == full }
            if (existing != null) selItems.remove(existing)
            else selItems.add(SelItem(full, item.name, item.dir, item.size))
            withContextMain { renderToolsFiles() }
            return
        }
        if (toolBusy) return
        if (toolPath == "__quick__" || toolPath == "__drives__" || item.quick) {
            loadToolDir(if (item.quick && item.path.isNotEmpty()) item.path else item.name)
            return
        }
        if (item.dir) {
            loadToolDir(if (toolPath.isNotEmpty()) "$toolPath\\${item.name}" else item.name)
            return
        }
        // 断点续传（对齐 ArkTS 1496-1501）：点击显示「点此续传」的同一文件项 → 从断点继续
        val full0 = fullPathOf(item)
        if (dlResume && dlItemPath == full0) {
            resumeDownload(full0)
            return
        }
        if (item.size > 500L * 1024 * 1024) {
            toolStatus = "「${item.name}」超过 500MB，手机端不支持（请到电脑下载）"
            toast("文件超过 500MB，手机端不支持")
            withContextMain { renderToolsFiles() }
            return
        }
        toolBusy = true
        toolStatus = "" // 🔴 下载进度只显示在文件列表蒙皮，不写入全局状态（否则每个工具子页都会显示）
        dlItemPath = full0
        dlText = "准备下载…"
        dlResume = false
        dlActive = true
        dlPauseReq = false
        dlTotal = 0
        dlTarget = ""
        withContextMain { renderToolsFiles() }
        try {
            val full = full0
            // 分块下载：1MB/块经 /__ph/file/get-chunk 拉取，逐块直写文件——
            // 不再整文件 base64 进内存，不堵共享隧道；服务端限速（transferThrottleKbps）自动生效
            val CHUNK = 1024 * 1024
            val first = toolCall("/__ph/file/get-chunk",
                JSONObject().put("path", full).put("offset", 0).put("size", CHUNK).toString())
            if (first.has("error")) throw RuntimeException(first.optString("error"))
            val total = first.optLong("size", 0)
            val name = first.optString("name").ifBlank { item.name }
            if (total <= 0) throw RuntimeException("电脑返回的文件为空")
            dlName = name
            dlTotal = total
            val savePath = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                val dir = java.io.File(filesDir, "download").apply { mkdirs() }
                java.io.File(dir, name)
            }
            dlTarget = savePath.absolutePath
            dlSaveJob(full) // 任务持久化：中断后跨重启可续传
            var offset = first.optLong("offset", 0) + first.optLong("len", 0)
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                savePath.outputStream().use { out ->
                    out.write(android.util.Base64.decode(first.optString("b64"), android.util.Base64.DEFAULT))
                    withContextMain { updateDlRow(offset, total) }
                    while (offset < total) {
                        if (dlPauseReq) throw DownloadPausedSignal()
                        val parsed = toolCall("/__ph/file/get-chunk",
                            JSONObject().put("path", full).put("offset", offset).put("size", CHUNK).toString())
                        if (parsed.has("error")) throw RuntimeException(parsed.optString("error"))
                        val part = android.util.Base64.decode(parsed.optString("b64"), android.util.Base64.DEFAULT)
                        if (part.isEmpty()) throw RuntimeException("电脑返回空数据块（文件可能已变化），下载中断")
                        out.write(part)
                        out.flush()
                        offset = parsed.optLong("offset", offset) + parsed.optLong("len", part.size.toLong())
                        dlText = "下载中 ${offset / 1048576}MB / ${total / 1048576}MB"
                        withContextMain { updateDlRow(offset, total) }
                    }
                }
            }
            dlClearJob()
            dlItemPath = ""
            dlText = ""
            toolStatus = "✅ 已保存（应用目录）：${savePath.absolutePath}"
            toast("✅ 已下载「${savePath.name}」（应用目录）")
        } catch (e: Exception) {
            if (e is DownloadPausedSignal) {
                // 用户点按蒙皮暂停：断点保留，点按同一文件续传（对齐鸿蒙交互）；提示只在蒙皮，不进全局状态
                dlResume = true
                dlText = "⏸ 已暂停，点此续传"
                toolStatus = ""
                toast("⏸ 已暂停「$dlName」，断点已保留")
                dlSaveJob(full0)
            } else if (dlTotal > 0) {
                // 下载中断：不清断点，文件项显示「点此续传」，任务已持久化可跨重启续传
                dlResume = true
                dlText = "⏸ 下载中断，点此续传"
                dlSaveJob(full0)
            } else {
                dlItemPath = ""
                dlText = ""
            }
            if (e !is DownloadPausedSignal) toolFail("下载失败", e)
        } finally {
            dlActive = false
            toolBusy = false
            withContextMain { renderToolsFiles() }
        }
    }

    /** 蒙皮进度刷新（下载循环逐块调用；行不存在时静默） */
    private fun updateDlRow(offset: Long, total: Long) {
        val pct = if (total > 0) (offset * 10000 / total).toInt() else 0
        dlRowBar?.let { it.progress = pct }
        dlRowText?.let {
            it.text = "⬇ ${fmtSize(offset)} / ${fmtSize(total)}（${pct / 100}%，点按暂停）"
        }
    }

    // ---------------- 窗口实况（对齐 ArkTS toolsLive，2026-10-27 移植） ----------------

    /** 窗口选择页：列出电脑窗口，点选开始 800ms 轮询实况 */
    private fun showToolsLive() {
        viewState = "toolsLive"
        clearContainer()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        col.addView(TextView(this).apply {
            text = "窗口实况"; textSize = 18f; setTypeface(null, android.graphics.Typeface.BOLD)
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(4) })
        col.addView(TextView(this).apply {
            text = toolStatus.ifEmpty { "选择一个窗口开始实况（横屏显示，点击画面回传点击）" }
            textSize = 12f; setTextColor(Color.parseColor("#6B6F80"))
            tag = "toolStatusView"
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(12) })
        liveWindows.forEach { w ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
                setBackgroundColor(Color.parseColor("#F7F8FA"))
                setOnClickListener { pickLiveWindow(w) }
            }
            row.addView(TextView(this).apply {
                text = w.title.ifEmpty { "（无标题窗口）" }; textSize = 14f; maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            })
            row.addView(TextView(this).apply {
                text = "${w.w}×${w.h}" + (if (w.minimized) " · 已最小化" else "")
                textSize = 10f; setTextColor(Color.parseColor("#9AA0B0"))
            })
            col.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(6) })
        }
        col.addView(Button(this).apply {
            text = "‹ 返回工具"
            setOnClickListener { showTools() }
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        container.addView(ScrollView(this).apply { addView(col) }, FrameLayout.LayoutParams(-1, -1))
    }

    /** 获取电脑窗口列表（/__ph/windows/list） */
    private suspend fun loadLiveWindows() {
        if (toolBusy) return
        toolBusy = true
        toolStatus = "正在获取窗口列表…"
        try {
            val parsed = toolCall("/__ph/windows/list", "{}")
            val raw = parsed.optJSONArray("windows")
            val items = ArrayList<LiveWindowItem>()
            if (raw != null) for (i in 0 until raw.length()) {
                val m = raw.getJSONObject(i)
                items.add(LiveWindowItem(
                    m.optString("hwnd"), m.optString("title"),
                    m.optInt("w", 0), m.optInt("h", 0), m.optBoolean("minimized")))
            }
            liveWindows = items
            toolStatus = if (items.isNotEmpty()) "共 ${items.size} 个窗口，选择一个开始实况" else "电脑上没有可用的窗口"
        } catch (e: Exception) {
            toolFail("获取窗口列表失败", e)
        } finally {
            toolBusy = false
            withContextMain { if (viewState == "toolsLive") showToolsLive() }
        }
    }

    /** 选中窗口 → 横屏 + 立即拉首帧 + 800ms 轮询（对齐 pickLiveWindow） */
    private fun pickLiveWindow(item: LiveWindowItem) {
        if (liveRunning) stopLiveLoop()
        liveHwnd = item.hwnd
        liveTitle = item.title
        liveFrameB64 = ""
        liveFrames = 0
        toolStatus = ""
        liveRunning = true
        requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        renderLiveFrame()
        scope.launch { pollLiveFrame() }
        liveTimer?.cancel()
        liveTimer = java.util.Timer()
        liveTimer?.schedule(object : java.util.TimerTask() {
            override fun run() { scope.launch { pollLiveFrame() } }
        }, 800, 800)
    }

    /** 实况画面页：帧图 + 状态；点击画面回传归一化坐标；⛶ 悬浮按钮进/出全屏（沉浸模式） */
    private fun renderLiveFrame() {
        viewState = "toolsLiveFrame"
        clearContainer()
        val wrap = FrameLayout(this)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        head.addView(Button(this).apply {
            text = "‹"; textSize = 12f
            setOnClickListener { stopLiveLoop(); showToolsLive() }
        }, LinearLayout.LayoutParams(dp(56), -2))
        head.addView(TextView(this).apply {
            text = liveTitle.ifEmpty { "窗口实况" }; textSize = 12f; maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
            layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
        })
        head.addView(TextView(this).apply {
            text = "帧:$liveFrames"; textSize = 10f; setTextColor(Color.parseColor("#9AA0B0"))
        })
        if (!liveFullscreen) col.addView(head)
        liveStatText = TextView(this).apply {
            text = toolStatus; textSize = 10f; setTextColor(Color.parseColor("#D93026"))
            visibility = if (toolStatus.isEmpty()) View.GONE else View.VISIBLE
        }
        if (!liveFullscreen) col.addView(liveStatText)
        liveImg = ImageView(this).apply {
            setBackgroundColor(Color.parseColor("#1A1A1A"))
            scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
            setOnTouchListener { v, ev ->
                if (ev.action == android.view.MotionEvent.ACTION_DOWN) {
                    val nx = (ev.x / v.width.coerceAtLeast(1)).coerceIn(0f, 1f).toDouble()
                    val ny = (ev.y / v.height.coerceAtLeast(1)).coerceIn(0f, 1f).toDouble()
                    scope.launch { onLiveTap(nx, ny) }
                }
                false
            }
        }
        if (liveFrameB64.isNotEmpty()) {
            val bmp = decodeBmp(liveFrameB64)
            if (bmp != null) liveImg?.setImageBitmap(bmp)
        }
        col.addView(liveImg, LinearLayout.LayoutParams(-1, 0, 1f))
        wrap.addView(col, FrameLayout.LayoutParams(-1, -1))
        // ⛶ 悬浮全屏切换按钮（半透明小按钮，不遮画面主体）
        wrap.addView(Button(this).apply {
            text = if (liveFullscreen) "✕" else "⛶"
            textSize = 14f
            alpha = 0.7f
            setOnClickListener { liveFullscreen = !liveFullscreen; renderLiveFrame() }
        }, FrameLayout.LayoutParams(dp(44), dp(40), Gravity.TOP or Gravity.END).apply { topMargin = dp(8); marginEnd = dp(8) })
        container.addView(wrap, FrameLayout.LayoutParams(-1, -1))
        applyLiveFullscreenFlags()
    }

    /** 实况全屏（2026-10-27）：隐藏标题/状态行 + 沉浸模式（系统状态栏/导航栏隐藏） */
    private var liveFullscreen = false
    private fun applyLiveFullscreenFlags() {
        if (liveFullscreen) {
            window.decorView.systemUiVisibility =
                (android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
                    or android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
        } else {
            window.decorView.systemUiVisibility = android.view.View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    private fun decodeBmp(b64: String): android.graphics.Bitmap? = try {
        val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    } catch (e: Exception) { null }

    /** 拉一帧（上一帧未返回跳过；changed=false 零流量，对齐 pollLiveFrame） */
    private suspend fun pollLiveFrame() {
        if (!liveRunning || liveBusy || liveHwnd.isEmpty()) return
        liveBusy = true
        try {
            val parsed = toolCall("/__ph/live/frame",
                JSONObject().put("hwnd", liveHwnd).put("title", liveTitle).put("maxW", 1920).put("q", 60).toString())
            if (!liveRunning) return
            if (parsed.optBoolean("changed")) {
                val b64 = parsed.optString("b64")
                if (b64.isNotEmpty()) {
                    liveFrameB64 = b64
                    liveFrames += 1
                    val bmp = decodeBmp(b64)
                    Log.i(TAG, "实况帧到达: b64=${b64.length} decode=${bmp != null} ${bmp?.width}x${bmp?.height} view=$viewState")
                    withContextMain {
                        if (viewState == "toolsLiveFrame") {
                            if (bmp != null) liveImg?.setImageBitmap(bmp)
                            liveStatText?.visibility = View.GONE
                        }
                    }
                }
            } else {
                Log.d(TAG, "实况帧静止（changed=false）")
            }
        } catch (e: Exception) {
            if (liveRunning) {
                toolStatus = "实况拉帧失败：${stripCode(e.message ?: "$e")}"
                withContextMain {
                    if (viewState == "toolsLiveFrame") {
                        liveStatText?.text = toolStatus
                        liveStatText?.visibility = View.VISIBLE
                    }
                }
            }
        } finally {
            liveBusy = false
        }
    }

    /** 停止实况轮询并恢复竖屏 */
    private fun stopLiveLoop() {
        liveTimer?.cancel()
        liveTimer = null
        liveRunning = false
        liveHwnd = ""
        liveTitle = ""
        liveFrameB64 = ""
        liveFrames = 0
        if (liveFullscreen) {
            liveFullscreen = false
            window.decorView.systemUiVisibility = android.view.View.SYSTEM_UI_FLAG_VISIBLE
        }
        requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    }

    /** 点击回传（/__ph/click，归一化坐标；403=窗口已不在实况状态） */
    private suspend fun onLiveTap(nx: Double, ny: Double) {
        if (liveHwnd.isEmpty() || toolBusy) return
        toolBusy = true
        try {
            val parsed = toolCall("/__ph/click",
                JSONObject().put("hwnd", liveHwnd).put("x", nx).put("y", ny).put("title", liveTitle).toString())
            toast("已点击 (${parsed.optInt("sx", 0)},${parsed.optInt("sy", 0)})")
        } catch (e: Exception) {
            val msg = stripCode(e.message ?: "$e")
            if (msg.contains("403")) toast("窗口已不在实况状态")
            else toolFail("点击回传失败", e)
        } finally {
            toolBusy = false
        }
    }

    // ---------------- 资料检索（对齐 ArkTS toolsData，2026-10-27 移植） ----------------

    /** 检索页：已索引统计 + 关键词输入 + 结果列表 */
    private fun showToolsData() {
        viewState = "toolsData"
        clearContainer()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        col.addView(TextView(this).apply {
            text = "资料检索"; textSize = 18f; setTypeface(null, android.graphics.Typeface.BOLD)
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(4) })
        col.addView(TextView(this).apply {
            text = if (dsIndexed >= 0) "已索引 ${dsIndexed} 个文件，输入关键词搜索电脑上的文档"
            else "输入关键词搜索电脑上已索引的文档"
            textSize = 12f; setTextColor(Color.parseColor("#6B6F80"))
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(8) })
        val inputRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        inputRow.addView(EditText(this).apply {
            hint = "关键词（如：会议纪要）"; textSize = 14f
            setText(dsQuery)
            layoutParams = LinearLayout.LayoutParams(0, dp(44), 1f).apply { marginEnd = dp(8) }
        }.also { et -> dsInput = et })
        inputRow.addView(Button(this).apply {
            text = "搜索"
            setOnClickListener {
                dsQuery = dsInput?.text?.toString()?.trim() ?: ""
                scope.launch { dataSearch() }
            }
        })
        col.addView(inputRow, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        col.addView(TextView(this).apply {
            text = toolStatus; textSize = 12f; setTextColor(Color.parseColor("#6B6F80"))
            tag = "toolStatusView"
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(8) })
        dsResults.forEach { dsIt ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
                setBackgroundColor(Color.parseColor("#F7F8FA"))
                setOnClickListener { scope.launch { dataRead(dsIt, "toolsData") } }
            }
            row.addView(TextView(this).apply {
                text = dsIt.name; textSize = 14f; maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            })
            row.addView(TextView(this).apply {
                text = dsIt.path; textSize = 10f; setTextColor(Color.parseColor("#9AA0B0")); maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
            })
            if (dsIt.size > 0) {
                row.addView(TextView(this).apply {
                    text = "${fmtSize(dsIt.size)} · 命中 ${dsIt.hits.size} 处"
                    textSize = 10f; setTextColor(Color.parseColor("#4D6BFE"))
                })
            }
            col.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(6) })
        }
        col.addView(Button(this).apply {
            text = "‹ 返回工具"
            setOnClickListener { showTools() }
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        container.addView(ScrollView(this).apply { addView(col) }, FrameLayout.LayoutParams(-1, -1))
    }

    /** 已索引统计（/__ph/data/sources） */
    private suspend fun dataLoadSources() {
        dsIndexed = -1
        try {
            val parsed = toolCall("/__ph/data/sources", "{}")
            var total = 0L
            val raw = parsed.optJSONArray("sources")
            if (raw != null) for (i in 0 until raw.length()) total += raw.getJSONObject(i).optLong("files", 0)
            dsIndexed = total
        } catch (e: Exception) {
            Log.w(TAG, "资料检索 sources 获取失败: ${e.message}")
        }
        withContextMain { if (viewState == "toolsData") showToolsData() }
    }

    /** 关键词搜索（/__ph/data/search，limit 20） */
    private suspend fun dataSearch() {
        val q = dsQuery.trim()
        if (q.isEmpty()) { toast("请输入关键词"); return }
        if (toolBusy) return
        toolBusy = true
        toolStatus = "搜索中…"
        withContextMain { if (viewState == "toolsData") showToolsData() }
        try {
            val parsed = toolCall("/__ph/data/search",
                JSONObject().put("query", q).put("limit", 20).toString())
            val raw = parsed.optJSONArray("results")
            val items = ArrayList<DataSearchItem>()
            if (raw != null) for (i in 0 until raw.length()) {
                val m = raw.getJSONObject(i)
                val hits = ArrayList<String>()
                val hraw = m.optJSONArray("hits")
                if (hraw != null) for (j in 0 until hraw.length()) hits.add(hraw.optString(j))
                items.add(DataSearchItem(m.optString("path"), m.optString("name"),
                    m.optLong("size", 0), m.optLong("mtime", 0), hits))
            }
            dsResults = items
            toolStatus = if (items.isEmpty()) "未找到，试试更短的关键词" else "找到 ${items.size} 个文件"
        } catch (e: Exception) {
            dsResults = emptyList()
            toolFail("搜索失败", e)
        } finally {
            toolBusy = false
            withContextMain { if (viewState == "toolsData") showToolsData() }
        }
    }

    // ---- 内容查看（分层预览：/__ph/file/preview → 图片/html；失败回落 /__ph/data/read 文本） ----
    private var previewHtml = ""
    private var previewB64 = ""

    private suspend fun dataRead(item: DataSearchItem, from: String) {
        if (toolBusy) return
        toolBusy = true
        toolStatus = "正在打开「${item.name}」…"
        dsReadBack = from
        try {
            var parsed: JSONObject? = null
            var previewErr = ""
            try {
                parsed = toolCall("/__ph/file/preview", JSONObject().put("path", item.path).toString())
            } catch (e: Exception) { previewErr = stripCode(e.message ?: "$e") }
            val kind = parsed?.optString("kind") ?: ""
            if (kind == "image") {
                previewB64 = parsed?.optString("b64") ?: ""
                previewHtml = ""
                withContextMain { renderDataRead(item.path, "image") }
                return
            }
            if (kind == "html") {
                previewHtml = parsed?.optString("content") ?: ""
                previewB64 = ""
                withContextMain { renderDataRead(item.path, "html") }
                return
            }
            if (previewErr.isNotEmpty()) toolStatus = "⚠️ $previewErr（尝试以文本打开）"
            val old = toolCall("/__ph/data/read",
                JSONObject().put("path", item.path).put("maxKB", 64).toString())
            previewHtml = "<meta charset=\"utf-8\"><pre style=\"white-space:pre-wrap;font:13px/1.6 ui-monospace,Consolas,monospace;padding:12px\">${
                android.text.Html.escapeHtml(old.optString("content"))}</pre>"
            previewB64 = ""
            withContextMain { renderDataRead(item.path, "html") }
        } catch (e: Exception) {
            toolFail("读取失败", e)
        } finally {
            toolBusy = false
        }
    }

    /** 内容查看页：图片用 ImageView，html/文本用只读 WebView */
    private fun renderDataRead(path: String, kind: String) {
        viewState = "toolsDataRead"
        clearContainer()
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        head.addView(Button(this).apply {
            text = "‹"; textSize = 12f
            setOnClickListener { if (dsReadBack == "toolsFiles") renderToolsFiles() else showToolsData() }
        }, LinearLayout.LayoutParams(dp(56), -2))
        head.addView(TextView(this).apply {
            text = path.substringAfterLast('\\').substringAfterLast('/')
            textSize = 13f; maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
            layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
        })
        col.addView(head)
        if (kind == "image" && previewB64.isNotEmpty()) {
            val bmp = decodeBmp(previewB64)
            if (bmp != null) {
                col.addView(ImageView(this).apply {
                    adjustViewBounds = true
                    setImageBitmap(bmp)
                }, LinearLayout.LayoutParams(-1, -2))
                container.addView(ScrollView(this).apply { addView(col) }, FrameLayout.LayoutParams(-1, -1))
                return
            }
        }
        val wv = WebView(this).apply {
            settings.javaScriptEnabled = false
            loadDataWithBaseURL(null, previewHtml, "text/html", "utf-8", null)
        }
        col.addView(wv, LinearLayout.LayoutParams(-1, 0, 1f))
        container.addView(col, FrameLayout.LayoutParams(-1, -1))
    }

    /** 断点续传（对齐 ArkTS resumeDownload）：APPEND 打开原目标，从已有字节数继续拉块 */
    private suspend fun resumeDownload(full: String) {
        if (toolBusy) return
        val total = dlTotal
        val name = dlName
        if (name.isEmpty() || total <= 0) {
            dlResume = false
            return
        }
        toolBusy = true
        dlResume = false
        dlActive = true
        dlPauseReq = false
        toolStatus = "" // 同上：续传进度只走蒙皮
        try {
            val savePath = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                if (dlTarget.isNotEmpty()) java.io.File(dlTarget) else {
                    val dir = java.io.File(filesDir, "download").apply { mkdirs() }
                    java.io.File(dir, name)
                }
            }
            if (dlTarget.isEmpty()) {
                dlTarget = savePath.absolutePath
                dlSaveJob(full)
            }
            var offset = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                savePath.apply { parentFile?.mkdirs() }.let { if (it.exists()) it.length() else 0L }
            }
            if (offset >= total) {
                dlClearJob()
                dlItemPath = ""
                dlText = ""
                toolStatus = "✅「$name」已完整（${total / 1048576}MB）"
                return
            }
            dlText = "下载中 ${offset / 1048576}MB / ${total / 1048576}MB"
            val CHUNK = 1024 * 1024
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                java.io.FileOutputStream(savePath, true).use { out ->
                    withContextMain { updateDlRow(offset, total) }
                    while (offset < total) {
                        if (dlPauseReq) throw DownloadPausedSignal()
                        val parsed = toolCall("/__ph/file/get-chunk",
                            JSONObject().put("path", full).put("offset", offset).put("size", CHUNK).toString())
                        if (parsed.has("error")) throw RuntimeException(parsed.optString("error"))
                        val part = android.util.Base64.decode(parsed.optString("b64"), android.util.Base64.DEFAULT)
                        if (part.isEmpty()) throw RuntimeException("电脑返回空数据块（文件可能已变化），续传中断")
                        out.write(part)
                        out.flush()
                        offset = parsed.optLong("offset", offset) + parsed.optLong("len", part.size.toLong())
                        dlText = "下载中 ${offset / 1048576}MB / ${total / 1048576}MB"
                        withContextMain { updateDlRow(offset, total) }
                    }
                }
            }
            dlClearJob()
            dlItemPath = ""
            dlText = ""
            toolStatus = "✅ 已续传完成「$name」"
            toast("✅ 已续传完成「$name」")
        } catch (e: Exception) {
            if (e is DownloadPausedSignal) {
                dlResume = true
                dlText = "⏸ 已暂停，点此续传"
                toolStatus = ""
                toast("⏸ 已暂停「$name」，断点已保留")
                dlSaveJob(full)
            } else {
                dlResume = true
                dlText = "⏸ 下载中断，点此续传"
                dlSaveJob(full)
                toolFail("续传失败", e)
            }
        } finally {
            dlActive = false
            toolBusy = false
            withContextMain { renderToolsFiles() }
        }
    }

    /** 上传到电脑：系统多选文件 → /__ph/file/put；>1MB 走分片 put-chunk（2026-10-26，对齐鸿蒙版）
     *  分片按 1MB 读流，不全量进内存；服务端 1GB 兜底，超限服务端报错 */
    private fun pickAndUpload() {
        if (toolBusy) return
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
            startActivityForResult(intent, REQ_PICK_FILES)
        } catch (e: Exception) {
            toast("无法打开文件选择器: ${e.message}")
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PICK_FILES || resultCode != RESULT_OK || data == null) return
        val uris = ArrayList<Uri>()
        data.clipData?.let { cd ->
            for (i in 0 until cd.itemCount) uris.add(cd.getItemAt(i).uri)
        } ?: data.data?.let { uris.add(it) }
        if (uris.isEmpty()) return
        scope.launch {
            val targetDir = if (toolPath.isNotEmpty() && toolPath != "__quick__" && toolPath != "__drives__") toolPath else ""
            var ok = 0
            toolBusy = true
            try {
                for ((i, uri) in uris.withIndex()) {
                    val name = queryDisplayName(uri) ?: "upload-$i.bin"
                    val size = querySize(uri) ?: -1L
                    val CHUNK = 1024 * 1024
                    if (size in 0..CHUNK.toLong()) {
                        // 小文件（或未知大小且 ≤1MB）单发
                        val bytes = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                            contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        } ?: continue
                        toolStatus = "上传中 ${i + 1}/${uris.size}：「$name」…"
                        withContextMain { renderToolsFiles() }
                        val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                        val parsed = toolCall(
                            "/__ph/file/put",
                            JSONObject().put("name", name).put("b64", b64).put("dir", targetDir).toString()
                        )
                        if (parsed.has("error")) throw RuntimeException(parsed.optString("error"))
                    } else if (size > CHUNK.toLong()) {
                        // 大文件分片（2026-10-26）：1MB/块发 /__ph/file/put-chunk，逐块读流
                        val n = Math.ceil(size.toDouble() / CHUNK).toInt()
                        val uploadId = System.currentTimeMillis().toString(36) +
                            (Math.random() * 46656).toInt().toString(36)
                        for (seq in 1..n) {
                            val len = Math.min(CHUNK.toLong(), size - (seq - 1).toLong() * CHUNK).toInt()
                            val buf = ByteArray(len)
                            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                contentResolver.openInputStream(uri)?.use { input ->
                                    var skipped = 0L
                                    while (skipped < (seq - 1).toLong() * CHUNK) {
                                        skipped += input.skip((seq - 1).toLong() * CHUNK - skipped)
                                    }
                                    var read = 0
                                    while (read < len) {
                                        val r = input.read(buf, read, len - read)
                                        if (r < 0) break
                                        read += r
                                    }
                                }
                            }
                            toolStatus = "上传中 ${i + 1}/${uris.size}「$name」分片 $seq/$n…"
                            withContextMain { renderToolsFiles() }
                            val b64 = android.util.Base64.encodeToString(buf, android.util.Base64.NO_WRAP)
                            val parsed = toolCall(
                                "/__ph/file/put-chunk",
                                JSONObject().put("uploadId", uploadId).put("seq", seq).put("n", n)
                                    .put("name", name).put("dir", targetDir).put("b64", b64)
                                    .put("fin", seq == n).toString()
                            )
                            if (parsed.has("error")) throw RuntimeException(parsed.optString("error"))
                        }
                    } else {
                        // 大小未知：全量读出后按大小选路
                        val bytes = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                            contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        } ?: continue
                        val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                        val parsed = if (bytes.size <= CHUNK) {
                            toolCall("/__ph/file/put",
                                JSONObject().put("name", name).put("b64", b64).put("dir", targetDir).toString())
                        } else {
                            val n = Math.ceil(bytes.size.toDouble() / CHUNK).toInt()
                            val uploadId = System.currentTimeMillis().toString(36) +
                                (Math.random() * 46656).toInt().toString(36)
                            var lastOk = JSONObject()
                            for (seq in 1..n) {
                                val from = (seq - 1) * CHUNK
                                val to = Math.min(bytes.size, seq * CHUNK)
                                val part = android.util.Base64.encodeToString(
                                    bytes.copyOfRange(from, to), android.util.Base64.NO_WRAP)
                                toolStatus = "上传中 ${i + 1}/${uris.size}「$name」分片 $seq/$n…"
                                withContextMain { renderToolsFiles() }
                                lastOk = toolCall(
                                    "/__ph/file/put-chunk",
                                    JSONObject().put("uploadId", uploadId).put("seq", seq).put("n", n)
                                        .put("name", name).put("dir", targetDir).put("b64", part)
                                        .put("fin", seq == n).toString()
                                )
                                if (lastOk.has("error")) throw RuntimeException(lastOk.optString("error"))
                            }
                            lastOk
                        }
                        if (parsed.has("error")) throw RuntimeException(parsed.optString("error"))
                    }
                    ok++
                    toolStatus = "已传 $ok/${uris.size}，最新：「$name」"
                }
                toolStatus = "✅ 已上传 $ok/${uris.size} 个文件${if (targetDir.isNotEmpty()) " → $targetDir" else "（收件箱）"}"
                toast("✅ 已传 $ok/${uris.size} 个文件")
            } catch (e: Exception) {
                toolFail("上传失败", e)
            } finally {
                toolBusy = false
                withContextMain { renderToolsFiles() }
            }
        }
    }

    /** OpenDocument URI 的字节大小（-1 = 未知） */
    private fun querySize(uri: Uri): Long? {
        return try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                val idx = c.getColumnIndex(android.provider.OpenableColumns.SIZE)
                if (c.moveToFirst() && idx >= 0 && !c.isNull(idx)) c.getLong(idx) else null
            }
        } catch (e: Exception) {
            null
        }
    }

    /** OpenDocument URI 的显示名（content resolver query） */
    private fun queryDisplayName(uri: Uri): String? {
        return try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                val idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (c.moveToFirst() && idx >= 0) c.getString(idx) else null
            } ?: uri.lastPathSegment
        } catch (e: Exception) {
            uri.lastPathSegment
        }
    }

    /** 新建文件夹输入浮层（对齐 mkdirHere） */
    private fun showMkdirDialog() {
        if (toolPath.isEmpty() || toolPath == "__quick__" || toolPath == "__drives__") {
            toast("先进入一个具体目录再新建文件夹")
            return
        }
        val input = EditText(this).apply { hint = "文件夹名" }
        AlertDialog.Builder(this)
            .setTitle("新建文件夹")
            .setView(input)
            .setPositiveButton("创建") { d, _ ->
                val name = input.text.toString().trim()
                d.dismiss()
                if (name.isNotEmpty()) {
                    scope.launch { mkdirHere(name) }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private suspend fun mkdirHere(name: String) {
        if (toolBusy) return
        toolBusy = true
        toolStatus = "新建文件夹「$name」…"
        withContextMain { renderToolsFiles() }
        try {
            toolCall("/__ph/files/mkdir", JSONObject().put("path", "$toolPath\\$name").toString())
            toolStatus = "✅ 已新建「$name」"
            toast("✅ 已新建 $name")
            loadToolDir("$toolPath\\$name") // 直接进入新目录
        } catch (e: Exception) {
            toolFail("新建文件夹失败", e)
        } finally {
            toolBusy = false
        }
    }

    /** 批量下载（多选）：文件直存应用下载目录；文件夹先 files/tree 收集再逐个取回（对齐 batchDownload）。
     *  断点续传（2026-10-26）：任务清单+进度持久化，中断后重进工具页显示续传条，点「继续」接着取 */
    private suspend fun batchDownload() {
        if (toolBusy || selItems.isEmpty()) return
        toolBusy = true
        val dlDir = java.io.File(filesDir, "download").apply { mkdirs() }
        var ok = 0
        var skip = 0
        try {
            // 展开全部选中项为待取文件清单（文件夹 → files/tree）
            val files = ArrayList<BatchFile>()
            val snapshot = selItems.toList()
            for (sel in snapshot) {
                if (sel.dir) {
                    toolStatus = "清点文件夹「${sel.name}」…"
                    withContextMain { renderToolsFiles() }
                    val tree = toolCall("/__ph/files/tree", JSONObject().put("path", sel.path).toString())
                    val fl = tree.optJSONArray("files")
                    if (fl != null) {
                        for (i in 0 until fl.length()) {
                            val m = fl.getJSONObject(i)
                            files.add(BatchFile(m.optString("path"), safeDirName(sel.name) + "/" + m.optString("rel"), m.optLong("size", 0)))
                        }
                    }
                    if (tree.optBoolean("truncated")) {
                        toolStatus = "⚠️「${sel.name}」过大被截断，只取前 2000 个/500MB"
                    }
                } else {
                    files.add(BatchFile(sel.path, safeDirName(sel.name), sel.size))
                }
            }
            batchFiles = files
            batchIndex = 0
            for (i in files.indices) {
                batchIndex = i
                val one = files[i]
                if (one.size > 500L * 1024 * 1024) {
                    skip++
                    batchSaveJob()
                    continue
                }
                toolStatus = "取回中（$i/${files.size}）：${one.rel}"
                withContextMain { renderToolsFiles() }
                if (batchFetchOne(one, dlDir)) ok++ else skip++
                batchSaveJob() // 每个文件完成即持久化进度（i = batchIndex + 1）
            }
            batchClearJob()
            batchLeft = 0
            batchFiles = emptyList()
            batchIndex = 0
            toolStatus = "✅ 批量取回完成：$ok 个文件${if (skip > 0) "（跳过 $skip 个：超限/空）" else ""} → $dlDir"
            toast("✅ 已取回 $ok 个文件")
            selMode = false
            selItems.clear()
        } catch (e: Exception) {
            // 中断：保留断点，列表上方显示续传条
            batchSaveJob()
            batchLeft = batchFiles.size - batchIndex
            toolFail("批量下载中断", e)
        } finally {
            toolBusy = false
            withContextMain { renderToolsFiles() }
        }
    }

    /** 批量取回单个文件到应用下载目录；已存在部分文件时 APPEND 续写（断点续传，对齐 batchFetchOne）。
     *  返回 true=取回成功/本已完整；false=跳过（空文件） */
    private suspend fun batchFetchOne(one: BatchFile, dlDir: java.io.File): Boolean = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        val savePath = java.io.File(dlDir, one.rel.replace('\\', '/'))
        savePath.parentFile?.mkdirs() // 文件夹传送保持结构
        var offset = if (savePath.exists()) savePath.length() else 0L
        try {
            val CHUNK = 1024 * 1024
            if (offset > 0) {
                // 已有一部分：探测远端总大小（1 字节探针），已完整则直接返回
                val probe = toolCall("/__ph/file/get-chunk",
                    JSONObject().put("path", one.path).put("offset", 0).put("size", 1).toString())
                if (probe.has("error")) throw RuntimeException(probe.optString("error"))
                val total = probe.optLong("size", 0)
                if (total in 1..offset) return@withContext true
            }
            java.io.FileOutputStream(savePath, true).use { out ->
                var total = -1L
                while (total < 0 || offset < total) {
                    val parsed = toolCall("/__ph/file/get-chunk",
                        JSONObject().put("path", one.path).put("offset", offset).put("size", CHUNK).toString())
                    if (parsed.has("error")) throw RuntimeException(parsed.optString("error"))
                    val part = android.util.Base64.decode(parsed.optString("b64"), android.util.Base64.DEFAULT)
                    if (part.isEmpty()) {
                        if (total >= 0) break // 已到文件尾
                        return@withContext false // 空文件，跳过
                    }
                    out.write(part)
                    out.flush()
                    offset = parsed.optLong("offset", offset) + parsed.optLong("len", part.size.toLong())
                    total = parsed.optLong("size", offset)
                }
            }
            true
        } catch (e: Exception) {
            if (offset > 0 || savePath.exists()) batchSaveJob() // 保断点
            throw e
        }
    }

    /** 批量下载断点续传：点续传条「继续」触发，从 batchIndex 接着取（对齐 resumeBatch） */
    private suspend fun resumeBatch() {
        if (toolBusy || batchLeft <= 0) return
        toolBusy = true
        val dlDir = java.io.File(filesDir, "download").apply { mkdirs() }
        var ok = 0
        try {
            while (batchIndex < batchFiles.size) {
                val one = batchFiles[batchIndex]
                toolStatus = "续传批量取回（${batchIndex + 1}/${batchFiles.size}）：${one.rel}"
                withContextMain { renderToolsFiles() }
                if (batchFetchOne(one, dlDir)) ok++
                batchSaveJob()
                batchIndex++
                batchLeft = batchFiles.size - batchIndex
            }
            batchClearJob()
            batchLeft = 0
            batchFiles = emptyList()
            batchIndex = 0
            toolStatus = "✅ 批量取回完成（含续传 $ok 个）→ $dlDir"
            toast("✅ 批量取回完成（含续传 $ok 个）")
        } catch (e: Exception) {
            batchSaveJob()
            batchLeft = batchFiles.size - batchIndex
            toolFail("批量续传失败", e)
        } finally {
            toolBusy = false
            withContextMain { renderToolsFiles() }
        }
    }

    /** 目录名转安全文件名（批量下载子目录用，对齐 safeDirName） */
    private fun safeDirName(name: String): String =
        name.replace('\\', '_').replace('/', '_').replace(':', '_').ifEmpty { "dir" }

    /** 剪贴板子页：从电脑取 / 发送到电脑（对齐 toolsClipView + clipFromPc/clipToPc） */
    private fun showToolsClip() {
        viewState = "toolsClip"
        clearContainer()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        head.addView(Button(this).apply { text = "‹"; setOnClickListener { showTools() } }, LinearLayout.LayoutParams(dp(48), -2))
        head.addView(TextView(this).apply { text = "剪贴板同步"; textSize = 18f })
        col.addView(head)
        col.addView(TextView(this).apply {
            text = "手机与电脑之间复制粘贴文本（E2E 加密）"
            textSize = 12f; setTextColor(Color.parseColor("#6B6F80"))
        }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(12) })
        col.addView(Button(this).apply {
            text = "⬇ 从电脑取剪贴板"
            setOnClickListener { scope.launch { clipFromPc() } }
        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        col.addView(Button(this).apply {
            text = "⬆ 发送手机剪贴板到电脑"
            setOnClickListener { scope.launch { clipToPc() } }
        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        col.addView(TextView(this).apply {
            tag = "clipText"
            text = "（剪贴板内容显示在这里）"
            textSize = 12f; setTextColor(Color.parseColor("#6B6F80"))
        })
        col.addView(TextView(this).apply {
            text = toolStatus; textSize = 12f; setTextColor(Color.parseColor("#6B6F80"))
        }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(8) })
        col.addView(Button(this).apply {
            text = "‹ 返回工具"
            setOnClickListener { showTools() }
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
        container.addView(ScrollView(this).apply { addView(col) }, FrameLayout.LayoutParams(-1, -1))
    }

    private fun setClipTextDisplay(text: String) {
        val v = container.findViewWithTag<TextView>("clipText") ?: return
        v.text = if (text.isEmpty()) "（电脑剪贴板是空的）" else text
    }

    /** 从电脑取剪贴板 → 存入手机剪贴板并显示（对齐 clipFromPc） */
    private suspend fun clipFromPc() {
        if (toolBusy) return
        toolBusy = true
        toolStatus = "正在从电脑取剪贴板…"
        withContextMain { renderToolsClipStatus() }
        try {
            val parsed = toolCall("/__ph/clipboard/get", "{}")
            val text = parsed.optString("text")
            if (text.isNotEmpty()) {
                val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.setPrimaryClip(android.content.ClipData.newPlainText("hh", text))
            }
            toolStatus = if (text.isNotEmpty()) "✅ 已取到并复制到手机剪贴板" else "电脑剪贴板是空的"
            toast(toolStatus)
            withContextMain { setClipTextDisplay(text) }
        } catch (e: Exception) {
            toolFail("取剪贴板失败", e)
        } finally {
            toolBusy = false
        }
    }

    private fun renderToolsClipStatus() {
        if (viewState == "toolsClip") showToolsClip()
    }

    /** 读手机剪贴板 → 发送到电脑（对齐 clipToPc） */
    private suspend fun clipToPc() {
        if (toolBusy) return
        toolBusy = true
        toolStatus = "正在发送到电脑…"
        try {
            val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
            val text = cm.primaryClip?.getItemAt(0)?.text?.toString() ?: ""
            if (text.isEmpty()) {
                toolStatus = "手机剪贴板是空的"
                toast("手机剪贴板是空的")
                return
            }
            toolCall("/__ph/clipboard/set", JSONObject().put("text", text).toString())
            toolStatus = "✅ 已发送到电脑剪贴板"
            toast(toolStatus)
        } catch (e: Exception) {
            toolFail("发送剪贴板失败", e)
        } finally {
            toolBusy = false
        }
    }

    /** 截图子页：电脑截屏 → 存应用沙箱并预览（对齐 toolsShotView + takeScreenshot） */
    private fun showToolsShot() {
        viewState = "toolsShot"
        clearContainer()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        head.addView(Button(this).apply { text = "‹"; setOnClickListener { showTools() } }, LinearLayout.LayoutParams(dp(48), -2))
        head.addView(TextView(this).apply { text = "电脑截图"; textSize = 18f })
        col.addView(head)
        col.addView(Button(this).apply {
            text = "📸 截取电脑屏幕"
            setOnClickListener { scope.launch { takeScreenshot() } }
        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        val iv = ImageView(this).apply {
            tag = "shotPreview"
            adjustViewBounds = true
        }
        col.addView(iv, LinearLayout.LayoutParams(-1, -2))
        col.addView(TextView(this).apply {
            text = toolStatus
            textSize = 12f; setTextColor(Color.parseColor("#6B6F80"))
        }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(8) })
        col.addView(Button(this).apply {
            text = "‹ 返回工具"
            setOnClickListener { showTools() }
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
        container.addView(ScrollView(this).apply { addView(col) }, FrameLayout.LayoutParams(-1, -1))
    }

    private var lastShotFile: java.io.File? = null

    /** 电脑截屏 → 存应用沙箱并预览（对齐 takeScreenshot；保存到系统下载 TODO，见 README） */
    private suspend fun takeScreenshot() {
        if (toolBusy) return
        toolBusy = true
        toolStatus = "正在截图…"
        try {
            val parsed = toolCall("/__ph/screenshot", "{}")
            val b64 = parsed.optString("b64")
            if (b64.isEmpty()) throw RuntimeException("电脑未返回截图内容")
            val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
            val savePath = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                val dir = java.io.File(filesDir, "screenshots").apply { mkdirs() }
                java.io.File(dir, "shot_${System.currentTimeMillis()}.png").apply {
                    outputStream().use { it.write(bytes) }
                }
            }
            lastShotFile = savePath
            val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            withContextMain {
                container.findViewWithTag<ImageView>("shotPreview")?.setImageBitmap(bmp)
            }
            toolStatus = "截图完成：${savePath.absolutePath}"
            toast("✅ 截图完成")
        } catch (e: Exception) {
            toolFail("截图失败", e)
        } finally {
            toolBusy = false
        }
    }

    companion object {
        private const val REQ_PICK_FILES = 4001
    }
}
