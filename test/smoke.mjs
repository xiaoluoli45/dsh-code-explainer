/**
 * 离线冒烟测试：不启动 DSH，用假 ctx 验证逐行规则、HTTP 接口、AI 补充与降级。
 *
 * 注意：这里的假 LLM 只验证协议形状（请求字段、JSON 解析、缓存、落盘），
 * 不作为「AI 解释可用」的验收证据；真实验收必须在 DSH 里跑真实模型。
 *
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { enrichLineNotes, explainCodeLines, explainCommandLine, redact, teachLine } from '../rules.js'

const API = '/dsh-code-explainer/api'
// 运行时拼出的假凭据：只用于验证掩码，不写入仓库中的任何真实 Key
const FAKE_KEY = 'sk-' + 'a1b2c3d4e5f6'
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dce-smoke-'))
process.env.DSH_CODE_EXPLAINER_DIR = tempDir

const { apply } = await import('../index.js')

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
    ctx,
    route: () => route,
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

function fakeLlm(answer) {
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
      return (async function* () {
        yield { type: 'text-delta', text: answer }
        yield { type: 'finish' }
      })()
    },
  }
}

const SAMPLE = [
  "const r = await tools.ops_bash({",
  '  command: "Get-ChildItem -LiteralPath \'D:\\\\project\\\\demo\'",',
  '  description: "List code-explainer directory contents",',
  '  timeoutMs: 60000',
  '});',
  'entries.sort((a, b) => a.size - b.size);',
  'console.log(JSON.stringify(r, null, 2));',
].join('\n')

/* ── 1. 纯规则 ──────────────────────────────────────────────────────── */

assert.equal(explainCommandLine('Remove-Item -Recurse -Force build-cache'), '删除指定的文件或文件夹')
assert.equal(explainCommandLine('Get-ChildItem -LiteralPath .'), '列出文件夹里有哪些文件')

const notes = explainCodeLines(SAMPLE, 'typescript')
assert.equal(notes[0], '调用命令行工具，把结果存起来')
assert.equal(notes[1], '列出文件夹里有哪些文件')
assert.equal(notes[2], '给这次操作加一句说明')
assert.equal(notes[3], '最多等 60 秒')
assert.equal(notes[4], '')
assert.equal(notes[5], '')
assert.equal(notes[6], '把结果打印出来')

// 具体表达式：模块、返回值、参数都要讲到，而不是只报语法名
const dynamicImport = explainCodeLines('const fs = await import("node:fs");', 'js')[0]
assert.ok(dynamicImport.includes('文件系统模块'))
assert.ok(dynamicImport.includes('返回模块对象'))
assert.ok(dynamicImport.includes('node: 前缀'))
const requireNote = explainCodeLines("const { readFile } = require('node:fs')", 'js')[0]
assert.ok(requireNote.includes('文件系统模块'))
assert.ok(requireNote.includes('readFile'))
const fsNote = explainCodeLines('fs.readFileSync("config.json", "utf8");', 'js')[0]
assert.ok(fsNote.includes('config.json'))
assert.ok(fsNote.includes('utf8'))
const fsPromise = explainCodeLines('const text = await fs.promises.readFile("a.txt", "utf8")', 'js')[0]
assert.ok(fsPromise.includes('读取文件内容'))
assert.ok(fsPromise.includes('a.txt'))
assert.ok(explainCodeLines('const home = process.env.HOME', 'js')[0].includes('HOME'))
assert.ok(explainCodeLines('const p = path.join("a", "b.txt")', 'js')[0].includes('b.txt'))
assert.ok(explainCodeLines('const p = path.join(__dirname, "a.txt")', 'js')[0].includes('__dirname'))

const redacted = redact('curl -H "Authorization: Bearer ' + FAKE_KEY + '" https://example.com')
assert.ok(!redacted.includes(FAKE_KEY))
assert.ok(redacted.includes('***'))

// 行尾注释：动作 + 半句为什么；同一写法只在第一次解释
assert.equal(teachLine('});'), null)
assert.equal(teachLine('const x = await foo()').key, 'await')

const enriched = enrichLineNotes(SAMPLE, 'typescript', notes)
assert.ok(enriched[0].includes('调用命令行工具，把结果存起来'))
assert.ok(enriched[0].includes('await（等待异步完成）'))
assert.ok(enriched[1].includes('列出文件夹里有哪些文件'))
assert.ok(enriched[1].includes('command（命令，必填）'))
assert.ok(enriched[2].includes('给这次操作加一句说明'))
assert.ok(enriched[2].includes('可选参数'))
assert.ok(enriched[3].includes('最多等 60 秒'))
assert.ok(enriched[3].includes('timeoutMs（超时毫秒）'))
assert.equal(enriched[4], '')
assert.equal(enriched[5], '')

const repeated = enrichLineNotes('const a = await f()\nconst b = await g()', 'js', [
  '等第一步做完',
  '等第二步做完',
])
assert.ok(repeated[0].includes('await（等待异步完成）'))
assert.ok(!repeated[0].includes('同上'))
assert.ok(repeated[1].includes('（同上）'))
assert.ok(!repeated[1].includes('等待异步完成'))

/* ── 2. HTTP + AI 补充 ──────────────────────────────────────────────── */

