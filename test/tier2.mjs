import assert from 'node:assert/strict'
import { explainPythonLine, explainJavaLine, explainCodeLines } from '../rules.js'

/* ── Python 语言包：10 条各一正例 ─────────────────────────────── */

const pyCases = [
  ['if __name__ == "__main__":', '直接运行'],
  ['def load(path):', '定义函数 load'],
  ['class Loader:', '定义类 Loader'],
  ['from pathlib import Path', '从 pathlib 里引入 Path'],
  ['import os', '引入 os 模块'],
  ['self.name = name', '访问这个对象自己的 name'],
  ['print(f"done {n}")', '拼进字符串'],
  ['print(total)', '打印到终端'],
  ['label = f"item-{i}"', 'f-string'],
  ['for item in items:', '逐个取出 items 里的 item'],
  ['return total', '把结果交回去'],
]

for (const [line, want] of pyCases) {
  const note = explainPythonLine(line)
  assert.ok(note.includes(want), 'python「' + line + '」应含「' + want + '」，实际「' + note + '」')
}

/* ── Java 语言包：9 类各一正例 ───────────────────────────────── */

const javaCases = [
  ['public static void main(String[] args) {', '程序入口'],
  ['@Override', '覆写'],
  ['public static synchronized void start(Context c) {', '定义一个方法'],
  ['private void startInternal() {', '定义一个方法'],
  ['public class Main {', '定义类 Main'],
  ['interface Task {', '定义接口 Task'],
  ['private static final int N = 3;', '属于类本身'],
  ['public int count;', '标明谁能访问它'],
  ['System.out.println("hi");', '打印到控制台'],
  ['import java.util.List;', '引入 Java 标准库'],
  ['// TODO: 补日志', '待办'],
]

for (const [line, want] of javaCases) {
  const note = explainJavaLine(line)
  assert.ok(note.includes(want), 'java「' + line + '」应含「' + want + '」，实际「' + note + '」')
}

/* ── 反例：不该命中的必须留空或走通用规则，不能乱猜 ───────────── */

for (const line of ['x = 1', '})', '', '   ', '# 注释行', 'value = foo(bar)']) {
  assert.equal(explainPythonLine(line), '', 'python 反例应留空：' + JSON.stringify(line))
}

for (const line of ['}', 'int x = 1;', '// 注释行']) {
  assert.equal(explainJavaLine(line), '', 'java 反例应留空：' + JSON.stringify(line))
}

// 两个语言包互不越界：Python 行不该被 Java 规则认领，反之亦然
assert.equal(explainJavaLine('def load(path):').includes('定义函数'), false, 'java 不该解释 python 的 def')
assert.equal(explainPythonLine('public static void main(String[] a) {').includes('程序入口'), false, 'python 不该解释 java 的 main')

/* ── 契约：没有声明的语言不跑语言包（Tier 1 的 JS 不被抢行）─────── */

assert.equal(explainCodeLines('def load(path):\n    return 1', 'js')[0], '', 'js 声明下 python 行不该有语言包说明')
assert.ok(explainCodeLines('def load(path):\n    return 1', 'python')[0].includes('定义函数'), 'python 声明下应出语言包说明')
assert.ok(explainCodeLines('public class Main {\n  public static void main(String[] a) {', 'java')[0].includes('定义类'), 'java 声明下应出语言包说明')

// Tier 3 仍然整块留空，语言包不改变这一点
assert.deepEqual(explainCodeLines('{\n  "a": 1\n}', 'json'), ['', '', ''], 'json 仍整块留空')

// 稳健性：空值不抛错
for (const v of [undefined, null, '', '   ']) {
  assert.equal(explainPythonLine(v), '')
  assert.equal(explainJavaLine(v), '')
}

console.log('tier2: PASS（Python 11 条 / Java 11 条正例、反例留空、语言包互不越界、Tier 3 不变）')
