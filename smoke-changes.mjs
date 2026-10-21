import { buildSections, captureDetail, lcsDiff, packageDelta, moduleDelta } from 'file:///D:/DeepSeek/dsh-plugin-restart-prompt/lib/index.js'

const before = {
  files: {
    'package.json': JSON.stringify({ dependencies: { 'a': '1.0.0', 'b': '2.0.0' }, dsh: { profile: { bundles: ['x', 'y'] } } }, null, 2),
    'cordis.yml': 'plugins:\n  - a\n  - b\n',
    'cordis.patch.yml': 'insert:\n  - id: q\n',
    'pnpm-workspace.yaml': 'packages: []\n',
  },
  modules: ['a', '@scope/b'],
}
const after = {
  files: {
    'package.json': JSON.stringify({ dependencies: { 'a': '1.1.0', 'c': '3.0.0' }, dsh: { profile: { bundles: ['x', 'y', 'z'] } } }, null, 2),
    'cordis.yml': 'plugins:\n  - a\n  - c\n',
    'cordis.patch.yml': 'insert:\n  - id: q\n',
    'pnpm-workspace.yaml': 'packages: []\n',
  },
  modules: ['a', '@scope/b', 'c'],
}
const sections = buildSections(before, after, ['package.json', 'cordis.yml', 'node_modules', 'pnpm-lock.yaml'])
for (const s of sections) {
  console.log('## ' + s.file + ' (' + s.kind + ') ' + (s.kind === 'text' ? '+' + s.add + '/-' + s.del : ''))
  if (s.kind === 'text') for (const r of s.rows) console.log('   ' + r.op + ' ' + r.text)
  if (s.kind === 'list') for (const i of s.items) console.log('   ' + i.op + ' ' + i.text)
  if (s.kind === 'note') console.log('   ' + s.note)
}
const real = captureDetail()
console.log('real modules count =', real.modules.length, 'first =', real.modules.slice(0, 6).join(','))
console.log('real files =', Object.keys(real.files).map((k) => k + ':' + (real.files[k] == null ? 'null' : real.files[k].length)).join(' '))