const answer = JSON.stringify({
  notes: { 6: '把这几项按大小排好顺序' },
})
const llm = fakeLlm(answer)
const runtime = createRuntime({ llm })

const first = await call(runtime.route(), {
  method: 'POST',
  url: API + '/line-notes',
  body: { code: SAMPLE, lang: 'typescript' },
})
assert.equal(first.statusCode, 200)
assert.equal(first.json.ok, true)
assert.equal(first.json.aiStatus, 'running')
assert.ok(first.json.notes[0].includes('调用命令行工具，把结果存起来'))
assert.ok(first.json.notes[0].includes('await（等待异步完成）'))
assert.equal(first.json.notes[5], '')
assert.ok(first.json.hash)

// 等 AI 队列跑完
await new Promise((resolve) => setTimeout(resolve, 300))
const second = await call(runtime.route(), { url: API + '/line-notes?hash=' + first.json.hash })
assert.equal(second.statusCode, 200)
assert.equal(second.json.aiStatus, 'done')
assert.equal(second.json.notes[5], '把这几项按大小排好顺序')
assert.equal(llm.calls.length, 1)
assert.equal(llm.calls[0].provider, 'p1')
assert.equal(llm.calls[0].model, 'm1')
assert.ok(!llm.calls[0].messages[0].content[0].text.includes(FAKE_KEY))

// 同一段代码再次请求：命中缓存，不再调模型
const third = await call(runtime.route(), {
  method: 'POST',
  url: API + '/line-notes',
  body: { code: SAMPLE, lang: 'typescript' },
})
assert.equal(third.json.aiStatus, 'done')
assert.equal(llm.calls.length, 1)

// 非法来源拒绝
const blocked = await call(runtime.route(), { url: API + '/state', host: 'evil.example.com' })
assert.equal(blocked.statusCode, 403)

// 落盘：含 AI 结果、不含原始密钥
await new Promise((resolve) => setTimeout(resolve, 200))
const stored = fs.readFileSync(path.join(tempDir, 'line-notes.jsonl'), 'utf8')
assert.ok(stored.includes(first.json.hash))
assert.ok(stored.includes('把这几项按大小排好顺序'))
assert.ok(!stored.includes(FAKE_KEY))

runtime.dispose()

/* ── 2.5 工具卡还在跑时只取规则，跑完再补 AI ────────────────────────── */

const deferredDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dce-smoke-defer-'))
process.env.DSH_CODE_EXPLAINER_DIR = deferredDir
const deferredLlm = fakeLlm(answer)
const deferred = createRuntime({ llm: deferredLlm })

const quick = await call(deferred.route(), {
  method: 'POST',
  url: API + '/line-notes',
  body: { code: SAMPLE, lang: 'typescript', ai: false },
})
assert.equal(quick.json.aiStatus, 'off')
assert.ok(quick.json.notes[0].includes('调用命令行工具，把结果存起来'))
await new Promise((resolve) => setTimeout(resolve, 250))
assert.equal(deferredLlm.calls.length, 0)

const settle = await call(deferred.route(), {
  method: 'POST',
  url: API + '/line-notes',
  body: { code: SAMPLE, lang: 'typescript' },
})
assert.equal(settle.json.aiStatus, 'running')
await new Promise((resolve) => setTimeout(resolve, 300))
const settled = await call(deferred.route(), { url: API + '/line-notes?hash=' + settle.json.hash })
assert.equal(settled.json.aiStatus, 'done')
assert.equal(settled.json.notes[5], '把这几项按大小排好顺序')
assert.equal(deferredLlm.calls.length, 1)
deferred.dispose()
fs.rmSync(deferredDir, { recursive: true, force: true })

/* ── 3. 没有 LLM 时降级 ─────────────────────────────────────────────── */

const offlineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dce-smoke-off-'))
process.env.DSH_CODE_EXPLAINER_DIR = offlineDir
const offline = createRuntime({ llm: null })
const fallback = await call(offline.route(), {
  method: 'POST',
  url: API + '/line-notes',
  body: { code: SAMPLE, lang: 'typescript' },
})
assert.equal(fallback.statusCode, 200)
assert.ok(fallback.json.notes[0].includes('调用命令行工具，把结果存起来'))
await new Promise((resolve) => setTimeout(resolve, 200))
const offlineState = await call(offline.route(), { url: API + '/line-notes?hash=' + fallback.json.hash })
assert.equal(offlineState.json.aiStatus, 'failed')
// 规则认不出、模型也没补上的调用要明确标「未识别」，不能默默跳过
assert.ok(offlineState.json.notes[5].includes('未识别'))

const offConfig = createRuntime({ llm: fakeLlm(answer), config: { llm: 'off' } })
const offResult = await call(offConfig.route(), {
  method: 'POST',
  url: API + '/line-notes',
  body: { code: SAMPLE, lang: 'typescript' },
})
assert.equal(offResult.json.aiStatus, 'off')
offline.dispose()
offConfig.dispose()

/* ── 4. 清理 ───────────────────────────────────────────────────────── */

fs.rmSync(tempDir, { recursive: true, force: true })
fs.rmSync(offlineDir, { recursive: true, force: true })
console.log('smoke: PASS（逐行规则、凭据掩码、HTTP、AI 补充、缓存、无 LLM 降级、落盘脱敏）')
