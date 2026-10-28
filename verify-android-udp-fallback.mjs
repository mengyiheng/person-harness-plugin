#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const root = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

function usage () {
  console.log(`用法：node verify-android-udp-fallback.mjs [选项]

选项：
  --serial <序列号>   多台设备时指定 ADB 序列号
  --adb <路径>        adb 可执行文件路径
  --url <地址>        独立 Agent 地址，默认 http://127.0.0.1:7712
  --task <任务名>     独立 Agent 计划任务，默认 PersonHarnessKimiCode
  --timeout <秒>      每阶段等待上限，默认 120
  --out <目录>        证据目录，默认 diagnostics/android-udp-fallback-<时间>
  --skip-approval     只验 UDP 回落，跳过服务重启与审批恢复
  --relay-only        不要求 UDP 直连，只验证中继新建会话与连续对话（隐含 --skip-approval）
  --approval-only     跳过 UDP，单独验证服务重启后的审批恢复
  --help              显示帮助

前置条件：DEBUG 版 App 已配对，当前已打开独立 Agent 轻壳；完整模式要求 UDP 直连可用。
默认还会重启独立 Agent 计划任务，验证手机待审批恢复。不会清除应用数据或修改配对。`)
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

const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME
const defaultAdb = sdk
  ? path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
  : (process.platform === 'win32' ? 'adb.exe' : 'adb')
const adbPath = option('--adb', defaultAdb)
const baseUrl = option('--url', 'http://127.0.0.1:7712').replace(/\/$/, '')
const taskName = option('--task', 'PersonHarnessKimiCode')
const approvalOnly = args.includes('--approval-only')
const relayOnly = args.includes('--relay-only')
if (approvalOnly && (args.includes('--skip-approval') || relayOnly)) throw new Error('--approval-only 与 --skip-approval/--relay-only 不能同时使用')
const skipApproval = !approvalOnly && (relayOnly || args.includes('--skip-approval'))
const totalSteps = approvalOnly || relayOnly ? 7 : (skipApproval ? 8 : 12)
const timeoutSeconds = Number(option('--timeout', '120'))
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 20) throw new Error('--timeout 须为不小于 20 的数字')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.resolve(root, option('--out', path.join('diagnostics', `android-udp-fallback-${stamp}`)))
fs.mkdirSync(outDir, { recursive: true })
const token = randomBytes(3).toString('hex').toUpperCase()
const firstMarker = `${relayOnly ? 'ANDROID_RELAY_FIRST' : 'UDP_FALLBACK'}_${token}`
const secondMarker = `${relayOnly ? 'ANDROID_RELAY_SECOND' : 'UDP_RELAY_AFTER'}_${token}`
const approvalMarker = `APPROVAL_RECOVERY_${token}`
const approvalContent = `ANDROID_RESTART_RECOVERY_${token}`
const approvalFile = path.join(root, 'diagnostics', `android-restart-recovery-${token}.txt`)
let serial = option('--serial', process.env.ANDROID_SERIAL || '')
let logcat
let logText = ''
let logError = ''
let serviceRecoveryRequired = false

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function execute (file, argv, { timeout = 30000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, argv, {
      timeout,
      windowsHide: true,
      encoding: binary ? 'buffer' : 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = binary ? '' : `\n${String(stderr || '').trim()}`
        reject(new Error(`${file} ${argv.join(' ')} 执行失败：${error.message}${detail}`))
      } else resolve({ stdout, stderr })
    })
  })
}

async function rawAdb (argv, options) {
  return execute(adbPath, argv, options)
}

async function adb (argv, options) {
  return rawAdb([...(serial ? ['-s', serial] : []), ...argv], options)
}

async function waitFor (check, description, timeout = timeoutSeconds * 1000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) { lastError = error }
    await sleep(700)
  }
  throw new Error(`等待超时：${description}${lastError ? `；最后错误：${lastError.message}` : ''}`)
}

