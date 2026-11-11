/**
 * dsh-code-explainer — 本地逐行解释规则
 *
 * 纯函数、零依赖：把一行代码/命令翻译成非程序员能看懂的一句话。
 * 规则能判的立即给结果；判不出来的返回空字符串，交给 AI 补充。
 */

/* ── 文本工具 ───────────────────────────────────────────────────────── */

function str(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function clip(text, max) {
  const value = str(text)
  if (value.length <= max) return value
  return value.slice(0, max) + '…'
}

/* ── 凭据掩码 ───────────────────────────────────────────────────────── */

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/g,
]

const KEY_VALUE_PATTERN =
  /\b(api[_-]?key|access[_-]?token|secret|password|passwd|token)\b(\s*[=:]\s*)(['"]?)([^\s'";,]{6,})\3/gi

/**
 * 把文本里像密钥的片段替换成 ***。
 * 只用于展示、落盘和发给模型前的输入，不改变实际命令。
 */
export function redact(input) {
  let text = str(input)
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '***')
  text = text.replace(KEY_VALUE_PATTERN, (_match, name, sep, quote) => {
    return name + sep + quote + '***' + quote
  })
  return text
}

/* ── 命令模式 ───────────────────────────────────────────────────────── */

/**
 * 每条规则：
 *   test   —— 命中命令的正则
 *   title  —— 卡片摘要里的短标题
 *   action —— 一行说明，直接用作行尾注释
 */
const COMMAND_RULES = [
  {
    test: /\brm\s+-\S*[rf]\S*|\brm\b|Remove-Item\b[^|;]*-(?:Recurse|Force)|\brmdir\s+\/s|\brd\s+\/s|\bdel\s+\/[sqf]/i,
    title: '删除文件或文件夹',
    action: '删除指定的文件或文件夹',
  },
  {
    test: /\bgit\s+push\b[^\n]*(?:--force|-f\b)/i,
    title: '强制上传代码',
    action: '强制把本地代码传到远程仓库',
  },
  {
    test: /\bgit\s+push\b/i,
    title: '上传代码到远程仓库',
    action: '把本地代码上传到远程仓库',
  },
  {
    test: /\bgit\s+(?:reset\s+--hard|clean\s+-)/i,
    title: '丢弃本地改动',
    action: '丢弃本地还没提交的改动',
  },
  {
    test: /\bgit\s+commit\b/i,
    title: '保存代码快照',
    action: '把当前改动保存成一条历史记录',
  },
  {
    test: /\bgit\s+(?:add|stage)\b/i,
    title: '挑选要保存的改动',
    action: '把改动标记为准备保存',
  },
  {
    test: /\bgit\s+clone\b/i,
    title: '下载一个代码仓库',
    action: '从网上下载一份完整代码仓库',
  },
  {
    test: /\bgit\s+(?:status|diff|log|show|branch|remote|rev-parse)\b/i,
    title: '查看代码仓库状态',
    action: '查看代码仓库的状态或历史',
  },
  {
    test: /\b(?:npm|pnpm|yarn)\s+(?:install|i|ci|add)\b/i,
    title: '安装项目依赖',
    action: '安装项目需要的第三方代码包',
  },
  {
    test: /\b(?:pip3?|uv|poetry)\s+(?:pip\s+)?(?:install|add)\b/i,
    title: '安装 Python 依赖',
    action: '安装 Python 需要的第三方包',
  },
  {
    test: /\b(?:npm|pnpm|yarn)\s+run\b|\bnpx\b/i,
    title: '运行项目脚本',
    action: '运行项目里预先写好的脚本',
  },
  {
    test: /\b(?:node|python3?|deno|bun)\b[^\n]*|\b(?:pwsh|powershell)\b[^\n]*\.ps1\b/i,
    title: '运行一段程序',
    action: '让电脑运行一段程序',
  },
  {
    test: /\bcurl\b|\bwget\b|Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b/i,
    title: '联网获取或发送数据',
    action: '联网访问一个地址并取回结果',
  },
  {
    test: /\bStart-Process\b|\bschtasks\b|\breg\s+add\b|\bSet-Service\b|\bNew-Service\b|\bsc\s+config\b|\bnetsh\b/i,
    title: '修改系统设置',
    action: '修改电脑的系统级设置或启动项',
  },
  {
    test: /\bmkdir\b|\bNew-Item\b[^|;]*-ItemType\s+Directory|\bmd\s+/i,
    title: '新建文件夹',
    action: '在指定位置新建一个文件夹',
  },
  {
    test: /\bCopy-Item\b|\brobocopy\b|\bcp\b|\bcopy\b/i,
    title: '复制文件',
    action: '把文件复制到另一个位置',
  },
  {
    test: /\bMove-Item\b|\bmv\b|\bmove\b/i,
    title: '移动或重命名文件',
    action: '把文件移到别处或改名',
  },
  {
    test: /\bGet-Content\b|\bcat\b|\btype\b|\bhead\b|\btail\b|\bmore\b/i,
    title: '查看文件内容',
    action: '读取一个文件里的文字并显示',
  },
  {
    test: /\bGet-ChildItem\b|\bdir\b|\bls\b|\btree\b/i,
    title: '查看目录内容',
    action: '列出文件夹里有哪些文件',
  },
  {
    test: /\bSelect-String\b|\bgrep\b|\bfindstr\b/i,
    title: '搜索文字',
    action: '在文件或输出里查找一段文字',
  },
  {
    test: /\bSet-Location\b|\bpushd\b|\bcd\b/i,
    title: '切换工作目录',
    action: '把当前工作位置切到另一个文件夹',
  },
  {
    test: /\bWrite-Output\b|\bWrite-Host\b|\becho\b/i,
    title: '输出一段文字',
    action: '在屏幕上显示一段文字',
  },
  {
    test: /\bTest-Path\b|\bGet-Item\b|\bGet-Command\b|\bwhere\b|\bwhich\b/i,
    title: '检查文件或命令是否存在',
    action: '确认某个文件或命令是否存在',
  },
  {
    test: /^\s*\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*\s*(?:[+\-*/]?=)/,
    title: '给变量设一个值',
    action: '先给这个变量设一个值，后面还会用到',
  },
  {
    test: /\bStart-Sleep\b/i,
    title: '暂停一会儿',
    action: '先暂停一会儿，等时间到了再继续',
  },
  {
    test: /\bNew-Object\b/i,
    title: '新建一个对象',
    action: '新建一个对象，用它来干活',
  },
  {
    test: /\bOut-File\b|\bSet-Content\b|\bAdd-Content\b/i,
    title: '把结果写进文件',
    action: '把刚才的结果写进一个文件',
  },
  {
    // 放在最后：让上面更具体的规则先命中，管道只在没有更好解释时兜底
    // \|\| 是「或者」不是管道，别把 npm test || exit 1 说成交接
    test: /(?<!\|)\|(?!\||=)/,
    title: '把结果交给下一步',
    action: '把上一步的结果接着交给下一步处理',
  },
]

const SHELL_LANGS = /^(pwsh|powershell|ps1|bash|sh|shell|shellscript|zsh|cmd|bat|console|terminal)$/i

/** 命令前的提示符（PS C:\\work> / PS> / C:\\>），记录里每行都可能带着 */
const PS_PROMPT = /^\s*(?:PS[^>\n]{0,60}>|[A-Za-z]:\\[^>\n]{0,60}>)\s*/

function stripPrompt(line) {
  return str(line).replace(PS_PROMPT, '')
}

/** 一行像不像 PowerShell 语句：变量赋值、动词-名词 Cmdlet（不分大小写）、管道右端、自动变量 */
const PS_STATEMENT =
  /^\s*(?:\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*\s*[+\-*/]?=|(?:Get|Set|New|Remove|Start|Stop|Restart|Invoke|Out|Write|Read|Test|Add|Copy|Move|Select|Where|ForEach|Sort|Measure|ConvertTo|ConvertFrom|Join|Split|Import|Export|Enable|Disable|Register|Unregister|Rename|Clear|Show|Format|Group|Compare|Resolve|Wait|Push|Pop|Enter|Exit|Find|Save|Update|Install)-[A-Za-z]{3,}\b|\|\s*[A-Z][A-Za-z]+-[A-Za-z]+|\$(?:env:|_|ErrorActionPreference|PSVersionTable|PSItem|true|false|null|args)\b)/i

/** 一行像不像 JS/TS 语句：声明、导入、打印、箭头函数 */
const JS_STATEMENT =
  /^\s*(?:const|let|var|function|class|import|export|return|await|throw|if\s*\(|for\s*\(|while\s*\(|try\s*\{|catch\s*\(|console\.|\/\/)|=>/

/** jQuery 的 $btn = $("#id") 不是 PowerShell 赋值 */
function isPowerShellLine(line) {
  const text = stripPrompt(line).trim()
  if (!text) return false
  if (text.includes('$(')) return false
  return PS_STATEMENT.test(text)
}

/** PS 块里也有 if (...) / for (...) 和 }，别把它们算成 JS 证据 */
function isJsLine(line) {
  const text = stripPrompt(line).trim()
  if (!text) return false
  if (isPowerShellLine(text)) return false
  if (/^(?:if|for|while|switch|try|catch)\b/.test(text)) return false
  return JS_STATEMENT.test(text)
}

function countLines(code, predicate) {
  let count = 0
  for (const line of str(code).split(/\r?\n/)) {
    if (line.trim() && predicate(line)) count += 1
  }
  return count
}

/**
 * 没有语言标签时，靠内容特征认出 PowerShell。
 * 判据：PowerShell 语句至少 2 行且比 JS 语句多；单行块只要是 PowerShell 也算。
 * 宁可不判——判不准就退回 JS 规则，免得把夹着 PowerShell 字符串的 JS 整块当 shell 讲。
 */
function looksLikePowerShell(code) {
  const psLines = countLines(code, isPowerShellLine)
  const jsLines = countLines(code, isJsLine)
  if (psLines === 1 && jsLines === 0) return true
  return psLines >= 2 && psLines > jsLines
}

function shortNote(text) {
  return clip(redact(str(text).replace(/。$/, '')), 30)
}

/** 一条命令行 → 一句说明；认不出来返回 '' */
/** 一条命令行 → 一句说明（可以带 PS C:\\work> 这类提示符） */
export function explainCommandLine(line) {
  // 有的记录把提示符一起贴出来（PS C:\work> Get-ChildItem），先摘掉再判断
  const text = stripPrompt(line).trim()
  if (!text) return ''
  // # 开头的整行是注释，没有动作可讲（bash、PowerShell 都一样）
  if (/^#/.test(text)) return ''
  const matched = COMMAND_RULES.filter((rule) => rule.test.test(text))
  return matched.length > 0 ? shortNote(matched[0].action) : ''
}

/* ── 代码行模式 ─────────────────────────────────────────────────────── */

const TOOL_HINTS = [
  [/bash|pwsh|shell|terminal/i, '命令行工具'],
  [/fetch|http|web/i, '联网工具'],
  [/file|fs|read|write/i, '文件工具'],
]

function toolLabel(name) {
  for (const [pattern, label] of TOOL_HINTS) {
    if (pattern.test(name)) return label
  }
  return '「' + name + '」工具'
}

function stringValue(line) {
  const match = line.match(/["'`](.*)["'`]\s*[,)]?\s*$/)
  return match ? match[1] : ''
}

/* ── 具体 API / 模块识别 ───────────────────────────────────────────── */

const MODULE_LABELS = {
  fs: '文件系统模块',
  path: '路径处理模块',
  os: '系统信息模块',
  child_process: '运行子进程模块',
  url: '网址（URL）处理模块',
  crypto: '加密模块',
  http: '网络请求模块',
  https: 'HTTPS 请求模块',
}

/** node:fs → 文件系统模块 fs */
function moduleOf(spec) {
  const raw = str(spec).trim()
  const name = raw.replace(/^node:/, '').split('/')[0]
  return { name, label: MODULE_LABELS[name] || '模块 ' + name }
}

/** 取出这一行里的字符串字面量，按出现顺序返回 */
function quotedParts(text) {
  const out = []
  const pattern = /["'`]([^"'`]*)["'`]/g
  let match
  while ((match = pattern.exec(str(text)))) out.push(match[1])
  return out
}

function fsActionOf(method) {
  const name = str(method).toLowerCase()
  if (/^readfile/.test(name)) return '读取文件内容'
  if (/^writefile/.test(name)) return '写入文件内容'
  if (/^appendfile/.test(name)) return '在文件末尾追加内容'
  if (/^readdir/.test(name)) return '列出目录里的内容'
  if (/^mkdir/.test(name)) return '新建文件夹'
  if (/^(rm|unlink|rmdir)/.test(name)) return '删除文件或文件夹'
  if (/^(copyfile|cp)/.test(name)) return '复制文件'
  if (/^(rename|mv)/.test(name)) return '移动或重命名文件'
  if (/^(stat|access|exists)/.test(name)) return '检查文件是否存在或取文件信息'
  return '操作本地文件'
}

const PATH_ACTIONS = {
  join: '把多段路径拼成一个完整路径',
  resolve: '把相对路径换算成绝对路径',
  basename: '取路径里的文件名',
  dirname: '取路径里的目录部分',
  extname: '取文件扩展名',
  parse: '把路径拆成目录、文件名和扩展名',
  relative: '算出两个路径之间的相对位置',
  normalize: '把路径整理成规范写法',
}

/**
 * 识别一行里具体的模块 / API / 参数，返回一句「做什么 → 返回什么 → 为什么」。
 * 认不出来返回 ''，交给后面的通用规则或模型。
 */
function apiNote(line) {
  const trimmed = str(line).trim()
  let match

  // const fs = await import("node:fs") / const fs = require("fs")
  if (
    (match = trimmed.match(
      /^(?:const|let|var)\s+(\{[^}]*\}|\w+)\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]/,
    ))
  ) {
    const target = match[1]
    const spec = match[2]
    const mod = moduleOf(spec)
    const builtin = /^node:/.test(spec.trim()) ? '；node: 前缀表示 Node 内置模块' : ''
    if (target.charAt(0) === '{') {
      const names = target
        .replace(/[{}]/g, '')
        .split(',')
        .map((item) => item.trim().split(':').pop().trim())
        .filter(Boolean)
      return '加载 ' + mod.label + ' ' + mod.name + '，取出 ' + names.join('、') + ' 后面直接用' + builtin
    }
    return (
      '动态加载 ' + mod.label + ' ' + mod.name + '，返回模块对象，后面用 ' + target + ' 调用' + builtin
    )
  }

  // 单独的 import("...") / require("...")
  if ((match = trimmed.match(/(?:^|[=(,]\s*)(?:await\s+)?(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]/))) {
    const mod = moduleOf(match[1])
    return '动态加载 ' + mod.label + ' ' + mod.name + '，返回模块对象' + (/^node:/.test(match[1]) ? '；node: 前缀表示 Node 内置模块' : '')
  }

  // 静态 import：import fs from "node:fs"
  if (/^import\b/.test(trimmed)) {
    const spec = quotedParts(trimmed)[0] || ''
    if (spec) {
      const mod = moduleOf(spec)
      return '导入 ' + mod.label + ' ' + mod.name + '，后面直接用它提供的功能'
    }
  }

  // fs.readFileSync("a.txt", "utf8") / await fs.promises.readFile(...)
  if ((match = trimmed.match(/(?:^|[=(,]\s*)(?:await\s+)?(?:fs\.promises|fsp|fs)\.(\w+)\s*\(/))) {
    const method = match[1]
    const args = quotedParts(trimmed)
    const file = args[0] || ''
    const option = args[1] || ''
    let note = '用 fs（文件系统模块）' + fsActionOf(method)
    if (file) note += ' ' + clip(file, 32)
    if (/^(utf-?8|ascii|latin1|base64|hex)$/i.test(option)) note += '，' + option + ' 表示按文本编码读写'
    else if (option) note += '，第二个字符串是选项'
    if (/Sync$/.test(method)) note += '（Sync：做完才继续）'
    return note
  }

  // process.env.X / process.cwd() / process.argv
  if ((match = trimmed.match(/process\.env\.(\w+)/))) return '用 process.env（环境变量）读取 ' + match[1] + ' 的值'
  if (/process\.env\b/.test(trimmed)) return '用 process.env（环境变量）读取运行环境给的配置'
  if (/process\.cwd\s*\(/.test(trimmed)) return '用 process.cwd() 取当前工作目录的完整路径'
  if (/process\.argv\b/.test(trimmed)) return '用 process.argv 取命令行传进来的参数'
  if (/process\.exit\s*\(/.test(trimmed)) return '用 process.exit() 结束程序并交回退出码'
  if (/process\.platform\b/.test(trimmed)) return '用 process.platform 取当前操作系统类型'
  if (/\bprocess\./.test(trimmed)) return '调用 Node 进程相关的功能'

  // path.join(...) 等
  if ((match = trimmed.match(/\bpath\.(join|resolve|basename|dirname|extname|parse|relative|normalize)\s*\(/))) {
    const action = PATH_ACTIONS[match[1]]
    const args = quotedParts(trimmed)
    const extra = []
    if (/__dirname/.test(trimmed)) extra.push('__dirname（当前文件所在目录）')
    if (/__filename/.test(trimmed)) extra.push('__filename（当前文件完整路径）')
    return (
      '用 path（路径处理模块）' +
      action +
      (args.length > 0 ? '：' + clip(args.join(' / '), 40) : '') +
      (extra.length > 0 ? '；' + extra.join('、') : '')
    )
  }

  // fetch("https://…")
  if ((match = trimmed.match(/\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/))) {
    return '联网请求 ' + clip(match[1], 48) + ' 并取回数据（通常要等结果）'
  }

  return ''
}

/**
 * 一行代码 → 一句说明；没有实际动作（空行、纯括号、已有注释）返回 ''。
 */
export function explainCodeLine(line) {
  const text = str(line)
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (/^(\/\/|#|\/\*|\*|\*\/)/.test(trimmed)) return ''
  if (/^[(){}\[\];,]+$/.test(trimmed)) return ''
  if (/^(else\s*)?\{\s*$/.test(trimmed)) return ''
  if (/^\}\s*\)?\s*;?$/.test(trimmed)) return ''

  let match

  // console.log(具体表达式)：外层打印 + 里层表达式一起讲
  const wrapped = trimmed.match(/^console\.log\((.+)\)\s*;?$/)
  if (wrapped) {
    const inner = apiNote(wrapped[1])
    if (inner) return '先' + inner + '，再把结果打印出来'
  }

  const specific = apiNote(trimmed)
  if (specific) return specific

  if (/^console\.log\(/.test(trimmed)) return '把结果打印出来'
  if (/^console\.(error|warn)\(/.test(trimmed)) return '打印错误提示'
  if (/^console\.table\(/.test(trimmed)) return '把结果整理成表格打印'
  if (/^console\./.test(trimmed)) return '在控制台输出信息'

  if (/^return\b/.test(trimmed)) return '把结果交回去'
  if (/^throw\b/.test(trimmed)) return '发现问题就立刻报错停下'
  if (/^else\s+if\s*\(/.test(trimmed)) return '另一种情况再判断'
  if (/^if\s*\(/.test(trimmed)) return '先判断一个条件'
  if (/^(for|while)\s*\(/.test(trimmed)) return '重复处理每一项'
  if (/^try\s*\{/.test(trimmed)) return '试着做下面的操作'
  if (/^catch\b/.test(trimmed)) return '出错时走这里'
  if (/^import\b/.test(trimmed)) return '引入需要用到的东西'
  if (/^(export\s+)?(async\s+)?function\b/.test(trimmed)) return '定义一个可重复使用的操作'

  if ((match = trimmed.match(/^(?:const|let|var)\s+\w+\s*=\s*await\s+tools\.(\w+)\s*\(/))) {
    return '调用' + toolLabel(match[1]) + '，把结果存起来'
  }
  if ((match = trimmed.match(/^await\s+tools\.(\w+)\s*\(/))) {
    return '调用' + toolLabel(match[1])
  }
  if ((match = trimmed.match(/^tools\.(\w+)\s*\(/))) {
    return '调用' + toolLabel(match[1])
  }
  if (/^(?:const|let|var)\s+\w+\s*=\s*await\s+/.test(trimmed)) return '等这一步做完，把结果存起来'
  if (/^await\s+/.test(trimmed)) return '等这一步做完'
  if (/^(?:const|let|var)\s+\w+\s*=\s*/.test(trimmed)) return '先把内容存起来备用'
  if (/fetch\s*\(|axios\./.test(trimmed)) return '联网取回数据'
  if (/^(fs|fsp|fs\.promises)\./.test(trimmed)) return '读写本地文件'
  if (/\.then\s*\(/.test(trimmed)) return '上一步完成后接着处理'

  if (/^command\s*[:=]/.test(trimmed)) {
    const value = stringValue(trimmed)
    return explainCommandLine(value) || '这里写明要执行的命令'
  }
  if (/^(description|desc)\s*[:=]/.test(trimmed)) return '给这次操作加一句说明'
  if ((match = trimmed.match(/^timeoutMs\s*[:=]\s*(\d+)/))) {
    const seconds = Math.max(1, Math.round(Number(match[1]) / 1000))
    return '最多等 ' + seconds + ' 秒'
  }
  if (/^(cwd|path|file_path|filePath|dir)\s*[:=]/.test(trimmed)) return '指定要操作的位置'
  if (/^(content|file_text|code|script)\s*[:=]/.test(trimmed)) return '这里是要写入或执行的内容'

  return ''
}

/**
 * 整段代码 → 逐行说明数组（与行一一对应，没有说明的位置是空字符串）。
 * @param {string} code
 * @param {string} [lang] 代码块语言；shell 类语言整行按命令行处理
 * @returns {string[]}
 */
export function explainCodeLines(code, lang) {
  // 记录里常把提示符一起贴出来，判定和解释都先摘掉，行数不变
  const lines = str(code).split(/\r?\n/).map(stripPrompt)
  const declared = str(lang).trim()
  // 工具卡的代码块通常没有语言标签：标签缺席时靠内容认方言，认不准仍按代码处理
  const shellLike = SHELL_LANGS.test(declared) || (!declared && looksLikePowerShell(lines.join('\n')))
  return lines.map((line) => (shellLike ? explainCommandLine(line) : explainCodeLine(line)))
}

/* ── 教学层：这一行用了什么通用写法 ─────────────────────────────────── */

/**
 * 每条规则：
 *   key   —— 模式标识，同一种写法只解释一次
 *   match —— 命中这行代码的正则
 *   label —— 短标签，面板里的标题
 *   term  —— 术语原文（英文）
 *   zh    —— 术语中文对照，只在第一次出现时展示
 *   why   —— 为什么这么写 / 这是什么通用写法
 */
const TEACH_RULES = [
  {
    key: 'dynamic-import',
    match: /(?:^|[=(,]\s*)(?:await\s+)?(?:import|require)\s*\(\s*["'`]/,
    label: '运行时加载模块',
    term: 'import() / require()',
    zh: '运行时加载模块',
    why: '和文件顶部写死的 import 不同，这种写法在代码执行到这里时才去加载模块，返回模块对象。',
  },
  {
    key: 'fs',
    match: /(?:^|[=(,]\s*)(?:await\s+)?(?:fs\.promises|fsp|fs)\.\w+\s*\(/,
    label: '读写本地文件',
    term: 'fs',
    zh: '文件系统模块',
    why: 'fs 是 Node.js 读写文件的模块；带 Sync 的方法表示读完或写完才继续。',
  },
  {
    key: 'process',
    match: /\bprocess\.(env|cwd|argv|exit|platform|version)\b/,
    label: '读取进程信息',
    term: 'process',
    zh: 'Node 当前进程',
    why: 'process 代表正在运行的这个 Node 程序，可以读环境变量、工作目录和启动参数。',
  },
  {
    key: 'path',
    match: /\bpath\.(join|resolve|basename|dirname|extname|parse|relative|normalize)\s*\(/,
    label: '处理文件路径',
    term: 'path',
    zh: '路径处理模块',
    why: 'path 专门拼路径、拆路径，避免手写斜杠在 Windows 和 macOS 上不兼容。',
  },
  {
    key: 'async',
    match: /^\s*(export\s+)?async\s+function\b|\basync\s*\(/,
    label: '异步函数',
    term: 'async',
    zh: '异步函数',
    why: '标了 async 的函数里才能写 await：它表示这个函数会等耗时任务，而不是一口气跑完。',
  },
  {
    key: 'await',
    match: /\bawait\b/,
    label: '等异步结果',
    term: 'await',
    zh: '等待异步操作完成',
    why: 'await 表示等这一步真的跑完、拿到结果后才继续下一行；后面的操作通常是联网、读写文件或跑命令。',
  },
  {
    key: 'tool-call',
    match: /\btools\.\w+\s*\(/,
    label: '调用工具',
    term: 'tools',
    zh: '宿主提供的工具集',
    why: '这是 agent 调用外部工具的标准写法：tools 后面跟工具名，括号里传参数对象；换个工具名，写法完全一样。',
  },
  {
    key: 'timeoutMs',
    match: /\btimeoutMs\s*[:=]/,
    label: '设置最长等待',
    term: 'timeoutMs',
    zh: '超时时间（毫秒）',
    why: '给命令设一个最长等待时间，超过就主动停下，防止程序一直卡住；60000 就是 60 秒。',
  },
  {
    key: 'command',
    match: /^\s*command\s*[:=]/,
    label: '必填的命令',
    term: 'command',
    zh: '要执行的命令（必填）',
    why: '这是一个参数对象：command 是必填项，说明到底要执行什么；description、timeoutMs 都是可选的补充。',
  },
  {
    key: 'options',
    match: /^\s*(description|desc|cwd|path|file_path|filePath|dir|content|file_text|code|script)\s*[:=]/,
    label: '可选参数',
    term: 'options',
    zh: '参数对象里的可选配置',
    why: '这些是给工具的可选参数，写在花括号里成对出现：左边是参数名，右边是值。',
  },
  {
    key: 'console.log',
    match: /\bconsole\.log\s*\(/,
    label: '打印结果',
    term: 'console.log',
    zh: '在控制台打印',
    why: '把结果打印到控制台，是最常用的查看程序输出方式；调试时想看什么就打印什么。',
  },
  {
    key: 'json',
    match: /\bJSON\.(parse|stringify)\s*\(/,
    label: '处理 JSON 数据',
    term: 'JSON',
    zh: '一种通用数据格式',
    why: 'JSON 是程序之间传数据的通用格式：parse 把文字变对象，stringify 把对象变文字。',
  },
  {
    key: 'arrow',
    match: /=>/,
    label: '箭头函数',
    term: '=>',
    zh: '箭头函数',
    why: '=> 是写小函数的一种简写：左边是参数，右边是要做的事，常用来给排序、筛选传一段规则。',
  },
  {
    key: 'const',
    match: /^\s*(const|let|var)\s+\w+\s*=/,
    label: '声明变量接结果',
    term: 'const / let',
    zh: '声明变量',
    why: '把右边算出来的结果存进左边的名字里，后面直接用；const 表示以后不再改指另一个值。',
  },
  {
    key: 'https',
    match: /\bfetch\s*\(|\baxios\.|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b/,
    label: '发网络请求',
    term: 'fetch',
    zh: '发网络请求的写法',
    why: '向一个网址发请求并等它返回数据，通常用于调用接口。',
  },
  {
    key: 'fs',
    match: /\b(fs|fsp|fs\.promises|readFileSync|writeFileSync|readFile|writeFile)\b/,
    label: '读写本地文件',
    term: 'fs',
    zh: '文件系统模块',
    why: 'fs 是 Node.js 读写文件的模块；带 Sync 的方法表示读完或写完才继续，简单但会暂时挡住后面的代码。',
  },
  {
    key: 'promise',
    match: /\.then\s*\(|\.catch\s*\(/,
    label: '接续处理',
    term: '.then / .catch',
    zh: '接续处理',
    why: '不用 await 时，可以用 .then 在上一步完成后接着处理，.catch 专门接错误。',
  },
  {
    key: 'function',
    match: /^\s*(export\s+)?(async\s+)?function\b/,
    label: '定义函数',
    term: 'function',
    zh: '函数',
    why: '把一段会重复用到的操作起个名字存起来，以后调用这个名字就等于执行那一段。',
  },
  {
    key: 'if',
    match: /^\s*(else\s+)?if\s*\(/,
    label: '条件判断',
    term: 'if',
    zh: '如果',
    why: '先判断括号里的条件成不成立，成立就执行下面花括号里的内容。',
  },
  {
    key: 'loop',
    match: /^\s*(for|while)\s*\(/,
    label: '循环',
    term: 'for / while',
    zh: '循环',
    why: '让同一段代码按条件重复执行多次，通常用来逐项处理一批数据。',
  },
  {
    key: 'try',
    match: /^\s*(try\s*\{|catch\b)/,
    label: '错误兜底',
    term: 'try / catch',
    zh: '先试，出错就接住',
    why: '把可能出错的步骤放进 try，出错就跳到 catch 处理，程序不会直接崩掉。',
  },
  {
    key: 'return',
    match: /^\s*return\b/,
    label: '返回结果',
    term: 'return',
    zh: '返回',
    why: '把结果交回给调用这个函数的地方，函数到这里就结束。',
  },
  {
    key: 'import',
    match: /^\s*import\b/,
    label: '引入依赖',
    term: 'import',
    zh: '导入',
    why: '从别的文件或第三方包把现成功能引进来，避免自己重写一遍。',
  },
  {
    key: 'env',
    match: /\bprocess\.env\b/,
    label: '读环境变量',
    term: 'process.env',
    zh: '环境变量',
    why: '环境变量是运行环境给的配置，常用来放密钥、路径这类不该写死在代码里的值。',
  },
]

/**
 * 一行代码 → 一个通用写法，没有可讲的返回 null。
 * @returns {{key:string,label:string,term:string,zh:string,why:string}|null}
 */
export function teachLine(line) {
  const trimmed = str(line).trim()
  if (!trimmed) return null
  if (/^(\"|\')?$/.test(trimmed)) return null
  for (const rule of TEACH_RULES) {
    if (rule.match.test(trimmed)) {
      return { key: rule.key, label: rule.label, term: rule.term, zh: rule.zh, why: rule.why }
    }
  }
  return null
}

/* ── 行尾注释：动作 + 半句为什么 ───────────────────────────────────── */

/**
 * 每种通用写法只补半句「为什么 / 术语对照」，直接拼在行尾动作说明后面。
 * 不放独立面板；同一写法只在第一次出现的那行解释。
 */
const TEACH_HINTS = {
  async: 'async（异步函数）标记后里面才能用 await',
  await: 'await（等待异步完成）表示等这步跑完再继续',
  'tool-call': 'tools（工具集）后面跟工具名、括号里传参数',
  timeoutMs: 'timeoutMs（超时毫秒）防止命令卡死',
  command: 'command（命令，必填）其余参数可选',
  options: '这是可选参数，按需给',
  'console.log': 'console.log（控制台打印）最直接查看结果',
  json: 'JSON（通用数据格式）parse 变对象、stringify 变文字',
  arrow: '=>（箭头函数）给排序/筛选传一段规则',
  const: 'const（声明后不再改指）把结果留着后面用',
  https: 'fetch（发请求）联网取回数据',
  fs: '',
  process: '',
  path: '',
  promise: '.then（接续处理）上一步完成后再接着做',
  function: 'function（函数）把一段操作起名存起来',
  if: 'if（如果）先判断条件再决定做不做',
  loop: 'for/while（循环）让同一段代码重复执行',
  try: 'try/catch（先试，出错就接住）',
  return: 'return（返回）把结果交回调用处',
  import: 'import（导入）把现成功能引进来',
  env: 'process.env（环境变量）读运行环境给的配置',
}

/**
 * 把「为什么这么写」压进行尾注释，不再单独出面板。
 * 没有动作说明的行保持空字符串，交给模型补；同一写法只在第一次解释，后续标「（同上）」。
 * @param {string} code
 * @param {string} [lang]
 * @param {string[]} notes explainCodeLines 的结果
 * @returns {string[]}
 */
export function enrichLineNotes(code, lang, notes) {
  const lines = str(code).split(/\r?\n/)
  const seen = new Set()
  return (Array.isArray(notes) ? notes : []).map((raw, index) => {
    const note = str(raw)
    if (!note) return ''
    const hit = teachLine(lines[index])
    if (!hit) return note
    if (seen.has(hit.key)) return clip(note + '（同上）', 60)
    seen.add(hit.key)
    const hint = TEACH_HINTS[hit.key]
    // 说明本身已经很长时不再追加通用写法，避免把具体表达式挤出屏幕
    return hint && note.length < 40 ? clip(note + '，' + hint, 96) : note
  })
}
