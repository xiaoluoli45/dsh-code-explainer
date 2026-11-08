/**
 * dsh-code-explainer — 宿主半身
 *
 * 监听 agent 的工具执行结果，把命令 / 程序 / 文件写入翻译成非程序员能看懂的中文。
 *
 * 数据流：
 *   tools/result（只读观察）
 *     → 本地规则立即生成解释（零成本）
 *     → 首次展开卡片时，可通过 /explain 让当前会话的模型补充一版更通俗的解释
 *     → 结果缓存在内存 + ~/.dsh/dsh-code-explainer/explanations.jsonl
 *
 * 纪律：
 *   · 只观察，不修改工具参数、不阻断执行、不写会话日志
 *   · 不改变用户当前的模型选择；辅助调用只借用路由
 *   · 发给模型的输入、落盘内容、返回给前端的文字都先做凭据掩码
 *   · 任何失败都降级成规则解释，不影响工具本身
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_TOOLS, explainWithRules, redact } from './rules.js'

export const name = 'dsh-code-explainer'

/** 需要宿主 HTTP 服务给浏览器半身开接口 */
export const inject = ['webServer']

const API_PATH = '/dsh-code-explainer/api'
const PLUGIN_VERSION = '0.1.0'
const MAX_BODY = 16 * 1024
const MAX_CALL_IDS = 120
const MAX_RECORDS = 500
const MAX_PERSISTED = 1200
const PERSIST_LIMIT_BYTES = 8 * 1024 * 1024

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /** onExpand：首次展开卡片时才请求 AI；auto：结果落地就请求；off：只用规则 */
  llm: 'onExpand',
  provider: '',
  model: '',
  maxInputChars: 6000,
  maxOutputTokens: 500,
  timeoutMs: 20000,
  concurrency: 2,
  tools: [...DEFAULT_TOOLS],
})

/* ── 小工具 ─────────────────────────────────────────────────────────── */

function str(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function clip(text, max) {
  const value = str(text)
  return value.length <= max ? value : value.slice(0, max) + '…'
}

function intIn(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const llm = raw.llm === 'auto' || raw.llm === 'off' || raw.llm === 'onExpand' ? raw.llm : DEFAULT_CONFIG.llm
  let provider = str(raw.provider).trim()
  let model = str(raw.model).trim()
  // provider 与 model 必须成对出现，否则退回会话路由
  if (!provider || !model) {
    provider = ''
    model = ''
  }
  const tools =
    Array.isArray(raw.tools) && raw.tools.length > 0
      ? raw.tools.map((item) => str(item).trim()).filter(Boolean).slice(0, 30)
      : [...DEFAULT_TOOLS]
  return {
    enabled: raw.enabled !== false,
    llm,
    provider,
    model,
    maxInputChars: intIn(raw.maxInputChars, DEFAULT_CONFIG.maxInputChars, 500, 20000),
    maxOutputTokens: intIn(raw.maxOutputTokens, DEFAULT_CONFIG.maxOutputTokens, 80, 2000),
    timeoutMs: intIn(raw.timeoutMs, DEFAULT_CONFIG.timeoutMs, 3000, 60000),
    concurrency: intIn(raw.concurrency, DEFAULT_CONFIG.concurrency, 1, 4),
    tools,
  }
}

function cleanExplanation(explanation) {
  const source = explanation && typeof explanation === 'object' ? explanation : {}
  const steps = Array.isArray(source.steps) ? source.steps : []
  const risks = Array.isArray(source.risks) ? source.risks : []
  return {
    title: redact(clip(str(source.title), 60)).trim() || '这段代码在干什么',
    purpose: redact(clip(str(source.purpose), 400)).trim(),
    steps: steps
      .slice(0, 6)
      .map((item) => redact(clip(str(item), 160)).trim())
      .filter(Boolean),
    risks: risks
      .slice(0, 6)
      .map((item) => redact(clip(str(item), 160)).trim())
      .filter(Boolean),
  }
}

function sendJson(res, code, payload) {
  try {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    /* 连接已断 */
  }
}

function sameOrigin(req) {
  const host = str(req.headers && req.headers.host)
  if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
  const origin = str(req.headers && req.headers.origin)
  if (!origin) return true
  try {
    const url = new URL(origin)
    return /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(url.hostname)
  } catch {
    return false
  }
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('BODY_TOO_LARGE'), { code: 'BODY_TOO_LARGE' })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw Object.assign(new Error('BODY_NOT_JSON'), { code: 'BODY_NOT_JSON' })
  }
}