function decodeXml (value) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function uiNodes (xml) {
  return [...xml.matchAll(/<node\b[^>]*>/g)].map(match => {
    const node = {}
    for (const attr of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) node[attr[1]] = decodeXml(attr[2])
    const bounds = /\[(\d+),(\d+)]\[(\d+),(\d+)]/.exec(node.bounds || '')
    node.visible = Boolean(bounds)
    if (bounds) {
      const [, left, top, right, bottom] = bounds.map(Number)
      node.x = Math.round((left + right) / 2)
      node.y = Math.round((top + bottom) / 2)
      node.visible = right > left && bottom > top
    }
    return node
  })
}

async function readUi () {
  const { stdout } = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 20000 })
  const start = stdout.indexOf('<?xml')
  const end = stdout.lastIndexOf('</hierarchy>')
  if (start < 0 || end < 0) throw new Error('uiautomator 未返回完整界面')
  return stdout.slice(start, end + '</hierarchy>'.length)
}

function visibleNode (xml, predicate) {
  return uiNodes(xml).find(node => node.visible && predicate(node))
}

async function tap (node) {
  if (!node?.visible) throw new Error('目标控件不可见，已拒绝按固定坐标点击')
  await adb(['shell', 'input', 'tap', String(node.x), String(node.y)])
  await sleep(400)
}

async function healthCheck () {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch(`${baseUrl}/__ph/transport-ping`, { signal: controller.signal })
    if (response.status !== 200) throw new Error(`独立 Agent 健康检查返回 ${response.status}`)
    return response.status
  } finally { clearTimeout(timer) }
}

async function capture (name) {
  const xml = await readUi()
  fs.writeFileSync(path.join(outDir, `${name}.xml`), xml)
  const { stdout } = await adb(['exec-out', 'screencap', '-p'], { binary: true, timeout: 20000 })
  fs.writeFileSync(path.join(outDir, `${name}.png`), stdout)
  return xml
}

async function createSession () {
  let xml = await readUi()
  if (!visibleNode(xml, node => node['resource-id'] === 'input')) throw new Error('当前不是独立 Agent 对话页，请先在手机打开轻壳')
  const menu = visibleNode(xml, node => node['resource-id'] === 'menu')
  if (!menu) throw new Error('找不到轻壳菜单按钮')
  await tap(menu)
  const newButton = await waitFor(async () => {
    xml = await readUi()
    return visibleNode(xml, node => node['resource-id'] === 'new')
  }, '展开侧栏并找到新对话按钮', 10000)
  await tap(newButton)
  await waitFor(async () => visibleNode(await readUi(), node => node['resource-id'] === 'input'), '新对话输入框', 15000)
  await sleep(700)
}

async function sendFromPhone (prompt) {
  let xml = await readUi()
  const input = visibleNode(xml, node => node['resource-id'] === 'input')
  if (!input) throw new Error('找不到消息输入框')
  await tap(input)
  await adb(['shell', 'input', 'text', prompt.replace(/ /g, '%s')])
  await waitFor(async () => {
    xml = await readUi()
    return visibleNode(xml, node => node['resource-id'] === 'input' && node.text === prompt)
  }, '手机输入框收到完整验收指令', 10000)
  const send = visibleNode(xml, node => node['resource-id'] === 'send' && node.text === '发送')
  if (!send) throw new Error('发送按钮不可用，上一轮可能仍在运行')
  await tap(send)
}

async function waitReply (marker) {
  return waitFor(async () => {
    const xml = await readUi()
    return visibleNode(xml, node => node.text === marker)
  }, `手机显示唯一回复 ${marker}`)
}

function visibleReplyCount (xml, marker) {
  return uiNodes(xml).filter(node => node.visible && node.text === marker).length
}

