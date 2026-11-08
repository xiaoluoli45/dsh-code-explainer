/**
 * 离线冒烟测试：不启动 DSH，用假 ctx 验证宿主半身的事件、规则解释、HTTP 与 LLM 降级。
 *
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { explainWithRules, redact } from '../rules.js'

const API = '/dsh-code-explainer/api'
// 运行时拼出的假凭据：只用于验证掩码，不写入仓库中的任何真实 Key
const FAKE_KEY = 'sk-' + 'a1b2c3d4e5f6'
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dce-smoke-'))
process.env.DSH_CODE_EXPLAINER_DIR = tempDir

const { apply, name } = await import('../index.js')

function createRuntime(options = {}) {
  const listeners = new Map()
  let route = null
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {
        const list = listeners.get(event) || []
        const index = list.indexOf(fn)
        if (index >= 0) list.splice(index, 1)
      }
    },
    get(service) {
      return service === 'llm' ? options.llm || null : undefined
    },
    webServer: {
      register(value) {
        route = value
        return () => {
          route = null
        }
      },
    },
    logger: { warn() {} },
  }
  apply(ctx, options.config || {})
  return {
    name,
    ctx,
    route() {
      return route
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) || []) fn(...args)
    },
    dispose() {
      for (const dispose of disposers) dispose()
    },
  }
}

function call(route, { method = 'GET', url, body, host = '127.0.0.1:1234' }) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough()
    req.method = method
    req.url = url
    req.headers = { host }
    let raw = ''
    const res = {
      statusCode: 0,
      writeHead(code) {
        this.statusCode = code
      },
      end(chunk) {
        if (chunk) raw += chunk.toString()
        try {
          resolve({ statusCode: this.statusCode, json: raw ? JSON.parse(raw) : null })
        } catch (error) {
          reject(error)
        }
      },
    }
    if (body !== undefined) req.end(JSON.stringify(body))
    else req.end()
    try {
      route.handler(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

function fakeLlm() {
  const calls = []
  return {
    calls,
    listProviders() {
      return [{ id: 'p1' }]
    },
    async listModels() {
      return [{ id: 'm1' }]
    },
    stream(options) {
      calls.push(options)
      const text =
        '```json\n' +
        JSON.stringify({
          title: '安装项目依赖',
          purpose: '把项目需要的第三方代码包下载并装好。',
          steps: ['读取依赖清单', '从网上下载并安装'],
          risks: ['需要联网'],
        }) +
        '\n```'
      return (async function* () {
        yield { type: 'text-delta', text }
        yield { type: 'finish' }
      })()
    },
  }
}

/* ── 1. 纯规则 ──────────────────────────────────────────────────────── */

const dangerous = explainWithRules({
  tool: 'pwsh',
  args: { command: 'Remove-Item -Recurse -Force build-cache' },
  result: { ok: true },
})
assert.equal(dangerous.title, '删除文件或文件夹')
assert.ok(dangerous.risks.some((item) => item.includes('无法恢复')))

const install = explainWithRules({
  tool: 'pwsh',
  args: { command: 'npm install --no-audit' },
  result: { ok: true },
})
assert.equal(install.title, '安装项目依赖')
assert.ok(install.steps.length > 0)

const redacted = redact('curl -H "Authorization: Bearer ' + FAKE_KEY + '" https://example.com')
assert.ok(!redacted.includes(FAKE_KEY))
assert.ok(redacted.includes('***'))

/* ── 2. 宿主事件与 HTTP ─────────────────────────────────────────────── */

const llm = fakeLlm()
const runtime = createRuntime({ llm })

runtime.emit(
  'session/event',
  { id: 's1' },
  { type: 'request/header', header: { config: { provider: 'p1', model: 'm1' } } },
)

runtime.emit(
  'tools/result',
  {
    callId: 'call-1',
    name: 'pwsh',
    arguments: {
      command: 'curl -H "Authorization: Bearer ' + FAKE_KEY + '" https://example.com/install',
    },
    agent: { session: { id: 's1' } },
  },
  { content: [{ type: 'text', text: 'ok\n[exit code: 0]' }] },
)

runtime.emit(
  'tools/result',
  {
    callId: 'call-2',
    name: 'write',
    arguments: { file_path: 'example/notes.txt', content: '第一行\n第二行' },
    agent: { session: { id: 's1' } },
  },
  { content: [{ type: 'text', text: 'written' }] },
)

