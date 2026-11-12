import assert from 'node:assert/strict'
import { detectDialect, shouldExplainPerLine, explainCodeLines, MIN_CONFIDENCE } from '../rules.js'

const PS = 'Get-ChildItem -LiteralPath .\nRemove-Item -Recurse -Force build-cache'
const JS = 'const home = process.env.HOME\nconsole.log(home)'
const PY = 'def load(path):\n    with open(path) as f:\n        return f.read()'
const JAVA = 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("hi");\n  }\n}'
const JSON_BODY = '{\n  "name": "dsh-code-explainer",\n  "version": "0.4.5"\n}'
const XML = '<config>\n  <item name="a" />\n</config>'
const GO = 'func main() {\n  fmt.Println("hi")\n}'

function same(a, b, msg) {
  assert.deepEqual({ lang: a.lang, tier: a.tier }, { lang: b.lang, tier: b.tier }, msg)
}

/* ── 1. 声明优先，且不同声明写法归一 ─────────────────────── */
const declaredForms = ['powershell', 'PowerShell', 'pwsh', 'ps1', '.ps1', 'PS1']
for (const form of declaredForms) {
  const d = detectDialect(PS, form)
  assert.equal(d.lang, 'powershell', 'declared ' + form)
  assert.equal(d.tier, 1, 'tier 1 for ' + form)
  assert.equal(d.source, 'declared')
  assert.ok(d.confidence >= 0.9, 'declared confidence ' + d.confidence)
}

for (const form of ['bash', 'sh', 'shell', 'zsh', 'cmd', 'bat', 'console', 'terminal']) {
  assert.equal(detectDialect('ls -la', form).lang, 'shell', 'shell tag ' + form)
  assert.equal(detectDialect('ls -la', form).tier, 1)
}

for (const form of ['js', 'javascript', 'ts', 'typescript', 'mjs', '.js']) {
  assert.equal(detectDialect(JS, form).lang, 'js', 'js tag ' + form)
  assert.equal(detectDialect(JS, form).tier, 1)
}

assert.equal(detectDialect(PY, 'python').tier, 2, 'python tier 2')
assert.equal(detectDialect(PY, 'py').lang, 'python')
assert.equal(detectDialect(JAVA, 'java').tier, 2, 'java tier 2')
assert.equal(detectDialect(JSON_BODY, 'json').tier, 3, 'json tier 3')
assert.equal(detectDialect(XML, 'xml').tier, 3, 'xml tier 3')

/* ── 2. 同一段代码，声明写法不同，判定一致 ───────────────── */
same(detectDialect(PS, 'powershell'), detectDialect(PS, 'PS1'), 'ps forms agree')
same(detectDialect(JS, 'js'), detectDialect(JS, 'typescript'), 'js forms agree')

/* ── 3. 无声明时按内容兜底（0.4.2 的 PowerShell 能力不回退） ── */
const psAuto = detectDialect(PS, '')
assert.equal(psAuto.lang, 'powershell', 'auto powershell')
assert.equal(psAuto.tier, 1)
assert.equal(psAuto.source, 'content')
assert.ok(psAuto.confidence >= MIN_CONFIDENCE, 'auto ps confident ' + psAuto.confidence)

const jsAuto = detectDialect(JS, '')
assert.equal(jsAuto.lang, 'js', 'auto js')
assert.ok(jsAuto.confidence >= MIN_CONFIDENCE)

/* ── 4. 数据与标记语言：内容也能认出来 ───────────────────── */
assert.equal(detectDialect(JSON_BODY, '').lang, 'data', 'auto json')
assert.equal(detectDialect(XML, '').lang, 'markup', 'auto xml')

/* ── 5. 认不准就低置信，不逐行猜 ─────────────────────────── */
const go = detectDialect(GO, 'go')
assert.equal(go.tier, 3, 'unknown tag falls to tier 3')
assert.ok(go.confidence < MIN_CONFIDENCE, 'unknown tag low confidence ' + go.confidence)
assert.equal(shouldExplainPerLine(go), false)

const junk = detectDialect('这里是一段说明文字，不是代码', '')
assert.equal(junk.lang, 'unknown')
assert.equal(shouldExplainPerLine(junk), false)

/* ── 6. 低置信块不出行注释；Tier 1 的行为不变 ────────────── */
assert.deepEqual(explainCodeLines(GO, 'go'), ['', '', ''])
const psNotes = explainCodeLines(PS, '')
assert.equal(psNotes[0], '列出文件夹里有哪些文件')
assert.ok(psNotes[1].includes('删除'))
assert.deepEqual(explainCodeLines(PS, ''), explainCodeLines(PS, 'powershell'), 'tag 与无 tag 结果一致')

/* ── 7. Tier 1 才逐行；Tier 2/3 目前一律低置信闸门之外 ───── */
assert.equal(shouldExplainPerLine(detectDialect(JS, 'js')), true)
assert.equal(shouldExplainPerLine(detectDialect(JSON_BODY, 'json')), false)

console.log('dialect: PASS')