function outputText(result) {
  const parts = []
  let total = 0
  const content = result && result.content
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && item.type === 'text' && typeof item.text === 'string') {
        parts.push(clip(item.text, 20000))
        total += item.text.length
        if (total > 20000) break
      }
    }
  }
  if (result && result.error) {
    parts.push(str(result.error.message || result.error))
  }
  return parts.join('\n')
}

function normalizeResult(result) {
  const text = outputText(result)
  const match = text.match(/\[exit code:\s*(-?\d+)\]/i)
  const exitCode = match ? Number(match[1]) : null
  return {
    ok: !(result && result.isError) && (exitCode === null || exitCode === 0),
    exitCode,
    outputExcerpt: redact(clip(text, 1200)),
  }
}

/** 供规则哈希与 AI 提示词使用的“这条调用实际做了什么” */
function argsTextFor(tool, args) {
  const a = args && typeof args === 'object' ? args : {}
  const limit = 6000
  if (tool === 'pwsh' || tool === 'bash' || tool === 'terminal_send') {
    return clip(str(a.command || a.cmd || a.input || a.text || ''), limit)
  }
  if (tool === 'run_code') return clip(str(a.code || a.script || a.command || ''), limit)
  if (tool === 'write') {
    return clip(
      `文件：${str(a.file_path || a.path || '')}\n内容：\n${clip(str(a.content || a.file_text || ''), 5000)}`,
      limit,
    )
  }
  if (tool === 'edit') {
    return clip(
      `文件：${str(a.file_path || a.path || '')}\n旧内容：\n${clip(str(a.old_string || a.old_str || ''), 2500)}\n新内容：\n${clip(str(a.new_string || a.new_str || ''), 2500)}`,
      limit,
    )
  }
  if (tool === 'str_replace_editor') {
    return clip(
      `操作：${str(a.command || '')}\n文件：${str(a.path || '')}\n旧内容：\n${clip(str(a.old_str || ''), 2500)}\n新内容：\n${clip(str(a.new_str || a.file_text || ''), 2500)}`,
      limit,
    )
  }
  try {
    return clip(JSON.stringify(a), limit)
  } catch {
    return ''
  }
}

/* ── 运行时 ─────────────────────────────────────────────────────────── */

class CodeExplainerRuntime {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.records = new Map()
    this.aiCache = new Map()
    this.sessionRoutes = new Map()
    this.fallbackRoute = null
    this.queue = []
    this.active = 0
    this.storeReady = false
    this.storeFailed = false

