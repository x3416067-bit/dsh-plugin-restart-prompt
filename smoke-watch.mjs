// 冒烟：验证「只检测插件变动」的判定口径
//   node smoke-watch.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watch-'))
const profile = path.join(home, 'profiles', 'desktop')
const nm = path.join(profile, 'node_modules')
fs.mkdirSync(nm, { recursive: true })
process.env.DSH_HOME = home
process.env.DSH_PROFILE = 'desktop'

const write = (name, text) => fs.writeFileSync(path.join(profile, name), text)
const PATCH_BASE = [
  '# 设置层',
  '- id: ui-settings',
  '  name: "@deepseek-ai/dsh-client-ui-settings"',
  '  config:',
  '    reasoning: low',
].join('\n')

write('package.json', JSON.stringify({ dependencies: { a: '1.0.0' }, dsh: { profile: { bundles: ['x'] } } }, null, 2))
write('cordis.yml', '[]\n')
write('cordis.patch.yml', PATCH_BASE + '\n')
write('pnpm-lock.yaml', 'lockfileVersion: 9\n')
fs.mkdirSync(path.join(nm, 'pkg-a'))

const mod = await import(new URL('./lib/index.js', import.meta.url))
const { snapshot } = mod

const fails = []
const check = (label, ok) => {
  if (!ok) fails.push(label)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
}

const s0 = snapshot()

// 1. 只改设置（推理等级）→ 不该触发
write('cordis.patch.yml', PATCH_BASE.replace('reasoning: low', 'reasoning: high') + '\n')
const s1 = snapshot()
check('设置改动（config 段）不触发', JSON.stringify(s0) === JSON.stringify(s1))

// 2. 新增插件条目 → 触发
write('cordis.patch.yml', PATCH_BASE + '\n- id: my-plugin\n  name: "dsh-my-plugin"\n')
const s2 = snapshot()
check('cordis 新增插件条目触发', s2['cordis.patch.yml'] !== s1['cordis.patch.yml'])

// 3. 依赖版本变化 → 触发
write('package.json', JSON.stringify({ dependencies: { a: '1.0.1' }, dsh: { profile: { bundles: ['x'] } } }, null, 2))
const s3 = snapshot()
check('package.json 依赖变化触发', s3['package.json'] !== s2['package.json'])

// 4. 只改 package.json 的其它字段（如 scripts）→ 不该触发
write('package.json', JSON.stringify({ dependencies: { a: '1.0.1' }, scripts: { test: 'x' }, dsh: { profile: { bundles: ['x'] } } }, null, 2))
const s4 = snapshot()
check('package.json 非依赖字段不触发', s4['package.json'] === s3['package.json'])

// 5. 新装插件包 → 触发
fs.mkdirSync(path.join(nm, 'pkg-b'))
const s5 = snapshot()
check('node_modules 新增插件包触发', s5['node_modules'] !== s4['node_modules'])

// 6. 缓存目录噪声（.cache）→ 不该触发
fs.mkdirSync(path.join(nm, '.cache'))
fs.writeFileSync(path.join(nm, '.cache', 'x'), 'y')
const s6 = snapshot()
check('node_modules 下 .cache 不触发', s6['node_modules'] === s5['node_modules'])

fs.rmSync(home, { recursive: true, force: true })
console.log(fails.length ? '\n失败：' + fails.join('；') : '\n全部通过')
process.exit(fails.length ? 1 : 0)