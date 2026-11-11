// 教学层：#9 让 teach 的「为什么」能补进动作说明为空的行
import assert from 'node:assert/strict'
import { explainCodeLines, enrichLineNotes, teachLine } from '../rules.js'

function notesOf(code, lang = '') {
  return enrichLineNotes(code, lang, explainCodeLines(code, lang))
}

// 1. 动作说明为空、教学命中：注释不再是空串
const ASYNC = 'foo(async () => {})'
assert.equal(explainCodeLines(ASYNC, '')[0], '', '前提：这行本来没有动作说明')
assert.ok(teachLine(ASYNC), '前提：这行能命中教学规则')
const asyncNote = notesOf(ASYNC)[0]
assert.notEqual(asyncNote, '', '教学命中却仍留空')
assert.match(asyncNote, /异步|async/, '补进去的不是教学说明：' + asyncNote)
assert.ok(asyncNote.length <= 96, '补进去的说明过长：' + asyncNote.length)

// 2. 已有动作说明的行逐字不变（追加教学说明的旧行为不许改）
assert.equal(notesOf('const a = 1')[0], '先把内容存起来备用，const（声明后不再改指）把结果留着后面用')
assert.equal(notesOf('console.log(a)')[0], '把结果打印出来，console.log（控制台打印）最直接查看结果')
assert.equal(notesOf('await fetch(url)')[0], '等这一步做完，await（等待异步完成）表示等这步跑完再继续')

// 3. 教学说明为空 / 只是泛泛一句：保持留空，交模型兜底
assert.equal(notesOf('readFile(p, cb)')[0], '', '没有具体解释的写法不该硬填')

// 4. 同一写法只在第一次解释，后面不重复填
const twice = notesOf(['foo(async () => {})', 'bar(async (x) => x)'].join('\n'))
assert.notEqual(twice[0], '', '第一次出现没解释')
assert.equal(twice[1], '', '同一写法重复填充：' + twice[1])

// 5. 很长的动作说明不再追加（长度约束原样保留）
const longLine = 'const value = await client.get("/api/users/1234567890/orders?expand=items")'
const longNote = notesOf(longLine)[0]
assert.ok(longNote.length <= 96, '注释超长：' + longNote.length)

// 6. 补进去的说明同样过脱敏
const secretLine = 'run(async () => token = "sk-abcdefghijklmnopqrstuvwxyz012345")'
const secretNote = notesOf(secretLine)[0]
assert.ok(!secretNote.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), '教学说明没脱敏：' + secretNote)

console.log('teach: PASS（教学命中可补空行、已有说明逐字不变、泛泛写法不硬填、同一写法只讲一次）')
