// 冒烟：验证插件可加载、路由可用、变更监听会翻起 needRestart。
// 只验证宿主半区（不触碰 /restart.json 的真实派发路径——那会真的重启 DSH）。
import fs from 'node:fs'
import path from 'node:path'

process.env.DSH_HOME = 'D:\\DeepSeek\\.dsh'
process.env.DSH_PROFILE = 'desktop'

const plugin = (await import('./lib/index.js')).default
console.log('plugin name =', plugin.name)

const listeners = new Map()
const routes = new Map()
let tapIndexFn = null
const disposers = []

const ctx = {
  webServer: {
    register(route) { routes.set(route.path, route); return () => {} },
    tapIndex(fn) { tapIndexFn = fn; return () => {} },
  },
  effect(fn) { const d = fn(); return () => {} },
}

const root = {
  on(name, fn) { listeners.set(name, fn); return () => {} },
  effect(fn) { fn(); return () => {} },
  inject(names, cb) { cb(ctx) },
}

plugin.apply(root)
console.log('routes =', [...routes.keys()].join(', '))
console.log('inject listener =', typeof listeners.get('webserver/index-inject'))

// 注入表：桌面端行
const table = []
listeners.get('webserver/index-inject')(table)
console.log('inject row =', JSON.stringify(table))

function callRoute(p, req) {
  const route = routes.get(p)
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(body) { resolve({ status: this.statusCode, body: String(body) }) },
    }
    route.handler(req || { headers: { host: '127.0.0.1:52193' } }, res)
  })
}

const state0 = await callRoute('/dsh-restart-prompt/state.json')
console.log('state(before) =', state0.body)

// 让 profile 的 package.json 落盘变化（只改 mtime，不动内容）
const target = path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'package.json')
const now = new Date()
fs.utimesSync(target, now, now)

console.log('等待监听窗口（约 6s）…')
await new Promise((r) => setTimeout(r, 6000))
const state1 = await callRoute('/dsh-restart-prompt/state.json')
console.log('state(after) =', state1.body)

// 安全栅栏：非本机 Host 必须被拒
const forbidden = await callRoute('/dsh-restart-prompt/dismiss.json', { headers: { host: 'evil.example.com' } })
console.log('dismiss(remote) =', forbidden.status, forbidden.body)

const client = await callRoute('/dsh-restart-prompt/client.js')
console.log('client.js =', client.status, 'bytes:', (client.body || '').length)
console.log('tapIndex works =', typeof tapIndexFn === 'function' && tapIndexFn('<html><body></body></html>').includes('/dsh-restart-prompt/client.js'))
