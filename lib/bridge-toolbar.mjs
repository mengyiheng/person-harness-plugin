// 通用壳：桥接页面注入的工具栏（访问端浏览器获得手机 App 的工具能力）
// 数据通道 = 同源相对路径 /r/<key>/__ph/*（桥接转发到插件内部端点，cookie 由桥接现铸）
export const bridgeToolbarHtml = `<script>
(function () {
  if (window.self !== window.top) { console.log('[ph-toolbar] iframe 内不注入（WebOS Dock 已有入口）'); return }
  if (window.__phBridgeToolbar) return
  window.__phBridgeToolbar = true
  var bar = null
  var mount = function () {
    if (document.getElementById('ph-bridge-toolbar')) return
    if (!document.body) return
    bar = document.createElement('div')
    bar.id = 'ph-bridge-toolbar'
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
    btn('🔍 资料检索', dataSearchWin)
    btn('📁 文件互传', fmOpen)
    // WebOS 入口（2026-10-26 v2）：插件内嵌桌面壳优先——/r/<key>/__ph/webos 打开即接管本机桌面；
    // 非桥接页面回退云端 /os（多机联邦入口）
    btn('🌐 WebOS', function () {
      var m = location.pathname.match(/^\\/r\\/([^/]+)\\//)
      window.open(m ? (location.origin + '/r/' + m[1] + '/__ph/webos') : (location.origin + '/os'), '_blank')
    })
    document.body.appendChild(bar)
    console.log('[ph-toolbar] 工具条已挂载')
  }
  // 自愈：SPA 重渲染/清理移除工具条时自动重新挂载（2026-10-26 假死排查加固）
  // （挂载与观察器在文件末尾启动——所有工具函数定义完成之后）


  var api = function (p, body) {
    return fetch('__ph/' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
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
          ? api('screenshot', { target: 'screen', fmt: 'jpeg', maxW: 1280, q: 60 })
          : api('live/frame', { hwnd: liveHwnd, title: w.title, maxW: 1280, q: 75 })
        req.then(function (r) {
          if (r.changed) {
            var img = liveWin.document.getElementById('i')
            if (img) img.src = 'data:image/jpeg;base64,' + r.b64
          }
        }).catch(function () {}).finally(function () { liveBusy = false })
      }
      pull()
      liveTimer = setInterval(pull, screenMode ? 1200 : 900)
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

  // ---- 资料检索（2026-10-25：与手机 App 工具页对齐）----
  var dsWin = null
  var dataSearchWin = function () {
    var q = window.prompt('搜索宿主电脑全盘索引（支持 ext:pdf days:7 语法）：', '')
    if (!q) return
    toast('搜索中…')
    api('data/search', { query: q, limit: 20 }).then(function (r) {
      var rs = (r && r.results) || []
      if (dsWin && !dsWin.closed) { try { dsWin.close() } catch (e) {} }
      dsWin = window.open('', '_blank', 'width=760,height=720')
      var doc = dsWin.document
      doc.write('<meta charset="utf-8"><title>检索: ' + q + '（' + rs.length + ' 命中）</title><body style="margin:0;font:13px/1.5 system-ui;background:#F7F8FA">')
      if (!rs.length) { doc.write('<p style="padding:24px;color:#888">无命中，试试更短的关键词</p>') }
      rs.forEach(function (it) {
        var card = doc.createElement('div')
        card.style.cssText = 'background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:10px 12px;margin:8px;cursor:pointer'
        var name = doc.createElement('div')
        name.innerHTML = '<b>' + (it.name || it.path) + '</b> <span style="color:#999;font-size:11px">' + (it.size / 1024 / 1024 >= 1 ? (it.size / 1048576).toFixed(1) + 'MB' : Math.round(it.size / 1024) + 'KB') + '</span>'
        var path = doc.createElement('div')
        path.textContent = it.path
        path.style.cssText = 'color:#999;font-size:11px;word-break:break-all'
        card.appendChild(name); card.appendChild(path)
        ;(it.hits || []).slice(0, 2).forEach(function (h) {
          var ctx = doc.createElement('div')
          ctx.textContent = h.context || ''
          ctx.style.cssText = 'color:#666;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
          card.appendChild(ctx)
        })
        card.onclick = function () { previewFile(it.path, it.name) }
        doc.body.appendChild(card)
      })
    }).catch(function (e) { toast('检索失败: ' + e.message) })
  }
  var previewFile = function (p, name) {
    toast('预览加载中…（Office 首次约 3 秒）')
    api('file/preview', { path: p }).then(function (r) {
      if (!r || r.error) return toast('预览失败: ' + ((r && r.error) || '未知'))
      var w = window.open('', '_blank')
      if (r.kind === 'image') {
        w.document.write('<meta charset="utf-8"><title>' + name + '</title><body style="margin:0;background:#111;text-align:center"><img style="max-width:100%" src="data:' + r.mime + ';base64,' + r.b64 + '"></body>')
      } else {
        w.document.open(); w.document.write(r.content); w.document.close()
      }
    }).catch(function (e) { toast('预览失败: ' + e.message) })
  }

  // ---- 文件互传（2026-10-25：与手机 App 工具页对齐：浏览/上传/下载）----
  var fmPanel = null, fmPath = '__quick__'
  var fmClose = function () { if (fmPanel) { fmPanel.remove(); fmPanel = null } }
  var fmOpen = function () {
    if (fmPanel) { fmClose(); return }
    fmPanel = document.createElement('div')
    fmPanel.style.cssText = 'position:fixed;right:16px;bottom:190px;width:380px;max-height:60vh;z-index:999999;background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.25);display:flex;flex-direction:column;font:13px system-ui;overflow:hidden'
    document.body.appendChild(fmPanel)
    fmRender()
  }
  var fmHead = function () {
    var head = document.createElement('div')
    head.style.cssText = 'padding:10px 12px;border-bottom:1px solid #eee;display:flex;gap:8px;align-items:center;background:#FAFBFC'
    var title = document.createElement('div')
    title.textContent = '文件互传'
    title.style.cssText = 'font-weight:600;flex:1'
    var up = document.createElement('button')
    up.textContent = '⬆ 传到当前目录'
    up.style.cssText = 'padding:5px 10px;border:none;border-radius:14px;background:#2b5fdb;color:#fff;cursor:pointer;font-size:12px'
    up.onclick = fmUpload
    var x = document.createElement('button')
    x.textContent = '✕'
    x.style.cssText = 'border:none;background:none;cursor:pointer;font-size:14px;color:#999'
    x.onclick = fmClose
    head.appendChild(title); head.appendChild(up); head.appendChild(x)
    return head
  }
  var fmRender = function () {
    if (!fmPanel) return
    fmPanel.innerHTML = ''
    fmPanel.appendChild(fmHead())
    var path = document.createElement('div')
    path.textContent = fmPath === '__quick__' ? '（常用位置）' : fmPath
    path.style.cssText = 'padding:6px 12px;color:#888;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid #f0f0f0'
    fmPanel.appendChild(path)
    var list = document.createElement('div')
    list.style.cssText = 'flex:1;overflow-y:auto;padding:6px'
    fmPanel.appendChild(list)
    var busy = document.createElement('div')
    busy.textContent = '加载中…'
    busy.style.cssText = 'padding:16px;color:#999'
    list.appendChild(busy)
    api('files/list', { path: fmPath }).then(function (r) {
      list.innerHTML = ''
      // 上一级
      if (fmPath !== '__quick__') {
        var up1 = row('⬆️ 上一级', function () { fmPath = (fmPath === '__drives__' || /^[a-zA-Z]:\\\\?$/.test(fmPath) || /^[a-zA-Z]:\\?$/.test(fmPath)) ? '__quick__' : fmPath.replace(/[\\/][^\\/]+[\\/]?$/, ''); fmRender() })
        list.appendChild(up1)
      }
      var entries = (r.quick || r.roots || r.items || [])
      entries.forEach(function (it) {
        var isQuick = !!r.quick
        var isDir = isQuick || (r.roots ? true : it.dir)
        var label = isQuick ? it.name : (r.roots ? it.label : it.name)
        var target = isQuick ? it.path : (r.roots ? it.path : null)
        var full = target || (fmPath === '__quick__' || fmPath === '__drives__' ? label : fmPath + '\\\\' + label)
        var el = row((isDir ? '📁 ' : '📄 ') + label + (isDir ? '' : '  <span style="color:#bbb;font-size:11px">' + fmtSize(it.size) + '</span>'), isDir ? function () { fmPath = full; fmRender() } : function () { fmDownload(full, label) })
        el._full = full
        list.appendChild(el)
      })
      if (!entries.length) { var e2 = document.createElement('div'); e2.textContent = '（空）'; e2.style.cssText = 'padding:16px;color:#999'; list.appendChild(e2) }
    }).catch(function (e) { busy.textContent = '读取失败: ' + e.message })
  }
  var fmtSize = function (n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB' }
  var row = function (html, fn) {
    var d = document.createElement('div')
    d.innerHTML = html
    d.style.cssText = 'padding:8px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
    d.onmouseover = function () { d.style.background = '#F0F4FF' }
    d.onmouseout = function () { d.style.background = '' }
    d.onclick = fn
    return d
  }
  var fmDownload = function (full, name) {
    // 分块下载（2026-10-26 反堵塞）：1MB/块循环拉取，小文件自然只有一块；不 atob 全量解码
    var CH = 1024 * 1024, parts = [], offset = 0, total = -1
    toast('下载中…')
    var pull = function () {
      api('file/get-chunk', { path: full, offset: offset, size: CH }).then(function (r) {
        if (!r || r.error) return toast('下载失败: ' + ((r && r.error) || '未知'))
        if (total < 0) { total = r.size; if (total > CH) toast('分块下载 ' + name + '…') }
        var bin = atob(r.b64)
        var buf = new Uint8Array(bin.length)
        for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
        parts.push(buf)
        offset = r.offset + r.len
        if (offset < total) { pull() } else {
          var a = document.createElement('a')
          a.href = URL.createObjectURL(new Blob(parts))
          a.download = name || r.name || 'file'
          a.click()
          toast('已下载 ' + fmtSize(total))
        }
      }).catch(function (e) { toast('下载失败: ' + e.message) })
    }
    pull()
  }
  var fmUpload = function () {
    var input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = function () {
      var dir = (fmPath !== '__quick__' && fmPath !== '__drives__') ? fmPath : ''
      var files = Array.prototype.slice.call(input.files)
      var ok = 0
      var next = function () {
        if (!files.length) { toast('已上传 ' + ok + ' 个文件' + (dir ? ' → ' + dir : '')); fmRender(); return }
        var f = files.shift()
        if (f.size <= 1024 * 1024) {
          var rd0 = new FileReader()
          rd0.onload = function () {
            var b64 = String(rd0.result).split(',')[1]
            api('file/put', { name: f.name, b64: b64, dir: dir }).then(function () { ok++; next() }).catch(function () { next() })
          }
          rd0.readAsDataURL(f)
          return
        }
        // 大文件分片（1MB/块）：避免单帧巨型 JSON 堵死共享隧道
        var CH = 1024 * 1024, n = Math.ceil(f.size / CH)
        var uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        var seq = 0
        toast('分片上传 ' + f.name + '（' + n + ' 块）…')
        var sendChunk = function () {
          if (seq >= n) { ok++; return next() }
          var rd = new FileReader()
          rd.onload = function () {
            var b64 = String(rd.result).split(',')[1]
            api('file/put-chunk', { uploadId: uid, seq: seq + 1, n: n, name: f.name, dir: dir, b64: b64, fin: seq + 1 === n })
              .then(function (r) {
                if (r && r.error) { toast(f.name + ' 分片失败：' + r.error); return next() }
                seq++
                if (seq % 10 === 0 || seq === n) toast(f.name + '：' + seq + '/' + n + ' 块')
                sendChunk()
              })
              .catch(function () { next() })
          }
          rd.readAsDataURL(f.slice(seq * CH, Math.min(f.size, (seq + 1) * CH)))
        }
        sendChunk()
      }
      next()
    }
    input.click()
  }

  // ---- 悬浮工具条（自愈挂载，2026-10-26）----
  var startObs = function () {
    if (!document.body) return
    new MutationObserver(ensure).observe(document.body, { childList: true })
  }
  var ensure = function () {
    if (!document.getElementById('ph-bridge-toolbar')) mount()
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { ensure(); startObs() })
  } else {
    ensure()
    startObs()
  }
})()
</script>`
