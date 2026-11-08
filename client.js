/**
 * dsh-code-explainer — 浏览器半身
 *
 * 在每条工具调用卡片下方插入一个默认收起的「这段代码在干什么」卡片。
 *
 * 为什么用 DOM 注入而不是插槽：
 *   宿主只提供 tool.call.toolview（按工具名替换整张卡）和 conversation.* 插槽，
 *   没有“在内置卡片下方追加内容”的槽位。工具卡外层带有稳定的
 *   data-chat-call-id / data-chat-anchor-key 契约，因此在卡片后插入自己的节点，
 *   既不动内置卡片，也不需要覆盖宿主组件；MutationObserver 负责在重渲染后挂回去。
 *
 * 宿主契约：window.__ModuleLoader__.load({ id, factory }) + exports.inject / apply(ctx)
 */

window.__ModuleLoader__.load({
  id: 'dsh-code-explainer',
  factory: function () {
    var module = { exports: {} }
    var exports = module.exports

    var API = '/dsh-code-explainer/api'
    var STYLE_ID = 'dce-style'
    var CARD_CLASS = 'dce-card'
    var CARD_FOR = 'data-dce-for'

    var cache = Object.create(null)
    var attempts = Object.create(null)
    var failed = Object.create(null)
    var pending = Object.create(null)
    var pendingCount = 0
    var refreshTimers = Object.create(null)
    var observer = null
    var scanTimer = null
    var fetchTimer = null
    var safetyTimer = null
    var inflight = false
    var lastFetch = 0
    var disposed = false

    /* ── 样式 ───────────────────────────────────────────────────────── */

    var CSS = [
      '.dce-card{margin:6px 0 2px;border:1px solid rgba(128,128,128,.28);border-radius:8px;background:rgba(128,128,128,.06);font-size:12.5px;line-height:1.7;overflow:hidden;color:inherit}',
      '.dce-card>details>summary{display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:pointer;list-style:none;user-select:none}',
      '.dce-card>details>summary::-webkit-details-marker{display:none}',
      '.dce-card .dce-caret{display:inline-block;width:10px;flex:0 0 10px;opacity:.55;transition:transform .15s ease}',
      '.dce-card details[open] .dce-caret{transform:rotate(90deg)}',
      '.dce-card .dce-label{font-weight:600;white-space:nowrap}',
      '.dce-card .dce-title{opacity:.82;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dce-card .dce-state{margin-left:auto;padding-left:8px;font-size:11px;opacity:.5;white-space:nowrap}',
      '.dce-card .dce-body{padding:0 10px 9px 26px}',
      '.dce-card .dce-purpose{margin:0 0 4px}',
      '.dce-card .dce-steps{margin:2px 0 4px;padding-left:18px}',
      '.dce-card .dce-steps li{margin:1px 0}',
      '.dce-card .dce-risks{margin:3px 0 0;opacity:.85}',
      '.dce-card .dce-risk-label{font-weight:600}',
      '.dce-card .dce-meta{margin:6px 0 0;font-size:11px;opacity:.5}',
    ].join('\n')

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      ;(document.head || document.documentElement).appendChild(style)
    }

    /* ── DOM 工具 ───────────────────────────────────────────────────── */

    function directCard(node) {
      var children = node.children
      for (var i = 0; i < children.length; i += 1) {
        if (children[i].classList && children[i].classList.contains(CARD_CLASS)) return children[i]
      }
      return null
    }

    function cardFor(callId) {
      var cards = document.querySelectorAll('[' + CARD_FOR + ']')
      for (var i = 0; i < cards.length; i += 1) {
        if (cards[i].getAttribute(CARD_FOR) === callId) return cards[i]
      }
      return null
    }

    function setText(node, text) {
      if (!node) return
      var value = typeof text === 'string' ? text : ''
      if (node.textContent !== value) node.textContent = value
    }

    function stateLabel(item) {
      if (item.aiStatus === 'running') return '正在用 AI 补充…'
      if (item.source === 'ai') return 'AI 解释'
      if (item.canEnrich === false) return '本地规则'
      if (item.aiStatus === 'failed') return '规则解释'
      return '本地规则 · 展开可补充'
    }

    function fillBody(card, item) {
      var body = card.querySelector('.dce-body')
      if (!body) return
      var nodes = []

      var purpose = document.createElement('p')
      purpose.className = 'dce-purpose'
      purpose.textContent = item.purpose || ''
      nodes.push(purpose)

      if (item.steps && item.steps.length > 0) {
        var list = document.createElement('ul')
        list.className = 'dce-steps'
        for (var i = 0; i < item.steps.length; i += 1) {
          var li = document.createElement('li')
          li.textContent = item.steps[i]
          list.appendChild(li)
        }
        nodes.push(list)
      }

      if (item.risks && item.risks.length > 0) {
        var risks = document.createElement('p')
        risks.className = 'dce-risks'
        var label = document.createElement('span')
        label.className = 'dce-risk-label'
        label.textContent = '可能的影响：'
        risks.appendChild(label)
        risks.appendChild(document.createTextNode(item.risks.join('；')))
        nodes.push(risks)
      }

      var meta = document.createElement('p')
      meta.className = 'dce-meta'
      var parts = [item.source === 'ai' ? 'AI 补充解释' : '本地规则解释']
      if (item.ok === false) parts.push('这次执行没有成功')
      if (item.aiStatus === 'failed') parts.push('AI 补充暂时不可用')
      meta.textContent = parts.join(' · ')
      nodes.push(meta)

      body.replaceChildren.apply(body, nodes)
    }

    function updateCard(card, item) {
      if (!card || !item) return
      var signature = [
        item.title,
        item.purpose,
        (item.steps || []).join('\u0000'),
        (item.risks || []).join('\u0000'),
        item.source,
        item.aiStatus,
        item.ok,
      ].join('\u0001')
      if (card.getAttribute('data-dce-sig') === signature) return
      card.setAttribute('data-dce-sig', signature)
      card.setAttribute('data-dce-source', item.source || 'rule')
      setText(card.querySelector('.dce-title'), item.title || '这段代码在干什么')
      setText(card.querySelector('.dce-state'), stateLabel(item))
      fillBody(card, item)
    }

    function setState(card, text) {
      setText(card.querySelector('.dce-state'), text)
    }

    function requestAi(card, item) {
      if (!item || !item.callId) return
      if (card.getAttribute('data-dce-asked') === '1') return
      card.setAttribute('data-dce-asked', '1')
      setState(card, '正在用 AI 补充…')
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var timer = setTimeout(function () {
        if (controller) controller.abort()
      }, 25000)

      fetch(API + '/explain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callId: item.callId }),
        signal: controller ? controller.signal : undefined,
      })
        .then(function (response) {
          return response.json()
        })
        .then(function (data) {
          clearTimeout(timer)
          if (data && data.ok && data.item) {
            cache[item.callId] = data.item
            updateCard(card, data.item)
            if (data.item.aiStatus === 'running') scheduleRefresh(item.callId)
          } else {
            setState(card, 'AI 补充暂时不可用，已保留规则解释')
          }
        })
        .catch(function () {
          clearTimeout(timer)
          setState(card, 'AI 补充暂时不可用，已保留规则解释')
        })
    }

    function mountCard(node, item) {
      var card = document.createElement('div')
      card.className = CARD_CLASS
      card.setAttribute(CARD_FOR, item.callId)

      var details = document.createElement('details')
      var summary = document.createElement('summary')

      var caret = document.createElement('span')
      caret.className = 'dce-caret'
      caret.textContent = '▸'

      var label = document.createElement('span')
      label.className = 'dce-label'
      label.textContent = '这段代码在干什么'

      var title = document.createElement('span')
      title.className = 'dce-title'

      var state = document.createElement('span')
      state.className = 'dce-state'

      summary.appendChild(caret)
      summary.appendChild(label)
      summary.appendChild(title)
      summary.appendChild(state)

      var body = document.createElement('div')
      body.className = 'dce-body'

      details.appendChild(summary)
      details.appendChild(body)
      card.appendChild(details)

      // 不要让点击解释卡时顺带触发展开内置工具卡
      card.addEventListener('click', function (event) {
        event.stopPropagation()
      })
      card.addEventListener('mousedown', function (event) {
        event.stopPropagation()
      })
      details.addEventListener('toggle', function () {
        if (!details.open) return
        var current = cache[item.callId]
        if (!current) return
        if (current.source === 'ai') return
        if (current.canEnrich === false) return
        requestAi(card, current)
      })

      // 插在内置卡片之后、子调用容器之前；没有子调用就追加到末尾
      try {
        node.insertBefore(card, node.children[1] || null)
      } catch {
        node.appendChild(card)
      }
      updateCard(card, item)
    }

    /* ── 数据拉取 ───────────────────────────────────────────────────── */

    function addPending(callId) {
      if (pending[callId] || failed[callId] || cache[callId]) return
      pending[callId] = true
      pendingCount += 1
      scheduleFetch()
    }

    function takePending(limit) {
      var ids = []
      for (var id in pending) {
        if (!Object.prototype.hasOwnProperty.call(pending, id)) continue
        ids.push(id)
        delete pending[id]
        pendingCount -= 1
        if (ids.length >= limit) break
      }
      return ids
    }

    function scheduleFetch() {
      if (disposed || inflight || pendingCount === 0) return
      var wait = Math.max(0, 800 - (Date.now() - lastFetch))
      clearTimeout(fetchTimer)
      fetchTimer = setTimeout(doFetch, wait)
    }

    function applyItems(items) {
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i]
        if (!item || !item.callId) continue
        cache[item.callId] = item
        var card = cardFor(item.callId)
        if (card) updateCard(card, item)
        if (item.aiStatus === 'running') scheduleRefresh(item.callId)
      }
    }

    function doFetch() {
      if (disposed || inflight || pendingCount === 0) return
      inflight = true
      lastFetch = Date.now()
      var ids = takePending(60)
      if (ids.length === 0) {
        inflight = false
        return
      }
      fetch(API + '/explanations?callIds=' + encodeURIComponent(ids.join(',')))
        .then(function (response) {
          return response.json()
        })
        .then(function (data) {
          var items = (data && data.items) || []
          var found = Object.create(null)
          for (var i = 0; i < items.length; i += 1) {
            if (items[i] && items[i].callId) found[items[i].callId] = true
          }
          applyItems(items)
          for (var j = 0; j < ids.length; j += 1) {
            var id = ids[j]
            if (found[id]) continue
            attempts[id] = (attempts[id] || 0) + 1
            if (attempts[id] >= 6) failed[id] = true
            else addPending(id)
          }
        })
        .catch(function () {
          for (var i = 0; i < ids.length; i += 1) addPending(ids[i])
        })
        .finally(function () {
          inflight = false
          if (pendingCount > 0) scheduleFetch()
        })
    }

    function scheduleRefresh(callId) {
      if (disposed || refreshTimers[callId]) return
      refreshTimers[callId] = setTimeout(function () {
        delete refreshTimers[callId]
        if (disposed) return
        fetch(API + '/explanations?callIds=' + encodeURIComponent(callId))
          .then(function (response) {
            return response.json()
          })
          .then(function (data) {
            var item = data && data.items && data.items[0]
            if (!item) return
            cache[item.callId] = item
            var card = cardFor(item.callId)
            if (card) updateCard(card, item)
            if (item.aiStatus === 'running') scheduleRefresh(item.callId)
          })
          .catch(function () {
            /* 静默重试由下次扫描负责 */
          })
      }, 2500)
    }

    /* ── 扫描与保活 ─────────────────────────────────────────────────── */

    function scan() {
      if (disposed) return
      var nodes = document.querySelectorAll('[data-chat-call-id]')
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i]
        var callId = node.getAttribute('data-chat-call-id')
        if (!callId) continue
        // 子调用嵌在根调用的外层里；宿主不解释子调用，这里也跳过，避免无谓请求
        if (node.parentElement && node.parentElement.closest('[data-chat-call-id]')) continue
        var existing = directCard(node)
        if (existing) {
          if (cache[callId]) updateCard(existing, cache[callId])
          continue
        }
        if (failed[callId]) continue
        if (cache[callId]) mountCard(node, cache[callId])
        else addPending(callId)
      }
    }

    function scheduleScan() {
      if (disposed) return
      clearTimeout(scanTimer)
      scanTimer = setTimeout(scan, 120)
    }

    function dispose() {
      disposed = true
      clearTimeout(scanTimer)
      clearTimeout(fetchTimer)
      if (safetyTimer) clearInterval(safetyTimer)
      if (observer) observer.disconnect()
      for (var id in refreshTimers) {
        if (Object.prototype.hasOwnProperty.call(refreshTimers, id)) clearTimeout(refreshTimers[id])
      }
      refreshTimers = Object.create(null)
      var style = document.getElementById(STYLE_ID)
      if (style && style.parentNode) style.parentNode.removeChild(style)
      var cards = document.querySelectorAll('.' + CARD_CLASS)
      for (var i = 0; i < cards.length; i += 1) {
        if (cards[i].parentNode) cards[i].parentNode.removeChild(cards[i])
      }
    }

    function start() {
      if (disposed) return
      injectStyle()
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
        }, 'dsh-code-explainer: tool call cards')
        return
      }
      boot()
    }

    return module.exports
  },
})
