// WebOS v2 桌面壳：访问端浏览器里的线上操作系统（开始菜单/任务栏/窗口化资源管理器/程序接管）
// 双通道自适应：
//   本机 dsh origin —— GET /api/ph-webos（页面）+ POST /api/ph-webos/api（shim，body 带 __ph 转发 onToolRequest）
//   桥接中继 origin —— GET /r/<key>/__ph/webos；页面内相对 POST 自动落到 /r/<key>/__ph/<端点>
// 零构建：单文件 vanilla JS，与 bridge-toolbar 同款策略
export const webosHtml = () => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WebOS · 远程桌面</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
  html, body { height: 100%; overflow: hidden; }
  body {
    font: 13px/1.5 -apple-system, 'Segoe UI', 'HarmonyOS Sans', system-ui, sans-serif;
    background: #0b1020 url('') ;
    background-image:
      radial-gradient(1200px 700px at 20% 10%, #1b2a5e 0%, transparent 60%),
      radial-gradient(1000px 600px at 85% 25%, #3a1c5e 0%, transparent 55%),
      radial-gradient(900px 900px at 60% 100%, #0e3a4e 0%, transparent 60%),
      linear-gradient(160deg, #0b1020 0%, #101828 100%);
    color: #E6EAF2;
  }
  /* ---------- 桌面 ---------- */
  #desktop { position: fixed; inset: 0 0 52px 0; }
  #icons { position: absolute; top: 18px; left: 18px; display: flex; flex-direction: column; gap: 10px; }
  .dicon { width: 84px; padding: 10px 4px 8px; border-radius: 10px; text-align: center; cursor: pointer; border: 1px solid transparent; }
  .dicon:hover { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.14); }
  .dicon .ic { font-size: 30px; line-height: 1.2; }
  .dicon .lb { font-size: 12px; margin-top: 4px; color: #D8DEE9; text-shadow: 0 1px 3px rgba(0,0,0,.6); word-break: break-all; }
  /* ---------- 任务栏 ---------- */
  #taskbar {
    position: fixed; left: 0; right: 0; bottom: 0; height: 52px; z-index: 5000;
    display: flex; align-items: center; gap: 6px; padding: 0 10px;
    background: rgba(16,20,32,.82); backdrop-filter: blur(14px);
    border-top: 1px solid rgba(255,255,255,.08);
  }
  #start-btn {
    height: 38px; padding: 0 14px; border: none; border-radius: 8px; cursor: pointer;
    background: linear-gradient(135deg, #2b5fdb, #4a3fd8); color: #fff; font-size: 15px; font-weight: 600;
  }
  #start-btn:hover { filter: brightness(1.15); }
  #task-btns { flex: 1; display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
  .task-btn {
    height: 38px; max-width: 190px; padding: 0 12px; border-radius: 8px; cursor: pointer;
    border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.06); color: #DDE3EE;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px;
  }
  .task-btn.active { background: rgba(84,120,240,.35); border-color: rgba(120,150,255,.5); }
  .task-btn.min { opacity: .55; }
  #tray { display: flex; align-items: center; gap: 8px; color: #AAB4C8; font-size: 12px; }
  #tray .mini {
    height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.08);
    background: rgba(255,255,255,.05); color: #DDE3EE; cursor: pointer; font-size: 12px;
  }
  #tray .mini:hover { background: rgba(255,255,255,.12); }
  /* ---------- 开始菜单 ---------- */
  #start-menu {
    position: fixed; left: 10px; bottom: 60px; width: 480px; max-width: calc(100vw - 20px); height: 560px; max-height: calc(100vh - 80px);
    z-index: 6000; display: none; flex-direction: column;
    background: rgba(18,22,36,.95); backdrop-filter: blur(18px);
    border: 1px solid rgba(255,255,255,.12); border-radius: 14px; box-shadow: 0 16px 60px rgba(0,0,0,.5);
  }
  #start-menu.open { display: flex; }
  #start-search { margin: 12px; padding: 9px 12px; border-radius: 9px; border: 1px solid rgba(255,255,255,.14); background: rgba(0,0,0,.3); color: #E6EAF2; outline: none; font-size: 13px; }
  #start-search:focus { border-color: #4a7dff; }
  #app-grid { flex: 1; overflow-y: auto; padding: 0 12px 12px; display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; align-content: start; }
  .app-tile { padding: 10px 6px; border-radius: 10px; text-align: center; cursor: pointer; border: 1px solid transparent; }
  .app-tile:hover { background: rgba(255,255,255,.09); border-color: rgba(255,255,255,.14); }
  .app-tile img { width: 36px; height: 36px; }
  .app-tile .no-ic { font-size: 30px; line-height: 36px; }
  .app-tile .lb { margin-top: 5px; font-size: 11px; color: #D8DEE9; height: 28px; overflow: hidden; }
  .grp-h { grid-column: 1 / -1; color: #8A93A8; font-size: 11px; margin: 8px 2px 2px; text-transform: uppercase; letter-spacing: .08em; }
  /* ---------- 窗口 ---------- */
  .win {
    position: fixed; min-width: 320px; min-height: 200px; display: flex; flex-direction: column;
    background: #141824; border: 1px solid rgba(255,255,255,.13); border-radius: 12px;
    box-shadow: 0 14px 50px rgba(0,0,0,.55); overflow: hidden;
  }
  .win.active { border-color: rgba(110,145,255,.55); box-shadow: 0 18px 60px rgba(20,40,120,.55); }
  .titlebar { height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 6px 0 12px; background: rgba(255,255,255,.05); cursor: move; flex: none; }
  .titlebar .t { flex: 1; font-size: 12px; color: #D8DEE9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .titlebar .hb { width: 30px; height: 26px; border: none; border-radius: 6px; background: transparent; color: #AAB4C8; cursor: pointer; font-size: 13px; }
  .titlebar .hb:hover { background: rgba(255,255,255,.13); color: #fff; }
  .titlebar .hb.x:hover { background: #d64545; }
  .win-body { flex: 1; overflow: auto; position: relative; background: #0F1320; }
  /* ---------- 资源管理器 ---------- */
  .ex-bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid rgba(255,255,255,.07); flex-wrap: wrap; }
  .ex-bar button { padding: 4px 10px; border-radius: 7px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: #DDE3EE; cursor: pointer; font-size: 12px; }
  .ex-bar button:hover { background: rgba(255,255,255,.13); }
  .ex-path { flex: 1; min-width: 120px; color: #8A93A8; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
  .ex-list { padding: 4px; }
  .ex-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 7px; cursor: pointer; font-size: 12px; }
  .ex-row:hover { background: rgba(90,130,255,.16); }
  .ex-row .n { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ex-row .s { color: #77809A; font-size: 11px; flex: none; }
  /* ---------- 程序接管 ---------- */
  .tk-status { padding: 5px 10px; font-size: 11px; color: #9AA5BC; border-bottom: 1px solid rgba(255,255,255,.07); display: flex; gap: 10px; align-items: center; flex: none; }
  .tk-status .hint { flex: 1; }
  .tk-status button { padding: 2px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: #DDE3EE; cursor: pointer; font-size: 11px; }
  .tk-view-wrap { position: absolute; inset: 30px 0 40px 0; overflow: auto; display: flex; align-items: flex-start; justify-content: center; background: #000; }
  .tk-view { max-width: 100%; cursor: crosshair; outline: none; display: block; }
  .tk-input { position: absolute; left: 0; right: 0; bottom: 0; height: 40px; display: flex; gap: 6px; padding: 6px; border-top: 1px solid rgba(255,255,255,.08); background: #141824; }
  .tk-input input { flex: 1; padding: 6px 10px; border-radius: 7px; border: 1px solid rgba(255,255,255,.14); background: rgba(0,0,0,.3); color: #E6EAF2; outline: none; font-size: 12px; }
  .tk-input button { padding: 0 14px; border: none; border-radius: 7px; background: #2b5fdb; color: #fff; cursor: pointer; font-size: 12px; }
  /* ---------- 通用 ---------- */
  .pad { padding: 12px; }
  .row2 { display: flex; gap: 8px; margin-bottom: 8px; }
  .btn { padding: 6px 12px; border: none; border-radius: 8px; background: #2b5fdb; color: #fff; cursor: pointer; font-size: 12px; }
  .btn.gray { background: rgba(255,255,255,.1); }
  .btn:hover { filter: brightness(1.15); }
  textarea.ta { width: 100%; height: 90px; border-radius: 8px; border: 1px solid rgba(255,255,255,.14); background: rgba(0,0,0,.3); color: #E6EAF2; padding: 8px; font: 12px/1.5 ui-monospace,Consolas,monospace; resize: vertical; user-select: text; }
  .card { background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.09); border-radius: 9px; padding: 8px 10px; margin-bottom: 6px; cursor: pointer; font-size: 12px; }
  .card:hover { background: rgba(90,130,255,.15); }
  .card .p { color: #77809A; font-size: 11px; word-break: break-all; }
  #toast { position: fixed; bottom: 64px; left: 50%; transform: translateX(-50%); z-index: 9000; background: #1A1F2E; color: #fff; padding: 8px 16px; border-radius: 9px; font-size: 12px; opacity: 0; transition: opacity .3s; pointer-events: none; border: 1px solid rgba(255,255,255,.15); max-width: 80vw; }
  /* ---------- 多电脑 ---------- */
  #pc-sel { height: 32px; max-width: 150px; background: rgba(255,255,255,.05); color: #DDE3EE; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; padding: 0 6px; font-size: 12px; outline: none; cursor: pointer; }
  .pcsel { height: 32px; width: 100%; background: rgba(0,0,0,.3); color: #E6EAF2; border: 1px solid rgba(255,255,255,.14); border-radius: 8px; padding: 0 8px; font-size: 12px; outline: none; }
  option { background: #1A1F2E; color: #E6EAF2; }
  .loading { padding: 24px; text-align: center; color: #77809A; font-size: 12px; }
</style>
</head>
<body>
<div id="desktop">
  <div id="icons"></div>
</div>
<div id="taskbar">
  <button id="start-btn">⊞ 开始</button>
  <div id="task-btns"></div>
  <div id="tray">
    <select id="pc-sel" title="切换要控制的电脑"></select>
    <button class="mini" id="pc-add" title="添加电脑">＋</button>
    <button class="mini" id="tray-shot" title="截取电脑屏幕">📷</button>
    <button class="mini" id="tray-clip" title="剪贴板">📋</button>
    <span id="clock"></span>
  </div>
</div>
<div id="start-menu">
  <input id="start-search" placeholder="搜索应用…">
  <div id="app-grid"><div class="loading">正在加载应用列表…</div></div>
</div>
<div id="toast"></div>
<script>
(function () {
  // ---- API：多电脑联邦。桥接模式统一走 /r/<key>/__ph/<端点>（本机=URL 里的 key，跨机=其他 key）；
  //      本机直连模式走 shim（/api/ph-webos/api，body.__ph 转发），跨机操作不可用（提示走桥接地址）----
  var BRIDGE = /\\/r\\/[^/]+\\//.test(location.pathname)
  var SELF_KEY = (location.pathname.match(/^\\/r\\/([^/]+)\\//) || [])[1] || 'local'
  var PC = { current: SELF_KEY, others: [] }
  function api (p, body, pc) {
    var target = pc || PC.current
    var opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body: null }
    var url
    if (target.indexOf('peer:') === 0) {
      // E2E 联邦电脑：调用经本机插件 peer/fwd 转发到对端（本机 shim 或本机桥接 key 都能进插件）
      var fwd = Object.assign({ deviceId: target.slice(5), inner: '/__ph/' + p }, body || {})
      if (BRIDGE) { url = '/r/' + SELF_KEY + '/__ph/peer/fwd'; opts.body = JSON.stringify(fwd) }
      else { url = 'api'; opts.body = JSON.stringify(Object.assign({ __ph: '/__ph/peer/fwd' }, fwd)) }
    } else if (BRIDGE) { url = '/r/' + target + '/__ph/' + p; opts.body = JSON.stringify(body || {}) }
    else if (target === 'local') { url = 'api'; opts.body = JSON.stringify(Object.assign({ __ph: '/__ph/' + p }, body || {})) }
    else return Promise.resolve({ error: '本机直连模式不能跨电脑操作——请从云端桥接地址打开 WebOS（手机授权后浏览器直达）' })
    return fetch(url, opts).then(function (r) { return r.json() })
  }

  // ---- 多电脑：设备清单存 localStorage「hh-os-pcs」（与云端 /os 同一约定，同源共享）----
  var pcSel = document.getElementById('pc-sel')
  function fillPcSelect (sel) {
    sel.innerHTML = ''
    var o = document.createElement('option'); o.value = SELF_KEY; o.textContent = '🖥 本机'; sel.appendChild(o)
    PC.others.forEach(function (x) {
      var oo = document.createElement('option'); oo.value = x.key
      oo.textContent = (x.key.indexOf('peer:') === 0 ? '🔗 ' : '🖥 ') + (x.name || x.key.slice(0, 8)); sel.appendChild(oo)
    })
    if (PC.current !== sel.value) sel.value = PC.current
  }
  function renderPcSwitch () { fillPcSelect(pcSel); pcSel.value = PC.current }
  function loadPcs () {
    var all = []
    try { all = JSON.parse(localStorage.getItem('hh-os-pcs') || '[]') } catch (e) {}
    PC.others = all.filter(function (x) { return x && x.key && x.key !== SELF_KEY })
    renderPcSwitch()
  }
  pcSel.onchange = function () {
    PC.current = pcSel.value
    appItems = []; remoteWins = []
    document.getElementById('app-grid').innerHTML = '<div class="loading">正在加载应用列表…</div>'
    loadApps(); pollRemoteWindows()
    toast('已切换到「' + pcSel.options[pcSel.selectedIndex].textContent + '」')
    api('windows/list', {}).then(function (r) {
      if (r && r.error) toast('⚠️ 该电脑暂时无响应（不在线或桥接未开）')
    }).catch(function () {})
  }
  document.getElementById('pc-add').onclick = openAddPc
  // 添加电脑：弹二维码 → 已配对手机扫码 → 在手机上选要添加的电脑并授权 → 自动入列表
  function openAddPc () {
    toast('正在生成授权二维码…')
    api('link/code', {}).then(function (r) {
      if (!r || r.error || !r.qr) return toast('生成二维码失败：' + ((r && r.error) || '未知'))
      var id = r.id, ttl = r.expiresInSec || 300
      openWin({ title: '添加电脑 · 扫码授权', icon: '➕', w: 440, h: 580, render: function (body, closeFn) {
        body.innerHTML = '<div class="pad" style="text-align:center">' +
          '<img style="width:230px;height:230px;border-radius:12px;background:#fff;padding:10px" src="' + r.qr + '">' +
          '<div style="color:#9AA5BC;font-size:12px;margin-top:12px;line-height:1.9">用<b>已配对的手机 App</b>扫此码<br>在手机上选择要添加的电脑并确认授权<br>授权后电脑自动出现在任务栏切换器里</div>' +
          '<div id="ap-st" style="margin-top:12px;color:#8A93A8;font-size:12px">等待手机扫码授权…</div>' +
          '<div style="margin-top:14px"><button class="btn gray" id="ap-manual">手动输入 Key（云端 /os 桥接）</button></div></div>'
        body.querySelector('#ap-manual').onclick = function () { manualAddPc(); closeFn() }
        var tries = 0
        var timer = setInterval(function () {
          tries++
          if (tries * 3 > ttl) {
            clearInterval(timer)
            var stEl = body.querySelector('#ap-st')
            if (stEl) stEl.textContent = '二维码已过期，请关闭本窗口后重试'
            return
          }
          api('link/status', { id: id }).then(function (st) {
            if (!st || st.status !== 'granted') return
            clearInterval(timer)
            var name = st.name || ('远程电脑 ' + String(st.deviceId).slice(-4))
            var key = 'peer:' + st.deviceId
            var all = []
            try { all = JSON.parse(localStorage.getItem('hh-os-pcs') || '[]') } catch (e) {}
            all = all.filter(function (x) { return x.key !== key })
            all.push({ key: key, name: name })
            localStorage.setItem('hh-os-pcs', JSON.stringify(all))
            loadPcs()
            toast('✅ 已添加「' + name + '」，任务栏切换即可控制')
            setTimeout(closeFn, 900)
          }).catch(function () {})
        }, 3000)
        return function () { clearInterval(timer) }
      } })
    }).catch(function (e) { toast('生成二维码失败: ' + e.message) })
  }
  // 兜底：手动输入云端桥接 Key（/os 添加电脑后可见）
  function manualAddPc () {
    if (!BRIDGE) return toast('本机直连模式不能添加云端桥接电脑——从云端桥接地址打开 WebOS 后添加')
    var name = window.prompt('电脑名称（如：家里电脑）：'); if (name === null) return; name = name.trim()
    var key = window.prompt('连接 Key（云端 /os 设备页可查看；由那台电脑的手机授权后获得）：'); if (key === null) return; key = key.trim()
    if (!name || !key) return toast('名称和 Key 都不能为空')
    if (/[\\/\\s]/.test(key) || key.length > 128) return toast('Key 格式不合法')
    toast('正在验证「' + name + '」…')
    fetch('/r/' + encodeURIComponent(key) + '/__ph/webos', { method: 'GET' }).then(function (r) {
      if (!r.ok) throw new Error('电脑不在线或桥接未开（HTTP ' + r.status + '）')
      var all = []
      try { all = JSON.parse(localStorage.getItem('hh-os-pcs') || '[]') } catch (e) {}
      all = all.filter(function (x) { return x.key !== key })
      all.push({ key: key, name: name })
      localStorage.setItem('hh-os-pcs', JSON.stringify(all))
      loadPcs()
      toast('✅ 已添加「' + name + '」，任务栏切换即可控制')
    }).catch(function (e) { toast('❌ 添加失败：' + e.message) })
  }
  loadPcs()
  var toastEl = document.getElementById('toast'); var toastTimer = 0
  function toast (m) {
    toastEl.textContent = m; toastEl.style.opacity = '1'
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.style.opacity = '0' }, 2600)
  }

  // ---- 窗口管理器 ----
  var wins = {}, winSeq = 0, zTop = 100
  var taskBtns = document.getElementById('task-btns')
  function focusWin (id) {
    var w = wins[id]; if (!w) return
    w.el.style.zIndex = ++zTop
    Object.keys(wins).forEach(function (k) { wins[k].el.classList.toggle('active', k === id); wins[k].tb.classList.toggle('active', k === id && !wins[k].minimized) })
  }
  function closeWin (id) {
    var w = wins[id]; if (!w) return
    try { w.cleanup && w.cleanup() } catch (e) {}
    try { w.opts.onClose && w.opts.onClose() } catch (e) {}
    w.el.remove(); w.tb.remove(); delete wins[id]
  }
  function minWin (id) {
    var w = wins[id]; if (!w) return
    w.minimized = true; w.el.style.display = 'none'; w.tb.classList.add('min')
  }
  function restoreWin (id) {
    var w = wins[id]; if (!w) return
    w.minimized = false; w.el.style.display = 'flex'; w.tb.classList.remove('min'); focusWin(id)
  }
  function openWin (opts) {
    var id = 'w' + (++winSeq)
    var el = document.createElement('div'); el.className = 'win'
    var W = Math.min(opts.w || 720, window.innerWidth - 20), H = Math.min(opts.h || 520, window.innerHeight - 80)
    el.style.width = W + 'px'; el.style.height = H + 'px'
    var off = 46 + (winSeq * 30) % 160
    el.style.left = Math.max(6, (window.innerWidth - W) / 2 - 120 + off) + 'px'
    el.style.top = Math.max(6, (window.innerHeight - H) / 2 - 60 + off * 0.6) + 'px'
    var tb = document.createElement('div'); tb.className = 'titlebar'
    tb.innerHTML = '<span>' + (opts.icon || '🪟') + '</span><span class="t">' + esc(opts.title || '窗口') + '</span>'
    var bMin = hb('▁'), bX = hb('✕', 'x')
    function hb (t, cls) { var b = document.createElement('button'); b.className = 'hb' + (cls ? ' ' + cls : ''); b.textContent = t; return b }
    bMin.onclick = function (e) { e.stopPropagation(); minWin(id) }
    bX.onclick = function (e) { e.stopPropagation(); closeWin(id) }
    tb.appendChild(bMin); tb.appendChild(bX)
    // 拖拽
    tb.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return
      var sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop
      function mv (e2) { el.style.left = Math.max(-W + 80, Math.min(window.innerWidth - 60, e2.clientX - sx)) + 'px'; el.style.top = Math.max(0, Math.min(window.innerHeight - 90, e2.clientY - sy)) + 'px' }
      function up () { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
    })
    var body = document.createElement('div'); body.className = 'win-body'
    el.appendChild(tb); el.appendChild(body)
    el.addEventListener('mousedown', function () { focusWin(id) })
    document.body.appendChild(el)
    var taskBtn = document.createElement('button'); taskBtn.className = 'task-btn'
    taskBtn.textContent = (opts.icon || '🪟') + ' ' + (opts.title || '窗口')
    taskBtn.onclick = function () { var w = wins[id]; if (!w) return; if (w.minimized) restoreWin(id); else if (w.el.classList.contains('active')) minWin(id); else focusWin(id) }
    taskBtns.appendChild(taskBtn)
    wins[id] = { el: el, body: body, tb: taskBtn, opts: opts, minimized: false, cleanup: null }
    focusWin(id)
    try { var cu = opts.render && opts.render(body, function () { closeWin(id) }); if (typeof cu === 'function') wins[id].cleanup = cu } catch (e) { toast('窗口初始化失败: ' + e.message) }
    return id
  }
  function esc (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }
  function fmtSize (n) { return n >= 1073741824 ? (n / 1073741824).toFixed(1) + 'GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n >= 1024 ? Math.round(n / 1024) + 'KB' : n + 'B' }

  // ---- 桌面图标 ----
  var desktopIcons = [
    { ic: '📁', lb: '资源管理器', fn: openExplorer },
    { ic: '🖥️', lb: '全屏实况', fn: openScreenLive },
    { ic: '🧭', lb: '窗口总览', fn: openWindowsOverview },
    { ic: '🔍', lb: '资料检索', fn: openSearch },
    { ic: '📋', lb: '剪贴板', fn: openClipboard }
  ]
  var iconsBox = document.getElementById('icons')
  desktopIcons.forEach(function (d) {
    var el = document.createElement('div'); el.className = 'dicon'
    el.innerHTML = '<div class="ic">' + d.ic + '</div><div class="lb">' + d.lb + '</div>'
    el.ondblclick = d.fn
    iconsBox.appendChild(el)
  })

  // ---- 开始菜单 ----
  var startMenu = document.getElementById('start-menu'), startBtn = document.getElementById('start-btn')
  var appItems = []
  var appsByPc = {}   // 每电脑一份应用清单缓存（切换即时恢复，不重复枚举）
  startBtn.onclick = function () {
    startMenu.classList.toggle('open')
    if (startMenu.classList.contains('open')) { document.getElementById('start-search').value = ''; renderApps(''); document.getElementById('start-search').focus() }
  }
  document.addEventListener('mousedown', function (e) {
    if (startMenu.classList.contains('open') && !startMenu.contains(e.target) && e.target !== startBtn) startMenu.classList.remove('open')
  })
  document.getElementById('start-search').addEventListener('input', function (e) { renderApps(e.target.value) })
  function loadApps () {
    var pc = PC.current
    if (appsByPc[pc]) {
      appItems = appsByPc[pc]
      if (startMenu.classList.contains('open')) renderApps(document.getElementById('start-search').value)
      return
    }
    api('apps/list', {}, pc).then(function (r) {
      appItems = ((r && r.items) || []).map(function (a) { a.pc = pc; return a })
      appsByPc[pc] = appItems
      if (r && r.error) toast('应用列表加载失败：' + r.error)
      if (startMenu.classList.contains('open')) renderApps(document.getElementById('start-search').value)
      lazyIcons()
    }).catch(function (e) { toast('应用列表加载失败: ' + e.message) })
  }
  function renderApps (q) {
    var grid = document.getElementById('app-grid'); grid.innerHTML = ''
    q = (q || '').toLowerCase()
    var lastGrp = null
    var list = appItems.filter(function (a) { return !q || a.name.toLowerCase().indexOf(q) >= 0 })
    if (!list.length) { grid.innerHTML = '<div class="loading">无匹配应用</div>'; return }
    list.slice(0, 120).forEach(function (a) {
      if (a.grp !== lastGrp) { lastGrp = a.grp; var h = document.createElement('div'); h.className = 'grp-h'; h.textContent = a.grp === 'desktop' ? '桌面' : '开始菜单'; grid.appendChild(h) }
      var t = document.createElement('div'); t.className = 'app-tile'; t.title = a.name
      t.innerHTML = a.b64 ? '<img src="data:image/png;base64,' + a.b64 + '">' : '<div class="no-ic">🪟</div><div class="lb">' + esc(a.name) + '</div>'
      if (a.b64) { var lb = document.createElement('div'); lb.className = 'lb'; lb.textContent = a.name; t.appendChild(lb) }
      t.onclick = function () { startMenu.classList.remove('open'); launchApp(a) }
      grid.appendChild(t)
    })
  }
  // 图标懒加载（分批并发，只提缺的；只在仍停留在该电脑时重绘）
  function lazyIcons () {
    var pc = PC.current
    var missing = appItems.filter(function (a) { return !a.b64 && a.icon })
    var CONC = 5
    function next () {
      if (!missing.length) return
      var batch = missing.splice(0, CONC)
      batch.forEach(function (a) {
        api('apps/list', { only: a.icon }, a.pc).then(function (r) {
          var hit = ((r && r.items) || [])[0]
          if (hit && hit.b64) {
            a.b64 = hit.b64
            if (a.pc === PC.current && startMenu.classList.contains('open')) renderApps(document.getElementById('start-search').value)
          }
        }).catch(function () {}).finally(next)
      })
    }
    next()
  }
  function launchApp (a) {
    toast('正在启动 ' + a.name + ' …')
    api('apps/open', { lnk: a.lnk, title: a.name }, a.pc).then(function (r) {
      if (!r || r.error) return toast('启动失败：' + ((r && r.error) || '未知'))
      toast('✅ 已启动 ' + a.name + (r.hwnd ? '，正在接管窗口' : '（点「窗口总览」找到它）'))
      pollRemoteWindows()
      if (r.hwnd) openTakeover({ hwnd: r.hwnd, title: a.name, pc: a.pc })
    }).catch(function (e) { toast('启动失败: ' + e.message) })
  }
  loadApps()

  // ---- 资源管理器（窗口打开时绑定电脑，之后所有操作固定走那台机器）----
  function openExplorer () {
    var pc = PC.current
    openWin({ title: '资源管理器', icon: '📁', w: 760, h: 540, render: function (body) { exRender(body, '__quick__', pc) } })
  }
  function exRender (body, path, pc) {
    body.innerHTML = ''
    var bar = document.createElement('div'); bar.className = 'ex-bar'
    var bUp = document.createElement('button'); bUp.textContent = '⬆ 上一级'
    var bUp2 = document.createElement('button'); bUp2.textContent = '🏠 常用位置'
    var bSend = document.createElement('button'); bSend.textContent = '⬆ 上传到此目录'
    var pEl = document.createElement('div'); pEl.className = 'ex-path'
    bar.appendChild(bUp); bar.appendChild(bUp2); bar.appendChild(bSend); bar.appendChild(pEl)
    var list = document.createElement('div'); list.className = 'ex-list'
    body.appendChild(bar); body.appendChild(list)
    function go (p) { exRender(body, p, pc) }
    bUp.onclick = function () {
      if (path === '__quick__' || path === '__drives__' || /^[a-zA-Z]:[\\\\]?$/.test(path)) return go('__quick__')
      go(path.replace(/[\\\\/][^\\\\/]+[\\\\]?$/, '') || '__quick__')
    }
    bUp2.onclick = function () { go('__quick__') }
    bSend.onclick = function () {
      var input = document.createElement('input'); input.type = 'file'; input.multiple = true
      input.onchange = function () {
        var dir = (path !== '__quick__' && path !== '__drives__') ? path : ''
        var files = Array.prototype.slice.call(input.files); var ok = 0
        function one () {
          if (!files.length) { toast('已上传 ' + ok + ' 个文件' + (dir ? ' → ' : '') + (dir || '收件箱')); exRender(body, path, pc); return }
          var f = files.shift()
          if (f.size <= 1024 * 1024) {
            // 小文件（≤1MB）保持单发
            var rd0 = new FileReader()
            rd0.onload = function () {
              api('file/put', { name: f.name, b64: String(rd0.result).split(',')[1], dir: dir }, pc).then(function () { ok++ }).catch(function () {}).finally(one)
            }
            rd0.readAsDataURL(f)
            return
          }
          // 大文件分片（1MB/块）：避免单帧巨型 JSON 堵死共享隧道、避免服务端全内存解析
          var CH = 1024 * 1024, n = Math.ceil(f.size / CH)
          var uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
          var seq = 0
          toast('分片上传 ' + f.name + '（' + (f.size / 1048576).toFixed(1) + 'MB，' + n + ' 块）…')
          function sendChunk () {
            if (seq >= n) { ok++; return one() }
            var rd = new FileReader()
            rd.onload = function () {
              api('file/put-chunk', { uploadId: uid, seq: seq + 1, n: n, name: f.name, dir: dir, b64: String(rd.result).split(',')[1], fin: seq + 1 === n }, pc)
                .then(function (r) {
                  if (r && r.error) { toast(f.name + ' 分片失败：' + r.error); return one() }
                  seq++
                  if (seq % 10 === 0 || seq === n) toast(f.name + '：' + seq + '/' + n + ' 块')
                  sendChunk()
                })
                .catch(function (e) { toast(f.name + ' 上传失败: ' + e.message); one() })
            }
            rd.readAsDataURL(f.slice(seq * CH, Math.min(f.size, (seq + 1) * CH)))
          }
          sendChunk()
        }
        one()
      }
      input.click()
    }
    pEl.textContent = path === '__quick__' ? '（常用位置）' : path
    list.innerHTML = '<div class="loading">加载中…</div>'
    api('files/list', { path: path }, pc).then(function (r) {
      list.innerHTML = ''
      var entries = (r.quick || r.roots || r.items) || []
      if (r && r.error) list.innerHTML = '<div class="loading">' + esc(r.error) + '</div>'
      entries.forEach(function (it) {
        var isQuick = !!r.quick, isRoots = !!r.roots
        var isDir = isQuick || isRoots || it.dir
        var label = isRoots ? it.label : it.name   // 盘符列表用 label 字段，其余用 name
        var target = (isQuick || isRoots) ? it.path : null
        var full = target || (path === '__quick__' || path === '__drives__' ? label : path + '\\\\' + label)
        var row = document.createElement('div'); row.className = 'ex-row'
        row.innerHTML = '<span>' + (isRoots ? '💽' : isDir ? '📁' : '📄') + '</span><span class="n">' + esc(label) + '</span>' + (isDir ? '' : '<span class="s">' + fmtSize(it.size) + '</span>')
        row.onclick = function () { if (isDir) go(full); else exFileMenu(full, label, pc) }
        list.appendChild(row)
      })
      if (!entries.length && !(r && r.error)) list.innerHTML = '<div class="loading">（空）</div>'
    }).catch(function (e) { list.innerHTML = '<div class="loading">读取失败：' + esc(e.message) + '</div>' })
  }
  function exFileMenu (full, name, pc) {
    openWin({ title: name, icon: '📄', w: 420, h: 200, render: function (b2) {
      b2.innerHTML = '<div class="pad"><div style="color:#8A93A8;font-size:11px;word-break:break-all;margin-bottom:12px">' + esc(full) + '</div><div class="row2"><button class="btn" id="m-prev">👁 预览</button><button class="btn gray" id="m-dl">⬇ 下载到本机</button></div></div>'
      b2.querySelector('#m-prev').onclick = function () { previewFile(full, name, pc) }
      b2.querySelector('#m-dl').onclick = function () {
        // 分块下载（2026-10-26 反堵塞）：1MB/块循环拉取，小文件自然只有一块；
        // 不再 atob 全量解码——大文件不撑爆浏览器内存，也不堵共享隧道
        var CH = 1024 * 1024, parts = [], offset = 0, total = -1
        toast('下载中…')
        function pull () {
          api('file/get-chunk', { path: full, offset: offset, size: CH }, pc).then(function (r) {
            if (!r || r.error) return toast('下载失败：' + ((r && r.error) || '未知'))
            if (total < 0) { total = r.size; if (total > CH) toast('分块下载 ' + name + '（' + fmtSize(total) + '）…') }
            var bin = atob(r.b64), buf = new Uint8Array(bin.length)
            for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
            parts.push(buf)
            offset = r.offset + r.len
            if (offset < total) { if (parts.length % 10 === 0) toast(name + '：' + fmtSize(offset) + ' / ' + fmtSize(total)); pull() }
            else {
              var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(parts)); a.download = name; a.click()
              toast('已下载 ' + fmtSize(total))
            }
          }).catch(function (e) { toast('下载失败: ' + e.message) })
        }
        pull()
      }
    } })
  }
  function previewFile (full, name, pc) {
    toast('预览加载中…（Office 首次约 3 秒）')
    api('file/preview', { path: full }, pc).then(function (r) {
      if (!r || r.error) return toast('预览失败：' + ((r && r.error) || '未知'))
      openWin({ title: '预览 · ' + name, icon: '👁', w: 720, h: 560, render: function (b2) {
        if (r.kind === 'image') b2.innerHTML = '<div style="height:100%;overflow:auto;background:#000;text-align:center"><img style="max-width:100%" src="data:' + r.mime + ';base64,' + r.b64 + '"></div>'
        else b2.innerHTML = '<iframe style="width:100%;height:100%;border:none;background:#fff" srcdoc="' + esc(r.content).replace(/"/g, '&quot;') + '"></iframe>'
      } })
    }).catch(function (e) { toast('预览失败: ' + e.message) })
  }

  // ---- 程序接管（核心：效果=远程桌面单窗口模式）----
  var VKMAP = { Escape: 27, Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Insert: 45, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 }
  function vkOf (e) {
    if (VKMAP[e.key] != null) return VKMAP[e.key]
    if (/^F\\d{1,2}$/.test(e.key)) return 111 + Number(e.key.slice(1))
    if (e.key.length === 1) return e.key.toUpperCase().charCodeAt(0)
    return 0
  }
  function openTakeover (w) {
    w.pc = w.pc || PC.current
    openWin({ title: w.title, icon: '🖥️', w: 860, h: 620, render: function (body, closeFn) {
      var status = document.createElement('div'); status.className = 'tk-status'
      status.innerHTML = '<span>🟢 接管中</span><span class="hint">点击画面操作 · 单击画面后可直接敲键盘 · 电脑前的人能看到这些操作</span>'
      var bMin = document.createElement('button'); bMin.textContent = '最小化窗口'
      var bAct = document.createElement('button'); bAct.textContent = '激活'
      var bClose = document.createElement('button'); bClose.textContent = '关闭程序'
      var bPaste = document.createElement('button'); bPaste.textContent = '📋 跨机粘贴'; bPaste.title = '从另一台已添加的电脑复制剪贴板并粘贴到本窗口'
      status.appendChild(bPaste); status.appendChild(bMin); status.appendChild(bAct); status.appendChild(bClose)
      var wrap = document.createElement('div'); wrap.className = 'tk-view-wrap'
      var img = document.createElement('img'); img.className = 'tk-view'; img.tabIndex = 0
      wrap.appendChild(img)
      var inputRow = document.createElement('div'); inputRow.className = 'tk-input'
      inputRow.innerHTML = '<input placeholder="输入文字，回车发送到电脑（中文/英文均可）…"><button>发送</button>'
      body.appendChild(status); body.appendChild(wrap); body.appendChild(inputRow)
      var busy = false, timer = 0, closed = false
      // 自适应轮询（2026-10-26 P3）：原生采集 <100ms/帧 后，画面变化时 350ms 追帧（≈3fps），
      // 静止逐帧退避到 1200ms——流畅度和带宽兼顾（静止仍≈零流量）。
      var delay = 900
      function pull () {
        if (closed) return
        if (busy) return
        busy = true
        api('live/frame', { hwnd: w.hwnd, title: w.title, maxW: 1280, q: 70 }, w.pc).then(function (r) {
          if (r && r.changed && r.b64) { img.src = 'data:image/jpeg;base64,' + r.b64; delay = 350 } else delay = Math.min(1200, delay + 80)
        }).catch(function () {}).finally(function () { busy = false; if (!closed) timer = setTimeout(pull, delay) })
      }
      timer = setTimeout(pull, 100)
      pull(); timer = setInterval(pull, 900)
      img.onclick = function (e) {
        img.focus()
        var rect = img.getBoundingClientRect()
        var x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
        var y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
        api('click', { hwnd: w.hwnd, title: w.title, x: x, y: y }, w.pc).then(function (r) {
          if (r && r.error) toast('点击被拒：' + r.error)
        }).catch(function () {})
      }
      img.addEventListener('wheel', function (e) {
        e.preventDefault()
        var dy = Math.max(-1200, Math.min(1200, -e.deltaY))
        api('input/scroll', { hwnd: w.hwnd, title: w.title, dy: dy }, w.pc).catch(function () {})
      }, { passive: false })
      img.addEventListener('contextmenu', function (e) { e.preventDefault() })
      img.addEventListener('keydown', function (e) {
        var vk = vkOf(e)
        if (!vk) return
        e.preventDefault()
        var mods = []
        if (e.ctrlKey) mods.push(162)
        if (e.altKey) mods.push(164)
        if (e.shiftKey) mods.push(160)
        api('key/raw', { hwnd: w.hwnd, title: w.title, vk: vk, mods: mods }, w.pc).then(function (r) {
          if (r && r.error) toast('键盘被拒：' + r.error)
        }).catch(function () {})
      })
      var input = inputRow.querySelector('input')
      function sendText () {
        var t = input.value; if (!t) return; input.value = ''
        api('key', { hwnd: w.hwnd, title: w.title, text: t }, w.pc).then(function (r) {
          if (r && r.error) toast('输入被拒：' + r.error); else toast('已发送 ' + t.length + ' 字')
        }).catch(function (e) { toast('发送失败: ' + e.message) })
      }
      inputRow.querySelector('button').onclick = sendText
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.stopPropagation(); sendText() } })
      bMin.onclick = function () { api('windows/ctl', { hwnd: w.hwnd, op: 'minimize' }, w.pc).then(function (r) { if (r && r.error) toast(r.error) }) }
      bAct.onclick = function () { api('windows/ctl', { hwnd: w.hwnd, op: 'activate' }, w.pc).then(function (r) { if (r && r.error) toast(r.error) }) }
      bClose.onclick = function () {
        if (!confirm('确定要关闭「' + w.title + '」吗？')) return
        api('windows/ctl', { hwnd: w.hwnd, op: 'close' }, w.pc).then(function (r) {
          if (r && r.error) toast(r.error); else { toast('已发送关闭'); setTimeout(closeFn, 800) }
        })
      }
      // 跨机粘贴：从已添加的另一台电脑取剪贴板 → 放进本窗口所在电脑的剪贴板 → 注入 Ctrl+V
      bPaste.onclick = function () {
        var others = PC.others
        if (!others.length) return toast('还没添加其他电脑——点任务栏 ＋ 添加')
        var src = others.length === 1 ? others[0] : null
        if (!src) {
          var pick = window.prompt('从哪台电脑粘贴？输入序号：\\n' + others.map(function (x, i) { return i + '. ' + (x.name || x.key) }).join('\\n'), '0')
          if (pick === null) return
          src = others[Number(pick)]
          if (!src) return toast('选择无效')
        }
        api('clipboard/get', {}, src.key).then(function (r) {
          if (!r || typeof r.text !== 'string' || !r.text) return toast('「' + (src.name || '电脑') + '」剪贴板为空')
          var text = r.text
          api('clipboard/set', { text: text }, w.pc).then(function (r2) {
            if (r2 && r2.error) return toast('写入目标电脑失败：' + r2.error)
            api('key/raw', { hwnd: w.hwnd, title: w.title, vk: 86, mods: [162] }, w.pc).then(function () {
              toast('📋 已从「' + (src.name || '电脑') + '」粘贴 ' + text.length + ' 字')
            })
          })
        }).catch(function (e) { toast('跨机粘贴失败: ' + e.message) })
      }
      // 关窗即停实况轮询（openWin 会调用本函数）
      return function () { closed = true; clearTimeout(timer) }
    }, onClose: function () {} })
  }

  // ---- 全屏实况（只读兜底；绑定打开时的电脑）----
  // 2026-10-26 带宽改造：PNG 整屏 → JPEG(1280/q60) + 服务端变化检测。
  // 实测 793KB/帧（静止也 337 KB/s、撞云端 30s 桥接超时）→ ~68KB/帧（静止≈0）。
  function openScreenLive () {
    var pc = PC.current
    openWin({ title: '全屏实况（只读·未接管输入）', icon: '🖥️', w: 900, h: 620, render: function (body, closeFn) {
      var wrap = document.createElement('div'); wrap.style.cssText = 'position:absolute;inset:0;overflow:auto;background:#000;display:flex;align-items:flex-start;justify-content:center'
      var img = document.createElement('img'); img.style.maxWidth = '100%'
      var tip = document.createElement('div'); tip.style.cssText = 'position:absolute;top:8px;left:10px;color:#8a8;font:12px system-ui'
      tip.textContent = '整屏只读实况 · JPEG 省流 · 静止零流量 · 要操作请从「窗口总览」接管具体窗口'
      wrap.appendChild(img); body.appendChild(wrap); body.appendChild(tip)
      var timer = 0, busy = false, slClosed = false, slDelay = 1200
      function pull () {
        if (slClosed) return
        if (busy) return; busy = true
        api('screenshot', { target: 'screen', fmt: 'jpeg', maxW: 1280, q: 60 }, pc).then(function (r) {
          if (r && r.changed && r.b64) { img.src = 'data:image/jpeg;base64,' + r.b64; slDelay = 500 } else slDelay = Math.min(1500, slDelay + 100)
        }).catch(function () {}).finally(function () { busy = false; if (!slClosed) timer = setTimeout(pull, slDelay) })
      }
      timer = setTimeout(pull, 100)
      return function () { slClosed = true; clearTimeout(timer) }
    }, onClose: function () {} })
  }

  // ---- 窗口总览（远程任务栏）----
  var remoteWins = []
  function pollRemoteWindows () {
    api('windows/list', {}).then(function (r) { remoteWins = (r && r.windows) || [] }).catch(function () {})
  }
  pollRemoteWindows(); setInterval(pollRemoteWindows, 3000)
  function openWindowsOverview () {
    var pc = PC.current
    var pcName = pc === SELF_KEY ? '本机' : (pcSel.querySelector('option[value="' + pc + '"]') || {}).textContent || pc
    openWin({ title: '窗口总览 · ' + pcName, icon: '🧭', w: 560, h: 520, render: function (body) {
      function render (ws) {
        body.innerHTML = '<div class="pad"><div style="color:#8A93A8;font-size:11px;margin-bottom:8px">点击窗口即接管（可观看+点击+键盘）；每 3 秒自动刷新</div></div>'
        var box = body.firstChild
        if (!ws.length) { box.innerHTML += '<div class="loading">没有可见窗口</div>'; return }
        ws.forEach(function (w) {
          var c = document.createElement('div'); c.className = 'card'
          c.innerHTML = (w.minimized ? '🟡 ' : '🟢 ') + esc(w.title) + ' <span class="p">' + w.w + '×' + w.h + (w.minimized ? ' · 已最小化' : '') + '</span>'
          c.onclick = function () { openTakeover({ hwnd: w.hwnd, title: w.title, pc: pc }) }
          box.appendChild(c)
        })
      }
      render(remoteWins)
      var t = setInterval(function () {
        if (!document.body.contains(body)) { clearInterval(t); return }
        api('windows/list', {}, pc).then(function (r) {
          if (document.body.contains(body)) render((r && r.windows) || [])
        }).catch(function () {})
      }, 3000)
    }, onClose: function () {} })
  }

  // ---- 资料检索（绑定打开时的电脑）----
  function openSearch () {
    var pc = PC.current
    openWin({ title: '资料检索', icon: '🔍', w: 640, h: 560, render: function (body) {
      body.innerHTML = '<div class="pad"><div class="row2"><input class="ta" style="height:34px" placeholder="搜索电脑全盘索引（支持 ext:pdf days:7 语法）…"><button class="btn">搜索</button></div><div id="sr"></div></div>'
      var input = body.querySelector('input'), box = body.querySelector('#sr')
      function go () {
        var q = input.value.trim(); if (!q) return
        box.innerHTML = '<div class="loading">搜索中…</div>'
        api('data/search', { query: q, limit: 30 }, pc).then(function (r) {
          var rs = (r && r.results) || []
          box.innerHTML = rs.length ? '' : '<div class="loading">无命中，试试更短的关键词</div>'
          rs.forEach(function (it) {
            var c = document.createElement('div'); c.className = 'card'
            c.innerHTML = '<b>' + esc(it.name || it.path) + '</b> <span style="color:#77809A;font-size:11px">' + fmtSize(it.size) + '</span><div class="p">' + esc(it.path) + '</div>'
            c.onclick = function () { previewFile(it.path, it.name || it.path, pc) }
            box.appendChild(c)
          })
        }).catch(function (e) { box.innerHTML = '<div class="loading">失败：' + esc(e.message) + '</div>' })
      }
      body.querySelector('button').onclick = go
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go() })
    }, onClose: function () {} })
  }

  // ---- 剪贴板（可选任意已添加的电脑取/发；跨机复制粘贴的另一入口）----
  function openClipboard () {
    openWin({ title: '剪贴板', icon: '📋', w: 460, h: 420, render: function (body) {
      body.innerHTML = '<div class="pad"><select id="c-pc" class="pcsel"></select>' +
        '<div class="row2" style="margin-top:8px"><button class="btn" id="c-get">⬇ 取剪贴板</button><button class="btn gray" id="c-set">⬆ 发到该电脑</button></div>' +
        '<textarea class="ta" placeholder="剪贴板内容…"></textarea>' +
        '<div style="margin-top:8px;color:#8A93A8;font-size:11px">跨电脑复制：在任意程序的接管窗口点「📋 跨机粘贴」，即可把另一台电脑刚复制的内容粘贴进来</div></div>'
      var ta = body.querySelector('textarea')
      var sel = body.querySelector('#c-pc')
      fillPcSelect(sel); sel.value = PC.current
      body.querySelector('#c-get').onclick = function () {
        api('clipboard/get', {}, sel.value).then(function (r) {
          if (!r || typeof r.text !== 'string') return toast('取剪贴板失败：电脑返回为空')
          ta.value = r.text; toast('已取回 ' + r.text.length + ' 字')
        }).catch(function (e) { toast('失败: ' + e.message) })
      }
      body.querySelector('#c-set').onclick = function () {
        var t = ta.value; if (!t) return toast('内容为空')
        api('clipboard/set', { text: t }, sel.value).then(function (r) {
          if (r && r.error) return toast('失败: ' + r.error)
          toast('已发送到' + (sel.value === SELF_KEY ? '电脑' : '「' + sel.options[sel.selectedIndex].textContent + '」') + '剪贴板')
        }).catch(function (e) { toast('失败: ' + e.message) })
      }
    }, onClose: function () {} })
  }

  // ---- 任务栏小工具 ----
  document.getElementById('tray-clip').onclick = openClipboard
  document.getElementById('tray-shot').onclick = function () {
    toast('截图中…')
    api('screenshot', {}).then(function (r) {
      if (!r || !r.b64) return toast('截图失败')
      openWin({ title: '屏幕截图', icon: '📷', w: 860, h: 620, render: function (b2) {
        b2.innerHTML = '<div style="height:100%;overflow:auto;background:#000;text-align:center"><img style="max-width:100%" src="data:image/png;base64,' + r.b64 + '"></div>'
      } })
    }).catch(function (e) { toast('截图失败: ' + e.message) })
  }
  // 时钟
  function tick () {
    var d = new Date()
    document.getElementById('clock').textContent = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
  }
  tick(); setInterval(tick, 1000)
})()
</script>
</body>
</html>`
