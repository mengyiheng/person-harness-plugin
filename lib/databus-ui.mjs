// 数据总线 · 浏览器监测与资源管理工作台（本机弹出，与二维码页同款通道）
// 用户在本机 GUI 已登录，Cookie 能过 /api/ph-databus 鉴权
export function databusHtml () {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>智枢 · 数据总线监测台</title>
<style>
:root{--bg:#f3f5f8;--card:#fff;--text:#172033;--muted:#697386;--line:#e6eaf0;--blue:#315efb;--blue-soft:#edf1ff;--green:#138a5b;--green-soft:#e9f8f1;--orange:#b76300;--orange-soft:#fff4df;--red:#c43838;--red-soft:#fff0f0;--shadow:0 1px 2px rgba(22,32,51,.03),0 8px 28px rgba(22,32,51,.045)}
*{box-sizing:border-box}body{font-family:Inter,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);margin:0;font-size:14px}button,input,select{font:inherit}button{cursor:pointer}.shell{max-width:1440px;margin:0 auto;padding:24px 28px 40px}.topbar{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:20px}.brand{display:flex;align-items:center;gap:12px}.logo{width:42px;height:42px;border-radius:12px;background:linear-gradient(145deg,#3f68ff,#2445c7);color:#fff;display:grid;place-items:center;font-size:20px;box-shadow:0 6px 18px rgba(49,94,251,.22)}h1{font-size:21px;line-height:1.25;margin:0 0 4px;letter-spacing:-.02em}.subtitle{font-size:12px;color:var(--muted)}.top-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}.btn{border:1px solid var(--line);background:#fff;color:#344054;border-radius:8px;padding:8px 13px;font-weight:600;font-size:13px;transition:.15s}.btn:hover{border-color:#b8c2d4;background:#fafbfc}.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff}.btn.primary:hover{background:#264dd8}.btn.small{padding:5px 9px;font-size:12px}.btn.ghost{border-color:transparent;background:transparent}.btn.danger{color:var(--red)}.btn:disabled{opacity:.55;cursor:wait}.live-pill{display:inline-flex;align-items:center;gap:7px;background:var(--green-soft);color:var(--green);border-radius:999px;padding:6px 10px;font-size:12px;font-weight:650;white-space:nowrap}.live-pill.warn{background:var(--orange-soft);color:var(--orange)}.dot{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px rgba(19,138,91,.1)}.updated{font-size:12px;color:var(--muted);white-space:nowrap}.tabs{display:flex;gap:4px;border-bottom:1px solid #dfe4eb;margin-bottom:20px;overflow-x:auto}.tab{border:0;background:transparent;color:var(--muted);padding:11px 15px 12px;white-space:nowrap;font-weight:600;border-bottom:2px solid transparent;margin-bottom:-1px}.tab:hover{color:var(--text)}.tab.active{color:var(--blue);border-bottom-color:var(--blue)}.panel{display:none}.panel.active{display:block}.grid{display:grid;gap:16px}.metrics{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:16px}.card{background:var(--card);border:1px solid rgba(224,229,236,.9);border-radius:13px;box-shadow:var(--shadow);padding:18px}.metric{position:relative;overflow:hidden}.metric-label{color:var(--muted);font-size:13px;display:flex;align-items:center;justify-content:space-between;gap:8px}.metric-value{font-size:30px;font-weight:720;line-height:1.2;margin:10px 0 6px;letter-spacing:-.035em}.metric-foot{font-size:12px;color:var(--muted)}.metric-icon{font-size:18px}.two-col{grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);margin-bottom:16px}.equal{grid-template-columns:repeat(2,minmax(0,1fr))}.card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}.card-title{font-size:15px;font-weight:700;margin:0}.card-desc{font-size:12px;color:var(--muted);margin-top:5px;line-height:1.6}.runtime-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 22px}.runtime-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 0;border-bottom:1px solid var(--line);font-size:13px}.runtime-row:nth-last-child(-n+2){border-bottom:0}.runtime-label{color:var(--muted)}.runtime-value{text-align:right;font-weight:600;word-break:break-word}.status-ok{color:var(--green)}.status-warn{color:var(--orange)}.status-bad{color:var(--red)}.distribution{display:flex;height:10px;border-radius:999px;overflow:hidden;background:#edf0f4;margin:18px 0 14px}.distribution span{min-width:0}.legend{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.legend-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px}.legend-name{display:flex;align-items:center;gap:8px}.level-dot{width:8px;height:8px;border-radius:50%}.lv-public{color:var(--green)}.lv-internal{color:#3471c9}.lv-sensitive{color:var(--orange)}.lv-restricted{color:var(--red)}.bg-public{background:#35ac7c}.bg-internal{background:#5a8fdf}.bg-sensitive{background:#e9a23b}.bg-restricted{background:#d95c5c}.tag{display:inline-flex;align-items:center;border-radius:6px;padding:3px 8px;background:#eef1f5;font-size:11px;font-weight:650;white-space:nowrap}.tag.lv-public{background:var(--green-soft)}.tag.lv-internal{background:#edf4ff}.tag.lv-sensitive{background:var(--orange-soft)}.tag.lv-restricted{background:var(--red-soft)}.alert-list,.access-list{display:grid;gap:2px}.alert-item{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);line-height:1.55}.alert-item:last-child{border-bottom:0}.alert-mark{flex:none}.alert-msg{font-size:13px;word-break:break-word}.alert-meta{font-size:11px;color:var(--muted);margin-top:4px;word-break:break-all}.empty{padding:26px 12px;text-align:center;color:var(--muted);font-size:13px}.empty.ok{color:var(--green)}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}th{color:var(--muted);font-size:11px;font-weight:650;letter-spacing:.03em;background:#fafbfc}td,th{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#fbfcfe}.path{color:var(--muted);font-size:12px;word-break:break-all}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}.field{border:1px solid #cfd6e1;background:#fff;color:var(--text);border-radius:8px;padding:9px 11px;outline:none;min-width:0}.field:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(49,94,251,.09)}.field.grow{flex:1;min-width:220px}.check{display:inline-flex;align-items:center;gap:6px;color:#475467;font-size:13px;white-space:nowrap}.check input{accent-color:var(--blue)}.hint{font-size:12px;color:var(--muted);line-height:1.7}.result-summary{color:var(--muted);font-size:12px;margin:4px 0 10px}.file-row{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;padding:13px 0;border-bottom:1px solid var(--line)}.file-row:last-child{border-bottom:0}.file-main{flex:1;min-width:220px}.file-name{font-weight:650;margin-right:7px;word-break:break-all}.file-actions{display:flex;gap:6px;margin-left:auto}.hit{font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;background:#f7f8fa;border-radius:7px;padding:8px 10px;margin:8px 0 0;white-space:pre-wrap;word-break:break-word}.preview{margin-top:16px;border-top:1px solid var(--line);padding-top:14px}.preview pre{background:#101828;color:#e6ebf2;padding:16px;border-radius:9px;max-height:440px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace}.notice{border-radius:10px;padding:12px 14px;background:var(--blue-soft);color:#344b9a;font-size:12px;line-height:1.7;margin-bottom:16px}.notice.warn{background:var(--orange-soft);color:#86500b}.section-gap{margin-top:16px}.policy-form{display:grid;grid-template-columns:minmax(150px,.8fr) minmax(260px,1.4fr) auto;gap:10px;align-items:start}.policy-form select[multiple]{min-height:98px}.toast{position:fixed;right:24px;bottom:24px;z-index:10;background:#172033;color:#fff;border-radius:10px;padding:12px 16px;box-shadow:0 10px 32px rgba(0,0,0,.2);font-size:13px;max-width:min(440px,calc(100vw - 32px));display:none;line-height:1.55}.toast.show{display:block}.toast.error{background:#9d2f2f}.mobile-only{display:none}
@media(max-width:980px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.two-col,.equal{grid-template-columns:minmax(0,1fr)}.shell{padding:20px}.topbar{align-items:flex-start}.runtime-list{grid-template-columns:1fr}.runtime-row:nth-last-child(-n+2){border-bottom:1px solid var(--line)}.runtime-row:last-child{border-bottom:0}.policy-form{grid-template-columns:1fr}.policy-form .btn{justify-self:start}}
@media(max-width:620px){.shell{padding:14px 12px 28px}.topbar{display:block}.top-actions{justify-content:flex-start;margin-top:14px}.updated{display:none}.metrics{gap:10px}.card{padding:14px;border-radius:11px;min-width:0}.metric-value{font-size:25px}.runtime-value{min-width:0;overflow-wrap:anywhere}.tabs{margin-left:-12px;margin-right:-12px;padding-left:8px}.tab{padding-left:11px;padding-right:11px}.file-actions{margin-left:0;width:100%}.field.grow{min-width:160px}.desktop-only{display:none}.mobile-only{display:inline}.toast{right:16px;bottom:16px}}
/* 与官网 homepage-v2 同一视觉语言：深色 Hero、薄荷绿状态、蓝紫强调、浅色卡片 */
:root{--bg:#f6f7f9;--card:#fff;--text:#101522;--muted:#667085;--line:#e4e7ec;--blue:#527df5;--blue-soft:#eef3ff;--green:#24967e;--green-soft:#eaf8f4;--orange:#a86113;--orange-soft:#fff4df;--red:#c43838;--red-soft:#fff0f0;--mint:#63ddc7;--dark:#090e18;--dark2:#101827;--shadow:0 12px 34px rgba(20,31,52,.055)}
body{background:var(--bg);font-family:Inter,"SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}::selection{background:#b9f6e9;color:#10231f}.shell{max-width:none;margin:0;padding:0 0 52px}.topbar{position:relative;isolation:isolate;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:36px;margin:0;padding:42px max(28px,calc((100vw - 1200px)/2 + 28px)) 40px;background:var(--dark);color:#fff}.topbar:before,.topbar:after{content:"";position:absolute;z-index:-1;border-radius:50%;pointer-events:none}.topbar:before{width:620px;height:620px;left:-260px;top:-390px;background:radial-gradient(circle,rgba(99,221,199,.16),transparent 66%)}.topbar:after{width:720px;height:720px;right:-260px;top:-430px;background:radial-gradient(circle,rgba(82,125,245,.22),transparent 66%)}.brand{gap:15px;min-width:0}.logo{flex:none;width:48px;height:48px;border:1px solid rgba(255,255,255,.17);border-radius:13px;background:linear-gradient(145deg,rgba(99,221,199,.23),rgba(82,125,245,.28));color:#dffff7;font-size:21px;font-weight:760;box-shadow:0 12px 32px rgba(0,0,0,.2)}.brand .eyebrow{display:flex;align-items:center;gap:8px;margin-bottom:9px;color:#91a0b5;font-size:9px;font-weight:700;letter-spacing:.15em}.brand .eyebrow:before{content:"";width:20px;height:1px;background:var(--mint)}h1{margin:0 0 8px;color:#fff;font-size:clamp(25px,3vw,36px);line-height:1.15;letter-spacing:-.04em}.subtitle{color:#93a1b5;font-size:13px;line-height:1.7}.top-actions{position:relative;z-index:1;max-width:520px}.top-actions .btn{border-color:rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:#dbe4f0}.top-actions .btn:hover{border-color:rgba(255,255,255,.28);background:rgba(255,255,255,.11)}.top-actions .btn.primary{border-color:#f5f8ff;background:#f5f8ff;color:#111827}.top-actions .btn.primary:hover{background:#fff}.top-actions .check{color:#aab6c8}.top-actions .updated{color:#758499}.live-pill{border:1px solid rgba(99,221,199,.16);background:rgba(99,221,199,.09);color:#77e5cf}.live-pill.warn{border-color:rgba(245,190,103,.2);background:rgba(245,190,103,.1);color:#f2c77e}.dot{box-shadow:0 0 0 3px rgba(99,221,199,.1)}
.tabs{position:relative;z-index:3;max-width:1200px;margin:0 auto;padding:16px 28px 0;gap:6px;border:0;background:var(--bg)}.tab{margin:0;padding:10px 14px;border:1px solid transparent;border-radius:9px;color:#6d7889;font-size:13px}.tab:hover{background:#eef1f5;color:#263349}.tab.active{border-color:#dce5f8;background:#eaf0ff;color:#405fab;box-shadow:0 3px 10px rgba(52,76,125,.05)}main{max-width:1200px;margin:0 auto;padding:22px 28px 0}.grid{gap:15px}.card{padding:23px;border:1px solid var(--line);border-radius:15px;box-shadow:0 1px 0 rgba(16,24,40,.015)}.card:hover{border-color:#d8dee8}.metric{position:relative;overflow:hidden}.metric:before{content:"";position:absolute;left:23px;right:23px;top:0;height:2px;background:linear-gradient(90deg,var(--mint),var(--blue));opacity:.75}.metric-label{color:#697586;font-weight:650}.metric-value{margin-top:12px;color:#152033;font-size:31px;letter-spacing:-.04em}.metric-foot{color:#8791a1}.metric-icon{filter:grayscale(.35);opacity:.75}.card-title{color:#182235;font-size:16px;letter-spacing:-.02em}.card-desc{color:#7a8494;line-height:1.7}.btn{border-radius:9px;font-weight:650}.btn.primary{background:var(--blue);border-color:var(--blue);box-shadow:0 5px 14px rgba(82,125,245,.15)}.btn.primary:hover{background:#416ce2}.btn.ghost{color:#4c68ae}.notice{border-color:#dce7f4;border-radius:11px;background:#f0f5fa;color:#5e6f84;line-height:1.8}.field{border-color:#dfe4eb;border-radius:9px;background:#fff;color:#263247}.field:focus{border-color:#8aa7ef;box-shadow:0 0 0 3px rgba(82,125,245,.09);outline:0}.tag{border-radius:6px}.table-wrap{border-color:#e5e9ef;border-radius:11px}th{background:#f8fafc;color:#778295;font-size:11px;letter-spacing:.02em}td{border-color:#edf0f4}tbody tr:hover{background:#fafbfc}.file-row{border-color:#e8ecf1;border-radius:11px}.file-row:hover{border-color:#d8e1ef;background:#fbfcfe}.distribution{overflow:hidden;border-radius:999px}.section-gap{margin-top:15px}.empty{border-radius:10px}.toast{border-radius:11px;box-shadow:0 18px 50px rgba(9,14,24,.2)}
@media(max-width:980px){.shell{padding:0 0 40px}.topbar{padding:36px 24px;grid-template-columns:1fr;gap:24px}.top-actions{max-width:none;justify-content:flex-start}.tabs{padding-left:24px;padding-right:24px}main{padding-left:24px;padding-right:24px}}
@media(max-width:620px){.shell{padding:0 0 30px}.topbar{display:grid;padding:30px 18px 28px}.brand{align-items:flex-start}.logo{width:42px;height:42px}.brand .eyebrow{font-size:8px;letter-spacing:.1em}h1{font-size:26px}.subtitle{font-size:12px}.top-actions{margin-top:0;gap:8px}.top-actions .check{width:100%}.updated{display:none}.tabs{margin:0;padding:12px 12px 0}.tab{padding:9px 11px}main{padding:16px 12px 0}.card{padding:17px;border-radius:13px}.metric:before{left:17px;right:17px}.metric-value{font-size:27px}}
</style></head><body><div class="shell">
<header class="topbar">
  <div class="brand"><div class="logo">H</div><div><div class="eyebrow">PERSON HARNESS · LOCAL DATA BUS</div><h1>智枢 MCP 数据总线</h1><div class="subtitle">本机资源监测、MCP 接入授权与访问审计，状态清晰可查。</div></div></div>
  <div class="top-actions"><span class="live-pill" id="servicePill"><span class="dot"></span><span id="serviceText">正在连接</span></span><span class="updated" id="lastUpdated">尚未刷新</span><label class="check" title="总览页每 30 秒自动刷新"><input type="checkbox" id="autoRefresh" checked> 自动刷新</label><button class="btn" id="refreshBtn" onclick="refresh()">刷新</button><button class="btn primary" id="scanBtn" onclick="doScan()">重新扫描</button></div>
</header>
<nav class="tabs" aria-label="数据总线功能">
  <button class="tab active" data-tab="overview" onclick="setTab('overview')">监测总览</button>
  <button class="tab" data-tab="search" onclick="setTab('search')">文件检索</button>
  <button class="tab" data-tab="sources" onclick="setTab('sources')">监控目录</button>
  <button class="tab" data-tab="review" onclick="setTab('review')">分级复核 <span id="reviewBadge"></span></button>
  <button class="tab" data-tab="audit" onclick="setTab('audit')">安全审计</button>
  <button class="tab" data-tab="mcp" onclick="setTab('mcp')">MCP 接入 <span id="mcpBadge"></span></button>
  <button class="tab" data-tab="policy" onclick="setTab('policy')">访问策略</button>
</nav>
<main>
<section class="panel active" id="tab-overview">
  <div class="grid metrics">
    <div class="card metric"><div class="metric-label">监控目录 <span class="metric-icon">🗂️</span></div><div class="metric-value" id="metricSources">—</div><div class="metric-foot">持续纳入索引的本机文件夹</div></div>
    <div class="card metric"><div class="metric-label">索引文件 <span class="metric-icon">📄</span></div><div class="metric-value" id="metricFiles">—</div><div class="metric-foot" id="metricFilesFoot">索引仅保存在本机</div></div>
    <div class="card metric"><div class="metric-label">待复核 <span class="metric-icon">◌</span></div><div class="metric-value" id="metricReview">—</div><div class="metric-foot">规则未命中的内部分级文件</div></div>
    <div class="card metric"><div class="metric-label">安全提醒 <span class="metric-icon">◇</span></div><div class="metric-value" id="metricAlerts">—</div><div class="metric-foot">最近 24 小时，按风险规则生成</div></div>
  </div>
  <div class="grid two-col">
    <div class="card"><div class="card-head"><div><h2 class="card-title">运行状态</h2><div class="card-desc">展示当前插件实例的真实运行指标</div></div><span class="tag" id="apiLatency">— ms</span></div><div class="runtime-list" id="runtime"><div class="empty">正在读取运行状态…</div></div></div>
    <div class="card"><div class="card-head"><div><h2 class="card-title">文件分级分布</h2><div class="card-desc">级别决定 Agent 可访问范围，不代表文件是否被索引</div></div></div><div class="distribution" id="levelBar"></div><div class="legend" id="levelLegend"></div><div class="notice section-gap">MCP 标准桥提供 <b>search_local_files</b> 与 <b>read_local_file</b> 两个工具。每次检索与读取均按策略过滤并写入本机台账。</div></div>
  </div>
  <div class="grid equal">
    <div class="card"><div class="card-head"><div><h2 class="card-title">最新安全提醒</h2><div class="card-desc">敏感读取、越权尝试、批量搬运与插件外修改</div></div><button class="btn ghost small" onclick="setTab('audit')">查看全部 →</button></div><div id="overviewAlerts" class="alert-list"></div></div>
    <div class="card"><div class="card-head"><div><h2 class="card-title">最近访问</h2><div class="card-desc">谁在何时对哪个文件执行了什么操作</div></div><button class="btn ghost small" onclick="setTab('audit')">完整台账 →</button></div><div id="overviewAccess" class="access-list"></div></div>
  </div>
</section>
<section class="panel" id="tab-search"><div class="card">
  <div class="card-head"><div><h2 class="card-title">文件检索</h2><div class="card-desc">支持 ext:png,pdf　days:7　size:&gt;10mb　path:文档；勾选“正文”可搜索文本内容</div></div></div>
  <div class="toolbar"><input class="field grow" id="q" placeholder="输入文件名关键词，例如：ext:md 报销" onkeydown="if(event.key==='Enter')doSearch()"><input class="field" id="days" type="number" value="0" min="0" style="width:82px" title="最近 N 天，0=不限"><span class="hint">天内</span><label class="check"><input type="checkbox" id="content"> 正文</label><button class="btn primary" id="searchBtn" onclick="doSearch()">搜索</button></div>
  <div class="result-summary" id="searchSummary">输入条件开始检索，结果仅包含当前策略允许的级别。</div><div id="results"></div><div id="preview" class="preview" style="display:none"></div>
</div></section>
<section class="panel" id="tab-sources"><div class="card">
  <div class="card-head"><div><h2 class="card-title">监控目录</h2><div class="card-desc">新增目录会进行全量索引；移除目录会同时删除其索引，不会删除原文件</div></div></div>
  <div class="toolbar"><input class="field grow" id="newsrc" placeholder="输入文件夹完整路径，例如 D:\\资料"><button class="btn primary" id="addSourceBtn" onclick="addSrc()">添加目录</button></div><div id="sources"></div>
</div></section>
<section class="panel" id="tab-review"><div class="card">
  <div class="card-head"><div><h2 class="card-title">分级复核</h2><div class="card-desc">规则未命中且未手工定级的文件会出现在这里；手工定级后不会被后续扫描覆盖</div></div><button class="btn small" onclick="loadUncertain()">刷新列表</button></div><div id="uncertain"></div>
</div></section>
<section class="panel" id="tab-audit">
  <div class="card"><div class="card-head"><div><h2 class="card-title">安全提醒</h2><div class="card-desc">统计最近 24 小时活动；插件之外的纯读取无法被本总线观测</div></div><button class="btn small" onclick="loadAudit()">刷新审计</button></div><div id="alerts" class="alert-list"></div></div>
  <div class="card section-gap"><div class="card-head"><div><h2 class="card-title">访问台账</h2><div class="card-desc">最近 50 条记录，只保存在本机 data-access.jsonl</div></div></div><div id="access"></div></div>
</section>
<section class="panel" id="tab-mcp">
  <div class="notice">同一个智枢插件包内置多家独立 Agent 驱动。独立 Agent 可适配手机独立对话；WorkBuddy、各类“龙虾”等按 MCP 宿主管理，只表示可接入总线，不表示已有手机驱动。“已发现”不等于“已代理”。</div>
  <div class="grid metrics section-gap">
    <div class="card metric"><div class="metric-label">必需宿主</div><div class="metric-value" id="mcpRequired">—</div><div class="metric-foot">插件所在的 dsh 始终接入</div></div>
    <div class="card metric"><div class="metric-label">待授权</div><div class="metric-value" id="mcpPending">—</div><div class="metric-foot">授权前不能检索或读取文件</div></div>
    <div class="card metric"><div class="metric-label">不接入</div><div class="metric-value" id="mcpDenied">—</div><div class="metric-foot">可随时重新允许</div></div>
    <div class="card metric"><div class="metric-label">旁路 MCP 配置</div><div class="metric-value" id="mcpBypassCount">—</div><div class="metric-foot">仅盘点配置，不代表调用已监测</div></div>
  </div>
  <div class="card section-gap">
    <div class="card-head"><div><h2 class="card-title">通用 MCP 接入助手</h2><div class="card-desc">插件与总线由 dsh 运行；其他 Agent / 宿主只需添加下面的标准 MCP 配置，不要求安装其他独立 Agent</div></div><button class="btn" id="mcpSetupBtn" onclick="generateMcpSetup()">生成配置</button></div>
    <div class="notice">① 输入宿主标识并生成配置　② 复制到该宿主的 MCP 配置，或登记 JSON 文件后授权自动写入　③ 重启宿主并检查握手。宿主本身必须支持 MCP；写入前自动保留 <b>.ph-backup</b> 备份。</div>
    <div class="policy-form section-gap"><input class="field" id="mcpAgent" value="workbuddy" placeholder="宿主标识，如 workbuddy"><input class="field" id="mcpConfigPath" placeholder="可选：JSON 配置文件绝对路径"><button class="btn primary" id="mcpRegisterBtn" onclick="registerCustomMcpHost()">登记为待授权</button></div>
    <div class="hint section-gap">登记只关联配置，不会立即写入。随后在下方“MCP 宿主”列表点击“允许接入”；留空路径则仅生成手工配置。</div>
    <textarea class="field" id="mcpSetupJson" readonly spellcheck="false" aria-label="智枢 MCP 配置" style="width:100%;min-height:210px;font:12px/1.55 Consolas,monospace;white-space:pre;resize:vertical"></textarea>
    <div class="toolbar"><button class="btn" id="mcpCopyBtn" onclick="copyMcpConfig()">复制配置</button><button class="btn" id="mcpCheckBtn" onclick="checkMcpConnection()">检查接入状态</button><span class="hint" id="mcpSetupState">配置由本机实时生成</span></div>
    <div class="path">桥接脚本：<span id="mcpBridgePath">读取中…</span></div>
  </div>
  <div class="card"><div class="card-head"><div><h2 class="card-title">独立 Agent</h2><div class="card-desc">已有专用驱动的 8 家 Agent；这里仅显示其总线授权与调用，不代表真实模型或手机配对已通过</div></div></div><div id="agentHosts"></div></div>
  <div class="card section-gap"><div class="card-head"><div><h2 class="card-title">MCP 宿主</h2><div class="card-desc">WorkBuddy、OpenClaw、Clawdbot 及插件所在宿主；每 5 分钟检测已知配置，自定义宿主可即时登记，标准桥首次握手也会记录</div></div><button class="btn" id="mcpDiscoverBtn" onclick="discoverMcp()">重新检测</button></div><div id="mcpHosts"></div></div>
  <div class="card section-gap"><div class="card-head"><div><h2 class="card-title">旁路 MCP Server 配置</h2><div class="card-desc">这些 Server 仍由原宿主直接连接；只有经过智枢标准桥的调用才纳入本总线审计</div></div></div><div id="mcpBypass"></div></div>
</section>
<section class="panel" id="tab-policy">
  <div class="notice">级别从低到高为：公开 &lt; 内部 &lt; 敏感 &lt; 禁碰。Agent 只能访问策略中明确允许的级别；目录规则按最长路径优先继承。</div>
  <div class="card"><div class="card-head"><div><h2 class="card-title">Agent 默认策略</h2><div class="card-desc">Agent 名留空表示默认规则（*），MCP 的 PH_AGENT 与此处名称对应</div></div></div><div id="policy"></div>
    <div class="policy-form section-gap"><input class="field" id="ag" placeholder="Agent 名（留空=默认）"><select class="field" id="lvs" multiple size="4"><option value="public">公开</option><option value="internal" selected>内部</option><option value="sensitive">敏感</option><option value="restricted">禁碰</option></select><button class="btn primary" onclick="setPol()">保存默认策略</button></div>
  </div>
  <div class="card section-gap"><div class="card-head"><div><h2 class="card-title">目录覆盖策略</h2><div class="card-desc">为某个目录及其子目录单独授权，优先于 Agent 默认策略</div></div></div><div id="dirPolicy"></div>
    <div class="policy-form section-gap"><div><input class="field" id="dirPath" placeholder="目录完整路径" style="width:100%;margin-bottom:8px"><input class="field" id="dirAgent" placeholder="Agent 名（留空=全部）" style="width:100%"></div><select class="field" id="dirLevels" multiple size="4"><option value="public">公开</option><option value="internal" selected>内部</option><option value="sensitive">敏感</option><option value="restricted">禁碰</option></select><button class="btn primary" onclick="setDirPol()">保存目录策略</button></div>
  </div>
</section>
</main></div><div class="toast" id="toast" role="status"></div>
<script>
const $ = (id) => document.getElementById(id);
const LEVELS = {public:'公开',internal:'内部',sensitive:'敏感',restricted:'禁碰'};
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api = async (action, data={}) => {
  const r = await fetch('/api/ph-databus/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...data})});
  if(!r.ok) throw new Error('请求失败（HTTP '+r.status+'）');
  return r.json();
};
const lvTag = (l) => '<span class="tag lv-'+esc(l)+'">'+esc(LEVELS[l]||l)+'</span>';
const fmt = (s) => { const n=Number(s)||0; if(n>=1073741824)return (n/1073741824).toFixed(2)+' GB'; if(n>=1048576)return (n/1048576).toFixed(1)+' MB'; if(n>=1024)return Math.max(1,Math.round(n/1024))+' KB'; return n+' B'; };
const num = (n) => Number(n||0).toLocaleString('zh-CN');
const timeText = (t) => t ? new Date(t).toLocaleString('zh-CN',{hour12:false}) : '暂无记录';
let currentTab = 'overview';
let toastTimer = null;
function notify(msg,error=false){ const t=$('toast'); t.textContent=String(msg); t.className='toast show'+(error?' error':''); clearTimeout(toastTimer); toastTimer=setTimeout(()=>{t.className='toast'},3600); }
function setTab(name){ currentTab=name; document.querySelectorAll('.tab').forEach((b)=>b.classList.toggle('active',b.dataset.tab===name)); document.querySelectorAll('.panel').forEach((p)=>p.classList.toggle('active',p.id==='tab-'+name)); if(name==='overview')refreshOverview(); if(name==='audit')loadAudit(); if(name==='mcp')loadMcp(); }
function eventName(ev){ return ({read:'读取',hit:'检索命中',search:'检索',setlevel:'定级',upload:'上传',download:'下载',preview:'预览',cleanup:'清理','ferry-send':'跨机发送','external-modify':'外部修改','mcp-denied':'MCP 接入拦截'})[ev]||ev; }
function renderAlerts(items,limit){ const list=(items||[]).slice(0,limit); if(!list.length)return '<div class="empty ok">✓ 暂无危险行为提醒</div>'; return list.map((a)=>'<div class="alert-item"><span class="alert-mark">'+(a.level==='high'?'🔴':'🟡')+'</span><div><div class="alert-msg">'+esc(a.msg)+'</div><div class="alert-meta">'+esc(timeText(a.time))+(a.path?' · '+esc(a.path):'')+'</div></div></div>').join(''); }
function renderAccess(items,table){ const list=items||[]; if(!list.length)return '<div class="empty">暂无访问记录</div>'; if(!table)return '<div class="access-list">'+list.slice(0,8).map((a)=>'<div class="alert-item"><div style="flex:1;min-width:0"><div class="alert-msg"><b>'+esc(a.agent)+'</b> · '+esc(eventName(a.ev))+(a.ok?'':' <span class="status-bad">被拒</span>')+'</div><div class="alert-meta">'+esc(a.path)+'</div></div><span class="hint">'+esc(a.time||timeText(a.t))+'</span></div>').join('')+'</div>'; return '<div class="table-wrap"><table><thead><tr><th>时间</th><th>Agent</th><th>行为</th><th>对象</th></tr></thead><tbody>'+list.map((a)=>'<tr><td style="white-space:nowrap">'+esc(a.time||timeText(a.t))+'</td><td><b>'+esc(a.agent)+'</b></td><td>'+esc(eventName(a.ev))+(a.ok?'':' <span class="status-bad">被拒</span>')+'</td><td class="path" title="'+esc(a.path)+'">'+esc(a.path)+'</td></tr>').join('')+'</tbody></table></div>'; }
async function refreshOverview(){
  const started=Date.now();
  try{
    const [m,a,u]=await Promise.all([api('monitor'),api('alerts'),api('access',{limit:8})]);
    if(m.error)throw new Error(m.error);
    const s=m.monitor||{}; const alerts=a.alerts||[]; const high=alerts.filter((x)=>x.level==='high').length;
    $('metricSources').textContent=num(s.sources); $('metricFiles').textContent=num(s.total); $('metricReview').textContent=num(s.uncertain); $('metricAlerts').textContent=num(alerts.length);
    $('metricFilesFoot').textContent='本地索引 '+fmt(s.storage&&s.storage.indexBytes);
    $('reviewBadge').textContent=s.uncertain?'('+num(s.uncertain)+')':'';
    $('metricAlerts').className='metric-value '+(high?'status-bad':alerts.length?'status-warn':'');
    $('servicePill').className='live-pill'+(high?' warn':'');
    $('serviceText').textContent=high?'发现高风险提醒':s.scanning?'正在扫描索引':'数据总线运行正常';
    $('apiLatency').textContent=(Date.now()-started)+' ms';
    const watch=s.watching>0?'<span class="status-ok">已开启（'+num(s.watching)+' 个目录）</span>':'<span class="status-warn">未开启 / 等待首次扫描</span>';
    $('runtime').innerHTML='<div class="runtime-row"><span class="runtime-label">数据服务</span><span class="runtime-value status-ok">正常</span></div><div class="runtime-row"><span class="runtime-label">文件监听</span><span class="runtime-value">'+watch+'</span></div><div class="runtime-row"><span class="runtime-label">索引扫描</span><span class="runtime-value">'+(s.scanning?'<span class="status-warn">扫描中…</span>':'空闲')+'</span></div><div class="runtime-row"><span class="runtime-label">最近扫描</span><span class="runtime-value">'+esc(timeText(s.lastScan))+'</span></div><div class="runtime-row"><span class="runtime-label">索引存储</span><span class="runtime-value">'+fmt(s.storage&&s.storage.indexBytes)+'</span></div><div class="runtime-row"><span class="runtime-label">台账存储</span><span class="runtime-value">'+fmt(s.storage&&s.storage.accessBytes)+'</span></div>';
    const levels=s.byLevel||{}; const total=Number(s.total)||0;
    $('levelBar').innerHTML=Object.keys(LEVELS).map((l)=>'<span class="bg-'+l+'" style="width:'+(total?(Number(levels[l]||0)*100/total):0)+'%" title="'+LEVELS[l]+' '+num(levels[l])+'"></span>').join('');
    $('levelLegend').innerHTML=Object.keys(LEVELS).map((l)=>'<div class="legend-row"><span class="legend-name"><i class="level-dot bg-'+l+'"></i>'+LEVELS[l]+'</span><b>'+num(levels[l])+'</b></div>').join('');
    $('overviewAlerts').innerHTML=renderAlerts(alerts,5); $('overviewAccess').innerHTML=renderAccess(u.items,false);
    $('lastUpdated').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN',{hour12:false});
  }catch(e){ $('servicePill').className='live-pill warn'; $('serviceText').textContent='状态读取失败'; $('runtime').innerHTML='<div class="empty status-bad">'+esc(e.message)+'</div>'; }
}
async function loadSources(){ try{ const r=await api('sources'); if(r.error)throw new Error(r.error); const list=r.sources||[]; $('sources').innerHTML=list.length?'<div class="table-wrap"><table><thead><tr><th>路径</th><th>文件数</th><th>上次扫描</th><th></th></tr></thead><tbody>'+list.map((s)=>'<tr><td class="path">'+esc(s.path)+'</td><td>'+num(s.files)+'</td><td style="white-space:nowrap">'+esc(s.lastScan)+'</td><td><button class="btn ghost small danger" onclick="delSrc(this.dataset.p)" data-p="'+esc(s.path)+'">移除</button></td></tr>').join('')+'</tbody></table></div>':'<div class="empty">尚未添加监控目录</div>'; }catch(e){ $('sources').innerHTML='<div class="empty status-bad">'+esc(e.message)+'</div>'; } }
async function addSrc(){ const p=$('newsrc').value.trim(); if(!p)return notify('请输入文件夹完整路径',true); $('addSourceBtn').disabled=true; try{ const r=await api('sources/add',{path:p}); if(r.error)throw new Error(r.error); $('newsrc').value=''; notify('目录已添加，后台扫描已开始'); await Promise.all([loadSources(),refreshOverview()]); }catch(e){notify(e.message,true)}finally{$('addSourceBtn').disabled=false} }
async function delSrc(p){ if(!confirm('移除监控目录并删除该目录的索引？\\n不会删除原文件。\\n\\n'+p))return; try{ const r=await api('sources/remove',{path:p}); if(r.error)throw new Error(r.error); notify('监控目录已移除'); await Promise.all([loadSources(),refreshOverview()]); }catch(e){notify(e.message,true)} }
async function loadUncertain(){ try{ const r=await api('uncertain',{limit:30}); if(r.error)throw new Error(r.error); const items=r.items||[]; $('uncertain').innerHTML='<div class="result-summary">共 <b>'+num(r.total)+'</b> 个待复核，当前显示 '+items.length+' 个</div>'+(items.length?items.map((it)=>'<div class="file-row"><div class="file-main"><span class="file-name">'+esc(it.name)+'</span><span class="tag">'+esc(it.ext||'无扩展名')+'</span><div class="path">'+esc(it.dir)+' · '+num(it.kb)+' KB</div></div><div class="file-actions"><button class="btn small" onclick="setLv(this.dataset.p,\\'public\\')" data-p="'+esc(it.id)+'">公开</button><button class="btn small" onclick="setLv(this.dataset.p,\\'internal\\')" data-p="'+esc(it.id)+'">内部</button><button class="btn small" onclick="setLv(this.dataset.p,\\'sensitive\\')" data-p="'+esc(it.id)+'">敏感</button><button class="btn small danger" onclick="setLv(this.dataset.p,\\'restricted\\')" data-p="'+esc(it.id)+'">禁碰</button></div></div>').join(''):'<div class="empty ok">✓ 没有待复核文件</div>'); }catch(e){ $('uncertain').innerHTML='<div class="empty status-bad">'+esc(e.message)+'</div>'; } }
async function setLv(p,l){ try{ const r=await api('setlevel',{path:p,level:l}); if(r.error||!r.ok)throw new Error(r.error||'定级失败'); notify('已标记为「'+LEVELS[l]+'」'); await Promise.all([loadUncertain(),refreshOverview()]); }catch(e){notify(e.message,true)} }
async function loadPolicy(){ try{ const r=await api('policy'); if(r.error)throw new Error(r.error); const agents=Object.entries(r.agents||{}); $('policy').innerHTML=agents.length?'<div class="table-wrap"><table><thead><tr><th>Agent</th><th>允许级别</th></tr></thead><tbody>'+agents.map(([k,v])=>'<tr><td><b>'+esc(k==='*'?'默认（全部 Agent）':k)+'</b> <span class="path">'+esc(k)+'</span></td><td>'+v.map(lvTag).join(' ')+'</td></tr>').join('')+'</tbody></table></div>':'<div class="empty">暂无 Agent 策略</div>'; const dirs=r.dirs||[]; $('dirPolicy').innerHTML=dirs.length?'<div class="table-wrap"><table><thead><tr><th>目录</th><th>Agent</th><th>允许级别</th><th></th></tr></thead><tbody>'+dirs.map((d)=>'<tr><td class="path">'+esc(d.path)+'</td><td>'+esc(d.agent)+'</td><td>'+(d.levels||[]).map(lvTag).join(' ')+'</td><td><button class="btn ghost small danger" onclick="delDirPol(this.dataset.p,this.dataset.a)" data-p="'+esc(d.path)+'" data-a="'+esc(d.agent)+'">删除</button></td></tr>').join('')+'</tbody></table></div>':'<div class="empty">暂无目录覆盖策略</div>'; }catch(e){ $('policy').innerHTML='<div class="empty status-bad">'+esc(e.message)+'</div>'; } }
function selectedLevels(id){ return [...$(id).selectedOptions].map((o)=>o.value); }
async function setPol(){ const a=$('ag').value.trim(); const levels=selectedLevels('lvs'); if(!levels.length)return notify('至少选择一个允许级别',true); try{ const r=await api('policy/set',{agent:a,levels}); if(r.error)throw new Error(r.error); notify('Agent 默认策略已保存'); $('ag').value=''; await loadPolicy(); }catch(e){notify(e.message,true)} }
async function setDirPol(){ const p=$('dirPath').value.trim(); const a=$('dirAgent').value.trim(); const levels=selectedLevels('dirLevels'); if(!p)return notify('请输入目录完整路径',true); if(!levels.length)return notify('至少选择一个允许级别',true); try{ const r=await api('policy/setdir',{path:p,agent:a,levels}); if(r.error)throw new Error(r.error); notify('目录覆盖策略已保存'); $('dirPath').value=''; $('dirAgent').value=''; await loadPolicy(); }catch(e){notify(e.message,true)} }
async function delDirPol(p,a){ if(!confirm('删除此目录覆盖策略？\\n'+p+'\\nAgent：'+a))return; try{ const r=await api('policy/deldir',{path:p,agent:a}); if(r.error)throw new Error(r.error); notify('目录策略已删除'); await loadPolicy(); }catch(e){notify(e.message,true)} }
function mcpStatus(h){ const s=h.required?'required':h.status; return ({required:['必需接入','status-ok'],allowed:['已允许','status-ok'],pending:['待授权','status-warn'],denied:['不接入','status-bad']}[s]||[s||'未知','']); }
function mcpActions(h){ if(h.required)return '<span class="hint">不可关闭</span>'; const allow='<button class="btn small primary" onclick="setMcpStatus(this.dataset.a,\\'allowed\\')" data-a="'+esc(h.agent)+'">允许接入</button> '; const deny='<button class="btn small danger" onclick="setMcpStatus(this.dataset.a,\\'denied\\')" data-a="'+esc(h.agent)+'">不接入</button>'; return h.status==='pending'?allow+deny:h.status==='allowed'?deny:allow; }
const INDEPENDENT_AGENTS = new Set(['kimi-code','claude-code','codex','opencode','pi','qwen-code','cursor','copilot-cli']);
function renderMcpHostTable(hosts,emptyText){
  if(!hosts.length)return '<div class="empty">'+esc(emptyText)+'</div>';
  return '<div class="table-wrap"><table><thead><tr><th>Agent / 宿主</th><th>状态</th><th>来源与最近活动</th><th>调用</th><th>拒绝 / 错误</th><th>最近延迟</th><th>授权</th></tr></thead><tbody>'+hosts.map((h)=>{ const st=mcpStatus(h); const stats=h.stats||{}; const source=({builtin:'内置',handshake:'首次握手',discovery:'配置发现',custom:'助手登记'})[h.source]||h.source||'未知'; const setup=h.setupRequired?'<div class="path status-warn">需手工完成桥接配置</div>':''; return '<tr><td><b>'+esc(h.label||h.agent)+'</b><div class="path">'+esc(h.agent)+'</div>'+setup+'</td><td><span class="tag '+st[1]+'">'+st[0]+'</span></td><td>'+esc(source)+'<div class="path">'+esc(timeText(h.lastHandshake||h.lastSeen||h.lastDiscovered))+'</div></td><td>'+num(stats.calls)+'<div class="path">'+esc(stats.lastTool||'')+'</div></td><td>'+num(stats.denied)+' / '+num(stats.errors)+'</td><td>'+(stats.lastLatencyMs?num(stats.lastLatencyMs)+' ms':'—')+'</td><td style="white-space:nowrap">'+mcpActions(h)+'</td></tr>'; }).join('')+'</tbody></table></div>';
}
function applyMcpSetup(setup){
  $('mcpSetupJson').value=setup.configText||'';
  $('mcpBridgePath').textContent=setup.bridgePath||'';
  $('mcpSetupState').textContent='已按 '+esc(setup.agent||'mcp-host')+' 生成本机配置';
}
async function generateMcpSetup(){
  const agent=$('mcpAgent').value.trim().toLowerCase()||'mcp-host'; $('mcpSetupBtn').disabled=true;
  try{ const setup=await api('mcp/setup',{agent}); if(setup.error)throw new Error(setup.error); applyMcpSetup(setup); }
  catch(e){ $('mcpSetupState').textContent=e.message; notify(e.message,true); }
  finally{ $('mcpSetupBtn').disabled=false; }
}
async function copyMcpConfig(){
  const text=$('mcpSetupJson').value; if(!text)return notify('请先生成配置',true);
  try{
    if(navigator.clipboard&&navigator.clipboard.writeText)await navigator.clipboard.writeText(text);
    else{ $('mcpSetupJson').select(); if(!document.execCommand||!document.execCommand('copy'))throw new Error('浏览器未允许复制，请在配置框中手工复制'); }
    notify('MCP 配置已复制');
  }catch(e){ notify(e.message||'复制失败，请手工复制',true); }
}
async function registerCustomMcpHost(){
  const agent=$('mcpAgent').value.trim().toLowerCase(); const path=$('mcpConfigPath').value.trim();
  if(!agent)return notify('请输入宿主标识',true); if(!path)return notify('请输入 JSON 配置文件绝对路径；留空场景请直接复制上方配置',true);
  $('mcpRegisterBtn').disabled=true;
  try{
    const r=await api('mcp/register',{agent,path,label:agent}); if(r.error)throw new Error(r.error);
    if(r.setup)applyMcpSetup(r.setup); notify('已登记为待授权，请在下方列表点击“允许接入”后写入配置'); await loadMcp();
  }catch(e){ notify(e.message,true); }
  finally{ $('mcpRegisterBtn').disabled=false; }
}
async function checkMcpConnection(){
  const agent=$('mcpAgent').value.trim().toLowerCase(); if(!agent)return notify('请输入要检查的宿主标识',true);
  $('mcpCheckBtn').disabled=true;
  try{
    const r=await api('mcp/hosts'); if(r.error)throw new Error(r.error); const h=(r.hosts||[]).find((item)=>item.agent===agent); let msg='';
    if(!h)msg='尚未登记 '+agent+'，请生成配置或登记 JSON 文件';
    else if(h.status==='pending')msg='已登记，待授权；授权前桥内访问会被阻断';
    else if(h.status==='denied')msg='当前设为不接入；桥内检索和读取会被阻断';
    else if(h.lastHandshake)msg='已收到标准桥握手：'+timeText(h.lastHandshake);
    else if(h.integrated)msg='桥接配置已写入，尚未收到握手；请重启宿主后再检查';
    else msg='已授权，等待桥接配置与首次握手';
    $('mcpSetupState').textContent=msg; notify(msg);
  }catch(e){ notify(e.message,true); }
  finally{ $('mcpCheckBtn').disabled=false; }
}
async function loadMcp(){
  try{
    const r=await api('mcp/hosts'); if(r.error)throw new Error(r.error);
    const hosts=r.hosts||[]; const s=r.summary||{};
    $('mcpRequired').textContent=num(s.required); $('mcpPending').textContent=num(s.pending); $('mcpDenied').textContent=num(s.denied); $('mcpBypassCount').textContent=num(s.bypass); $('mcpBadge').textContent=s.pending?'('+num(s.pending)+')':'';
    const independent=hosts.filter((h)=>INDEPENDENT_AGENTS.has(h.agent));
    const mcpOnly=hosts.filter((h)=>!INDEPENDENT_AGENTS.has(h.agent));
    $('agentHosts').innerHTML=renderMcpHostTable(independent,'尚未发现 8 家独立 Agent 的 MCP 配置或握手');
    $('mcpHosts').innerHTML=renderMcpHostTable(mcpOnly,'尚未发现其他 MCP 宿主');
    const bypass=hosts.filter((h)=>(h.bypass||[]).length);
    $('mcpBypass').innerHTML=bypass.length?bypass.map((h)=>'<div class="file-row"><div class="file-main"><span class="file-name">'+esc(h.label||h.agent)+'</span>'+h.bypass.map((name)=>'<span class="tag">'+esc(name)+'</span>').join(' ')+'<div class="path">'+esc(h.configPath||'')+'</div></div><span class="hint">未经过智枢桥</span></div>').join(''):'<div class="empty ok">未在已知配置路径发现其他 MCP Server</div>';
    if(!$('mcpSetupJson').value)await generateMcpSetup();
  }catch(e){ $('agentHosts').innerHTML='<div class="empty status-bad">'+esc(e.message)+'</div>'; $('mcpHosts').innerHTML='<div class="empty status-bad">'+esc(e.message)+'</div>'; $('mcpBypass').innerHTML=''; }
}
async function setMcpStatus(agent,status){ if(status==='denied'&&!confirm('确认不让「'+agent+'」接入数据总线？\\n其桥内检索和读取会立即被阻断。'))return; try{ const r=await api('mcp/consent',{agent,status}); if(r.error)throw new Error(r.error); notify(status==='allowed'?(r.injected?'已允许接入，并写入桥接配置':r.setupRequired?'已允许；该宿主需手工完成桥接配置':'已允许接入'):'已设为不接入'); await loadMcp(); }catch(e){notify(e.message,true)} }
async function discoverMcp(){ $('mcpDiscoverBtn').disabled=true; $('mcpDiscoverBtn').textContent='检测中…'; try{ const r=await api('mcp/discover'); if(r.error)throw new Error(r.error); notify('检测完成：发现 '+num(r.found)+' 个已知宿主配置'); await loadMcp(); }catch(e){notify(e.message,true)}finally{$('mcpDiscoverBtn').disabled=false; $('mcpDiscoverBtn').textContent='重新检测'} }
async function loadAudit(){ try{ const [a,u]=await Promise.all([api('alerts'),api('access',{limit:50})]); $('alerts').innerHTML=renderAlerts(a.alerts,50); $('access').innerHTML=renderAccess(u.items,true); }catch(e){ $('alerts').innerHTML='<div class="empty status-bad">'+esc(e.message)+'</div>'; $('access').innerHTML=''; } }
async function doSearch(){ const content=$('content').checked; $('searchBtn').disabled=true; $('searchSummary').textContent='正在检索…'; $('preview').style.display='none'; try{ const r=await api('search',{q:$('q').value,days:Number($('days').value)||0,limit:content?5:30,content}); if(r.error)throw new Error(r.error); const list=r.results||[]; $('searchSummary').textContent='找到 '+list.length+' 条结果'+(content?'（正文检索最多返回 5 个文件）':''); $('results').innerHTML=list.length?list.map((f)=>'<div class="file-row"><div class="file-main"><span class="file-name">'+esc(f.name)+'</span>'+lvTag(f.level)+' <span class="tag">'+fmt(f.size)+'</span><div class="path">'+esc(f.path)+'</div>'+(f.hits?f.hits.map((h)=>'<pre class="hit">L'+num(h.line)+': '+esc(h.context)+'</pre>').join(''):'')+'</div><div class="file-actions"><button class="btn small" onclick="preview(this.dataset.p)" data-p="'+esc(f.path)+'">查看</button><button class="btn small" onclick="ferry(this.dataset.p)" data-p="'+esc(f.path)+'">传到对端</button></div></div>').join(''):'<div class="empty">没有命中结果，可调整关键词或检查访问策略</div>'; }catch(e){ $('searchSummary').textContent='检索失败'; $('results').innerHTML='<div class="empty status-bad">'+esc(e.message)+'</div>'; }finally{$('searchBtn').disabled=false} }
async function preview(p){ try{ const r=await api('read',{path:p}); if(r.error)throw new Error(r.error); $('preview').style.display='block'; $('preview').innerHTML='<div class="card-head"><div><h3 class="card-title">文件预览</h3><div class="path">'+esc(p)+'</div></div><button class="btn ghost small" onclick="this.parentNode.parentNode.style.display=\\'none\\'">关闭</button></div><pre>'+esc(r.content)+'</pre>'; }catch(e){ $('preview').style.display='block'; $('preview').innerHTML='<div class="empty status-bad">'+esc(e.message)+'</div>'; } }
async function doScan(){ $('scanBtn').disabled=true; $('scanBtn').textContent='扫描中…'; try{ const r=await api('scan'); if(r.error)throw new Error(r.error); notify(r.result&&r.result.skipped?'已有扫描任务正在进行':'扫描完成：'+num(r.result&&r.result.total)+' 个文件（新增/更新 '+num(r.result&&r.result.changed)+'）'); await refresh(); }catch(e){notify(e.message,true)}finally{$('scanBtn').disabled=false; $('scanBtn').textContent='重新扫描'} }
async function ferry(p){
  try{
    const selfKey=(location.pathname.match(new RegExp('^/r/([^/]+)/'))||[])[1];
    if(!selfKey)return notify('无法识别当前电脑（URL 无 /r/<key>/）',true);
    let pcs=[]; try{pcs=JSON.parse(localStorage.getItem('hh-os-pcs')||'[]')}catch(e){}
    const others=pcs.filter((x)=>x.key!==selfKey);
    if(!others.length)return notify('WebOS 里只有一台电脑。请先在 /os 添加另一台电脑。',true);
    const pick=others.length===1?0:Number(prompt('传到哪台电脑？输入序号：\\n'+others.map((x,i)=>i+'. '+x.name).join('\\n'),'0'));
    if(isNaN(pick)||pick<0||pick>=others.length)return;
    const target=others[pick].key;
    if(!confirm('把该文件传到「'+(others[pick].name||'电脑')+'」收件箱？\\n'+p))return;
    const g=await fetch('/r/'+selfKey+'/__ph/file/get',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:p})}).then((r)=>r.json());
    if(!g||g.error||!g.b64)throw new Error('读取失败：'+((g&&g.error)||'未知'));
    const pu=await fetch('/r/'+target+'/__ph/file/put',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:g.name||p.split('/').pop().split(String.fromCharCode(92)).pop(),b64:g.b64})}).then((r)=>r.json());
    if(pu.ok!==false&&!pu.error)notify('已传到「'+(others[pick].name||'电脑')+'」收件箱：'+(pu.savedTo||''));
    else throw new Error(pu.error||'推送失败');
  }catch(e){notify(e.message,true)}
}
async function refresh(){ $('refreshBtn').disabled=true; try{await Promise.all([refreshOverview(),loadSources(),loadUncertain(),loadPolicy(),loadMcp()]); if(currentTab==='audit')await loadAudit();}finally{$('refreshBtn').disabled=false} }
refresh();
setInterval(()=>{ if($('autoRefresh').checked&&currentTab==='overview'&&!document.hidden)refreshOverview(); },30000);
</script></body></html>`
}
