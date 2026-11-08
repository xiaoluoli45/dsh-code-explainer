/**
 * dsh-code-explainer — 浏览器半身
 *
 * 把工具卡里代码块的每一行翻译成一句话，写在行尾（注释样式，灰色）：
 *
 *   const r = await tools.ops_bash({      // 调用命令行工具，把结果存起来
 *     command: "Get-ChildItem ...",        // 列出文件夹里有哪些文件
 *
 * 为什么这样做：
 *   · 说明只挂在 CSS ::after 上，不往 <pre> 里塞文本节点，所以复制得到的仍是原始代码；
 *   · 不替换、不重排宿主的高亮 DOM，语法高亮、行号、换行开关都保持原样；
 *   · 代码块底部再挂一条默认收起的「为什么这么写」，讲通用写法与术语，
 *     展开内容同样不进 <pre>，不影响复制和选中；
 *   · 顶部保留一个全局开关「注释：开/关」，一键回到纯代码视图（状态存在 localStorage）。
 *
 * 宿主契约：window.__ModuleLoader__.load({ id, factory }) + exports.inject / apply(ctx)
 */

window.__ModuleLoader__.load({
  id: 'dsh-code-explainer',
  factory: function () {
    var module = { exports: {} }
    var exports = module.exports

    var API = '/dsh-code-explainer/api'
    var STYLE_ID = 'dce-line-style'
    var STORE_KEY = 'dce-line-notes'
    var ATTR_NOTE = 'data-dce-note'
    var ATTR_ONOTE = 'data-dce-onote'
    var ATTR_HASH = 'data-dce-hash'
    var ATTR_MODE = 'data-dce-mode'
    var ATTR_LEARN = 'data-dce-learn'

    var notesCache = Object.create(null)
    var inflight = Object.create(null)
    var observer = null
    var scanTimer = null
    var safetyTimer = null
    var disposed = false
    var termOwner = Object.create(null)

    /* ── 样式 ───────────────────────────────────────────────────────── */

    var CSS = [
      // 输入代码的行尾注释：灰色、注释感
      ':root.dce-notes-on .md-code-block .line[data-dce-note]::after{',
      'content:"  // " attr(data-dce-note);',
      'color:var(--dsw-alias-label-tertiary,#8b8f96);',
      'opacity:.92;font-style:normal;font-weight:400;',
      'user-select:none;-webkit-user-select:none;pointer-events:none;',
      '}',
      // 输出代码的行尾注释：换一种颜色和箭头，和输入区分开
      ':root.dce-notes-on .md-code-block .line[data-dce-onote]::after{',
      'content:"  → " attr(data-dce-onote);',
      'color:var(--dsw-alias-label-secondary,#6b93d6);',
      'opacity:.95;font-style:normal;font-weight:400;',
      'user-select:none;-webkit-user-select:none;pointer-events:none;',
      '}',
      // 长行：把注释放到下一行，避免被横向滚动裁掉，也不把版面撑宽
      ':root.dce-notes-on .md-code-block .line[data-dce-long="1"][data-dce-note]::after{',
      'content:"// " attr(data-dce-note);display:block;margin-top:1px;padding-left:2ch;',
      'white-space:normal;line-height:1.45}',
      ':root.dce-notes-on .md-code-block .line[data-dce-long="1"][data-dce-onote]::after{',
      'content:"→ " attr(data-dce-onote);display:block;margin-top:1px;padding-left:2ch;',
      'white-space:normal;line-height:1.45}',
      // 输出文本按行拆成的 span：原样保留文字和换行，说明只走伪元素
      ':root.dce-notes-on .dce-ol[data-dce-onote]::after{',
      'content:"  → " attr(data-dce-onote);',
      'color:var(--dsw-alias-label-secondary,#6b93d6);',
      'opacity:.95;font-style:normal;',
      'user-select:none;-webkit-user-select:none;pointer-events:none;',
      '}',
      ':root.dce-notes-on .dce-ol[data-dce-long="1"][data-dce-onote]::after{',
      'content:"→ " attr(data-dce-onote);display:block;margin-top:1px;padding-left:2ch;',
      'white-space:normal;line-height:1.45}',
      // 输出块首的一句总述：关掉开关时整块隐藏，回到纯代码视图
      '.dce-io-head{display:none;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-secondary,#5d7fb5)}',
      ':root.dce-notes-on .dce-io-head{display:block;margin:2px 0 4px;padding:3px 8px;',
      'border-left:2px solid rgba(107,147,214,.55);background:rgba(107,147,214,.08);border-radius:3px}',
      // 可展开的教学层：默认收起，只留一行「为什么这么写」
      '.dce-learn{display:none;margin:4px 0 2px;padding-top:4px;',
      'border-top:1px dashed rgba(128,128,128,.25);font-size:12px;line-height:18px}',
      ':root.dce-notes-on .dce-learn{display:block}',
      '.dce-learn-btn{appearance:none;border:0;border-radius:3px;background:transparent;',
      'color:var(--dsw-alias-label-tertiary,#8b8f96);font-size:11px;line-height:18px;',
      'padding:0 4px;cursor:pointer;white-space:nowrap}',
      '.dce-learn-btn:hover{background:rgba(128,128,128,.14)}',
      '.dce-learn-btn:focus-visible{outline:1px solid currentColor;outline-offset:2px}',
      '.dce-learn[data-mode="out"] .dce-learn-btn{color:var(--dsw-alias-label-secondary,#6b93d6)}',
      '.dce-learn-body{display:none;margin:4px 0 2px;padding:6px 8px;border-radius:3px;',
      'border-left:2px solid rgba(128,128,128,.42);background:rgba(128,128,128,.07)}',
      '.dce-learn[data-mode="out"] .dce-learn-body{border-left-color:rgba(107,147,214,.55);',
      'background:rgba(107,147,214,.07)}',
      '.dce-learn[data-open="1"] .dce-learn-body{display:block}',
      '.dce-learn-sum{margin:0 0 4px;font-weight:500;color:var(--dsw-alias-label-secondary,#4d5561)}',
      '.dce-learn-list{margin:0;padding-left:16px}',
      '.dce-learn-list li{margin:0 0 5px}',
      '.dce-learn-label{font-weight:600;color:var(--dsw-alias-label-primary,#2f3540)}',
      '.dce-learn-zh{margin-left:5px;color:var(--dsw-alias-label-tertiary,#8b8f96)}',
      '.dce-learn-why{margin:1px 0 0;color:var(--dsw-alias-label-secondary,#4d5561)}',
      '.dce-learn-lines{margin:1px 0 0;color:var(--dsw-alias-label-tertiary,#8b8f96);',
      'font-style:normal;font-size:11px}',
      '.dce-learn-terms{margin:4px 0 0;color:var(--dsw-alias-label-tertiary,#8b8f96)}',
      // 顶部开关：小而低调，插在语言标签/复制按钮那一行
      '.dce-toggle{appearance:none;border:0;border-radius:4px;background:transparent;',
      'color:var(--dsw-alias-label-tertiary,#8b8f96);font-size:11px;line-height:18px;',
      'padding:0 6px;margin-inline-end:4px;cursor:pointer;white-space:nowrap;opacity:.75}',
      '.dce-toggle:hover{background:rgba(128,128,128,.14);opacity:1}',
      '.dce-toggle:focus-visible{outline:1px solid currentColor;outline-offset:2px}',
    ].join('')

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      ;(document.head || document.documentElement).appendChild(style)
    }

    /* ── 开关 ───────────────────────────────────────────────────────── */

    function isOn() {
      try {
        return localStorage.getItem(STORE_KEY) !== 'off'
      } catch {
        return true
      }
    }

    function applyMode() {
      var on = isOn()
      document.documentElement.classList.toggle('dce-notes-on', on)
      var buttons = document.querySelectorAll('.dce-toggle')
      for (var i = 0; i < buttons.length; i += 1) {
        buttons[i].textContent = on ? '注释：开' : '注释：关'
        buttons[i].setAttribute('aria-pressed', String(on))
        buttons[i].title = on ? '点一下隐藏所有行尾注释' : '点一下显示行尾注释'
      }
    }

    function toggle() {
      try {
        localStorage.setItem(STORE_KEY, isOn() ? 'off' : 'on')
      } catch {
        /* 隐私模式下存不了就只在本次生效 */
      }
      applyMode()
    }

    /* ── 工具函数 ───────────────────────────────────────────────────── */

    function hashOf(text) {
      var h1 = 0x811c9dc5
      var h2 = 0x01000193
      for (var i = 0; i < text.length; i += 1) {
        var c = text.charCodeAt(i)
        h1 = (h1 ^ c) * 0x01000193
        h2 = (h2 + c * (i + 1)) >>> 0
      }
      return (h1 >>> 0).toString(16) + '-' + text.length.toString(16) + '-' + h2.toString(16)
    }

    function lineNodes(block) {
      var code = block.querySelector('pre > code')
      if (!code) return []
      var out = []
      for (var i = 0; i < code.children.length; i += 1) {
        var child = code.children[i]
        if (child.tagName === 'SPAN' && child.classList.contains('line')) out.push(child)
      }
      return out
    }

    function langOf(block) {
      var banner = block.querySelector('[data-code-block-banner]')
      if (!banner) return ''
      var first = banner.querySelector('span')
      var text = first && first.textContent ? first.textContent.trim() : ''
      return /^[a-z0-9+#._-]{1,24}$/i.test(text) ? text : ''
    }

    /* ── 注入 ───────────────────────────────────────────────────────── */

    function ensureToggle(block) {
      var banner = block.querySelector('[data-code-block-banner]')
      if (!banner) return
      if (banner.querySelector('.dce-toggle')) return
      var actions = banner.lastElementChild
      if (!actions || actions === banner.firstElementChild) return
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'dce-toggle'
      button.textContent = isOn() ? '注释：开' : '注释：关'
      button.setAttribute('aria-pressed', String(isOn()))
      button.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        toggle()
      })
      button.addEventListener('mousedown', function (event) {
        event.stopPropagation()
      })
      actions.insertBefore(button, actions.firstChild)
    }

    function applyNotes(hash, entry) {
      var blocks = document.querySelectorAll('[' + ATTR_HASH + '="' + hash + '"]')
      for (var b = 0; b < blocks.length; b += 1) {
        var block = blocks[b]
        var attr = block.getAttribute(ATTR_MODE) === 'out' ? ATTR_ONOTE : ATTR_NOTE
        var lines = lineNodes(block)
        if (lines.length === 0) lines = block.querySelectorAll('.dce-ol')
        // 用可见宽度估算一行能放多少字符；长行把注释放到下一行，避免被横向裁掉
        var container = block.querySelector('pre') || block
        var avail = container && container.clientWidth ? container.clientWidth : 0
        var capacity = avail > 0 ? Math.max(16, Math.floor(avail / 7.2)) : 0
        for (var i = 0; i < lines.length; i += 1) {
          var note = entry.notes && entry.notes[i]
          if (note) {
            if (lines[i].getAttribute(attr) !== note) lines[i].setAttribute(attr, note)
            var long = capacity > 0 && String(lines[i].textContent || '').length + note.length + 4 > capacity
            var flag = long ? '1' : '0'
            if (lines[i].getAttribute('data-dce-long') !== flag) lines[i].setAttribute('data-dce-long', flag)
          } else {
            if (lines[i].hasAttribute(attr)) lines[i].removeAttribute(attr)
            if (lines[i].hasAttribute('data-dce-long')) lines[i].removeAttribute('data-dce-long')
          }
        }
      }
      applyLearn(hash, entry)
    }

    /* ── 教学层：可展开的「为什么这么写」 ───────────────────────────── */

    function hasLearn(learn) {
      if (!learn) return false
      return Boolean(
        (learn.patterns && learn.patterns.length) ||
          learn.summary ||
          (learn.terms && learn.terms.length),
      )
    }

    /** 同一个术语只由第一处代码解释，后续代码块只提示「前面讲过」；同一个 hash 重渲染不重复计数 */
    function claimTerm(key, owner) {
      if (!key) return false
      if (termOwner[key] === undefined) {
        termOwner[key] = owner
        return true
      }
      return termOwner[key] === owner
    }

    function makeLearnStrip(mode, owner) {
      var strip = document.createElement('div')
      strip.className = 'dce-learn'
      strip.setAttribute('data-mode', mode)
      strip.setAttribute(ATTR_LEARN, mode)
      strip.setAttribute('data-open', '0')
      strip.__dceOwner = owner
      var baseText = mode === 'out' ? '输出为什么这么写' : '为什么这么写'
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'dce-learn-btn'
      button.textContent = baseText + ' ▸'
      button.setAttribute('aria-expanded', 'false')
      button.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        var open = strip.getAttribute('data-open') === '1'
        strip.setAttribute('data-open', open ? '0' : '1')
        button.textContent = baseText + (open ? ' ▸' : ' ▾')
        button.setAttribute('aria-expanded', String(!open))
      })
      button.addEventListener('mousedown', function (event) {
        event.stopPropagation()
      })
      var body = document.createElement('div')
      body.className = 'dce-learn-body'
      strip.appendChild(button)
      strip.appendChild(body)
      return strip
    }

    function renderLearn(strip, learn) {
      var signature = ''
      try {
        signature = JSON.stringify(learn)
      } catch {
        signature = ''
      }
      if (strip.__dceSignature === signature) return
      strip.__dceSignature = signature

      var body = strip.querySelector('.dce-learn-body')
      if (!body) return
      var fragment = document.createDocumentFragment()
      var owner = strip.__dceOwner
      var summary = String(learn.summary || '')
      if (summary) {
        var head = document.createElement('p')
        head.className = 'dce-learn-sum'
        head.textContent = summary
        fragment.appendChild(head)
      }

      var patternTerms = Object.create(null)
      var patterns = Array.isArray(learn.patterns) ? learn.patterns.slice(0, 10) : []
      if (patterns.length > 0) {
        var list = document.createElement('ul')
        list.className = 'dce-learn-list'
        for (var i = 0; i < patterns.length; i += 1) {
          var pattern = patterns[i] || {}
          var key = String(pattern.key || pattern.term || pattern.label || '')
          if (!key) continue
          var term = String(pattern.term || '')
          var zh = String(pattern.zh || '')
          var why = String(pattern.why || '')
          if (term) patternTerms[term] = true

          var item = document.createElement('li')
          var label = document.createElement('span')
          label.className = 'dce-learn-label'
          label.textContent = String(pattern.label || key)
          item.appendChild(label)

          if (zh) {
            var first = claimTerm(key, owner)
            var gloss = document.createElement('span')
            gloss.className = 'dce-learn-zh'
            gloss.textContent = first ? (term ? term + '（' + zh + '）' : zh) : '同一写法，前面讲过'
            item.appendChild(gloss)
          }
          if (why) {
            var whyEl = document.createElement('p')
            whyEl.className = 'dce-learn-why'
            whyEl.textContent = why
            item.appendChild(whyEl)
          }
          var lines = Array.isArray(pattern.lines) ? pattern.lines : []
          if (lines.length > 0) {
            var lineEl = document.createElement('em')
            lineEl.className = 'dce-learn-lines'
            lineEl.textContent =
              lines.length > 1
                ? '同一个模式，出现 ' + lines.length + ' 次（第 ' + lines.slice(0, 8).join('、') + ' 行）'
                : '第 ' + lines[0] + ' 行'
            item.appendChild(lineEl)
          }
          list.appendChild(item)
        }
        if (list.children.length > 0) fragment.appendChild(list)
      }

      var terms = Array.isArray(learn.terms) ? learn.terms.slice(0, 12) : []
      var extra = []
      for (var t = 0; t < terms.length; t += 1) {
        var termText = String((terms[t] && terms[t].term) || '')
        if (!termText || patternTerms[termText]) continue
        if (!claimTerm(termText, owner)) continue
        var zhText = String((terms[t] && terms[t].zh) || '')
        extra.push(zhText ? termText + '（' + zhText + '）' : termText)
      }
      if (extra.length > 0) {
        var termsEl = document.createElement('p')
        termsEl.className = 'dce-learn-terms'
        termsEl.textContent = '术语：' + extra.join('、')
        fragment.appendChild(termsEl)
      }
      body.replaceChildren(fragment)
    }

    function ensureLearn(target, mode, learn) {
      var strip = target.__dceLearn
      if (strip && !strip.isConnected) strip = null
      if (!hasLearn(learn)) {
        if (strip && strip.parentNode) strip.parentNode.removeChild(strip)
        target.__dceLearn = null
        return
      }
      if (!strip) {
        strip = makeLearnStrip(mode, target.getAttribute(ATTR_HASH) || mode)
        // 放在代码块/输出文本外面，避免挤占代码块自身的高度
        var parent = target.parentElement
        if (!parent) return
        parent.insertBefore(strip, target.nextSibling)
        target.__dceLearn = strip
      }
      renderLearn(strip, learn)
    }

    function applyLearn(hash, entry) {
      if (!entry || !entry.learn) return
      var targets = document.querySelectorAll('[' + ATTR_HASH + '="' + hash + '"]')
      for (var i = 0; i < targets.length; i += 1) {
        var target = targets[i]
        var mode = target.getAttribute(ATTR_MODE) === 'out' ? 'out' : 'in'
        ensureLearn(target, mode, entry.learn)
      }
    }

    /** 本地 hash 只用来找 DOM，宿主返回的 hash 用来轮询 AI 结果 */
    function poll(localHash, serverHash, attempt) {
      if (disposed || attempt >= 8) return
      setTimeout(function () {
        if (disposed) return
        fetch(API + '/line-notes?hash=' + encodeURIComponent(serverHash))
          .then(function (response) {
            return response.json()
          })
          .then(function (data) {
            if (!data || !data.ok) return
            var previous = notesCache[localHash] || {}
            var entry = {
              notes: Array.isArray(data.notes) ? data.notes : previous.notes,
              learn: data.learn || previous.learn,
              aiStatus: data.aiStatus || 'done',
              serverHash: serverHash,
            }
            notesCache[localHash] = entry
            applyNotes(localHash, entry)
            if (entry.aiStatus === 'running') poll(localHash, serverHash, attempt + 1)
          })
          .catch(function () {
            /* 轮询失败就保留规则结果，下一轮扫描会重试 */
          })
      }, 1500)
    }

    /**
     * @param {string} source 代码原文
     * @param {string} lang 语言标签
     * @param {boolean} allowAi 工具卡已结束时才允许请模型补行
     */
    function ensureNotes(source, lang, allowAi) {
      var hash = hashOf(source)
      var cached = notesCache[hash]
      if (cached && !(allowAi && cached.aiStatus === 'off' && cached.serverHash)) {
        applyNotes(hash, cached)
        if (cached.aiStatus === 'running' && cached.serverHash) poll(hash, cached.serverHash, 0)
        return
      }
      if (inflight[hash]) return
      inflight[hash] = true
      fetch(API + '/line-notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: source, lang: lang, ai: allowAi !== false }),
      })
        .then(function (response) {
          return response.json()
        })
        .then(function (data) {
          delete inflight[hash]
          if (!data || !data.ok || !Array.isArray(data.notes)) return
          var entry = {
            notes: data.notes,
            learn: data.learn || null,
            aiStatus: data.aiStatus || 'done',
            serverHash: data.hash || '',
          }
          notesCache[hash] = entry
          applyNotes(hash, entry)
          if (entry.aiStatus === 'running' && entry.serverHash) poll(hash, entry.serverHash, 0)
        })
        .catch(function () {
          delete inflight[hash]
        })
    }

    /** 工具卡是否已经跑完：跑的过程中不给模型加活 */
    function isSettled(el) {
      var card = el.closest('[data-state]')
      if (!card) return true
      var state = String(card.getAttribute('data-state') || '')
      return state !== 'running' && state !== 'pending' && state !== ''
    }

    function annotateBlock(block, isOutput) {
      if (!block.isConnected) return
      var lines = lineNodes(block)
      if (lines.length === 0) return
      if (!isOutput) ensureToggle(block)

      var parts = []
      for (var i = 0; i < lines.length; i += 1) parts.push(lines[i].textContent)
      var source = parts.join('\n')
      if (!source.trim()) return

      block.setAttribute(ATTR_MODE, isOutput ? 'out' : 'in')
      block.setAttribute(ATTR_HASH, hashOf(source))
      ensureNotes(source, langOf(block), isSettled(block))
    }

    /* ── 输出区 ─────────────────────────────────────────────────────── */

    var CODE_EXT = /^(js|mjs|cjs|ts|tsx|jsx|py|ps1|sh|bash|bat|cmd|css|scss|html|vue|go|rs|java|c|h|cpp|cs|php|rb|kt|swift|lua|sql|yml|yaml|toml|ini|conf|xml)$/i

    var DATA_KEY_RULES = [
      [/^\s*"exitCode"\s*:/, '退出码，0 表示成功'],
      [/^\s*"(status|state)"\s*:/, '这次执行的状态'],
      [/^\s*"stdout"\s*:/, '正常输出'],
      [/^\s*"stderr"\s*:/, '错误输出'],
      [/^\s*"timedOut"\s*:/, '是否超时'],
      [/^\s*"durationMs"\s*:/, '这次执行花了多久'],
      [/^\s*"text"\s*:/, '具体内容'],
      [/^\s*"(count|total|size)"\s*:/, '数量或大小合计'],
    ]

    var KEY_LINE_RULES = [
      [/command not found|is not recognized as/i, '系统找不到这个命令'],
      [/no such file|does not exist|cannot find/i, '找不到这个文件或目录'],
      [/permission denied|access is denied|拒绝访问/i, '没有权限'],
      [/\b(FATAL|SEVERE)\b/, '这里出了严重错误'],
      [/\bERROR\b|\berror:/i, '这里报错了'],
      [/\bWARN(ING)?\b/i, '这里是一条警告'],
      [/^total\s+\d+/i, '下面是文件清单'],
      [/^[-dl][rwx-]{9}/, '这里是文件权限和名称'],
      [/\bexit\s*code\s*[:=]\s*\d+/i, '这里是退出码'],
    ]

    function toolOf(el) {
      var card = el.closest('[data-tool]')
      return card ? String(card.getAttribute('data-tool') || '') : ''
    }

    /** 这张卡里同一个 ioText 结构既用于「输入」也用于「输出」，只处理输出那一段 */
    function isOutputSection(el) {
      var section = el.closest('[class*="ioSection"]') || el.parentElement
      if (!section) return false
      var label = section.querySelector('[class*="ioLabel"]')
      if (!label) return true
      var text = String(label.textContent || '').trim()
      if (!text) return true
      if (/输入|input/i.test(text)) return false
      return /输出|output|结果|result/i.test(text)
    }

    function pathOf(raw) {
      var match = raw.match(/<path>([^<]{1,400})<\/path>/)
      return match ? match[1].trim() : ''
    }

    function extOf(file) {
      var clean = String(file).split(/[?#]/)[0]
      var index = clean.lastIndexOf('.')
      return index >= 0 ? clean.slice(index + 1).toLowerCase() : ''
    }

    function looksLikeCode(lines) {
      var checked = 0
      var hits = 0
      for (var i = 0; i < lines.length && i < 60; i += 1) {
        var text = lines[i].replace(/^\s*\d+:\s?/, '').trim()
        if (!text) continue
        checked += 1
        var codeStart = /^(\/\/|#include|#!|\/\*|\*|import\s|export\s|const\s|let\s|var\s|function\s|class\s|async\s|await\s|if\s*\(|for\s*\(|while\s*\(|return\b|def\s|from\s|package\s|using\s|public\s|private\s|@\w+)/.test(text)
        var codeEnd = /[;{}]\s*$/.test(text) && /[=()]/.test(text)
        if (codeStart || codeEnd) hits += 1
      }
      return checked >= 3 && hits / checked >= 0.5
    }

    function stripNumbering(lines) {
      var checked = 0
      var numbered = 0
      for (var i = 0; i < lines.length; i += 1) {
        if (!lines[i].trim()) continue
        checked += 1
        if (/^\s*\d+:\s?/.test(lines[i])) numbered += 1
      }
      if (checked === 0 || numbered < checked * 0.6) return lines
      return lines.map(function (line) {
        return line.replace(/^\s*\d+:\s?/, '')
      })
    }

    function classifyOutput(raw, tool) {
      var wrapped = raw.match(/<content>([\s\S]*)<\/content>/)
      var body = wrapped ? wrapped[1] : raw
      var file = pathOf(raw)
      var ext = extOf(file)
      var trimmed = body.trim()

      if (/^[\[{]/.test(trimmed)) {
        try {
          var json = JSON.parse(trimmed)
          return { kind: 'data', body: body, path: file, json: json }
        } catch {
          /* 不是完整 JSON，继续按代码/文本判断 */
        }
      }
      if (CODE_EXT.test(ext)) return { kind: 'code', body: body, path: file, lang: ext }
      if (looksLikeCode(body.split(/\r?\n/))) return { kind: 'code', body: body, path: file, lang: ext }
      var lines = body.split(/\r?\n/)
      if (lines.length > 2 && /^(total\s+\d+|[-dl][rwx-]{9})/.test(lines[0].trim())) {
        return { kind: 'listing', body: body, path: file }
      }
      if (/(^|\n)\s*(ERROR|WARN|INFO|DEBUG|TRACE|FATAL)\b/.test(body)) {
        return { kind: 'log', body: body, path: file }
      }
      return { kind: 'text', body: body, path: file, tool: tool }
    }

    function summaryFor(info, tool) {
      if (info.kind === 'data') {
        var exitCode = info.json && typeof info.json === 'object' && !Array.isArray(info.json) ? info.json.exitCode : undefined
        if (typeof exitCode === 'number') {
          return '这段输出是执行结果：退出码 ' + exitCode + (exitCode === 0 ? '（成功）' : '（失败）')
        }
        return '这段输出是工具返回的数据'
      }
      if (info.kind === 'code') {
        return tool === 'read' ? '这段输出是读到的代码文件内容' : '这段输出是代码内容'
      }
      if (info.kind === 'listing') return '这段输出是目录里的文件清单'
      if (info.kind === 'log') return '这段输出是程序运行日志'
      return tool === 'read' ? '这段输出是读到的文件内容' : '这段输出是工具返回的文字'
    }

    function ensureIoHead(card, textEl, text) {
      var section = textEl.parentElement || card
      var existing = section.querySelector('.dce-io-head')
      if (existing) {
        if (existing.textContent !== text) existing.textContent = text
        return
      }
      var head = document.createElement('div')
      head.className = 'dce-io-head'
      head.textContent = text
      section.insertBefore(head, textEl)
    }

    function wrapLines(textEl) {
      var existing = textEl.querySelectorAll('.dce-ol')
      if (existing.length > 0) return existing
      if (textEl.children.length > 0) return null
      var raw = textEl.textContent || ''
      if (!raw) return null
      var lines = raw.split('\n')
      var fragment = document.createDocumentFragment()
      var spans = []
      for (var i = 0; i < lines.length; i += 1) {
        var span = document.createElement('span')
        span.className = 'dce-ol'
        span.textContent = lines[i]
        fragment.appendChild(span)
        spans.push(span)
        if (i < lines.length - 1) fragment.appendChild(document.createTextNode('\n'))
      }
      textEl.replaceChildren(fragment)
      return spans
    }

    function applyKeyNotes(spans, kind) {
      var rules = kind === 'data' ? DATA_KEY_RULES : KEY_LINE_RULES
      var used = 0
      for (var i = 0; i < spans.length && used < 6; i += 1) {
        var text = spans[i].textContent || ''
        if (!text.trim()) continue
        for (var r = 0; r < rules.length; r += 1) {
          if (rules[r][0].test(text)) {
            spans[i].setAttribute(ATTR_ONOTE, rules[r][1])
            used += 1
            break
          }
        }
      }
    }

    function annotateOutputText(textEl) {
      if (!textEl.isConnected) return
      if (!isOutputSection(textEl)) return
      var raw = textEl.textContent || ''
      if (!raw.trim()) return
      var card = textEl.closest('[class*="ioCard"]') || textEl.parentElement
      if (!card) return
      var tool = toolOf(textEl)
      var info = classifyOutput(raw, tool)
      ensureIoHead(card, textEl, summaryFor(info, tool))

      var spans = wrapLines(textEl)
      if (!spans) return
      if (info.kind === 'code') {
        // 用整段原始输出的逐行文本发给宿主：去掉行号但保留行数，
        // 这样第 i 条说明永远对应第 i 个行节点，不会错位。
        var source = stripNumbering(raw.split(/\r?\n/)).join('\n')
        if (!source.trim()) return
        textEl.setAttribute(ATTR_MODE, 'out')
        textEl.setAttribute(ATTR_HASH, hashOf(source))
        ensureNotes(source, info.lang || '', isSettled(textEl))
        return
      }
      applyKeyNotes(spans, info.kind)
    }

    /* ── 扫描 ───────────────────────────────────────────────────────── */

    function scan() {
      if (disposed) return
      var blocks = document.querySelectorAll('[data-chat-call-id] .md-code-block')
      for (var i = 0; i < blocks.length; i += 1) {
        try {
          annotateBlock(blocks[i], Boolean(blocks[i].closest('[class*="ioCard"]')))
        } catch {
          /* 单个代码块异常不影响其它块 */
        }
      }
      var texts = document.querySelectorAll('[data-chat-call-id] [class*="ioText"]')
      for (var j = 0; j < texts.length; j += 1) {
        try {
          annotateOutputText(texts[j])
        } catch {
          /* 单个输出块异常不影响其它块 */
        }
      }
    }

    function scheduleScan() {
      if (disposed) return
      clearTimeout(scanTimer)
      scanTimer = setTimeout(scan, 200)
    }

    function dispose() {
      disposed = true
      clearTimeout(scanTimer)
      if (safetyTimer) clearInterval(safetyTimer)
      if (observer) observer.disconnect()
      document.documentElement.classList.remove('dce-notes-on')
      var style = document.getElementById(STYLE_ID)
      if (style && style.parentNode) style.parentNode.removeChild(style)
      var buttons = document.querySelectorAll('.dce-toggle')
      for (var i = 0; i < buttons.length; i += 1) {
        if (buttons[i].parentNode) buttons[i].parentNode.removeChild(buttons[i])
      }
      var lines = document.querySelectorAll('[' + ATTR_NOTE + ']')
      for (var j = 0; j < lines.length; j += 1) lines[j].removeAttribute(ATTR_NOTE)
      var strips = document.querySelectorAll('[' + ATTR_LEARN + ']')
      for (var k = 0; k < strips.length; k += 1) {
        if (strips[k].parentNode) strips[k].parentNode.removeChild(strips[k])
      }
      termOwner = Object.create(null)
    }

    function start() {
      if (disposed) return
      injectStyle()
      applyMode()
      scan()
      observer = new MutationObserver(function () {
        scheduleScan()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      safetyTimer = setInterval(scan, 3000)
      return dispose
    }

    exports.inject = []
    exports.apply = function apply(ctx) {
      function boot() {
        if (!document.body) {
          document.addEventListener('DOMContentLoaded', boot, { once: true })
          return
        }
        start()
      }
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          boot()
          return dispose
        }, 'dsh-code-explainer: line notes')
        return
      }
      boot()
    }

    return module.exports
  },
})
