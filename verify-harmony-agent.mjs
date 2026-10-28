#!/usr/bin/env node
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const root = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

function usage () {
  console.log(`用法：node verify-harmony-agent.mjs [选项]

选项：
  --target <设备号>   多台设备时指定 HDC 设备号
  --hdc <路径>        hdc 可执行文件路径
  --url <地址>        独立 Agent 地址，默认 http://127.0.0.1:7712
  --task <任务名>     独立 Agent 计划任务，默认 PersonHarnessKimiCode
  --timeout <秒>      每阶段等待上限，默认 120
  --out <目录>        证据目录，默认 diagnostics/harmony-agent-<时间>
  --skip-approval     只验新建会话和连续对话，跳过服务重启与审批恢复
  --relay-only        跳过 UDP 直连与故障回落断言，仅回归中继链路
  --help              显示帮助

前置条件：App 已配对，当前 Agent 为独立 Kimi。不会清除应用数据或修改配对。
默认验收真实 UDP 直连、对话、审批恢复和只断 UDP 后的中继回落；中继回复不冒充直连。`)
}

function option (name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} 缺少参数`)
  return args[index + 1]
}

if (args.includes('--help') || args.includes('-h')) {
  usage()
  process.exit(0)
}

const harmonySdk = process.env.OHOS_SDK_HOME || process.env.DEVECO_SDK_HOME
const defaultHdc = harmonySdk
  ? path.join(harmonySdk, 'default', 'openharmony', 'toolchains', process.platform === 'win32' ? 'hdc.exe' : 'hdc')
  : (process.platform === 'win32' ? 'hdc.exe' : 'hdc')
const hdcPath = option('--hdc', process.env.HARMONY_HDC || defaultHdc)
const bundle = 'com.happyharness.tunnel'
const baseUrl = option('--url', 'http://127.0.0.1:7712').replace(/\/$/, '')
const taskName = option('--task', 'PersonHarnessKimiCode')
const skipApproval = args.includes('--skip-approval')
const relayOnly = args.includes('--relay-only')
const totalSteps = (skipApproval ? 7 : 11) + (relayOnly ? 0 : 3)
const timeoutSeconds = Number(option('--timeout', '120'))
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 20) throw new Error('--timeout 须为不小于 20 的数字')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.resolve(root, option('--out', path.join('diagnostics', `harmony-agent-${stamp}`)))
fs.mkdirSync(outDir, { recursive: true })
const token = randomBytes(3).toString('hex').toUpperCase()
const firstMarker = `HARMONY_RELAY_FIRST_${token}`
const secondMarker = `HARMONY_RELAY_SECOND_${token}`
const fallbackMarker = `HARMONY_UDP_FALLBACK_${token}`
const approvalMarker = `HARMONY_APPROVAL_RECOVERY_${token}`
const approvalContent = `HARMONY_RESTART_RECOVERY_${token}`
const approvalFile = path.join(root, 'diagnostics', `harmony-restart-recovery-${token}.txt`)
let target = option('--target', process.env.HARMONY_TARGET || '')
let serviceRecoveryRequired = false
let captureSeq = 0

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function execute (file, argv, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, argv, {
      timeout,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${file} ${argv.join(' ')} 执行失败：${error.message}\n${String(stderr || '').trim()}`))
      } else resolve({ stdout, stderr })
    })
  })
}

async function rawHdc (argv, options) {
  return execute(hdcPath, argv, options)
}

async function hdc (argv, options) {
  return rawHdc([...(target ? ['-t', target] : []), ...argv], options)
}

async function waitFor (check, description, timeout = timeoutSeconds * 1000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) { lastError = error }
    await sleep(800)
  }
  throw new Error(`等待超时：${description}${lastError ? `；最后错误：${lastError.message}` : ''}`)
}

function uiNodes (layout) {
  const result = []
  const walk = (node) => {
    const attributes = node?.attributes || {}
    const bounds = /\[(\d+),(\d+)]\[(\d+),(\d+)]/.exec(attributes.bounds || '')
    const item = { ...attributes, visible: false }
    if (bounds) {
      const [, left, top, right, bottom] = bounds.map(Number)
      item.x = Math.round((left + right) / 2)
      item.y = Math.round((top + bottom) / 2)
      item.visible = right > left && bottom > top
    }
    result.push(item)
    for (const child of node?.children || []) walk(child)
  }
  walk(layout)
  return result
}

async function readUi () {
  const serial = ++captureSeq
  const remote = `/data/local/tmp/ph-harmony-layout-${process.pid}-${serial}.json`
  const local = path.join(outDir, `.layout-${serial}.json`)
  await hdc(['shell', 'uitest', 'dumpLayout', '-p', remote], { timeout: 20000 })
  await hdc(['file', 'recv', remote, local], { timeout: 20000 })
  const layout = JSON.parse(fs.readFileSync(local, 'utf8'))
  fs.unlinkSync(local)
  return layout
}