// 子调用不应该被解释
runtime.emit(
  'tools/result',
  {
    callId: 'call-sub',
    name: 'bash',
    arguments: { command: 'ls' },
    parent: { callId: 'call-0' },
    agent: { session: { id: 's1' } },
  },
  { content: [{ type: 'text', text: 'a\nb' }] },
)

const state = await call(runtime.route(), { url: API + '/state' })
assert.equal(state.statusCode, 200)
assert.equal(state.json.ok, true)
assert.equal(state.json.llmAvailable, true)
assert.equal(state.json.records, 2)

const list = await call(runtime.route(), { url: API + '/explanations?callIds=call-1,call-2,call-sub' })
assert.equal(list.statusCode, 200)
assert.equal(list.json.items.length, 2)
const first = list.json.items.find((item) => item.callId === 'call-1')
assert.equal(first.source, 'rule')
assert.equal(first.canEnrich, true)
assert.ok(!JSON.stringify(list.json).includes(FAKE_KEY))
assert.ok(!('argsText' in first))
assert.ok(!('outputExcerpt' in first))
const second = list.json.items.find((item) => item.callId === 'call-2')
assert.equal(second.title, '写入文件')
assert.ok(second.purpose.includes('notes.txt'))

// 非法来源拒绝
const blocked = await call(runtime.route(), {
  url: API + '/state',
  host: 'evil.example.com',
})
assert.equal(blocked.statusCode, 403)

// AI 补充：只接受本地回环、用会话路由、输入已脱敏
const enriched = await call(runtime.route(), {
  method: 'POST',
  url: API + '/explain',
  body: { callId: 'call-1' },
})
assert.equal(enriched.statusCode, 200)
assert.equal(enriched.json.item.source, 'ai')
assert.equal(enriched.json.item.title, '安装项目依赖')
assert.equal(llm.calls.length, 1)
assert.equal(llm.calls[0].provider, 'p1')
assert.equal(llm.calls[0].model, 'm1')
const prompt = llm.calls[0].messages[0].content[0].text
assert.ok(!prompt.includes(FAKE_KEY))

// 第二次直接命中缓存，不再请求模型
const again = await call(runtime.route(), {
  method: 'POST',
  url: API + '/explain',
  body: { callId: 'call-1' },
})
assert.equal(again.json.item.source, 'ai')
assert.equal(llm.calls.length, 1)

// 未知 callId
const missing = await call(runtime.route(), {
  method: 'POST',
  url: API + '/explain',
  body: { callId: 'no-such-call' },
})
assert.equal(missing.statusCode, 404)

const unknown = await call(runtime.route(), { url: API + '/explanations?callIds=no-such-call' })
assert.equal(unknown.json.items.length, 0)

// 落盘内容不含原始密钥（appendFile 是异步的，等一拍）
await new Promise((resolve) => setTimeout(resolve, 200))
const stored = fs.readFileSync(path.join(tempDir, 'explanations.jsonl'), 'utf8')
assert.ok(stored.includes('call-1'))
assert.ok(!stored.includes(FAKE_KEY))

runtime.dispose()

/* ── 3. 没有 LLM 时降级 ─────────────────────────────────────────────── */

const offline = createRuntime({ llm: null })
offline.emit(
  'tools/result',
  {
    callId: 'call-offline',
    name: 'bash',
    arguments: { command: 'git status' },
    agent: { session: { id: 's2' } },
  },
  { content: [{ type: 'text', text: 'clean' }] },
)
const offlineItem = await call(offline.route(), {
  url: API + '/explanations?callIds=call-offline',
})
assert.equal(offlineItem.json.items[0].canEnrich, false)
const offlineExplain = await call(offline.route(), {
  method: 'POST',
  url: API + '/explain',
  body: { callId: 'call-offline' },
})
assert.equal(offlineExplain.statusCode, 200)
assert.equal(offlineExplain.json.item.source, 'rule')
assert.equal(offlineExplain.json.item.aiStatus, 'failed')
offline.dispose()

/* ── 4. 清理 ───────────────────────────────────────────────────────── */

fs.rmSync(tempDir, { recursive: true, force: true })
console.log('smoke: PASS（规则解释、凭据掩码、事件监听、HTTP、AI 补充、缓存、无 LLM 降级）')
