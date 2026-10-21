// dsh-plugin-restart-prompt —— 插件变动后提示「重启 DSH」
//
// 行为：
//   1. 监听当前 profile 的插件清单/依赖树（package.json、pnpm-lock.yaml、cordis*.yml、
//      node_modules 目录）的落盘变化；变化稳定 SETTLE_MS 后判定「插件已变动，需要重启」。
//   2. 客户端半区（浏览器脚本）轮询 /dsh-restart-prompt/state.json，弹出提示卡片。
//   3. 用户点「重启 DSH」：若此刻 DSH 正在工作（任一 agent running），客户端先弹确认框
//      （「是」按钮红色高亮）；确认后 POST /restart。
//   4. 宿主把「结束全部 DSH 进程 + 重新拉起」交给一个 detached 的 PowerShell 脚本执行，
//      这样本进程被杀掉之后脚本仍然活着，能把新实例拉起来。
//
// 脱敏：只落文件 mtime/size 与进程路径，不落任何会话内容。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PLUGIN_ID = 'dsh-plugin-restart-prompt'
const ROUTE_PREFIX = '/dsh-restart-prompt'
const POLL_MS = 1000
const SETTLE_MS = 700
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_FILE = path.join(PACKAGE_ROOT, 'lib', 'client.js')

// DSH 数据根：与宿主同一口径（$DSH_HOME 优先）
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROFILE_NAME = process.env.DSH_PROFILE || 'desktop'
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE_NAME)
const STATE_DIR = path.join(DSH_HOME, 'dsh-plugin-restart')
const RELAUNCH_LOG = path.join(STATE_DIR, 'relaunch.log')

// 插件身份变化的观测面（任一处落盘变化都算「插件变动」）
const WATCH_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.yml', 'cordis.patch.yml']
const WATCH_DIRS = ['node_modules']

// 「查看变动内容」用：小文件留全文做行级对比，大文件只留 stat，目录留顶层包名。
const TEXT_FILES = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']
const NOTE_FILES = ['pnpm-lock.yaml']
const MAX_DIFF_ROWS = 400

// 桌面端外壳：注入行必须是内联 script（script-src 加载失败会 reject 整个 boot），
// 且宿主只在启动时收集一次注入表 —— 所以这里自己建 script 标签并吞掉 onerror。
const DESKTOP_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'var s=document.createElement("script");s.src="' + ROUTE_PREFIX + '/client.js";'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

function statSig(target) {
  try {
    const s = fs.statSync(target)
    return String(Math.round(s.mtimeMs)) + ':' + String(s.size)
  } catch {
    return '-'
  }
}

function snapshot() {
  const out = {}
  for (const name of WATCH_FILES) out[name] = statSig(path.join(PROFILE_DIR, name))
  for (const name of WATCH_DIRS) out[name] = statSig(path.join(PROFILE_DIR, name))
  return out
}

function changedKeys(a, b) {
  if (!a || !b) return []
  const keys = []
  for (const key of Object.keys(b)) if (a[key] !== b[key]) keys.push(key)
  return keys
}

function readText(target) {
  try {
    return fs.readFileSync(target, 'utf8')
  } catch {
    return null
  }
}

function splitLines(text) {
  if (text == null) return []
  return String(text).replace(/\r\n/g, '\n').split('\n')
}

// 行级 LCS 对比：profile 里的清单文件都很小（几十行），成本可忽略；过大就跳过。
function lcsDiff(a, b) {
  const n = a.length
  const m = b.length
  if (n * m > 400000) return [{ op: '~', text: '内容较大（' + n + ' → ' + m + ' 行），已跳过行级对比' }]
  const dp = []
  for (let i = 0; i <= n; i += 1) dp.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i += 1; j += 1 }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: '-', text: a[i] }); i += 1 }
    else { out.push({ op: '+', text: b[j] }); j += 1 }
  }
  while (i < n) { out.push({ op: '-', text: a[i] }); i += 1 }
  while (j < m) { out.push({ op: '+', text: b[j] }); j += 1 }
  return out
}

