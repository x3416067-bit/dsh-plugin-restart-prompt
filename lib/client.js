// dsh-plugin-restart-prompt —— 客户端半区（浏览器脚本，vanilla，自挂载）
// 职责：轮询宿主 /dsh-restart-prompt/state.json；插件变动后弹提示卡片；
//       点「重启 DSH」时若 DSH 正在工作则先弹确认框（「是」红色高亮）。
// 设计要点：失败必须看得见 —— 派发失败/未生效时显示红色错误与「重试」，绝不只剩一张转圈卡片。
(function () {
  'use strict'
  if (window.__DSH_RESTART_PROMPT__) return
  window.__DSH_RESTART_PROMPT__ = true

  var PREFIX = '/dsh-restart-prompt'
  var POLL_MS = 1200
  var mounted = false
  var shadow = null
  var card = null
  var modal = null
  var restarting = false
  var lastState = null

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.card{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:330px;border-radius:14px;',
    'background:rgba(24,24,27,.97);color:#f4f4f5;border:1px solid rgba(255,255,255,.12);',
    'box-shadow:0 12px 40px rgba(0,0,0,.45);padding:14px 16px;font-size:13px;line-height:20px}',
    '.title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;margin:0 0 6px}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#f59e0b;box-shadow:0 0 0 4px rgba(245,158,11,.15)}',
    '.dot.busy{animation:pulse 1.1s ease-in-out infinite}',
    '.dot.bad{background:#ef4444;box-shadow:0 0 0 4px rgba(239,68,68,.16)}',
    '.dot.work{background:#3b82f6;box-shadow:0 0 0 4px rgba(59,130,246,.18)}',
    '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}',
    '.desc{color:#a1a1aa;font-size:12px;line-height:18px;margin:0 0 10px;word-break:break-word}',
    '.err{color:#fca5a5;font-size:12px;line-height:18px;margin:0 0 10px;word-break:break-word}',
    '.row{display:flex;gap:8px;justify-content:flex-end}',
    'button{font:inherit;font-size:12px;border-radius:8px;padding:6px 12px;cursor:pointer;border:1px solid transparent;transition:filter .15s}',
    'button:hover{filter:brightness(1.12)}',
    '.ghost{background:transparent;color:#a1a1aa;border-color:rgba(255,255,255,.16)}',
    '.primary{background:#2563eb;color:#fff}',
    '.danger{background:#dc2626;color:#fff}',
    '.danger:hover{filter:brightness(1.18)}',
    '.mask{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px}',
    '.dialog{width:360px;max-width:100%;border-radius:14px;background:#1c1c1f;color:#f4f4f5;border:1px solid rgba(255,255,255,.12);',
    'box-shadow:0 24px 64px rgba(0,0,0,.55);padding:18px}',
    '.dialog h3{margin:0 0 8px;font-size:14px;font-weight:600}',
    '.dialog p{margin:0 0 16px;font-size:12.5px;line-height:19px;color:#a1a1aa}',
    '.warn{color:#fca5a5}',
    '.panel{width:min(900px,100%);max-height:78vh;display:flex;flex-direction:column;border-radius:14px;background:#1c1c1f;',
    'color:#f4f4f5;border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 64px rgba(0,0,0,.55);overflow:hidden}',
    '.panelHead{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;',
    'border-bottom:1px solid rgba(255,255,255,.1);font-size:13px;font-weight:600}',
    '.panelBody{padding:12px 14px;overflow:auto;font-size:12px;line-height:18px}',
    '.sum{color:#a1a1aa;margin:0 0 12px;font-size:12px;line-height:18px;word-break:break-word}',
    '.sec{margin:0 0 16px}',
    '.secHead{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:12.5px;font-weight:600;color:#e4e4e7}',
    '.pill{font-size:11px;font-weight:400;color:#a1a1aa}',
    '.diff{margin:0;padding:8px 10px;background:#111113;border:1px solid rgba(255,255,255,.08);border-radius:8px;',
    'max-height:260px;overflow:auto;font:12px/16px "Cascadia Mono",ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}',
    '.ln{display:block}',
    '.ln.add{color:#86efac}.ln.del{color:#fca5a5}.ln.ctx{color:#a1a1aa}.ln.skip{color:#71717a}',
    '.item{display:block;font:12px/17px "Cascadia Mono",ui-monospace,Consolas,monospace}',
    '.item.add{color:#86efac}.item.del{color:#fca5a5}.item.mod{color:#fbbf24}',
    '.none{color:#a1a1aa}'
  ].join('')

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text != null) node.textContent = text
    return node
  }

  function mount() {
    if (mounted || !document.body) return
    mounted = true
    var host = document.createElement('div')
    host.setAttribute('data-dsh-restart-prompt', '')
    shadow = host.attachShadow({ mode: 'open' })
    shadow.appendChild(el('style', null, CSS))
    document.body.appendChild(host)
  }

  function clearCard() { if (card && card.parentNode) card.parentNode.removeChild(card); card = null }
  function clearModal() { if (modal && modal.parentNode) modal.parentNode.removeChild(modal); modal = null }

  function humanChanges(changes) {
    var names = {
      'package.json': '插件清单', 'pnpm-lock.yaml': '依赖锁',
      'cordis.yml': '插件树', 'cordis.patch.yml': '补丁层', node_modules: '插件目录'
    }
    if (!changes || !changes.length) return '插件'
    return changes.map(function (k) { return names[k] || k }).join('、')
  }

  function post(path) {
    return fetch(PREFIX + path, { method: 'POST', cache: 'no-store' })
      .then(function (res) { return res.json().catch(function () { return { ok: res.ok } }) })
  }

  function makeCard(title, dotClass) {
    clearCard()
    card = el('div', 'card')
    var head = el('div', 'title')
    head.appendChild(el('span', 'dot' + (dotClass ? ' ' + dotClass : '')))
    head.appendChild(el('span', null, title))
    card.appendChild(head)
    shadow.appendChild(card)
    return card
  }

  function renderRestarting() {
    restarting = true
    mount()
    makeCard('正在重启 DSH…', 'busy')
    card.appendChild(el('p', 'desc', '已结束全部 DSH 进程并重新拉起，页面稍后会自动断开；若未自动打开，请从桌面快捷方式启动。'))
  }

  function renderError(message) {
    restarting = false
    mount()
    makeCard('重启未能生效', 'bad')
    card.appendChild(el('p', 'err', message || '派发失败'))
    card.appendChild(el('p', 'desc', '详情见 %DSH_HOME%\\dsh-plugin-restart\\relaunch.log'))
    var row = el('div', 'row')
    var again = el('button', 'primary', '重试')
    again.addEventListener('click', function () { doRestart() })
    row.appendChild(again)
    card.appendChild(row)
  }

  function doRestart() {
    clearModal()
    renderRestarting()
    post('/restart.json')
      .then(function (res) {
        if (res && res.ok) return
        renderError((res && res.error) || '重启请求被宿主拒绝')
      })
      .catch(function () { renderError('重启请求失败（宿主无响应）') })
  }

  function askThenRestart() {
    mount()
    clearModal()
    modal = el('div', 'mask')
    var dialog = el('div', 'dialog')
    dialog.appendChild(el('h3', null, 'DSH 正在工作'))
    var p = el('p', null, '当前有任务正在执行，重启会立即结束全部 DSH 进程，')
    p.appendChild(el('span', 'warn', '正在进行的任务会被中断。'))
    p.appendChild(document.createTextNode('确定要现在重启吗？'))
    dialog.appendChild(p)

    var row = el('div', 'row')
    var no = el('button', 'ghost', '否')
    var yes = el('button', 'danger', '是')
    no.addEventListener('click', function () { clearModal() })
    yes.addEventListener('click', function () { clearModal(); doRestart() })
    row.appendChild(no)
    row.appendChild(yes)
    dialog.appendChild(row)
    modal.appendChild(dialog)
    modal.addEventListener('click', function (event) { if (event.target === modal) clearModal() })
    shadow.appendChild(modal)
    try { yes.focus() } catch (e) {}

    var onKey = function (event) {
      if (event.key === 'Escape') { clearModal(); document.removeEventListener('keydown', onKey, true) }
    }
    document.addEventListener('keydown', onKey, true)
  }

  var OP_CLASS = { '+': 'add', '-': 'del', ' ': 'ctx', '~': 'skip' }

  function sectionNode(section) {
    var box = el('div', 'sec')
    var head = el('div', 'secHead')
    head.appendChild(el('span', null, section.file || '变动'))
    if (section.kind === 'text') {
      var pill = '+ ' + (section.add || 0) + ' / - ' + (section.del || 0)
      if (section.fresh) pill = '新增文件 · ' + (section.add || 0) + ' 行'
      head.appendChild(el('span', 'pill', pill))
    } else if (section.kind === 'list') {
      head.appendChild(el('span', 'pill', (section.items || []).length + ' 项'))
    }
    box.appendChild(head)

    if (section.kind === 'text') {
      var pre = el('div', 'diff')
      var rows = section.rows || []
      if (!rows.length) pre.appendChild(el('span', 'none', '（无可展示的差异）'))
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i]
        var line = el('span', 'ln ' + (OP_CLASS[row.op] || 'ctx'))
        line.textContent = row.op === '~' ? String(row.text) : (row.op === ' ' ? '  ' : row.op + ' ') + row.text
        pre.appendChild(line)
      }
      box.appendChild(pre)
    } else if (section.kind === 'list') {
      var list = el('div', 'diff')
      var items = section.items || []
      for (var k = 0; k < items.length; k += 1) {
        var item = items[k]
        var cls = item.op === '+' ? 'add' : item.op === '-' ? 'del' : 'mod'
        list.appendChild(el('span', 'item ' + cls, item.op + ' ' + item.text))
      }
      box.appendChild(list)
    } else {
      box.appendChild(el('p', 'sum', section.note || ''))
    }
    return box
  }

  function renderChanges(body, data) {
    body.textContent = ''
    var changes = (data && data.changes) || []
    var sections = (data && data.sections) || []
    var when = data && data.at ? new Date(data.at).toLocaleString('zh-CN', { hour12: false }) : '未知时间'
    var sum = el('p', 'sum')
    sum.textContent = changes.length
      ? '变动文件：' + humanChanges(changes) + '　·　检测时间 ' + when + '　·　配置目录 ' + (data.profileDir || '')
      : '没有记录到具体变动（可能是宿主启动后第一次变更）。'
    body.appendChild(sum)
    if (!sections.length) {
      body.appendChild(el('p', 'none', '没有可展示的差异明细：这次只改动了目录 mtime，或对方文件过大。'))
      return
    }
    for (var i = 0; i < sections.length; i += 1) body.appendChild(sectionNode(sections[i]))
  }

  function openChanges() {
    mount()
    clearModal()
    modal = el('div', 'mask')
    var panel = el('div', 'panel')
    var head = el('div', 'panelHead')
    head.appendChild(el('span', null, '插件变动详情'))
    var close = el('button', 'ghost', '关闭')
    close.addEventListener('click', function () { clearModal() })
    head.appendChild(close)
    panel.appendChild(head)
    var body = el('div', 'panelBody', '读取中...')
    panel.appendChild(body)
    modal.appendChild(panel)
    modal.addEventListener('click', function (event) { if (event.target === modal) clearModal() })
    shadow.appendChild(modal)

    var onKey = function (event) {
      if (event.key === 'Escape') { clearModal(); document.removeEventListener('keydown', onKey, true) }
    }
    document.addEventListener('keydown', onKey, true)

    fetch(PREFIX + '/changes.json', { cache: 'no-store' })
      .then(function (res) { return res.json() })
      .then(function (data) { renderChanges(body, data) })
      .catch(function () { body.textContent = '读取变动详情失败（宿主无响应）' })
  }

  function render(state) {
    mount()
    if (restarting) return
    if (state && state.restartError) { renderError(state.restartError); return }
    if (!state || !state.needRestart) { clearCard(); return }

    makeCard('插件已变动，需重启 DSH', state.busy ? 'work' : '')
    var desc = humanChanges(state.changes) + ' 已更新完成；重启后新插件才会被加载。'
    if (state.busy) desc += '（当前有任务在执行）'
    card.appendChild(el('p', 'desc', desc))

    var row = el('div', 'row')
    var detail = el('button', 'ghost', '查看变动')
    var later = el('button', 'ghost', '稍后')
    var go = el('button', 'primary', '重启 DSH')
    detail.addEventListener('click', function () { openChanges() })
    later.addEventListener('click', function () {
      post('/dismiss.json').catch(function () {})
      clearCard()
    })
    go.addEventListener('click', function () {
      // 用最近一次轮询结果判定忙碌：省掉一次往返，点下去立刻有反应
      if (lastState && lastState.busy) askThenRestart()
      else doRestart()
    })
    row.appendChild(detail)
    row.appendChild(later)
    row.appendChild(go)
    card.appendChild(row)
  }

  function poll() {
    fetch(PREFIX + '/state.json', { cache: 'no-store' })
      .then(function (res) { return res.json() })
      .then(function (state) {
        lastState = state
        if (state && state.restartRequested) { if (!restarting) renderRestarting(); return }
        restarting = false
        render(state)
      })
      .catch(function () { /* 宿主重启中：静默 */ })
      .then(function () { setTimeout(poll, POLL_MS) })
  }

  if (document.body) poll()
  else document.addEventListener('DOMContentLoaded', poll, { once: true })
})()