    const override = str(process.env.DSH_CODE_EXPLAINER_DIR).trim()
    const base = override || path.join(os.homedir(), '.dsh', 'dsh-code-explainer')
    this.storeDir = base
    this.storeFile = path.join(base, 'explanations.jsonl')
  }

  start() {
    this.loadPersisted()
    this.ctx.effect(
      () => {
        const offResult = this.ctx.on('tools/result', (exec, result) => {
          this.onToolResult(exec, result)
        })
        const offSession = this.ctx.on('session/event', (session, event) => {
          this.onSessionEvent(session, event)
        })
        return () => {
          try {
            offResult && offResult()
          } catch {
            /* ignore */
          }
          try {
            offSession && offSession()
          } catch {
            /* ignore */
          }
        }
      },
      'dsh-code-explainer: tool observers',
    )

    this.ctx.effect(
      () =>
        this.ctx.webServer.register({
          kind: 'prefix',
          path: API_PATH,
          handler: (req, res) => {
            if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: '只接受本机回环请求' })
            this.handleHttp(req, res).catch((error) => {
              this.warn('HTTP 处理失败：' + str(error && error.message))
              sendJson(res, 500, { ok: false, error: 'INTERNAL_ERROR' })
            })
          },
        }),
      'dsh-code-explainer: api route',
    )
  }

  warn(message) {
    try {
      this.ctx.logger.warn('[dsh-code-explainer] ' + message)
    } catch {
      /* ignore */
    }
  }

  /* ── 事件 ─────────────────────────────────────────────────────────── */

  onSessionEvent(session, event) {
    try {
      if (!event || event.type !== 'request/header') return
      const config = event.header && event.header.config
      if (!config || typeof config !== 'object') return
      const provider = str(config.provider)
      const model = str(config.model)
      if (!provider || !model) return
      const id = str(session && session.id)
      if (!id) return
      this.sessionRoutes.set(id, { provider, model })
      if (this.sessionRoutes.size > 200) {
        const oldest = this.sessionRoutes.keys().next().value
        if (oldest !== undefined) this.sessionRoutes.delete(oldest)
      }
    } catch (error) {
      this.warn('读取会话模型路由失败：' + str(error && error.message))
    }
  }

  onToolResult(exec, result) {
    try {
      if (!this.config.enabled) return
      if (!exec || typeof exec.callId !== 'string' || !exec.callId) return
      // 只解释根调用；run_code / 子代理里的子调用不重复刷卡片
      if (exec.parent !== undefined) return
      const tool = str(exec.name)
      if (!this.config.tools.includes(tool)) return

      const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
      const normalized = normalizeResult(result)
      const rule = cleanExplanation(
        explainWithRules({ tool, args, result: normalized }),
      )
      const argsText = redact(clip(argsTextFor(tool, args), this.config.maxInputChars))
      const hash = crypto
        .createHash('sha256')
        .update(tool + '\u0000' + argsText + '\u0000' + normalized.outputExcerpt)
        .digest('hex')

      const now = Date.now()
      const record = {
        callId: exec.callId,
        sessionId: str(exec.agent && exec.agent.session && exec.agent.session.id),
        tool,
        argsText,
        outputExcerpt: normalized.outputExcerpt,
        ok: normalized.ok,
        exitCode: normalized.exitCode,
        hash,
        rule,
        ai: null,
        aiStatus: 'idle',
        aiError: '',
        canEnrich: Boolean(this.getLlm()),
        createdAt: now,
        updatedAt: now,
      }
      this.records.set(record.callId, record)
      this.evictRecords()

      if (this.config.llm === 'auto' && record.canEnrich) {
        this.enqueue(() => this.enrich(record)).catch((error) => {
          this.warn('自动 AI 解释失败：' + str(error && error.message))
        })
      }
    } catch (error) {
      this.warn('生成解释失败：' + str(error && error.message))
    }
  }

  evictRecords() {
    while (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value
      if (oldest === undefined) return
      const record = this.records.get(oldest)
      if (record && record.aiStatus === 'running') return
      this.records.delete(oldest)
    }
  }

  /* ── LLM ──────────────────────────────────────────────────────────── */

  getLlm() {
    try {
      return this.ctx.get('llm') || null
    } catch {
      return null
    }
  }

  async resolveRoute(sessionId) {
    const llm = this.getLlm()
    if (!llm || typeof llm.stream !== 'function') return null
    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model }
    }
    const sessionRoute = sessionId ? this.sessionRoutes.get(sessionId) : null
    if (sessionRoute) return sessionRoute
    if (this.fallbackRoute) return this.fallbackRoute
    try {
      const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
      for (const provider of Array.isArray(providers) ? providers : []) {
        const id = str(provider && provider.id)
        if (!id) continue
        const models = await llm.listModels(id)
        const first = Array.isArray(models) ? models.find((model) => model && model.id) : null
        if (first) {
          this.fallbackRoute = { provider: id, model: str(first.id) }
          return this.fallbackRoute
        }
      }
    } catch (error) {
      this.warn('解析模型路由失败：' + str(error && error.message))
    }
    return null
  }

  buildPrompt(record) {
    const status = record.ok
      ? '成功'
      : `没有成功${record.exitCode === null ? '' : `（返回码 ${record.exitCode}）`}`
    return [
      `工具类型：${record.tool}`,
      '这次操作的内容：',
      record.argsText || '（没有可读内容）',
      '',
      `执行结果：${status}`,
      '输出摘要：',
      record.outputExcerpt || '（没有输出）',
    ].join('\n')
  }

  async runLlm(route, prompt) {
    const llm = this.getLlm()
    if (!llm || typeof llm.stream !== 'function') throw new Error('NO_LLM')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      let text = ''
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: this.config.maxOutputTokens,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
          if (text.length > 8000) break
        }
      }
      if (!text.trim()) throw new Error('EMPTY_RESPONSE')
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  parseAi(text) {
    let value = str(text).trim()
    value = value.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    const start = value.indexOf('{')
    const end = value.lastIndexOf('}')
    if (start >= 0 && end > start) value = value.slice(start, end + 1)
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object') {
        return cleanExplanation({
          title: parsed.title,
          purpose: parsed.purpose,
          steps: parsed.steps,
          risks: parsed.risks,
        })
      }
    } catch {
      /* 模型没按 JSON 返回时，退化成一段普通话解释 */
    }
    return cleanExplanation({
      title: '补充解释',
      purpose: text,
      steps: [],
      risks: [],
    })
  }

  async enrich(record) {
    if (!record || !this.config.enabled) return record
    if (record.ai) return record
    if (record.aiStatus === 'running') return record
    if (!record.canEnrich) {
      record.aiStatus = 'failed'
      record.aiError = 'NO_ROUTE'
      return record
    }

    const cached = this.aiCache.get(record.hash)
    if (cached) {
      record.ai = cached
      record.aiStatus = 'done'
      record.aiError = ''
      record.updatedAt = Date.now()
      this.persist(record)
      return record
    }

    record.aiStatus = 'running'
    record.aiError = ''
    record.updatedAt = Date.now()
    try {
      const route = await this.resolveRoute(record.sessionId)
      if (!route) throw new Error('NO_ROUTE')
      const prompt = clip(this.buildPrompt(record), this.config.maxInputChars)
      const text = await this.runLlm(route, prompt)
      const ai = this.parseAi(text)
      record.ai = ai
      record.aiStatus = 'done'
      this.aiCache.set(record.hash, ai)
      this.persist(record)
    } catch (error) {
      record.aiStatus = 'failed'
      record.aiError = clip(redact(str(error && error.message) || 'UNKNOWN'), 120)
      this.warn('AI 解释失败：' + record.aiError)
    }
    record.updatedAt = Date.now()
    return record
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject })
      this.pump()
    })
  }

  pump() {
    while (this.active < this.config.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()
      this.active += 1
      Promise.resolve()
        .then(() => item.task())
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1
          this.pump()
        })
    }
  }

  /* ── 持久化 ───────────────────────────────────────────────────────── */

  ensureStore() {
    if (this.storeReady || this.storeFailed) return this.storeReady
    try {
      fs.mkdirSync(this.storeDir, { recursive: true })
      this.storeReady = true
    } catch (error) {
      this.storeFailed = true
      this.warn('无法创建数据目录，本次只在内存里保留解释：' + str(error && error.message))
    }
    return this.storeReady
  }

  loadPersisted() {
    if (!this.ensureStore()) return
    try {
      if (!fs.existsSync(this.storeFile)) return
      const raw = fs.readFileSync(this.storeFile, 'utf8')
      const lines = raw.split(/\r?\n/)
      const start = Math.max(0, lines.length - MAX_PERSISTED)
      for (let i = start; i < lines.length; i += 1) {
        const line = lines[i].trim()
        if (!line) continue
        try {
          const stored = JSON.parse(line)
          if (!stored || typeof stored.callId !== 'string') continue
          const record = {
            callId: stored.callId,
            sessionId: '',
            tool: str(stored.tool),
            argsText: '',
            outputExcerpt: '',
            ok: stored.ok !== false,
            exitCode: typeof stored.exitCode === 'number' ? stored.exitCode : null,
            hash: str(stored.hash),
            rule: cleanExplanation(stored.rule),
            ai: stored.ai ? cleanExplanation(stored.ai) : null,
            aiStatus: stored.ai ? 'done' : 'idle',
            aiError: '',
            canEnrich: false,
            createdAt: Number(stored.createdAt) || Date.now(),
            updatedAt: Number(stored.updatedAt) || Date.now(),
          }
          this.records.set(record.callId, record)
          if (record.ai && record.hash) this.aiCache.set(record.hash, record.ai)
        } catch {
          /* 单行损坏不影响其它记录 */
        }
      }
      this.evictRecords()
    } catch (error) {
      this.warn('读取历史解释失败：' + str(error && error.message))
    }
  }

  persist(record) {
    if (!record || !record.ai) return
    if (!this.ensureStore()) return
    try {
      const stat = fs.statSync(this.storeFile, { throwIfNoEntry: false })
      if (stat && stat.size > PERSIST_LIMIT_BYTES) {
        fs.renameSync(this.storeFile, this.storeFile + '.1')
      }
    } catch {
      /* 轮转失败不阻断追加 */
    }
    const payload = {
      v: 1,
      callId: record.callId,
      tool: record.tool,
      ok: record.ok,
      exitCode: record.exitCode,
      hash: record.hash,
      rule: record.rule,
      ai: record.ai,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
    try {
      fs.appendFile(this.storeFile, JSON.stringify(payload) + '\n', () => {})
    } catch (error) {
      this.warn('写入解释缓存失败：' + str(error && error.message))
    }
  }

  /* ── HTTP ─────────────────────────────────────────────────────────── */

  publicRecord(record) {
    const chosen = record.ai || record.rule
    return {
      callId: record.callId,
      tool: record.tool,
      title: chosen.title,
      purpose: chosen.purpose,
      steps: chosen.steps,
      risks: chosen.risks,
      source: record.ai ? 'ai' : 'rule',
      aiStatus: record.aiStatus,
      canEnrich: record.canEnrich,
      ok: record.ok,
      exitCode: record.exitCode,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  async handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const route = url.pathname.slice(API_PATH.length) || '/'
    const method = str(req.method).toUpperCase()

    if (route === '/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, version: PLUGIN_VERSION })
    }

    if (route === '/state' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        version: PLUGIN_VERSION,
        enabled: this.config.enabled,
        llm: this.config.llm,
        provider: this.config.provider,
        model: this.config.model,
        records: this.records.size,
        llmAvailable: Boolean(this.getLlm()),
      })
    }

    if (route === '/explanations' && method === 'GET') {
      const raw = str(url.searchParams.get('callIds'))
      const ids = raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item && item.length <= 120)
        .slice(0, MAX_CALL_IDS)
      const items = []
      for (const id of ids) {
        const record = this.records.get(id)
        if (record) items.push(this.publicRecord(record))
      }
      return sendJson(res, 200, { ok: true, items })
    }

    if (route === '/explain' && method === 'POST') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: str(error && error.code) || 'BAD_BODY' })
      }
      const callId = str(body.callId).trim()
      const record = callId ? this.records.get(callId) : null
      if (!record) return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' })
      if (record.ai || record.aiStatus === 'running') {
        return sendJson(res, 200, { ok: true, item: this.publicRecord(record) })
      }
      await this.enrich(record)
      return sendJson(res, 200, { ok: true, item: this.publicRecord(record) })
    }

    return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' })
  }
}

const SYSTEM_PROMPT = [
  '你是一个给完全不懂编程的人解释电脑操作的助手。',
  '你会收到 agent 刚执行的一条命令、程序或文件修改，以及它的执行结果。',
  '请用日常中文解释：它为什么做这件事、关键步骤是什么、有没有需要留意的后果。',
  '要求：',
  '1. 不出现函数名、参数名、正则、stderr 等术语；必须提到时用生活化说法替代。',
  '2. 不要复述原始命令或代码，不要贴代码。',
  '3. 不要评价好坏，不要建议用户下一步做什么。',
  '4. 如果执行失败，用一句话说明“这次没有成功”，不要猜测原因。',
  '5. 只输出一个 JSON 对象，不要 Markdown 代码块：',
  '{"title":"不超过16字的短标题","purpose":"一两句话说明目的","steps":["最多4步，每步一句话"],"risks":["最多4条可能的影响；没有就空数组"]}',
].join('\n')

/* ── 挂载 ───────────────────────────────────────────────────────────── */

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return
  const runtime = new CodeExplainerRuntime(ctx, config)
  runtime.start()
}