// 只保留改动行上下各 2 行，其余折叠成「… 跳过 N 行」，避免把整份清单贴给用户。
function trimDiff(rows, context) {
  const pad = context == null ? 2 : context
  const keep = new Array(rows.length).fill(false)
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].op === ' ') continue
    const from = Math.max(0, i - pad)
    const to = Math.min(rows.length - 1, i + pad)
    for (let k = from; k <= to; k += 1) keep[k] = true
  }
  const out = []
  let skipped = 0
  for (let i = 0; i < rows.length; i += 1) {
    if (!keep[i]) { skipped += 1; continue }
    if (skipped > 0) { out.push({ op: '~', text: '… 跳过 ' + skipped + ' 行' }); skipped = 0 }
    out.push({ op: rows[i].op, text: String(rows[i].text == null ? '' : rows[i].text).slice(0, 300) })
    if (out.length >= MAX_DIFF_ROWS) { out.push({ op: '~', text: '… 已截断' }); break }
  }
  if (skipped > 0) out.push({ op: '~', text: '… 跳过 ' + skipped + ' 行' })
  return out
}

function listModules() {
  const root = path.join(PROFILE_DIR, 'node_modules')
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const name = entry.name
    if (!name || name.startsWith('.')) continue
    if (name.startsWith('@')) {
      try {
        for (const sub of fs.readdirSync(path.join(root, name))) {
          if (!sub || sub.startsWith('.')) continue
          out.push(name + '/' + sub)
        }
      } catch {}
      continue
    }
    out.push(name)
  }
  return out.sort()
}

function captureDetail() {
  const files = {}
  for (const name of TEXT_FILES) files[name] = readText(path.join(PROFILE_DIR, name))
  return { files, modules: listModules(), at: Date.now() }
}

function parsePkg(text) {
  try {
    const json = JSON.parse(text || '{}')
    const profile = json && json.dsh && json.dsh.profile
    const bundles = profile && Array.isArray(profile.bundles) ? profile.bundles : []
    const deps = json && json.dependencies && typeof json.dependencies === 'object' ? json.dependencies : {}
    return { deps, bundles }
  } catch {
    return { deps: {}, bundles: [] }
  }
}

// 依赖版本变化、插件树（bundles）增删 —— 比读 diff 更直观
function packageDelta(before, after) {
  if (before === after) return []
  const a = parsePkg(before)
  const b = parsePkg(after)
  const items = []
  const keys = new Set(Object.keys(a.deps).concat(Object.keys(b.deps)))
  for (const key of keys) {
    const from = a.deps[key]
    const to = b.deps[key]
    if (from === to) continue
    if (from === undefined) items.push({ op: '+', text: key + ' ' + to })
    else if (to === undefined) items.push({ op: '-', text: key + ' ' + from })
    else items.push({ op: '~', text: key + ' ' + from + ' → ' + to })
  }
  for (const name of b.bundles) if (!a.bundles.includes(name)) items.push({ op: '+', text: '插件树：' + name })
  for (const name of a.bundles) if (!b.bundles.includes(name)) items.push({ op: '-', text: '插件树：' + name })
  return items
}

function moduleDelta(before, after) {
  const old = new Set(before || [])
  const next = new Set(after || [])
  const items = []
  for (const name of next) if (!old.has(name)) items.push({ op: '+', text: name })
  for (const name of old) if (!next.has(name)) items.push({ op: '-', text: name })
  return items
}

// 组装「查看变动内容」面板的数据：文本文件给行级 diff，清单给依赖/插件树增删，目录给包增删
function buildSections(before, after, changed) {
  const sections = []
  const oldFiles = (before && before.files) || {}
  const newFiles = (after && after.files) || {}
  for (const name of TEXT_FILES) {
    const from = oldFiles[name]
    const to = newFiles[name]
    if (from === to) continue
    const rows = lcsDiff(splitLines(from), splitLines(to))
    let add = 0
    let del = 0
    for (const row of rows) {
      if (row.op === '+') add += 1
      else if (row.op === '-') del += 1
    }
    sections.push({ file: name, kind: 'text', add, del, fresh: from == null ? 1 : 0, rows: trimDiff(rows) })
  }
  const deps = packageDelta(oldFiles['package.json'], newFiles['package.json'])
  if (deps.length) sections.push({ file: 'package.json · 依赖与插件树', kind: 'list', items: deps })
  const mods = moduleDelta(before && before.modules, after && after.modules)
  if (mods.length) sections.push({ file: 'node_modules · 插件目录', kind: 'list', items: mods })
  for (const name of NOTE_FILES) {
    if (Array.isArray(changed) && changed.includes(name)) {
      sections.push({ file: name, kind: 'note', note: '依赖锁已变化（体积大，不做行级对比）' })
    }
  }
  return sections
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  try {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(body)
  } catch {
    try { res.statusCode = status; res.end(body) } catch {}
  }
}

