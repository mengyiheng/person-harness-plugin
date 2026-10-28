// 公共设备页与配对路由：dsh 插件、独立 agent-relay、ph-cli 共用。
// 仅经已配对的 E2E 内部通道暴露；不经过 dsh，也不复制身份/配对实现。
import QRCode from 'qrcode'

export function devicesHtml () {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f5f6f8">
<title>设备与配对 · Person Harness</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#191c20;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","HarmonyOS Sans",sans-serif}.wrap{max-width:760px;margin:auto;padding:20px 16px 40px}.top{display:flex;align-items:center;gap:12px;margin-bottom:20px}button{font:inherit;cursor:pointer}.back{border:0;background:transparent;font-size:22px;padding:4px 8px}.top h1{font-size:20px;margin:0}.card{background:#fff;border:1px solid #e3e6ea;border-radius:15px;padding:16px;margin:12px 0}.row{display:flex;align-items:center;gap:10px}.grow{flex:1;min-width:0}.sub{color:#737b87;font-size:13px;overflow-wrap:anywhere}.dot{width:9px;height:9px;border-radius:50%;background:#b43c36;flex:none}.dot.on{background:#2b9b68}.primary{border:0;border-radius:10px;background:#237a57;color:#fff;padding:9px 14px}.danger{border:1px solid #e4c5c2;background:#fff;color:#a43832;border-radius:8px;padding:6px 10px}.device{padding:13px 0;border-top:1px solid #edf0f2}.device:first-child{border-top:0}.pair{text-align:center}.pair img{display:block;max-width:min(320px,85vw);width:100%;height:auto;margin:14px auto;border-radius:10px}.code{font:700 26px/1.3 ui-monospace,monospace;letter-spacing:4px}.empty{color:#737b87;text-align:center;padding:14px}.toast{display:none;position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:90vw;background:#192027;color:#fff;padding:9px 15px;border-radius:9px;z-index:5}
</style></head><body><div class="wrap"><header class="top"><button class="back" id="back" aria-label="返回">‹</button><h1>设备与配对</h1></header>
<section class="card"><div class="row"><span class="dot" id="dot"></span><div class="grow"><strong id="name">当前电脑</strong><div class="sub" id="status">读取连接状态…</div></div><button class="primary" id="pair">配对新手机</button></div></section>
<section class="card pair" id="pair-card" hidden><strong>用手机 App 扫码添加此电脑</strong><img id="qr" alt="一次性配对二维码"><div class="code" id="code"></div><div class="sub" id="expires"></div></section>
<section class="card"><strong>已配对设备</strong><div id="devices"><div class="empty">读取中…</div></div></section>
<section class="card"><strong>MCP 与本地文件</strong><div class="sub">它们由 Person Harness 插件统一提供。各 Agent 通过同一 MCP 总线检索和读取文件，并遵守相同的数据分级与访问台账。</div></section>
</div><div class="toast" id="toast"></div><script>
const $=id=>document.getElementById(id);$('back').onclick=()=>history.length>1?history.back():location.href='/t/';
function toast(text){$('toast').textContent=text;$('toast').style.display='block';clearTimeout(toast.t);toast.t=setTimeout(()=>$('toast').style.display='none',3500)}
async function api(path,body={}){const r=await fetch('/__ph/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok||v.error)throw new Error(v.error||('请求失败 '+r.status));return v}
async function loadStatus(){try{const s=await api('status');$('name').textContent=s.deviceName||s.agent||'当前电脑';$('status').textContent=(s.connected?'中继已连接':'中继未连接')+(s.deviceId?' · '+s.deviceId:'');$('dot').className='dot'+(s.connected?' on':'')}catch(e){$('status').textContent=e.message}}
async function loadDevices(){try{const r=await api('devices/list');const items=r.items||[];const box=$('devices');box.replaceChildren();if(!items.length){const e=document.createElement('div');e.className='empty';e.textContent='暂无已配对设备';box.append(e);return}for(const item of items){const row=document.createElement('div');row.className='device row';const text=document.createElement('div');text.className='grow';const name=document.createElement('div');name.textContent=item.phone?.name||item.phone?.deviceId||'手机';const meta=document.createElement('div');meta.className='sub';meta.textContent=(item.createdAt?new Date(item.createdAt).toLocaleString()+' · ':'')+item.pairId;text.append(name,meta);const del=document.createElement('button');del.className='danger';del.textContent='解除';del.onclick=async()=>{if(!confirm('解除这台手机的配对？它将立即失去访问权。'))return;try{await api('devices/revoke',{pairId:item.pairId});toast('已解除配对');await loadDevices()}catch(e){toast(e.message)}};row.append(text,del);box.append(row)}}catch(e){$('devices').textContent=e.message}}
$('pair').onclick=async()=>{try{$('pair').disabled=true;const r=await api('devices/pair');$('qr').src=r.qr;$('code').textContent=r.code;$('expires').textContent='配对码 '+r.expiresInSec+' 秒内有效，一次性使用';$('pair-card').hidden=false;$('pair-card').scrollIntoView({behavior:'smooth',block:'center'})}catch(e){toast(e.message)}finally{$('pair').disabled=false}};
loadStatus();loadDevices();
</script></body></html>`
}

export function createDeviceRoutes ({ identity, getTunnel, server, agent = 'Agent', deviceName = '' }) {
  const serverHost = String(server || '').replace(/^https?:\/\//, '')
  return async function handleDeviceRoute (path, method = 'GET', body = Buffer.alloc(0)) {
    const known = path === '/__ph/status' || path === '/__ph/devices' || path === '/__ph/devices/list' || path === '/__ph/devices/pair' || path === '/__ph/devices/revoke'
    if (!known) return null
    try {
      if (path === '/__ph/status' && (method === 'GET' || method === 'POST')) {
        return { status: 200, body: { agent, deviceName: deviceName || agent, deviceId: identity.deviceId, connected: !!getTunnel()?.connected, server } }
      }
      if (path === '/__ph/devices' && method === 'GET') {
        return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: devicesHtml() }
      }
      if (path === '/__ph/devices/list' && (method === 'GET' || method === 'POST')) {
        return { status: 200, body: { items: await identity.listPairs() } }
      }
      if (path === '/__ph/devices/pair' && method === 'POST') {
        const pc = await identity.requestPairCode()
        const deepLink = `myapp://pair?ver=2&server=${encodeURIComponent(serverHost)}&device=${encodeURIComponent(identity.deviceId)}&code=${encodeURIComponent(pc.code)}`
        const png = await QRCode.toBuffer(deepLink, { margin: 1, width: 320 })
        return { status: 200, body: { code: pc.code, qr: 'data:image/png;base64,' + png.toString('base64'), expiresInSec: pc.expiresInSec ?? 300, deviceId: identity.deviceId } }
      }
      if (path === '/__ph/devices/revoke' && method === 'POST') {
        let payload = {}
        try { payload = JSON.parse(body.toString('utf8') || '{}') } catch { }
        const pairId = String(payload.pairId || '')
        if (!pairId) return { status: 400, body: { error: '缺 pairId' } }
        await identity.removePair(pairId)
        return { status: 200, body: { ok: true } }
      }
      return { status: 405, body: { error: 'method not allowed' } }
    } catch (e) {
      return { status: 502, body: { error: e?.message || String(e) } }
    }
  }
}
