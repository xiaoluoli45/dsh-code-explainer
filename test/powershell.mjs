/**
 * 回归：没有 lang 标签的 PowerShell 代码也要按 shell 规则解释（#11）
 *
 * 失败即回到「PowerShell 语句一句都判不出」的旧行为。
 */
import assert from 'node:assert/strict'
import { explainCodeLines, explainCommandLine } from '../rules.js'

const PS = [
  "$ErrorActionPreference = 'Continue'",
  'Start-Sleep -Seconds 2',
  'New-Object System.Net.WebClient',
  'Get-ChildItem -Path . | Where-Object { $_.Length -gt 0 }',
  "Out-File -FilePath out.txt -Encoding utf8",
].join('\n')

const JS = [
  'const total = items.length',
  'if (total > 0) {',
  '  console.log(total)',
  '}',
  'const path = file - 1',
  'const flag = a | b',
].join('\n')

function notesOf(code, lang) {
  return explainCodeLines(code, lang)
}

// 1. 无标签的 PowerShell：四类语句都要有具体说明，不是空串
const bare = notesOf(PS, '')
const psLines = PS.split('\n')
const empty = psLines.filter((line, i) => !bare[i])
assert.equal(empty.length, 0, '无标签 PowerShell 有行判不出：' + JSON.stringify(empty))

// 2. 四类必须给具体说明（覆盖 brief 的验收清单）
const expect = {
  "Start-Sleep -Seconds 2": /暂停|等/,
  'New-Object System.Net.WebClient': /新建|创建/,
  'Get-ChildItem -Path . | Where-Object { $_.Length -gt 0 }': /列出|文件夹/,
  "Out-File -FilePath out.txt -Encoding utf8": /写|存|文件/,
}
for (const [line, pattern] of Object.entries(expect)) {
  const index = psLines.indexOf(line)
  assert.ok(index >= 0, '测试样本少了一行：' + line)
  assert.match(bare[index], pattern, '这一行说明不对：' + line + ' → ' + bare[index])
}

// 3. 标了 ps1 时结果一致
assert.deepEqual(notesOf(PS, 'ps1'), bare, 'lang=ps1 与无标签的结果应当一致')

// 4. JS 不能被误判成 shell
const jsBare = notesOf(JS, '')
assert.equal(jsBare[0], '先把内容存起来备用', 'JS 赋值行不该被 shell 规则接管：' + jsBare[0])
assert.equal(jsBare[2], '把结果打印出来', 'JS 打印行不该被 shell 规则接管：' + jsBare[2])
assert.equal(jsBare[4], '先把内容存起来备用', 'JS 减法行不该被 shell 规则接管：' + jsBare[4])
assert.equal(jsBare[5], '先把内容存起来备用', 'JS 按位或行不该被 shell 规则接管：' + jsBare[5])

// 5. JS 里夹着 PowerShell 字符串：整块仍是 JS，不能全被 shell 规则接管
const MIXED = [
  'const sample = "$ErrorActionPreference = \'Continue\'"',
  'const cmd = "Start-Sleep -Seconds 2"',
  'console.log(sample, cmd)',
].join('\n')
const mixed = notesOf(MIXED, '')
assert.equal(mixed[0], '先把内容存起来备用', 'JS 里带 PowerShell 字符串被误判：' + mixed[0])
assert.equal(mixed[2], '把结果打印出来', 'JS 里带 PowerShell 字符串被误判：' + mixed[2])

// 6. 单行块也要认（ops_bash 最常见的形态就是一两条命令）
assert.match(notesOf('Start-Sleep -Seconds 2', '')[0], /暂停|等/, '单行 PowerShell 没被判成 shell')
assert.match(notesOf('ConvertTo-Json | Out-File a.json', '')[0], /写|存|文件/, '单行管道落盘没解释')
assert.match(notesOf('New-Object System.Net.WebClient', '')[0], /新建|创建/, '单行建对象没解释')

// 7. 提示符：整块都要摘，PS> 与 PS C:\\work> 两种形态
const PROMPTED = [
  'PS C:\\work> Get-ChildItem .',
  'PS C:\\work> $a = 1',
  'PS C:\\work> Write-Output $a',
].join('\n')
const prompted = notesOf(PROMPTED, '')
assert.match(prompted[0], /列出|文件夹/, '带提示符的整块没判成 shell')
assert.match(prompted[1], /设一个值/, '带提示符的赋值行没解释')
assert.match(prompted[2], /显示|打印|输出/, '带提示符的输出行没解释')
assert.match(notesOf('PS> Get-ChildItem', '')[0], /列出|文件夹/, 'PS> 形态没摘')

// 8. 大小写：PowerShell 本身不分大小写
assert.match(notesOf('get-childitem .\nwrite-host hi', '')[1], /显示|打印/, '小写 Cmdlet 没认出来')

// 9. jQuery 与 PS 里的 if：都不该把 JS 块拖成 shell，也不该把 PS 块判回 JS
const jquery = notesOf('$btn = $("#btn")\n$list = $("ul")\nconsole.log($btn)', '')
assert.equal(jquery[2], '把结果打印出来', 'jQuery 风格的 JS 被当成 PowerShell：' + jquery[2])
const psIf = notesOf('$f = Get-ChildItem\nif ($f) { Write-Output $f }', '')
assert.match(psIf[0], /列出|文件夹/, 'PS 块里的 if 把整块拖回 JS 了：' + psIf[0])

// 10. 逻辑或不是管道；cmd 里 # 不是注释
assert.equal(explainCommandLine('npm test || exit 1'), '', '|| 被当成了管道')
assert.equal(notesOf('# 这不是注释\ndir', 'cmd')[1], '列出文件夹里有哪些文件', 'cmd 块被 # 规则带偏')

// 11. 单行入口同样生效
assert.match(explainCommandLine('Start-Sleep -Seconds 2'), /暂停|等/)
assert.match(explainCommandLine('PS C:\\work> Get-ChildItem'), /列出|文件夹/, '带提示符的行没被认出')
assert.equal(explainCommandLine('# 先注释一下'), '', '注释行不该解释')

console.log('powershell: PASS（无标签与单行 PowerShell 都按 shell 解释、提示符可摘、大小写不敏感、JS/jQuery 不误判、|| 不算管道）')
