// 教学层：#9 让 teach 的「为什么」能补进动作说明为空的行
import assert from 'node:assert/strict'
import { MIN_TEACH_HINT, TEACH_HINTS, explainCodeLines, enrichLineNotes, needsNote, teachLine } from '../rules.js'

function notesOf(code, lang = '') {
  return enrichLineNotes(code, lang, explainCodeLines(code, lang))
}

// 0. 表级不变量：每条教学说明要么为空（没有具体解释）、要么达到阈值
for (const [key, hint] of Object.entries(TEACH_HINTS)) {
  assert.ok(hint === '' || hint.length >= MIN_TEACH_HINT, '这条教学说明太短，阈值形同虚设：' + key)
}

// 1. 动作说明为空、教学命中：用教学说明顶上去（逐字）
const ASYNC = 'foo(async () => {})'
assert.equal(explainCodeLines(ASYNC, '')[0], '', '前提：这行本来没有动作说明')
assert.ok(teachLine(ASYNC), '前提：这行能命中教学规则')
const asyncNote = notesOf(ASYNC)[0]
assert.equal(asyncNote, 'async（异步函数）标记后里面才能用 await')
assert.ok(asyncNote.length <= 60, '补进去的说明超过 clip 上限：' + asyncNote.length)

// 2. 已有动作说明的行逐字不变
assert.equal(notesOf('const a = 1')[0], '先把内容存起来备用，const（声明后不再改指）把结果留着后面用')
assert.equal(notesOf('console.log(a)')[0], '把结果打印出来，console.log（控制台打印）最直接查看结果')
assert.equal(notesOf('await fetch(url)')[0], '等这一步做完，await（等待异步完成）表示等这步跑完再继续')

// 3. 教学说明为空（没有具体解释）：保持留空，交模型兜底
assert.equal(notesOf('readFile(p, cb)')[0], '')

// 4. 跨分支：同一写法只讲一次（两个方向）
const orderA = notesOf(['const r = async () => 1', 'foo(async () => {})'].join('\n'))
assert.match(orderA[0], /async（异步函数）/, '说明行先讲')
assert.equal(orderA[1], '', '说明行已经讲过的写法，空行不该再讲一遍')
const orderB = notesOf(['foo(async () => {})', 'const r = async () => 1'].join('\n'))
assert.equal(orderB[0], 'async（异步函数）标记后里面才能用 await')
assert.equal(orderB[1], '先把内容存起来备用', '空行讲过的写法，说明行不该再追加一遍')

// 5. 本来就不解释的行（注释、JSDoc）不补教学说明
assert.equal(notesOf('// console.log(具体表达式)：外层打印 + 里层表达式一起讲')[0], '')
assert.deepEqual(notesOf('/**\n * 用 await 读文件\n */'), ['', '', ''])
assert.equal(needsNote('// x'), false, 'needsNote 应随教学层一起导出')

// 5b. 没有具体解释可追加的写法不记账：第二次出现不该冒出「（同上）」
const fsTwice = notesOf(['const a = fs.readFileSync(p)', 'const b = fs.existsSync(p)'].join('\n'))
assert.ok(!fsTwice[0].includes('同上'), '第一次出现不该有「同上」：' + fsTwice[0])
assert.ok(!fsTwice[1].includes('同上'), '第一次其实什么都没追加，第二次不该标「（同上）」：' + fsTwice[1])

// 6. 很长的动作说明不再追加（长度约束原样保留）
const longNote = notesOf('const value = await client.get("/api/users/1234567890/orders?expand=items")')[0]
assert.ok(longNote.length <= 96, '注释超长：' + longNote.length)

console.log('teach: PASS（教学命中可补空行、动作说明本身不变、泛泛写法不硬填、同一写法跨分支只讲一次、注释行不补）')
