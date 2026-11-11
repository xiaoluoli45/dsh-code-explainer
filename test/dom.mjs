/**
 * client.js 的最小 DOM 桩：只实现插件真正用到的那一小撮 API。
 *
 * 为什么要有它：client.js 是浏览器半身，跑在 `window.__ModuleLoader__.load` 里，
 * 没有它就只能读代码「看着像对」。这套桩让 scan() 能真的跑一遍，
 * 断言落在 DOM 上（节点结构、textContent、属性），而不是正则匹配源码。
 *
 * createDom(source, options) 会把 window/document/localStorage/MutationObserver
 * 挂到 globalThis，用虚拟机里的假 window 执行 client.js，然后返回加载器。
 * options.fetch / setTimeout / setInterval / clearInterval 可以替换掉默认实现，
 * 用来喂假接口、或者把定时器里跑着的 scan() 抓出来手动触发。
 */

export class TextNode {
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

export class El {
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
  get lastElementChild() {
    const list = this.children
    return list[list.length - 1] || null
  }
  get firstElementChild() {
    return this.children[0] || null
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
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true
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

/** 只支持本插件用到的那几种选择器：.cls、tag、[attr]、[attr="v"]、[class*="v"]、a b、a > b */
function matches(el, selector) {
  const parts = selector.trim().split(/\s+(?![^\[]*\])/).filter(Boolean)
  if (!parts.some((part) => part !== '>' && part.length > 0)) return false
  const last = parts[parts.length - 1]
  if (last === '>') return false
  if (!matchesSimple(el, last)) return false
  if (parts.length <= 1) return true
  // 其余部分只做「祖先里存在」的判断，覆盖 a b 与 a > b 两种情况
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

let doc = null

export function createDom(source, options = {}) {
  doc = {
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

  const observer = class {
    observe() {}
    disconnect() {}
  }
  const doFetch =
    options.fetch ||
    (() => Promise.resolve({ json: () => Promise.resolve({ ok: false }) }))
  const doSetTimeout = options.setTimeout || setTimeout
  const doSetInterval = options.setInterval || setInterval
  const doClearInterval = options.clearInterval || clearInterval

  globalThis.window = win
  globalThis.document = doc
  globalThis.localStorage = win.localStorage
  globalThis.MutationObserver = observer
  globalThis.fetch = doFetch

  new Function(
    'window',
    'document',
    'localStorage',
    'MutationObserver',
    'fetch',
    'setTimeout',
    'setInterval',
    'clearInterval',
    source,
  )(win, doc, win.localStorage, observer, doFetch, doSetTimeout, doSetInterval, doClearInterval)

  return {
    doc,
    El,
    TextNode,
    win,
    /** 取到 client.js 注册的工厂函数（等价于宿主调 __ModuleLoader__） */
    factory() {
      const def = win.__def
      if (!def || typeof def.factory !== 'function') {
        throw new Error('client.js 应该通过 __ModuleLoader__.load 注册')
      }
      return def.factory
    },
    /** 按宿主的做法启动插件；返回 dispose */
    apply(exportsObject) {
      let dispose = null
      exportsObject.apply({
        effect(fn) {
          dispose = fn()
        },
      })
      return dispose
    },
  }
}
