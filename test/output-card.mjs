/**
 * 输出区的结构回归测试：\u603b述必须在 ioSection 外面。
 *
 * 为什么需要这个文件：
 * 宿主（@deepseek-ai/dsh-client-ui-tool）的输出区是
 *   div.ioCard（flex 纵向）
 *     div.ioSection（grid，grid-template-columns: max-content 1fr）
 *       span.ioLabel「输出」 + span.ioText
 * 一旦往 ioSection 里多塞一个子节点，grid 自动排布就会把 ioText 挤到
 * 第二行第一列——正文被甩到下面、上面留一片空白（v0.4.0 的线上 bug）。
 * 这个测试用最小 DOM 桩把 scan() 跑一遍，断言总述是 ioSection 的兄弟节点。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/* ── 最小 DOM 桩 ──────────────────────────────────────────────────── */

class TextNode {
  constructor(text) {
    this.nodeType = 3
    this.text = String(text)
    this.parentElement = null
  }
  get textContent() {
    return this.text
  }
  set textContent(value) {
    this.text = String(value)
  }
}

class El {
  constructor(tag) {
    this.nodeType = 1
    this.tagName = String(tag).toUpperCase()
    this.className = ''
    this.attrs = new Map()
    this.childNodes = []
    this.parentElement = null
    this._display = ''
  }
  get children() {
    return this.childNodes.filter((node) => node instanceof El)
  }
  get firstChild() {
    return this.childNodes[0] || null
  }
  get nextSibling() {
    if (!this.parentElement) return null
    const list = this.parentElement.childNodes
    const index = list.indexOf(this)
    return index >= 0 ? list[index + 1] || null : null
  }
  get isConnected() {
    let node = this
    while (node.parentElement) node = node.parentElement
    return node === doc.documentElement || node === doc.body
  }
  appendChild(node) {
    if (node instanceof Fragment) {
      for (const child of [...node.childNodes]) this.appendChild(child)
      node.childNodes = []
      return node
    }
    if (node.parentElement) node.parentElement.removeChild(node)
    node.parentElement = this
    this.childNodes.push(node)
    return node
  }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node)
    if (node instanceof Fragment) {
      for (const child of [...node.childNodes]) this.insertBefore(child, ref)
      node.childNodes = []
      return node
    }
    if (node.parentElement) node.parentElement.removeChild(node)
    const index = this.childNodes.indexOf(ref)
    node.parentElement = this
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node)
    return node
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node)
    if (index >= 0) this.childNodes.splice(index, 1)
    node.parentElement = null
    return node
  }
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentElement = null
    this.childNodes = []
    for (const node of nodes) this.appendChild(node)
  }
  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('')
  }
  set textContent(value) {
    for (const child of this.childNodes) child.parentElement = null
    this.childNodes = []
    const node = new TextNode(value)
    node.parentElement = this
    this.childNodes.push(node)
  }
  setAttribute(name, value) {
    if (name === 'class') this.className = String(value)
    else this.attrs.set(name, String(value))
  }
  getAttribute(name) {
    if (name === 'class') return this.className
    return this.attrs.has(name) ? this.attrs.get(name) : null
  }
  hasAttribute(name) {
    return this.getAttribute(name) !== null
  }
  removeAttribute(name) {
    if (name === 'class') this.className = ''
    else this.attrs.delete(name)
  }
  get classList() {
    const el = this
    const list = () => el.className.split(/\s+/).filter(Boolean)
    return {
      contains: (name) => list().includes(name),
      add: (name) => {
        if (!list().includes(name)) el.className = [...list(), name].join(' ')
      },
      remove: (name) => {
        el.className = list().filter((item) => item !== name).join(' ')
      },
      toggle: (name, force) => {
        const on = force === undefined ? !list().includes(name) : Boolean(force)
        if (on) {
          if (!list().includes(name)) el.className = [...list(), name].join(' ')
        } else {
          el.className = list().filter((item) => item !== name).join(' ')
        }
        return on
      },
    }
  }
  closest(selector) {
    let node = this
    while (node) {
      if (matches(node, selector)) return node
      node = node.parentElement
    }
    return null
  }
  querySelectorAll(selector) {
    const out = []
    walk(this, (node) => {
      if (matches(node, selector)) out.push(node)
    })
    return out
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }
}

class Fragment {
  constructor() {
    this.nodeType = 11
    this.childNodes = []
    this.parentElement = null
  }
  appendChild(node) {
    node.parentElement = null
    this.childNodes.push(node)
    return node
  }
}

function walk(root, fn) {
  for (const child of root.children) {
    fn(child)
    walk(child, fn)
  }
}

/** 只支持本插件用到的那几种选择器：.cls、tag、[attr]、[attr="v"]、[class*="v"]、a b */
function matches(el, selector) {
  const parts = selector.trim().split(/\s+(?![^\[]*\])/).filter(Boolean)
  if (!parts.some((part) => part !== '>' && part.length > 0)) return false
  const last = parts[parts.length - 1]
  if (last === '>') return false
  if (!matchesSimple(el, last)) return false
  if (parts.length <= 1) return true
  // 其余部分只做"祖先里存在"的判断，覆盖 a b 与 a > b 两种情况
  let ancestor = el.parentElement
  let index = parts.length - 2
  while (index >= 0 && ancestor) {
    const part = parts[index]
    if (part === '>') {
      index -= 1
      continue
    }
    if (matchesSimple(ancestor, part)) {
      index -= 1
      ancestor = ancestor.parentElement
      continue
    }
    ancestor = ancestor.parentElement
  }
  return index < 0
}

