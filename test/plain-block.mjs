/**
 * 纯文本代码块的回归测试：没有 span.line 也要逐行出注释。
 *
 * 为什么需要这个文件：
 * 宿主的代码块渲染器 iw() 里，\`lineNumbers\` 默认 false，而唯一调用点 iU() 从不传它，
 * 于是「没有语言标注 / 语言包还没加载」的块走的是
 *   <pre class="plain"><code>整段文本</code></pre>
 * 里面一个 span.line 都没有。client.js 早先在这里直接早退，
 * 结果这类块零注释、连「注释：开/关」按钮都不出现（issue #10）。
 *
 * 这个测试用最小 DOM 桩把 scan() 跑一遍，断言：
 *   · 补出来的行是宿主的 span.line，注释按行挂上；
 *   · pre.textContent 逐字不变（复制拿到的还是原文）；
 *   · 已经有 span.line 的块一根手指都不动；
 *   · 二次扫描不会套娃；
 *   · 宿主重写文本后下一次扫描自己能接回来。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createDom } from './dom.mjs'
import { explainCodeLines, enrichLineNotes } from '../rules.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

const API = '/dsh-code-explainer/api'

/** 假接口：按真实契约返回逐行规则说明（不发 AI，aiStatus 固定 off） */
function fakeFetch(url, init) {
  if (url === API + '/line-notes' && init && init.method === 'POST') {
    const body = JSON.parse(init.body)
    const notes = enrichLineNotes(body.code, body.lang, explainCodeLines(body.code, body.lang))
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, notes, aiStatus: 'off', hash: 'h1' }) })
  }
  return Promise.resolve({ json: () => Promise.resolve({ ok: false }) })
}

// start() 里会挂一个 3 秒兜底扫描：抓出来手动触发，测试里不等 3 秒
const timers = { scan: null }
const dom = createDom(source, {
  fetch: fakeFetch,
  setInterval: (callback) => {
    timers.scan = callback
    return 0
  },
})
const { doc, El } = dom

/** 宿主 banner 的真实结构：infostring 是 div，里面没有 span —— 所以 langOf() 拿不到语言 */
function makeBlock(card, text, { lang = '', lineSpans = false, blockState = null } = {}) {
  const block = card.appendChild(new El('div'))
  block.className = 'kQ_1 md-code-block'
  if (blockState !== null) block.setAttribute('data-state', blockState)

  const banner = block.appendChild(new El('div'))
  banner.className = 'kQ_1_banner'
  banner.setAttribute('data-code-block-banner', '')
  const info = banner.appendChild(new El('div'))
  info.className = 'kQ_1_infostring'
  info.textContent = lang
  const action = banner.appendChild(new El('div'))
  action.className = 'kQ_1_action'
  action.appendChild(new El('button')).className = 'kQ_1_copy'

  const content = block.appendChild(new El('div'))
  content.setAttribute('data-code-block-content', '')
  const pre = content.appendChild(new El('pre'))
  pre.className = 'kQ_1_plain'
  const code = pre.appendChild(new El('code'))

  if (lineSpans) {
    const parts = text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) code.appendChild(doc.createTextNode('\n'))
      const span = code.appendChild(new El('span'))
      span.className = 'line'
      span.textContent = part
    })
  } else {
    code.textContent = text
  }
  return { block, banner, action, pre, code }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

const card = doc.body.appendChild(new El('div'))
card.setAttribute('data-chat-call-id', 'call-plain')

const PLAIN = 'const a = 1\nconsole.log(a)'

const plain = makeBlock(card, PLAIN)
const unknownLang = makeBlock(card, PLAIN, { lang: 'dsh-ui' })
const already = makeBlock(card, PLAIN, { lineSpans: true })
const foreign = makeBlock(card, 'whatever')

// 第三方渲染器接了手的块：code 里已经有元素子节点，但不是 span.line
foreign.code.appendChild(new El('span')).className = 'tok'
foreign.code.children[0].textContent = 'whatever'