function isLoopbackHost(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return false
  const authority = raw.startsWith('[') ? raw : raw.split(':')[0]
  const host = authority.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host.endsWith('.localhost')
}

// 只允许本机页面（回环 Host / 同源 Origin）触发重启 —— 重启等同关掉用户全部会话，不能开放给远端页面。
function isTrustedRequest(req) {
  const headers = (req && req.headers) || {}
  const host = headers.host || ''
  if (!isLoopbackHost(host)) return false
  const origin = headers.origin
  if (origin) {
    try {
      const parsed = new URL(origin)
      const originAuthority = parsed.host.toLowerCase()
      const originHost = parsed.hostname.toLowerCase()
      if (originAuthority !== String(host).toLowerCase() && !(originHost === 'localhost' && isLoopbackHost(host))) return false
    } catch {
      return false
    }
  }
  return true
}

// ===== 重启实现（全程无窗口）=====
// 为什么用 VBScript + wscript.exe：
//   · wscript.exe / cscript 的 GUI 版 wscript 是 **GUI 子系统**程序，启动时根本不分配控制台；
//     powershell.exe / cmd.exe 是控制台程序，即使 -WindowStyle Hidden 也会先闪一下黑框。
//   · WMI 的 Win32_Process.Create 派生的进程挂在 WmiPrvSE 下，脱离宿主的 Job Object，
//     宿主被结束也不会被连带杀掉（这是「杀掉 → 拉起」能成立的前提）。
function vbsStr(value) {
  return '"' + String(value).replace(/"/g, '""') + '"'
}

function systemDir() {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')
}

function resolveWscript() {
  const candidate = path.join(systemDir(), 'wscript.exe')
  try {
    return fs.existsSync(candidate) ? candidate : ''
  } catch {
    return ''
  }
}

// 真正的重启动作：杀进程 → 等它退干净 → 拉起外壳
function buildRelaunchVbs({ exePath, exeArgs }) {
  const taskkill = path.join(systemDir(), 'taskkill.exe')
  const killCommand = vbsStr(taskkill) + ' /F /T /IM ' + vbsStr(path.basename(exePath))
  const startCommand = vbsStr(exePath) + (exeArgs && exeArgs.length ? ' ' + exeArgs.map(vbsStr).join(' ') : '')
  return [
    "' 由 dsh-plugin-restart-prompt 生成：结束全部 DSH 进程并重新拉起（全程无窗口）",
    'Option Explicit',
    'Dim sh',
    'WScript.Sleep 700',
    'Set sh = CreateObject("WScript.Shell")',
    'On Error Resume Next',
    'sh.Run ' + vbsStr(killCommand) + ', 0, True',
    'WScript.Sleep 1800',
    'sh.Run ' + vbsStr(startCommand) + ', 1, False',
    '',
  ].join('\r\n')
}

// 启动器：由宿主同步调用，自己再经 WMI 派生真正的重启脚本，然后立刻退出。
// （宿主直接派的子进程会被 Job Object 连带杀掉，所以必须跨出 WMI 这一层。）
function buildLauncherVbs({ wscript, relaunchScript }) {
  const childCommand = vbsStr(wscript) + ' //B //Nologo ' + vbsStr(relaunchScript)
  return [
    "' 由 dsh-plugin-restart-prompt 生成：经 WMI 派生重启脚本",
    'Option Explicit',
    'Dim svc, rv',
    'Set svc = GetObject("winmgmts:\\\\.\\root\\cimv2:Win32_Process")',
    'rv = svc.Create(' + vbsStr(childCommand) + ')',
    'WScript.Quit rv',
    '',
  ].join('\r\n')
}

function resolveExe() {
  // Electron 宿主：process.execPath 就是外壳 exe；命令行里的 app 入口参数不需要复现，
  // 直接启动外壳即可（换端口/会话由外壳自己决定）。
  return { exePath: process.execPath, exeArgs: [] }
}

// PowerShell 绝对路径 —— 绝不依赖 PATH。
// 实测该机 PATH 里既没有 pwsh 也没有 powershell：`spawn('powershell')` 只会异步发一个
// error 事件（try/catch 抓不到），于是「已派发」是假的、进程从未启动。
function resolvePowershell() {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const candidates = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'PowerShell', '7', 'pwsh.exe'))
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'))
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {}
  }
  return ''
}

