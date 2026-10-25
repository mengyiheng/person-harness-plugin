// 数据总线 · 浏览器资源管理器页面（本机弹出，与二维码页同款通道）
// 用户在本机 GUI 已登录，Cookie 能过 /api/happy-databus 鉴权
export function databusHtml () {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>Happy Harness · 资源管理器（数据总线）</title>
<style>
body{font-family:system-ui,'Microsoft YaHei';background:#f5f6f8;color:#222;margin:0;padding:24px;max-width:1100px;margin:0 auto}
h1{font-size:20px}h1 small{color:#888;font-weight:400;font-size:13px}
.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:16px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
.stats span{display:inline-block;background:#eef1f5;border-radius:8px;padding:4px 12px;margin-right:8px;font-size:13px}
.lv-public{color:#2e7d32}.lv-internal{color:#1565c0}.lv-sensitive{color:#e65100}.lv-restricted{color:#b71c1f}
input,select,button{font-size:14px;padding:8px 10px;border:1px solid #ccc;border-radius:8px}
button{background:#1a73e8;color:#fff;border:0;cursor:pointer}button.gray{background:#666}button.small{padding:4px 10px;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:6px 8px;border-bottom:1px solid #eee;text-align:left}
.path{color:#888;font-size:12px;word-break:break-all}
#preview pre{background:#f8f9fa;padding:12px;border-radius:8px;max-height:400px;overflow:auto;white-space:pre-wrap;font-size:12px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
.msg{color:#b71c1f;font-size:13px}.ok{color:#2e7d32;font-size:13px}
.tag{font-size:11px;border-radius:6px;padding:2px 8px;background:#eee}
</style></head><body>
<h1>🗂️ 资源管理器 <small>数据总线 · 索引只存在本机，检索结果只交给策略允许的 agent</small></h1>
<div class="card stats" id="stats">加载中…</div>
<div class="card">
  <b>检索</b> <span class="path">语法：ext:png,pdf days:7 size:&gt;10mb path:文档｜勾选"内容"搜文件正文</span>
  <div class="row">
    <input id="q" placeholder="文件名关键词，或 ext:md 报销" style="flex:1" onkeydown="if(event.key==='Enter')doSearch()">
    <input id="days" type="number" value="0" min="0" style="width:80px" title="最近 N 天，0=不限">天
    <label style="font-size:13px"><input type="checkbox" id="content"> 内容</label>
    <button onclick="doSearch()">搜索</button>
  </div>
  <div id="results"></div>
  <div id="preview"></div>
</div>
<div class="card"><b>监控目录</b><div id="sources">加载中…</div>
  <div class="row"><input id="newsrc" placeholder="添加文件夹完整路径（将索引其中全部内容）" style="flex:1"><button onclick="addSrc()">添加</button></div>
</div>
<div class="card"><b>待复核（规则未命中，由 agent/你批量定级）</b><div id="uncertain">加载中…</div></div>
<div class="card"><b>⚠️ 危险行为提醒</b><div id="alerts">加载中…</div>
  <div class="row" style="margin-top:12px"><b>访问台账</b> <span class="path">谁在何时碰了哪个文件（仅存本机）</span></div>
  <div id="access">加载中…</div>
</div>
<div class="card"><b>agent 访问策略</b> <span class="tag">级别：公开 &lt; 内部 &lt; 敏感 &lt; 禁碰</span><div id="policy">加载中…</div>
  <div class="row"><input id="ag" placeholder="agent 名（留空=默认）" style="width:180px">
  <select id="lvs" multiple size="4"><option value="public">公开</option><option value="internal">内部</option><option value="sensitive">敏感</option><option value="restricted">禁碰</option></select>
  <button onclick="setPol()">保存策略</button></div>
</div>
<script>
const api = (action, data={}) => fetch('/api/happy-databus/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...data})}).then(r=>r.json());
const lvTag = l => '<span class="tag lv-'+l+'">'+({public:'公开',internal:'内部',sensitive:'敏感',restricted:'禁碰'})[l]+'</span>';
const fmt = (s) => s>1048576 ? (s/1048576).toFixed(1)+'MB' : Math.max(1,Math.round(s/1024))+'KB';
async function refresh(){ loadStats(); loadSources(); loadUncertain(); loadPolicy(); loadAlerts(); loadAccess(); }
async function loadAlerts(){ const r=await api('alerts'); document.getElementById('alerts').innerHTML=(r.alerts||[]).length
  ? r.alerts.slice(0,10).map(a=>'<div class="row" style="margin:2px 0">'+(a.level==='high'?'<span class="msg">🔴</span>':'🟡')+' '+a.msg+'</div>').join('')
  : '<span class="ok">✅ 暂无危险行为</span>'; }
async function loadAccess(){ const r=await api('access',{limit:20}); document.getElementById('access').innerHTML='<table><tr><th>时间</th><th>Agent</th><th>行为</th><th>对象</th></tr>'+
  (r.items||[]).map(a=>'<tr><td>'+a.time+'</td><td>'+a.agent+'</td><td>'+(a.ev==='read'?'读取':a.ev==='hit'?'检索命中':a.ev==='setlevel'?'定级':a.ev==='upload'?'<b>上传</b>':a.ev==='external-modify'?'<span class="msg">外部修改</span>':'检索')+(a.ok?'':' <span class="msg">被拒</span>')+'</td><td class="path">'+a.path.slice(0,90)+'</td></tr>').join('')+'</table>'; }
async function loadStats(){ const r = await api('stats'); if(!r.stats){document.getElementById('stats').textContent='加载失败';return}
  const s=r.stats; document.getElementById('stats').innerHTML =
  '数据源 '+s.sources+' 个｜索引 '+s.total+' 个文件｜' + Object.entries(s.byLevel).map(([k,v])=>'<span class="lv-'+k+'">'+({public:'公开',internal:'内部',sensitive:'敏感',restricted:'禁碰'})[k]+' '+v+'</span>').join('') +
  ' <button class="small" style="float:right" onclick="doScan()">'+(s.scanning?'扫描中…':'重新扫描')+'</button>'; }
async function doScan(){ const r=await api('scan'); const e=document.createElement('div'); e.className='ok'; e.textContent='扫描完成：'+(r.result?r.result.total+' 个文件（新增/更新 '+r.result.changed+'）':'已在扫描中'); document.getElementById('stats').appendChild(e); refresh(); }
async function loadSources(){ const r=await api('sources'); document.getElementById('sources').innerHTML='<table><tr><th>路径</th><th>文件数</th><th>上次扫描</th><th></th></tr>'+
  (r.sources||[]).map(s=>'<tr><td class="path">'+s.path+'</td><td>'+s.files+'</td><td>'+s.lastScan+'</td><td><button class="small gray" onclick="delSrc(this.dataset.p)" data-p="'+s.path+'">移除</button></td></tr>').join('')+'</table>'; }
async function addSrc(){ const p=document.getElementById('newsrc').value.trim(); if(!p)return; const r=await api('sources/add',{path:p}); r.error?alert(r.error):loadSources(); }
async function delSrc(p){ if(!confirm('移除监控目录并删除该目录的索引？\\n'+p))return; await api('sources/remove',{path:p}); refresh(); }
async function loadUncertain(){ const r=await api('uncertain',{limit:20}); const u=document.getElementById('uncertain');
  u.innerHTML='共 <b>'+r.total+'</b> 个待复核'+(r.items||[]).map(it=>'<div class="row"><span class="tag">'+it.ext+'</span> '+it.name+' <span class="path">'+it.dir+' · '+it.kb+'KB</span> <button class="small" onclick="setLv(this.dataset.p,\'public\')" data-p="'+it.id+'">公开</button> <button class="small" onclick="setLv(this.dataset.p,\'internal\')" data-p="'+it.id+'">内部</button> <button class="small gray" onclick="setLv(this.dataset.p,\'sensitive\')" data-p="'+it.id+'">敏感</button> <button class="small gray" onclick="setLv(this.dataset.p,\'restricted\')" data-p="'+it.id+'">禁碰</button></div>').join(''); }
async function setLv(p,l){ await api('setlevel',{path:p,level:l}); loadUncertain(); loadStats(); }
async function loadPolicy(){ const r=await api('policy'); document.getElementById('policy').innerHTML='<table><tr><th>Agent</th><th>允许级别</th></tr>'+
  Object.entries(r.agents||{}).map(([k,v])=>'<tr><td>'+k+'</td><td>'+v.map(lvTag).join(' ')+'</td></tr>').join('')+'</table>'; }
async function setPol(){ const a=document.getElementById('ag').value.trim(); const l=[...document.getElementById('lvs').selectedOptions].map(o=>o.value); if(!l.length){alert('至少选一个级别');return} const r=await api('policy/set',{agent:a,levels:l}); r.error?alert(r.error):loadPolicy(); }
async function doSearch(){ const content=document.getElementById('content').checked;
  const r=await api('search',{q:document.getElementById('q').value,days:Number(document.getElementById('days').value)||0,limit:content?5:20,content});
  document.getElementById('preview').innerHTML='';
  document.getElementById('results').innerHTML=(r.results||[]).map(f=>'<div class="row" style="border-bottom:1px solid #eee;padding:6px 0"><b>'+f.name+'</b> '+lvTag(f.level)+' <span class="tag">'+fmt(f.size)+'</span> <span class="path">'+f.path+'</span> <button class="small" onclick="preview(this.dataset.p)" data-p="'+f.path+'">查看</button> <button class="small gray" onclick="ferry(this.dataset.p)" data-p="'+f.path+'">⇢ 传到对端</button></div>'+
    (f.hits?f.hits.map(h=>'<pre style="margin:0 0 8px 24px;background:#f8f9fa;padding:6px 10px;border-radius:6px;font-size:12px">L'+h.line+': '+h.context.replaceAll('&','&amp;').replaceAll('<','&lt;')+'</pre>').join(''):'')).join('')||'<span class="path">无命中</span>'; }
async function ferry(p){
  // M-D2 浏览器枢纽模型：从本机(/r/<key>)拉文件 → 推到用户选的另一台已授权电脑。无需 happy link。
  try{
    const selfKey=(location.pathname.match(/^\/r\/([^/]+)\//)||[])[1];
    if(!selfKey) return alert('无法识别当前电脑（URL 无 /r/<key>/）');
    let pcs=[]; try{ pcs=JSON.parse(localStorage.getItem('hh-os-pcs')||'[]') }catch(e){}
    const others=pcs.filter(x=>x.key!==selfKey);
    if(!others.length) return alert('WebOS 里只有一台电脑。先在 /os 「＋添加电脑」加另一台，再回来传。');
    const pick=others.length===1?0:Number(prompt('传到哪台电脑？输入序号：\n'+others.map((x,i)=>i+'. '+x.name).join('\n'),'0'));
    if(isNaN(pick)||pick<0||pick>=others.length) return;
    const target=others[pick].key;
    if(!confirm('把该文件传到「'+(others[pick].name||'电脑')+'」收件箱？\n'+p))return;
    const g=await fetch('/r/'+selfKey+'/__happy/file/get',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:p})}).then(r=>r.json());
    if(!g||g.error||!g.b64) return alert('读取失败: '+((g&&g.error)||'未知'));
    if((g.size||0)>50*1048576) return alert('超过 50MB 单次上限（当前 '+(g.size/1048576).toFixed(1)+'MB）');
    const pu=await fetch('/r/'+target+'/__happy/file/put',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:g.name||p.split(/[\\/]/).pop(),b64:g.b64})}).then(r=>r.json());
    if(pu.ok!==false&&!pu.error) alert('✅ 已传到「'+(others[pick].name||'电脑')+'」收件箱：'+(pu.savedTo||'')+'（'+Math.round((pu.size||g.size||0)/1024)+'KB）');
    else alert('❌ '+(pu.error||'推送失败'));
  }catch(e){ alert('❌ '+e.message) }
}
async function preview(p){ const r=await api('read',{path:p}); document.getElementById('preview').innerHTML = r.error ? '<span class="msg">'+r.error+'</span>' : '<pre>'+r.content.replaceAll('&','&amp;').replaceAll('<','&lt;')+'</pre>'; }
refresh();
</script></body></html>`
}
