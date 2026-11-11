/**
 * 输出区的结构回归测试：总述必须在 ioSection 外面。
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
import { createDom } from './dom.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

const dom = createDom(source)
const { doc, El } = dom

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

const exportsObject = dom.factory()()
const dispose = dom.apply(exportsObject)

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