function matchesSimple(el, part) {
  if (!part || part === '>') return false
  if (part === ':root') return el === doc.documentElement
  const tokens = part.match(/^[a-zA-Z][a-zA-Z0-9-]*|\.[^.#[\]:]+|\[[^\]]+\]|:[a-z-]+/g) || []
  for (const token of tokens) {
    if (token.startsWith('.')) {
      if (!el.classList.contains(token.slice(1))) return false
    } else if (token.startsWith('[')) {
      const body = token.slice(1, -1)
      const star = body.match(/^([\w-]+)\*="([^"]*)"$/)
      const exact = body.match(/^([\w-]+)="([^"]*)"$/)
      const bare = body.match(/^([\w-]+)$/)
      if (star) {
        if (!String(el.getAttribute(star[1]) || '').includes(star[2])) return false
      } else if (exact) {
        if (String(el.getAttribute(exact[1]) || '') !== exact[2]) return false
      } else if (bare) {
        if (!el.hasAttribute(bare[1])) return false
      } else return false
    } else if (token.startsWith(':')) {
      continue
    } else if (!el.tagName || el.tagName.toLowerCase() !== token.toLowerCase()) {
      return false
    }
  }
  return tokens.length > 0
}

const doc = {
  documentElement: null,
  body: null,
  head: null,
  createElement(tag) {
    return new El(tag)
  },
  createDocumentFragment() {
    return new Fragment()
  },
  createTextNode(text) {
    return new TextNode(text)
  },
  getElementById() {
    return null
  },
  addEventListener() {},
  querySelectorAll(selector) {
    return doc.body ? doc.body.querySelectorAll(selector) : []
  },
  querySelector(selector) {
    return doc.querySelectorAll(selector)[0] || null
  },
}

doc.documentElement = new El('html')
doc.head = doc.documentElement.appendChild(new El('head'))
doc.body = doc.documentElement.appendChild(new El('body'))

const store = new Map()
const win = {
  __ModuleLoader__: {
    load(definition) {
      win.__def = definition
    },
  },
  getComputedStyle(el) {
    return { display: el && el._display ? el._display : 'block' }
  },
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  },
}

globalThis.window = win
globalThis.document = doc
globalThis.localStorage = win.localStorage
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) })

new Function('window', 'document', 'localStorage', 'MutationObserver', 'fetch', 'setTimeout', 'setInterval', 'clearInterval', source)(
  win,
  doc,
  win.localStorage,
  globalThis.MutationObserver,
  globalThis.fetch,
  setTimeout,
  setInterval,
  clearInterval,
)

assert.ok(win.__def && typeof win.__def.factory === 'function', 'client.js 应该通过 __ModuleLoader__.load 注册')

/* ── 按宿主的真实结构搭一张工具卡 ──────────────────────────────────── */

const card = doc.body.appendChild(new El('div'))
card.setAttribute('data-chat-call-id', 'call-1')

const ioCard = card.appendChild(new El('div'))
ioCard.className = 'hKdVjq_ioCard'
ioCard._display = 'flex'

const inputSection = ioCard.appendChild(new El('div'))
inputSection.className = 'hKdVjq_ioSection'
inputSection._display = 'grid'
inputSection.appendChild(new El('span')).className = 'hKdVjq_ioLabel'
inputSection.children[0].textContent = '输入'
const inputText = inputSection.appendChild(new El('span'))
inputText.className = 'hKdVjq_ioText'
inputText.textContent = 'cd D:\\dsh-plugin'

ioCard.appendChild(new El('span')).className = 'hKdVjq_ioDivider'

const outputSection = ioCard.appendChild(new El('div'))
outputSection.className = 'hKdVjq_ioSection'
outputSection._display = 'grid'
const outputLabel = outputSection.appendChild(new El('span'))
outputLabel.className = 'hKdVjq_ioLabel'
outputLabel.textContent = '输出'
const outputText = outputSection.appendChild(new El('span'))
outputText.className = 'hKdVjq_ioText'
outputText.textContent = 'total 3\ndrwxr-xr-x 1 Admin staff 96 Nov 10 12:54 .'

doc.documentElement.classList.add('dce-notes-on')

/* ── 启动插件：start() 里会立刻扫描一次 ────────────────────────────── */

const exportsObject = win.__def.factory()
let dispose = null
exportsObject.apply({
  effect(fn) {
    dispose = fn()
  },
})

const heads = ioCard.querySelectorAll('.dce-io-head')
assert.equal(heads.length, 1, '输出区应该恰好有一条总述')

const head = heads[0]
assert.equal(head.parentElement, ioCard, '总述必须挂在 ioCard 上')
assert.equal(head.nextSibling, outputSection, '总述必须紧挨在输出 ioSection 前面')

assert.equal(outputSection.children.length, 2, '输出 ioSection 只能有「标签 + 正文」两个子节点')
assert.equal(outputSection.children[0], outputLabel)
assert.equal(outputSection.children[1], outputText)
assert.equal(outputSection.querySelector('.dce-io-head'), null, '总述不能落在 ioSection 里面（grid 会挤坏正文）')

const wrapped = outputText.querySelectorAll('.dce-ol')
assert.ok(wrapped.length >= 2, '输出正文应该按行拆成 .dce-ol，且换行原样保留')
assert.equal(outputText.textContent, 'total 3\ndrwxr-xr-x 1 Admin staff 96 Nov 10 12:54 .', '拆行不能改动原文')

assert.equal(inputSection.querySelector('.dce-io-head'), null, '输入区不应该有总述')
assert.equal(inputSection.children.length, 2, '输入 ioSection 保持两格')

dispose()
console.log('output-card: PASS（总述在 ioSection 外侧、正文两格不破、拆行不改原文）')
