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
]

const SHELL_LANGS = /^(pwsh|powershell|ps1|bash|sh|shell|shellscript|zsh|cmd|bat|console|terminal)$/i

function shortNote(text) {
  return clip(redact(str(text).replace(/。$/, '')), 30)
}

/** 一条命令行 → 一句说明；认不出来返回 '' */
export function explainCommandLine(line) {
  const text = str(line).trim()
  if (!text) return ''
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
  const lines = str(code).split(/\r?\n/)
  const shellLike = SHELL_LANGS.test(str(lang).trim())
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

/**
 * 整段代码 → 教学信息：一句总述 + 按写法聚合的条目（附出现行号）+ 术语表。
 * 同一种写法只保留一条，重复出现的行号挂在同一条上。
 */
export function teachCode(code, lang) {
  const lines = str(code).split(/\r?\n/)
  const shellLike = SHELL_LANGS.test(str(lang).trim())
  const patterns = []
  const index = new Map()
  const terms = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (shellLike && !/^\s*(?:const|let|var|import|async|await|function|export|if|for|while|try|catch|return|console)\b/.test(line)) {
      continue
    }
    const hit = teachLine(line)
    if (!hit) continue
    let pattern = index.get(hit.key)
    if (!pattern) {
      pattern = { key: hit.key, label: hit.label, term: hit.term, zh: hit.zh, why: hit.why, lines: [] }
      index.set(hit.key, pattern)
      patterns.push(pattern)
      terms.push({ term: hit.term, zh: hit.zh })
    }
    pattern.lines.push(i + 1)
  }
  const summary = patterns.length
    ? '这段代码主要用到了：' + patterns.slice(0, 4).map((p) => p.label).join('、') + '。'
    : ''
  return { summary, patterns, terms }
}
