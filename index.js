/**
 * dsh-code-explainer — 宿主半身
 *
 * 把 agent 实际执行的代码块逐行翻译成非程序员能看懂的中文，供浏览器半身写在行尾。
 *
 * 数据流：
 *   client 取出工具卡代码块的纯文本
 *     → POST /line-notes
 *     → 本地规则立即给每行一句（零成本）
 *     → 规则认不出的行，用当前会话的模型补一版（真实模型，失败就保留规则结果）
 *     → 结果缓存在内存 + ~/.dsh/dsh-code-explainer/line-notes.jsonl
 *
 * 纪律：
 *   · 只读代码文本，不修改工具调用、不阻断执行、不写会话日志
 *   · 不改变用户当前的模型选择；辅助调用只借用路由
 *   · 发给模型的输入、落盘内容、返回给前端的文字都先做凭据掩码
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { explainCodeLines, redact, teachCode } from './rules.js'

export const name = 'dsh-code-explainer'

/** 需要宿主 HTTP 服务给浏览器半身开接口 */
export const inject = ['webServer']

const API_PATH = '/dsh-code-explainer/api'
const PLUGIN_VERSION = '0.3.0'
const MAX_BODY = 256 * 1024
const MAX_CODE_CHARS = 20000
const MAX_AI_LINES = 120
const MAX_CACHE = 400
const MAX_PERSISTED = 800
const PERSIST_LIMIT_BYTES = 8 * 1024 * 1024

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /** auto：规则认不出的行自动请模型补；off：只用规则 */
  llm: 'auto',
  provider: '',
  model: '',
  maxInputChars: 8000,
  maxOutputTokens: 900,
  timeoutMs: 25000,
  concurrency: 2,
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
  let provider = str(raw.provider).trim()
  let model = str(raw.model).trim()
  if (!provider || !model) {
    provider = ''
    model = ''
  }
  return {
    enabled: raw.enabled !== false,
    llm: raw.llm === 'off' ? 'off' : 'auto',
    provider,
    model,
    maxInputChars: intIn(raw.maxInputChars, DEFAULT_CONFIG.maxInputChars, 1000, 20000),
    maxOutputTokens: intIn(raw.maxOutputTokens, DEFAULT_CONFIG.maxOutputTokens, 200, 2000),
    timeoutMs: intIn(raw.timeoutMs, DEFAULT_CONFIG.timeoutMs, 5000, 60000),
    concurrency: intIn(raw.concurrency, DEFAULT_CONFIG.concurrency, 1, 4),
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

/** 这一行是否值得解释：空行、纯括号、纯注释跳过 */
function needsNote(line) {
  const trimmed = str(line).trim()
  if (!trimmed) return false
  if (/^(\/\/|#|\/\*|\*|\*\/)/.test(trimmed)) return false
  if (/^[(){}\[\];,]+$/.test(trimmed)) return false
  if (/^\}\s*\)?\s*;?$/.test(trimmed)) return false
  // 读取结果外面包的工具标记（<path>、<content> 之类）不需要逐行解释
  if (/^<\/?[a-z][^>]*>$/i.test(trimmed)) return false
  return true
}

const SYSTEM_PROMPT = [
  '你是一个给完全不懂编程的人解释电脑操作的助手，目标是让他通过注释慢慢学会写代码。',
  '你会收到一段正在被执行的代码，每行前面带行号。',
  '请完成两件事：',
  '1) notes：为指定的行号各写一句日常中文，说明这一行在让电脑做什么。',
  '2) learn：总结这段代码里的通用写法，让人下次遇到同类代码也能看懂。',
  '要求：',
  '- notes 每条不超过 20 个汉字，不出现函数名、参数名、英文术语、正则。',
  '- learn.summary 用一句话概括这段代码；learn.patterns 每项是一条通用写法：',
  '  key 用英文短标识（同一种写法共用一个 key），label 是中文短标签，',
  '  term 是术语原文，zh 是术语第一次出现时的中文对照，why 用一句白话讲为什么这么写。',
  '- 同一种写法只出现一次，不要为每一行重复解释。',
  '- 不要复述代码，不要贴代码，不要评价好坏，不要给建议。',
  '- 只输出一个 JSON 对象，不要 Markdown 代码块，例如：',
  '{"notes":{"3":"列出目录里的文件"},"learn":{"summary":"这段代码调用命令行工具并打印结果。",',
  '"patterns":[{"key":"await","label":"等异步结果","term":"await","zh":"等待异步操作完成",',
  '"why":"await 表示等这一步真的跑完再继续。"}],"terms":[{"term":"await","zh":"等待异步操作完成"}]}}',
].join('\n')

/* ── 运行时 ─────────────────────────────────────────────────────────── */

class LineNoteRuntime {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.entries = new Map()
    this.aiMemory = new Map()
    this.learnMemory = new Map()
    this.lastRoute = null
    this.queue = []
    this.active = 0
    this.storeReady = false
    this.storeFailed = false

    const override = str(process.env.DSH_CODE_EXPLAINER_DIR).trim()
    const base = override || path.join(os.homedir(), '.dsh', 'dsh-code-explainer')
    this.storeDir = base
    this.storeFile = path.join(base, 'line-notes.jsonl')
  }

  start() {
    this.loadPersisted()
    this.ctx.effect(
      () => {
        const off = this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
        return () => {
          try {
            off && off()
          } catch {
            /* ignore */
          }
        }
      },
      'dsh-code-explainer: session route',
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

  onSessionEvent(session, event) {
    try {
      if (!event || event.type !== 'request/header') return
      const config = event.header && event.header.config
      if (!config || typeof config !== 'object') return
      const provider = str(config.provider)
      const model = str(config.model)
      if (!provider || !model) return
      this.lastRoute = { provider, model }
    } catch (error) {
      this.warn('读取会话模型路由失败：' + str(error && error.message))
    }
  }

  /* ── 条目 ─────────────────────────────────────────────────────────── */

  ensureEntry(code, lang) {
    const hash = crypto.createHash('sha256').update(str(lang) + '\u0000' + code).digest('hex').slice(0, 32)
    const existing = this.entries.get(hash)
    if (existing) return existing
    const ruleNotes = explainCodeLines(code, lang)
    const ruleLearn = teachCode(code, lang)
    const entry = {
      hash,
      lang: str(lang),
      lineCount: ruleNotes.length,
      ruleNotes,
      ruleLearn,
      aiNotes: this.aiMemory.get(hash) || null,
      aiLearn: this.learnMemory.get(hash) || null,
      aiStatus: 'off',
      aiError: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    if (entry.aiLearn) entry.aiStatus = 'done'
    else if (entry.aiNotes && ruleLearn.patterns.length > 0) entry.aiStatus = 'done'
    this.entries.set(hash, entry)
    this.evict()
    return entry
  }

  mergedNotes(entry) {
    const out = []
    for (let i = 0; i < entry.lineCount; i += 1) {
      out.push(entry.ruleNotes[i] || (entry.aiNotes && entry.aiNotes[i]) || '')
    }
    return out
  }

  /** 规则给的写法优先；模型只补规则没覆盖到的写法，并去重术语 */
  mergedLearn(entry) {
    const rule = entry.ruleLearn || { summary: '', patterns: [], terms: [] }
    const ai = entry.aiLearn
    const patterns = (rule.patterns || []).map((pattern) => ({ ...pattern }))
    if (ai && Array.isArray(ai.patterns)) {
      const seen = new Set(patterns.map((pattern) => pattern.key))
      for (const raw of ai.patterns) {
        if (!raw || typeof raw !== 'object') continue
        const key = str(raw.key).trim() || str(raw.label).trim()
        if (!key || seen.has(key)) continue
        seen.add(key)
        patterns.push({
          key,
          label: clip(redact(str(raw.label).trim() || key), 24),
          term: clip(redact(str(raw.term).trim() || key), 32),
          zh: clip(redact(str(raw.zh).trim()), 32),
          why: clip(redact(str(raw.why).trim()), 90),
          lines: [],
        })
      }
    }
    const terms = []
    const seenTerms = new Set()
    for (const raw of (rule.terms || []).concat(ai && Array.isArray(ai.terms) ? ai.terms : [])) {
      const term = str(raw && raw.term).trim()
      if (!term || seenTerms.has(term)) continue
      seenTerms.add(term)
      terms.push({ term, zh: clip(redact(str(raw && raw.zh).trim()), 32) })
    }
    return {
      summary: (ai && str(ai.summary).trim()) || rule.summary || '',
      patterns,
      terms,
    }
  }

  /** 规则一个写法都没认出来、但确实有内容可讲时，才值得再花一次模型调用去补 */
  needsLearn(entry, code) {
    if (!entry.ruleLearn || entry.ruleLearn.patterns.length > 0) return false
    return str(code).split(/\r?\n/).some((line) => needsNote(line))
  }

  publicEntry(entry) {
    return {
      ok: true,
      hash: entry.hash,
      notes: this.mergedNotes(entry),
      learn: this.mergedLearn(entry),
      aiStatus: entry.aiStatus,
      aiError: entry.aiError,
      lines: entry.lineCount,
    }
  }

  evict() {
    while (this.entries.size > MAX_CACHE) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) return
      const entry = this.entries.get(oldest)
      if (entry && entry.aiStatus === 'running') return
      this.entries.delete(oldest)
    }
  }

  unresolvedLines(entry, code) {
    const lines = str(code).split(/\r?\n/)
    const out = []
    for (let i = 0; i < entry.lineCount && i < MAX_AI_LINES; i += 1) {
      if (entry.ruleNotes[i]) continue
      if (!needsNote(lines[i])) continue
      out.push(i)
    }
    return out
  }

  /* ── LLM ──────────────────────────────────────────────────────────── */

  getLlm() {
    try {
      return this.ctx.get('llm') || null
    } catch {
      return null
    }
  }

  async resolveRoute() {
    const llm = this.getLlm()
    if (!llm || typeof llm.stream !== 'function') return null
    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model }
    }
    if (this.lastRoute) return this.lastRoute
    try {
      const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
      for (const provider of Array.isArray(providers) ? providers : []) {
        const id = str(provider && provider.id)
        if (!id) continue
        const models = await llm.listModels(id)
        const first = Array.isArray(models) ? models.find((model) => model && model.id) : null
        if (first) return { provider: id, model: str(first.id) }
      }
    } catch (error) {
      this.warn('解析模型路由失败：' + str(error && error.message))
    }
    return null
  }

  buildPrompt(code, indexes) {
    const lines = str(code).split(/\r?\n/)
    const numbered = []
    for (let i = 0; i < lines.length && i < MAX_AI_LINES; i += 1) {
      numbered.push(i + 1 + '| ' + clip(redact(lines[i]), 200))
    }
    const targets = indexes.map((i) => i + 1).join('、')
    return [
      indexes.length > 0 ? '请解释这些行号：' + targets : '这次不需要逐行解释，请重点总结 learn。',
      '同时总结这段代码里的通用写法（learn）。',
      '',
      '代码：',
      numbered.join('\n'),
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
          if (text.length > 12000) break
        }
      }
      if (!text.trim()) throw new Error('EMPTY_RESPONSE')
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  parseJson(text) {
    let value = str(text).trim()
    value = value.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    const start = value.indexOf('{')
    const end = value.lastIndexOf('}')
    if (start >= 0 && end > start) value = value.slice(start, end + 1)
    return JSON.parse(value)
  }

  parseNotes(text, indexes, lineCount) {
    const parsed = this.parseJson(text)
    const source = parsed && typeof parsed === 'object' ? parsed.notes || parsed : {}
    const notes = {}
    for (const [key, raw] of Object.entries(source)) {
      const lineNo = Number(key)
      if (!Number.isFinite(lineNo)) continue
      const index = Math.round(lineNo) - 1
      if (index < 0 || index >= lineCount) continue
      if (!indexes.includes(index)) continue
      const note = clip(redact(str(raw)).trim(), 40)
      if (note) notes[index] = note
    }
    return notes
  }

  /** 模型返回的通用写法；解析失败或为空就返回 null */
  parseLearn(text) {
    const parsed = this.parseJson(text)
    const raw = parsed && typeof parsed === 'object' ? parsed.learn : null
    if (!raw || typeof raw !== 'object') return null
    const patterns = []
    for (const item of Array.isArray(raw.patterns) ? raw.patterns : []) {
      if (!item || typeof item !== 'object') continue
      if (patterns.length >= 10) break
      const key = clip(redact(str(item.key).trim()), 40)
      const label = clip(redact(str(item.label).trim()), 24)
      if (!key && !label) continue
      patterns.push({
        key: key || label,
        label: label || key,
        term: clip(redact(str(item.term).trim() || key), 32),
        zh: clip(redact(str(item.zh).trim()), 32),
        why: clip(redact(str(item.why).trim()), 90),
      })
    }
    const terms = []
    for (const item of Array.isArray(raw.terms) ? raw.terms : []) {
      if (!item || typeof item !== 'object') continue
      if (terms.length >= 12) break
      const term = clip(redact(str(item.term).trim()), 32)
      const zh = clip(redact(str(item.zh).trim()), 32)
      if (!term || !zh) continue
      terms.push({ term, zh })
    }
    const summary = clip(redact(str(raw.summary).trim()), 120)
    if (!summary && patterns.length === 0 && terms.length === 0) return null
    return { summary, patterns, terms }
  }

  async enrich(entry, code) {
    if (!entry) return entry
    const indexes = this.unresolvedLines(entry, code)
    const needLearn = this.needsLearn(entry, code) && !entry.aiLearn
    if (indexes.length === 0 && !needLearn) {
      entry.aiStatus = 'done'
      return entry
    }
    if (entry.aiNotes && !needLearn) return entry
    entry.aiStatus = 'running'
    entry.aiError = ''
    entry.updatedAt = Date.now()
    try {
      const route = await this.resolveRoute()
      if (!route) throw new Error('NO_ROUTE')
      const prompt = clip(this.buildPrompt(code, indexes), this.config.maxInputChars)
      const text = await this.runLlm(route, prompt)
      const notes = indexes.length > 0 ? this.parseNotes(text, indexes, entry.lineCount) : {}
      const learn = this.parseLearn(text)
      const gotNotes = Object.keys(notes).length > 0
      if (!gotNotes && !learn) throw new Error('NO_NOTES_PARSED')
      if (gotNotes) {
        entry.aiNotes = notes
        this.aiMemory.set(entry.hash, notes)
      }
      if (learn) {
        entry.aiLearn = learn
        this.learnMemory.set(entry.hash, learn)
      }
      entry.aiStatus = 'done'
      this.persist(entry, code)
    } catch (error) {
      entry.aiStatus = 'failed'
      entry.aiError = clip(redact(str(error && error.message) || 'UNKNOWN'), 120)
      this.warn('AI 逐行补充失败：' + entry.aiError)
    }
    entry.updatedAt = Date.now()
    return entry
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
          if (!stored || typeof stored.hash !== 'string') continue
          if (stored.aiNotes) this.aiMemory.set(stored.hash, stored.aiNotes)
          if (stored.aiLearn) this.learnMemory.set(stored.hash, stored.aiLearn)
        } catch {
          /* 单行损坏不影响其它记录 */
        }
      }
    } catch (error) {
      this.warn('读取历史逐行解释失败：' + str(error && error.message))
    }
  }

  persist(entry, code) {
    if (!entry || (!entry.aiNotes && !entry.aiLearn)) return
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
      hash: entry.hash,
      lang: entry.lang,
      lines: entry.lineCount,
      codeSample: clip(redact(str(code).split(/\r?\n/).slice(0, 6).join('\n')), 600),
      aiNotes: entry.aiNotes,
      aiLearn: entry.aiLearn,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }
    try {
      fs.appendFile(this.storeFile, JSON.stringify(payload) + '\n', () => {})
    } catch (error) {
      this.warn('写入逐行解释缓存失败：' + str(error && error.message))
    }
  }

  /* ── HTTP ─────────────────────────────────────────────────────────── */

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
        cache: this.entries.size,
        llmAvailable: Boolean(this.getLlm()),
      })
    }

    if (route === '/line-notes' && method === 'POST') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: str(error && error.code) || 'BAD_BODY' })
      }
      const code = clip(str(body.code), MAX_CODE_CHARS)
      const lang = clip(str(body.lang), 40)
      if (!code.trim()) return sendJson(res, 400, { ok: false, error: 'EMPTY_CODE' })
      // 工具卡还在跑的时候前端只取规则结果，别让半截代码也去烧模型
      const allowAi = body.ai !== false
      const entry = this.ensureEntry(code, lang)
      if (allowAi && this.config.llm === 'auto' && entry.aiStatus === 'off') {
        const indexes = this.unresolvedLines(entry, code)
        if (indexes.length > 0 || this.needsLearn(entry, code)) {
          entry.aiStatus = 'running'
          entry.updatedAt = Date.now()
          this.enqueue(() => this.enrich(entry, code)).catch((error) => {
            this.warn('AI 逐行补充失败：' + str(error && error.message))
          })
        } else {
          entry.aiStatus = 'done'
        }
      } else if (this.config.llm === 'off' && entry.aiStatus === 'off') {
        entry.aiStatus = 'off'
      }
      return sendJson(res, 200, this.publicEntry(entry))
    }

    if (route === '/line-notes' && method === 'GET') {
      const hash = str(url.searchParams.get('hash')).trim()
      const entry = hash ? this.entries.get(hash) : null
      if (!entry) return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' })
      return sendJson(res, 200, this.publicEntry(entry))
    }

    return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' })
  }
}

/* ── 挂载 ───────────────────────────────────────────────────────────── */

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return
  const runtime = new LineNoteRuntime(ctx, config)
  runtime.start()
}