function visibleNode (layout, predicate) {
  return uiNodes(layout).find(node => node.visible && predicate(node))
}

function isInput (node) {
  return node.type === 'textField' && String(node.hint || '').includes('输入消息')
}

async function tap (node) {
  if (!node?.visible) throw new Error('目标控件不可见，已拒绝按固定坐标点击')
  await hdc(['shell', 'uitest', 'uiInput', 'click', String(node.x), String(node.y)])
  await sleep(500)
}

async function healthCheck () {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch(`${baseUrl}/api/workspace/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcId: 'harmony-health', payload: { args: { request: {} } } }),
      signal: controller.signal
    })
    if (response.status !== 200) throw new Error(`独立 Agent 健康检查返回 ${response.status}`)
    const message = await response.json()
    if (!message.result?.ok || !Array.isArray(message.result?.value?.items)) throw new Error('独立 Agent 健康检查未返回有效工作区')
    return response.status
  } finally { clearTimeout(timer) }
}

async function capture (name) {
  const layout = await readUi()
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(layout, null, 2))
  const remote = `/data/local/tmp/ph-harmony-${process.pid}-${name}.png`
  await hdc(['shell', 'uitest', 'screenCap', '-p', remote], { timeout: 20000 })
  await hdc(['file', 'recv', remote, path.join(outDir, `${name}.png`)], { timeout: 20000 })
  return layout
}

async function waitForShell (timeout = 30000) {
  return waitFor(async () => visibleNode(await readUi(), isInput), '独立 Kimi 轻壳消息输入框', timeout)
}

async function phoneLog () {
  return (await hdc(['shell', 'hilog', '-x'], { timeout: 20000 })).stdout
}

async function coldStart () {
  await hdc(['shell', 'hilog', '-r'])
  await hdc(['shell', 'aa', 'force-stop', bundle])
  await sleep(800)
  await hdc(['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', bundle])
  await waitForShell(35000)
}

async function waitForUdpDirect () {
  const log = await waitFor(async () => {
    const text = await phoneLog()
    return text.includes('UDP 业务直连建立') && text.includes('UDP 直连状态=1') ? text : false
  }, '手机真实 UDP 业务直连与直连灯', 45000)
  fs.writeFileSync(path.join(outDir, 'udp-direct.log'), log)
}

async function createSession () {
  let layout = await readUi()
  if (!visibleNode(layout, isInput)) throw new Error('当前不是独立 Kimi 对话页，请先切换 Agent')
  let newButton = visibleNode(layout, node => node.type === 'button' && node.text === '＋ 新对话')
  for (let attempt = 0; !newButton && attempt < 3; attempt++) {
    const menu = visibleNode(layout, node => node.type === 'button' && node.text === '☰')
    if (!menu) throw new Error('找不到轻壳菜单按钮')
    await tap(menu)
    try {
      newButton = await waitFor(async () => {
        layout = await readUi()
        return visibleNode(layout, node => node.type === 'button' && node.text === '＋ 新对话')
      }, '展开侧栏并找到新对话按钮', 4000)
    } catch (error) {
      if (attempt === 2) throw error
      layout = await readUi()
    }
  }
  await tap(newButton)
  await waitForShell(15000)
  await sleep(1200)
}

async function sendFromPhone (prompt) {
  let layout = await readUi()
  const input = visibleNode(layout, isInput)
  if (!input) throw new Error('找不到消息输入框')
  await hdc(['shell', 'uitest', 'uiInput', 'inputText', String(input.x), String(input.y), prompt], { timeout: 20000 })
  await waitFor(async () => {
    layout = await readUi()
    return visibleNode(layout, node => isInput(node) && node.text === prompt)
  }, '手机输入框收到完整验收指令', 15000)
  const send = visibleNode(layout, node => node.type === 'button' && node.text === '发送')
  if (!send) throw new Error('发送按钮不可用，上一轮可能仍在运行')
  await tap(send)
}

async function waitReply (marker) {
  return waitFor(async () => {
    const layout = await readUi()
    return visibleNode(layout, node => node.text === marker)
  }, `手机显示唯一回复 ${marker}`)
}

async function verifyUdpFallback () {
  await hdc(['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', bundle, '--pb', 'hhDebugDropUdp', 'true'])
  const log = await waitFor(async () => {
    const text = await phoneLog()
    return text.includes('DEBUG UDP 故障注入：丢弃双向 UDP 流量，中继保持') &&
      text.includes('UDP 可靠通道失败') && text.includes('UDP 直连状态=0') ? text : false
  }, '只断 UDP 后可靠层自然超时并回落中继', 40000)
  fs.writeFileSync(path.join(outDir, 'udp-fallback.log'), log)
  await sendFromPhone(`Reply only ${fallbackMarker} without tools.`)
  await waitReply(fallbackMarker)
  const layout = await capture('06-udp-fallback-reply')
  const fallbackVisibleReplyCount = visibleReplyCount(layout, fallbackMarker)
  if (fallbackVisibleReplyCount !== 1) throw new Error(`${fallbackMarker} 可见回复不是恰好一次`)
  return { fallbackMarker, fallbackVisibleReplyCount }
}

function visibleReplyCount (layout, marker) {
  return uiNodes(layout).filter(node => node.visible && node.text === marker).length
}

async function isHealthy () {
  try { await healthCheck(); return true } catch { return false }
}

async function listenerPid () {
  const port = new URL(baseUrl).port || (baseUrl.startsWith('https:') ? '443' : '80')
  const command = `(Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess`
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 15000 })
  const pid = stdout.trim().split(/\r?\n/)[0].trim()
  if (!/^\d+$/.test(pid)) throw new Error(`找不到 ${port} 的监听进程`)
  return pid
}

async function assertIndependentAgentProcess (pid) {
  const command = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 15000 })
  if (!/person-harness-plugin/i.test(stdout) || !/(?:kimi-agent|agent)\.mjs/i.test(stdout)) {
    throw new Error(`端口监听进程 ${pid} 不是本项目的独立 Agent，已拒绝结束`)
  }
}

async function restartIndependentAgent () {
  const previousPid = await listenerPid()
  serviceRecoveryRequired = true
  await execute('schtasks.exe', ['/End', '/TN', taskName], { timeout: 20000 })
  await sleep(1500)
  if (await isHealthy()) {
    const pid = await listenerPid()
    await assertIndependentAgentProcess(pid)
    await execute('taskkill.exe', ['/PID', pid, '/T', '/F'], { timeout: 20000 })
  }
  await waitFor(async () => !(await isHealthy()), '独立 Agent 确实停止', 25000)
  await execute('schtasks.exe', ['/Run', '/TN', taskName], { timeout: 20000 })
  await waitFor(() => healthCheck(), '独立 Agent 重启并恢复健康', 90000)
  const currentPid = await listenerPid()
  if (currentPid === previousPid) throw new Error(`独立 Agent PID 仍为 ${currentPid}，未发生真实重启`)
  return { previousPid, currentPid }
}

function approvalButton (layout) {
  return visibleNode(layout, node => node.text === 'Approve once' || node.text === '批准一次')
}

async function verifyApprovalRecovery () {
  if (process.platform !== 'win32') throw new Error('审批恢复验收目前需要 Windows 计划任务；可用 --skip-approval 只验对话')
  if (fs.existsSync(approvalFile)) throw new Error(`本轮唯一验收文件已存在：${approvalFile}`)
  const forwardPath = approvalFile.replace(/\\/g, '/')
  const prompt = `Use the Write tool to create ${forwardPath}. The exact file content must be ${approvalContent}. After writing the file reply only ${approvalMarker}.`
  console.log(`[7/${totalSteps}] 手机请求真实 Write 审批；目标 ${forwardPath}`)
  await sendFromPhone(prompt)
  await waitFor(async () => approvalButton(await readUi()), '手机显示真实 Write 审批')
  if (fs.existsSync(approvalFile)) throw new Error('审批前文件已被写入，未满足受控审批前提')
  await capture('03-approval-pending')

  console.log(`[8/${totalSteps}] 待审批期间重启 ${taskName}`)
  const restart = await restartIndependentAgent()

  console.log(`[9/${totalSteps}] 手机恢复原审批并批准一次`)
  const restoredButton = await waitFor(async () => approvalButton(await readUi()), '服务重启后手机恢复审批卡', 90000)
  await capture('04-approval-restored')
  await tap(restoredButton)

  console.log(`[10/${totalSteps}] 核对真实文件内容和 ${approvalMarker}`)
  await waitFor(() => fs.existsSync(approvalFile), '批准后真实写入验收文件', 90000)
  const actualContent = fs.readFileSync(approvalFile, 'utf8').trim()
  if (actualContent !== approvalContent) throw new Error(`验收文件内容不符：${JSON.stringify(actualContent)}`)
  await waitReply(approvalMarker)
  const approvalLayout = await capture('05-approval-done')
  const approvalVisibleReplyCount = visibleReplyCount(approvalLayout, approvalMarker)
  if (approvalVisibleReplyCount !== 1) throw new Error(`${approvalMarker} 可见回复不是恰好一次`)
  return { approvalMarker, approvalFile, approvalContent, approvalVisibleReplyCount, serviceRestarted: true, ...restart }
}

async function main () {
  console.log(`[1/${totalSteps}] 检查 HDC、独立 Agent 与 DEBUG App；证据目录：${outDir}`)
  const { stdout: devices } = await rawHdc(['list', 'targets'])
  const connected = devices.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.includes('[Empty]'))
  if (!target) {
    if (connected.length !== 1) throw new Error(`检测到 ${connected.length} 台设备，请用 --target 明确指定`)
    target = connected[0]
  }
  if (!connected.includes(target)) throw new Error(`设备 ${target} 不在在线 HDC 设备列表中`)
  const { stdout: bundleInfo } = await hdc(['shell', 'bm', 'dump', '-n', bundle])
  if (!bundleInfo.includes(bundle)) throw new Error(`手机未安装 ${bundle}`)
  await healthCheck()
  await coldStart()
  if (!relayOnly) await waitForUdpDirect()

  console.log(`[2/${totalSteps}] 通过手机侧栏新建独立验收会话`)
  await createSession()

  console.log(`[3/${totalSteps}] 手机发送 ${firstMarker}`)
  await sendFromPhone(`Reply only ${firstMarker} without tools.`)
  await waitReply(firstMarker)
  const firstLayout = await capture('01-first-reply')
  const firstVisibleReplyCount = visibleReplyCount(firstLayout, firstMarker)
  if (firstVisibleReplyCount !== 1) throw new Error(`${firstMarker} 可见回复不是恰好一次`)

  console.log(`[4/${totalSteps}] 同一会话继续发送 ${secondMarker}`)
  await waitFor(async () => visibleNode(await readUi(), node => node.type === 'button' && node.text === '发送'), '发送按钮恢复', 20000)
  await sendFromPhone(`Reply only ${secondMarker} without tools.`)
  await waitReply(secondMarker)

  console.log(`[5/${totalSteps}] 核对连续回复并保存手机界面`)
  const secondLayout = await capture('02-second-reply')
  const secondVisibleReplyCount = visibleReplyCount(secondLayout, secondMarker)
  if (secondVisibleReplyCount !== 1) throw new Error(`${secondMarker} 可见回复不是恰好一次`)

  const approval = skipApproval ? { approvalSkipped: true } : await verifyApprovalRecovery()
  let fallback = { udpDirectTested: false, udpFaultInjected: false }
  if (!relayOnly) {
    fs.copyFileSync(path.join(outDir, 'udp-direct.log'), path.join(outDir, 'udp-direct-initial.log'))
    fs.writeFileSync(path.join(outDir, 'phone-approval.log'), await phoneLog())
    console.log(`[${totalSteps - 2}/${totalSteps}] 重新建立直连，再只断 UDP 验证中继回落与后续对话`)
    await coldStart()
    await waitForUdpDirect()
    await createSession()
    fallback = { ...(await verifyUdpFallback()), udpDirectTested: true, udpFaultInjected: true }
  }
  const transportPing = await healthCheck()
  console.log(`[${totalSteps - 1}/${totalSteps}] 保存鸿蒙日志和机器可读报告`)
  let phoneLogText = ''
  try {
    phoneLogText = await phoneLog()
  } catch (error) {
    phoneLogText = `hilog 收集失败：${error.message}`
  }
  fs.writeFileSync(path.join(outDir, 'phone.log'), phoneLogText)
  const report = {
    ok: true,
    target,
    bundle,
    baseUrl,
    transportMode: relayOnly ? 'relay-websocket' : 'udp-direct-with-relay-fallback',
    udpNote: relayOnly ? '本轮按 --relay-only 只证明中继链路。' : '手机与电脑日志均证明 UDP 业务直连；DEBUG 只断 UDP 后自然超时回落中继，回落后回复恰好一次。',
    firstMarker,
    secondMarker,
    firstVisibleReplyCount,
    secondVisibleReplyCount,
    ...approval,
    ...fallback,
    transportPing,
    createdAt: new Date().toISOString()
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`[${totalSteps}/${totalSteps}] 通过：鸿蒙新建会话与连续对话正常${skipApproval ? '' : '，服务重启后审批恢复和真实写入正常'}${relayOnly ? '' : '，真实 UDP 直连和故障回落正常'}`)
  console.log(path.join(outDir, 'report.json'))
}

try {
  await main()
} catch (error) {
  try {
    if (target) await capture('failure')
  } catch { /* 保留原始失败原因 */ }
  console.error(`验收失败：${error.message}`)
  console.error(`现场与日志：${outDir}`)
  process.exitCode = 1
} finally {
  if (serviceRecoveryRequired) {
    try { await healthCheck() } catch {
      try {
        console.error('检测到独立 Agent 未恢复健康，正在执行兜底启动')
        await execute('schtasks.exe', ['/Run', '/TN', taskName], { timeout: 20000 })
        await waitFor(() => healthCheck(), '独立 Agent 兜底恢复', 90000)
      } catch (error) {
        console.error(`独立 Agent 兜底恢复失败：${error.message}`)
        process.exitCode = 1
      }
    }
  }
}