async function ensureDirect () {
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[2/${totalSteps}] 第 ${attempt}/3 次建立新 attach，等待真实 UDP 业务直连`)
    const logOffset = logText.length
    await adb(['shell', 'am', 'force-stop', 'com.happyharness.app'])
    await sleep(600)
    await adb(['shell', 'am', 'start', '-n', 'com.happyharness.app/.MainActivity'])
    await waitFor(async () => visibleNode(await readUi(), node => node['resource-id'] === 'input'), '独立 Agent 轻壳输入框', 20000)
    try {
      await waitFor(() => /UDP 业务直连建立/.test(logText.slice(logOffset)), '手机 UDP 业务直连日志', 25000)
      await sleep(500)
      return attempt
    } catch (error) {
      if (attempt === 3) throw new Error('连续 3 次 attach 均未建立 UDP 业务直连；这不是回落验收失败，请检查当前 NAT/网络后重试')
    }
  }
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

function approvalButton (xml) {
  return visibleNode(xml, node => node.text === 'Approve once' || node.text === '批准一次')
}

async function verifyApprovalRecovery () {
  if (process.platform !== 'win32') throw new Error('审批恢复验收目前需要 Windows 计划任务；可用 --skip-approval 只验 UDP')
  if (fs.existsSync(approvalFile)) throw new Error(`本轮唯一验收文件已存在：${approvalFile}`)
  const forwardPath = approvalFile.replace(/\\/g, '/')
  const prompt = `Use the Write tool to create ${forwardPath}. The exact file content must be ${approvalContent}. After writing the file reply only ${approvalMarker}.`
  const step = approvalOnly ? 2 : 6
  console.log(`[${step + 1}/${totalSteps}] 手机请求真实 Write 审批；目标 ${forwardPath}`)
  await sendFromPhone(prompt)
  await waitFor(async () => approvalButton(await readUi()), '手机显示真实 Write 审批')
  if (fs.existsSync(approvalFile)) throw new Error('审批前文件已被写入，未满足受控审批前提')
  await capture('03-approval-pending')

  console.log(`[${step + 2}/${totalSteps}] 待审批期间重启 ${taskName}`)
  const restart = await restartIndependentAgent()

  console.log(`[${step + 3}/${totalSteps}] 手机恢复原审批并批准一次`)
  const restoredButton = await waitFor(async () => approvalButton(await readUi()), '服务重启后手机恢复审批卡', 90000)
  await capture('04-approval-restored')
  await tap(restoredButton)

  console.log(`[${step + 4}/${totalSteps}] 核对真实文件内容和 ${approvalMarker}`)
  await waitFor(() => fs.existsSync(approvalFile), '批准后真实写入验收文件', 90000)
  const actualContent = fs.readFileSync(approvalFile, 'utf8').trim()
  if (actualContent !== approvalContent) throw new Error(`验收文件内容不符：${JSON.stringify(actualContent)}`)
  await waitReply(approvalMarker)
  const approvalXml = await capture('05-approval-done')
  const approvalVisibleReplyCount = visibleReplyCount(approvalXml, approvalMarker)
  if (approvalVisibleReplyCount !== 1) throw new Error(`${approvalMarker} 可见回复不是恰好一次`)
  return { approvalMarker, approvalFile, approvalContent, approvalVisibleReplyCount, serviceRestarted: true, ...restart }
}

async function main () {
  console.log(`[1/${totalSteps}] 检查 ADB、独立 Agent 与 DEBUG App；证据目录：${outDir}`)
  const { stdout: devices } = await rawAdb(['devices', '-l'])
  const connected = devices.split(/\r?\n/).slice(1).filter(line => /\sdevice(?:\s|$)/.test(line)).map(line => line.trim().split(/\s+/)[0])
  if (!serial) {
    if (connected.length !== 1) throw new Error(`检测到 ${connected.length} 台设备，请用 --serial 明确指定`)
    serial = connected[0]
  }
  if (!connected.includes(serial)) throw new Error(`设备 ${serial} 不在在线 ADB 设备列表中`)
  await adb(['shell', 'pm', 'path', 'com.happyharness.app'])
  await healthCheck()
  await adb(['shell', 'am', 'start', '-n', 'com.happyharness.app/.MainActivity'])

  logcat = spawn(adbPath, ['-s', serial, 'logcat', '-v', 'time', '-T', '1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  logcat.stdout.on('data', chunk => { logText += chunk.toString('utf8') })
  logcat.stderr.on('data', chunk => { logError += chunk.toString('utf8') })
  logcat.on('error', error => { logError += `${error.message}\n` })

  if (approvalOnly) {
    await adb(['shell', 'am', 'force-stop', 'com.happyharness.app'])
    await sleep(600)
    await adb(['shell', 'am', 'start', '-n', 'com.happyharness.app/.MainActivity'])
    await waitFor(async () => visibleNode(await readUi(), node => node['resource-id'] === 'input'), '独立 Agent 轻壳输入框', 25000)
  }
  const directAttachAttempts = approvalOnly || relayOnly ? 0 : await ensureDirect()
  console.log(`[${approvalOnly || relayOnly ? 2 : 3}/${totalSteps}] 通过手机侧栏新建独立验收会话`)
  await createSession()

  let finalXml = ''
  if (!approvalOnly) {
    console.log(`[${relayOnly ? 3 : 4}/${totalSteps}] 手机发送 ${firstMarker}${relayOnly ? '' : '，立即只断 UDP'}`)
    await sendFromPhone(`Reply only ${firstMarker} without tools.`)
    if (!relayOnly) {
      await adb(['shell', 'am', 'broadcast', '-a', 'com.happyharness.app.debug.UDP_LINK_DOWN', '-p', 'com.happyharness.app'])
    }
    await waitReply(firstMarker)
    if (!relayOnly) {
      await waitFor(() => /UDP 故障注入.*中继保持/.test(logText), 'DEBUG 故障注入日志', 20000)
      await waitFor(() => /UDP 可靠通道失败.*回落中继/.test(logText), '真实 UDP 超时与中继回落日志', 30000)
    }
    const fallbackXml = await capture('01-udp-fallback')
    if (visibleReplyCount(fallbackXml, firstMarker) !== 1) throw new Error(`${firstMarker} 可见回复不是恰好一次`)

    console.log(`[${relayOnly ? 4 : 5}/${totalSteps}] ${relayOnly ? '同一会话继续' : '回落后在同一会话'}发送 ${secondMarker}`)
    await waitFor(async () => visibleNode(await readUi(), node => node['resource-id'] === 'send' && node.text === '发送'), '发送按钮恢复', 20000)
    await sendFromPhone(`Reply only ${secondMarker} without tools.`)
    await waitReply(secondMarker)

    console.log(`[${relayOnly ? 5 : 6}/${totalSteps}] 核对两条可见回复和中继截图`)
    finalXml = await capture('02-relay-after')
    if (visibleReplyCount(finalXml, firstMarker) !== 1) throw new Error(`最终界面中 ${firstMarker} 可见回复不是恰好一次`)
    if (visibleReplyCount(finalXml, secondMarker) !== 1) throw new Error(`最终界面中 ${secondMarker} 可见回复不是恰好一次`)
  }
  const approval = skipApproval ? { approvalSkipped: true } : await verifyApprovalRecovery()
  const transportPing = await healthCheck()

  console.log(`[${approvalOnly || relayOnly ? 6 : (skipApproval ? 7 : 11)}/${totalSteps}] 保存手机日志和机器可读报告`)
  const report = {
    ok: true,
    serial,
    baseUrl,
    transportMode: relayOnly ? 'relay-websocket' : 'udp-then-relay',
    firstMarker: approvalOnly ? null : firstMarker,
    secondMarker: approvalOnly ? null : secondMarker,
    directAttachAttempts,
    udpSkipped: approvalOnly || relayOnly,
    debugFaultInjected: !approvalOnly && !relayOnly,
    realUdpTimeoutFallbackObserved: !approvalOnly && !relayOnly,
    firstVisibleReplyCount: finalXml ? visibleReplyCount(finalXml, firstMarker) : 0,
    secondVisibleReplyCount: finalXml ? visibleReplyCount(finalXml, secondMarker) : 0,
    ...approval,
    transportPing,
    createdAt: new Date().toISOString()
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  const successText = approvalOnly
    ? '服务重启后审批恢复和真实写入正常'
    : (relayOnly ? '中继新建会话与连续对话正常' : `UDP 回落与后续对话正常${skipApproval ? '' : '，服务重启后审批恢复和真实写入正常'}`)
  console.log(`[${totalSteps}/${totalSteps}] 通过：${successText}`)
  console.log(path.join(outDir, 'report.json'))
}

try {
  await main()
} catch (error) {
  try {
    if (serial) await capture('failure')
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
  if (logcat && !logcat.killed) logcat.kill()
  fs.writeFileSync(path.join(outDir, 'phone.log'), `${logText}${logError ? `\n[logcat stderr]\n${logError}` : ''}`)
}