const streamingCard = doc.body.appendChild(new El('div'))
streamingCard.setAttribute('data-chat-call-id', 'call-streaming')
streamingCard.setAttribute('data-state', 'running')
const streaming = makeBlock(streamingCard, PLAIN)

doc.documentElement.classList.add('dce-notes-on')

const scanFromTimer = () => timers.scan()
const exportsObject = dom.factory()()
const dispose = dom.apply(exportsObject)

await tick()

/* ── 1. 无语言标注的纯文本块 ──────────────────────────────────────── */

assert.equal(plain.pre.textContent, PLAIN, '补行之后 pre.textContent 必须逐字不变（复制的是原文）')
const plainLines = plain.code.querySelectorAll('span.line')
assert.equal(plainLines.length, 2, '无 lang 的块应该按行补出 span.line')
assert.equal(plainLines[0].textContent, 'const a = 1')
assert.equal(plainLines[1].textContent, 'console.log(a)')
assert.ok(
  plain.code.querySelectorAll('.line[data-dce-note]').length >= 2,
  '无 lang 的块也要逐行挂上注释',
)
assert.equal(plain.code.children.length, 2, '行节点只有补出来的 span.line')
assert.ok(plain.banner.querySelector('.dce-toggle'), '无 lang 的块也要有「注释：开/关」按钮')

/* ── 2. 语言标签不认识（第三方 fence）同样处理 ─────────────────────── */

assert.equal(unknownLang.pre.textContent, PLAIN)
assert.equal(unknownLang.code.querySelectorAll('span.line').length, 2)
assert.ok(unknownLang.code.querySelectorAll('.line[data-dce-note]').length >= 2)

/* ── 3. 已经有 span.line 的块保持一致 ──────────────────────────────── */

const alreadyLines = already.code.querySelectorAll('span.line')
assert.equal(alreadyLines.length, 2)
assert.equal(alreadyLines[0], already.code.children[0], '不能重建行节点，必须沿用宿主已有的那两个')
assert.equal(already.pre.textContent, PLAIN)
assert.ok(already.code.querySelectorAll('.line[data-dce-note]').length >= 2)

/* ── 4. 别人的 DOM 不碰 ────────────────────────────────────────────── */

assert.equal(foreign.code.children.length, 1)
assert.equal(foreign.code.children[0].className, 'tok')
assert.equal(foreign.banner.querySelector('.dce-toggle'), null, '结构不认识的块不插开关')

/* ── 5. 流式渲染中不动，落定后再补行 ──────────────────────────────── */

assert.equal(streaming.code.querySelectorAll('span.line').length, 0, '流式块先不补行（宿主还会重写这段文本）')
streaming.block.setAttribute('data-state', 'done')
scanFromTimer()
assert.equal(streaming.pre.textContent, PLAIN)
assert.equal(streaming.code.querySelectorAll('span.line').length, 2, '卡片落定后补行')

/* ── 6. 二次扫描不套娃 ─────────────────────────────────────────────── */

const before = plain.code.children.length
scanFromTimer()
assert.equal(plain.code.children.length, before, '再扫一次不能再包一层')
assert.equal(plain.pre.textContent, PLAIN)

/* ── 7. 宿主重写文本后能自愈 ───────────────────────────────────────── */

const NEXT = 'let b = 2\nb += 1\nconsole.log(b)'
plain.code.textContent = NEXT
scanFromTimer()
await tick()
assert.equal(plain.pre.textContent, NEXT, '重写后的文本仍然逐字可复现')
assert.equal(plain.code.querySelectorAll('span.line').length, 3, '重写后按新行数重新补行')
assert.equal(plain.code.children[2].textContent, 'console.log(b)')
assert.ok(plain.code.querySelectorAll('.line[data-dce-note]').length >= 2)

dispose()
console.log('plain-block: PASS（无 lang / 未知语言也逐行出注释，文本逐字不变，已有行节点不重建，二次扫描不套娃）')
