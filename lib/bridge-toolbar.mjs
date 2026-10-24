// 通用壳：桥接页面注入的工具栏（访问端浏览器获得手机 App 的工具能力）
// 数据通道 = 同源相对路径 /r/<key>/__happy/*（桥接转发到插件内部端点，cookie 由桥接现铸）
export const bridgeToolbarHtml = `<script>
(function () {
  if (window.__happyBridgeToolbar) return
  window.__happyBridgeToolbar = true
  var api = function (p, body) {
    return fetch('__happy/' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json() })
  }
  var toast = function (msg) {
    var t = document.getElementById('hb-toast') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'hb-toast' }))
    t.textContent = msg
    t.style.cssText = 'position:fixed;bottom:64px;left:50%;transform:translateX(-50%);background:#1A1A1A;color:#fff;padding:8px 16px;border-radius:8px;font:13px system-ui;z-index:999999;transition:opacity .5s;opacity:1'
    clearTimeout(t._h)
    t._h = setTimeout(function () { t.style.opacity = '0' }, 2500)
  }

  // ---- 截图 ----
  var shot = function () {
    toast('正在截图…')
    api('screenshot', {}).then(function (r) {
      if (!r.b64) return toast('截图失败')
      var w = window.open()
      var img = w.document.createElement('img')
      img.src = 'data:image/png;base64,' + r.b64
      img.style.cssText = 'max-width:100%'
      w.document.body.style.cssText = 'margin:0;background:#111'
      w.document.body.appendChild(img)
    }).catch(function (e) { toast('截图失败: ' + e.message) })
  }

  // ---- 剪贴板（http 页面无 navigator.clipboard → execCommand/prompt 兜底）----
  var copyText = function (t) {
    var ta = document.createElement('textarea')
    ta.value = t
    ta.style.cssText = 'position:fixed;left:-9999px'
    document.body.appendChild(ta)
    ta.select()
    var ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  }
  var clipGet = function () {
    api('clipboard/get').then(function (r) {
      if (!r || typeof r.text !== 'string') return toast('取剪贴板失败：电脑返回为空')
      if (copyText(r.text)) toast('已复制电脑剪贴板（' + r.text.length + ' 字）')
      else window.prompt('自动复制失败，请手动 Ctrl+C：', r.text)
    }).catch(function (e) { toast('失败: ' + e.message) })
  }
  var clipSet = function () {
    var t = window.prompt('粘贴要发送到电脑的内容（Ctrl+V）：', '')
    if (t === null) return
    if (t === '') return toast('内容为空')
    api('clipboard/set', { text: t }).then(function () { toast('已发送到电脑剪贴板') }).catch(function (e) { toast('失败: ' + e.message) })
  }

  // ---- 窗口/屏幕实况 ----
  var liveWin = null, liveTimer = -1, liveHwnd = '', liveBusy = false
  var liveStop = function () {
    if (liveTimer >= 0) clearInterval(liveTimer)
    liveTimer = -1
    if (liveWin) { try { liveWin.close() } catch (e) {} }
    liveWin = null
  }
  var liveStart = function () {
    api('windows/list').then(function (r) {
      var ws = (r.windows || [])
      var pick = prompt('输入窗口标题关键字；输入"全屏"=整个显示器（只读）：\\n' + ws.slice(0, 15).map(function (w, i) { return i + '. ' + w.title }).join('\\n'))
      if (pick === null) return
      var screenMode = (pick === '全屏')
      var w = screenMode ? null : (pick === '' ? ws[0] : ws.filter(function (x) { return x.title.toLowerCase().indexOf(pick.toLowerCase()) >= 0 })[0])
      if (!screenMode && !w) return toast('没有匹配窗口')
      liveHwnd = screenMode ? '' : w.hwnd
      liveWin = window.open('', '_blank', 'width=900,height=680')
      liveWin.document.write('<meta charset="utf-8"><title>' + (screenMode ? '整屏实况' : '窗口实况: ' + w.title) + '</title><body style="margin:0;background:#111;text-align:center"><img id=i style="max-width:100%"><p id=s style="color:#8a8;font:12px system-ui">连接中…</p><p style="color:#666;font:11px system-ui">' + (screenMode ? '整屏模式（只读）· 输入窗口标题关键字可实况+点击操作' : '点击画面 = 操作电脑该位置') + '</p></body>')
      var pull = function () {
        if (!liveWin || liveWin.closed) return liveStop()
        if (liveBusy) return
        liveBusy = true
        var req = screenMode
          ? api('screenshot', {}).then(function (r) { return r.b64 ? { changed: true, b64: r.b64 } : { changed: false } })
          : api('live/frame', { hwnd: liveHwnd, title: w.title, maxW: 1280, q: 75 })
        req.then(function (r) {
          if (r.changed) {
            var img = liveWin.document.getElementById('i')
            if (img) img.src = 'data:image/' + (screenMode ? 'png' : 'jpeg') + ';base64,' + r.b64
          }
        }).catch(function () {}).finally(function () { liveBusy = false })
      }
      pull()
      liveTimer = setInterval(pull, screenMode ? 1500 : 900)
      if (screenMode) return
      // 点击回传：在弹窗上监听（用主窗口代理存储坐标，弹窗内 click 上报）
      liveWin.document.getElementById('i').addEventListener('click', function (ev) {
        var rect = ev.target.getBoundingClientRect()
        var x = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
        var y = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height))
        api('click', { hwnd: liveHwnd, title: w.title, x: x, y: y }).then(function (r) {
          toast('已点击 (' + r.sx + ',' + r.sy + ')')
        }).catch(function (e) { toast('点击失败: ' + e.message) })
      })
    })
  }

  // ---- 悬浮工具条 ----
  var bar = document.createElement('div')
  bar.id = 'happy-bridge-toolbar'
  bar.style.cssText = 'position:fixed;right:16px;bottom:72px;z-index:999998;display:flex;flex-direction:column;gap:6px;font:13px system-ui;align-items:flex-end'
  var btn = function (label, fn) {
    var b = document.createElement('button')
    b.textContent = label
    b.style.cssText = 'padding:8px 12px;border:none;border-radius:18px;background:#2b5fdb;color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);white-space:nowrap'
    b.onclick = fn
    bar.appendChild(b)
  }
  btn('📷 截图', shot)
  btn('📋 取剪贴板', clipGet)
  btn('📋 发剪贴板', clipSet)
  btn('🖥️ 窗口实况', liveStart)
  document.body.appendChild(bar)
})()
</script>`