function appendLog(message) {
  try {
    fs.appendFileSync(RELAUNCH_LOG, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {}
}

function scheduleRelaunch() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const { exePath, exeArgs } = resolveExe()
  const relaunchScript = path.join(STATE_DIR, 'relaunch.vbs')
  fs.writeFileSync(relaunchScript, buildRelaunchVbs({ exePath, exeArgs }), 'utf8')

  const wscript = resolveWscript()
  if (wscript) {
    const launcherScript = path.join(STATE_DIR, 'launcher.vbs')
    fs.writeFileSync(launcherScript, buildLauncherVbs({ wscript, relaunchScript }), 'utf8')
    try {
      // wscript 是 GUI 子系统程序：宿主这里同步调用不会闪任何控制台窗口。
      // 退出码 = Win32_Process.Create 的 ReturnValue（0 成功），失败绝不谎报。
      const result = spawnSync(wscript, ['//B', '//Nologo', launcherScript], {
        timeout: 8000,
        windowsHide: true,
        stdio: 'ignore',
      })
      if (result && result.status === 0) {
        appendLog(`已通过 WMI 派发重启（wscript=${wscript} exe=${exePath}）`)
        return { ok: true, via: 'wmi-vbs' }
      }
      appendLog(`WMI 派发失败：exit=${result ? result.status : 'null'} err=${String((result && result.error && result.error.message) || '')}`)
    } catch (error) {
      appendLog(`WMI 派发异常：${String((error && error.message) || error)}`)
    }
  }

  // 兜底：直接 detached 启动 wscript 执行重启脚本（正常机器走不到这里）
  const host = wscript || resolvePowershell()
  if (!host) {
    appendLog('派发失败：找不到 wscript.exe / powershell.exe')
    return { ok: false, error: '找不到 wscript.exe / powershell.exe' }
  }
  try {
    const args = path.basename(host).toLowerCase() === 'wscript.exe'
      ? ['//B', '//Nologo', relaunchScript]
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', relaunchScript]
    const child = spawn(host, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', (error) => appendLog(`兜底派发失败：${String((error && error.message) || error)}`))
    child.unref()
    if (!child.pid) return { ok: false, error: '子进程未创建（宿主启动失败）' }
    appendLog(`已通过 detached spawn 派发重启（host=${host} pid=${child.pid}）`)
    return { ok: true, via: 'spawn', detail: String(child.pid) }
  } catch (error) {
    const message = String((error && error.message) || error)
    appendLog(`兜底派发异常：${message}`)
    return { ok: false, error: message }
  }
}

// 供离线冒烟/回归直接校验脚本文本（不派发、不杀进程）
export {
  buildRelaunchVbs,
  buildLauncherVbs,
  resolveWscript,
  resolvePowershell,
  lcsDiff,
  trimDiff,
  buildSections,
  packageDelta,
  moduleDelta,
  captureDetail,
  listModules,
}

export default {
  name: PLUGIN_ID,
  apply(root) {
    // ---- 状态（进程内）----
    const state = {
      baseline: null,
      pendingKeys: [],
      pendingAt: 0,
      needRestart: false,
      dismissed: false,
      changes: [],
      changedAt: 0,
      changeDetail: [],
      busy: false,
      workingAgents: 0,
      restartRequestedAt: 0,
      restartVia: '',
      restartError: '',
    }

    // ---- 客户端半区注入（桌面端 + Web 形态两条通道，各自去重）----
    const rowDisposers = []
    rowDisposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        const marker = ROUTE_PREFIX + '/client.js'
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && String(row.src || '').indexOf(marker) >= 0) return
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(marker) >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
      } catch {}
    }))
    root.effect(() => () => {
      for (const dispose of rowDisposers) {
        try { dispose() } catch {}
      }
    })

    // ---- 忙碌判定：任一 agent 处于 running 即视为「DSH 正在工作」----
    const agentStates = new Map()
    root.on('agent/created', ({ agent } = {}) => {
      if (!agent) return
      agent.ctx.effect(() => {
        agentStates.set(agent, 'idle')
        const stop = agent.ctx.on('agent/status', ({ status } = {}) => {
          agentStates.set(agent, status === 'running' ? 'working' : 'idle')
          syncBusy()
        })
        return () => {
          if (typeof stop === 'function') stop()
          agentStates.delete(agent)
          syncBusy()
        }
      }, `${PLUGIN_ID}.agent()`)
    })

    function syncBusy() {
      let working = 0
      for (const value of agentStates.values()) if (value === 'working') working += 1
      state.workingAgents = working
      state.busy = working > 0
    }

    // ---- 插件变动监听（轮询 stat：比 fs.watch 稳，容器/网络盘也不会漏）----
    let detailSnapshot = captureDetail()
    state.baseline = snapshot()
    const timer = setInterval(() => {
      // 派发后 20 秒仍未退出 = 重启没生效：清掉「正在重启」并如实报错，让用户能重试
      if (state.restartRequestedAt > 0 && Date.now() - state.restartRequestedAt > 20000) {
        state.restartRequestedAt = 0
        state.restartError = '重启未生效（20 秒内进程仍在运行），请查看 dsh-plugin-restart/relaunch.log'
        appendLog('重启未生效：20 秒内本进程仍在运行')
      }
      const current = snapshot()
      const changed = changedKeys(state.baseline, current)
      if (changed.length === 0) {
        if (state.pendingKeys.length && Date.now() - state.pendingAt > SETTLE_MS) {
          // 变动已稳定：判定需要重启
          state.changes = state.pendingKeys.slice()
          const nextDetail = captureDetail()
          try {
            state.changeDetail = buildSections(detailSnapshot, nextDetail, state.changes)
          } catch {
            state.changeDetail = []
          }
          detailSnapshot = nextDetail
          state.changedAt = Date.now()
          state.needRestart = true
          state.dismissed = false
          state.restartError = ''
          state.baseline = current
          state.pendingKeys = []
          state.pendingAt = 0
        }
        return
      }
      // 仍在变动中：刷新稳定窗口
      const merged = new Set(state.pendingKeys.concat(changed))
      state.pendingKeys = [...merged]
      state.pendingAt = Date.now()
      state.baseline = current
    }, POLL_MS)
    if (timer.unref) timer.unref()

    // ---- 路由 ----
    root.inject(['webServer'], (ctx) => {
      const disposers = []

      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/state.json`,
        handler: (req, res) => {
          sendJson(res, 200, {
            ok: true,
            needRestart: state.needRestart && !state.dismissed,
            dismissed: state.dismissed,
            busy: state.busy,
            workingAgents: state.workingAgents,
            changes: state.changes,
            changedAt: state.changedAt,
            restartRequested: state.restartRequestedAt > 0,
            restartVia: state.restartVia,
            restartError: state.restartError,
            profile: PROFILE_NAME,
            profileDir: PROFILE_DIR,
            updatedAt: Date.now(),
          })
        },
      }))

      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/dismiss.json`,
        handler: (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
          state.dismissed = true
          sendJson(res, 200, { ok: true })
        },
      }))

      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/restart.json`,
        handler: (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
          if (state.restartRequestedAt > 0 && Date.now() - state.restartRequestedAt < 20000) {
            return sendJson(res, 200, { ok: true, already: true, via: state.restartVia })
          }
          state.restartError = ''
          const result = scheduleRelaunch()
          if (!result.ok) {
            state.restartRequestedAt = 0
            state.restartVia = ''
            state.restartError = result.error || '派发失败'
            return sendJson(res, 500, { ok: false, error: state.restartError })
          }
          state.restartRequestedAt = Date.now()
          state.restartVia = result.via || ''
          sendJson(res, 200, { ok: true, busy: state.busy, via: result.via, detail: result.detail })
        },
      }))

      // 只读诊断数据：给卡片上的「查看变动」用（不涉及任何会话内容）
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/changes.json`,
        handler: (req, res) => {
          sendJson(res, 200, {
            ok: true,
            at: state.changedAt,
            changes: state.changes,
            sections: state.changeDetail || [],
            profile: PROFILE_NAME,
            profileDir: PROFILE_DIR,
            needRestart: state.needRestart && !state.dismissed,
          })
        },
      }))

      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/client.js`,
        handler: (req, res) => {
          let source = ''
          try {
            source = fs.readFileSync(CLIENT_FILE, 'utf8')
          } catch (error) {
            source = `console.warn('[restart-prompt] 客户端脚本读取失败: ' + ${JSON.stringify(String((error && error.message) || error))})`
          }
          try {
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
            res.setHeader('Cache-Control', 'no-store')
            res.end(source)
          } catch {}
        },
      }))

      // Web 形态：直接改 index.html
      disposers.push(ctx.webServer.tapIndex((html) => {
        const marker = `${ROUTE_PREFIX}/client.js`
        if (typeof html !== 'string' || html.indexOf(marker) !== -1) return html
        const tag = `<script defer src="${marker}"></script>`
        if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
        return html + tag
      }))

      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try { dispose() } catch {}
        }
      })
    })
  },
}
