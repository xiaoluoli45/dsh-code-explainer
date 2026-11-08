/**
 * dsh-code-explainer — 本地规则解释
 *
 * 纯函数、零依赖：把一次工具调用的参数/结果翻译成非程序员能看懂的中文。
 * 规则解释是即时的兜底；AI 解释失败或用户没展开卡片时，页面显示的就是这份内容。
 */

/** 默认需要解释的工具：会执行命令、运行程序、写文件、改文件、向终端输入的工具。 */
export const DEFAULT_TOOLS = Object.freeze([
  'pwsh',
  'bash',
  'run_code',
  'terminal_send',
  'write',
  'edit',
  'str_replace_editor',
])

/* ── 文本工具 ───────────────────────────────────────────────────────── */

function str(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function clip(text, max) {
  const value = str(text)
  if (value.length <= max) return value
  return value.slice(0, max) + '…'
}

function baseName(filePath) {
  const value = str(filePath)
  if (!value) return ''
  const parts = value.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : value
}

function unique(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const value = str(item).trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
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
 *   test    —— 命中命令/代码的正则
 *   title   —— 卡片摘要里的短标题
 *   action  —— 拼进“这条命令会……”的动词短语
 *   steps   —— 关键步骤（白话）
 *   risks   —— 可能的影响（白话）
 */
const COMMAND_RULES = [
  {
    test: /\brm\s+-\S*[rf]\S*|\brm\b|Remove-Item\b[^|;]*-(?:Recurse|Force)|\brmdir\s+\/s|\brd\s+\/s|\bdel\s+\/[sqf]/i,
    title: '删除文件或文件夹',
    action: '删除指定的文件或文件夹',
    steps: ['找到要删除的位置', '执行删除'],
    risks: ['删除后通常无法恢复'],
  },
  {
    test: /\bgit\s+push\b[^\n]*(?:--force|-f\b)/i,
    title: '强制上传代码',
    action: '强制把本地代码上传到远程仓库',
    steps: ['连接远程代码仓库', '用本地内容覆盖远程记录'],
    risks: ['会覆盖远程仓库的历史', '可能影响其他人的工作'],
  },
  {
    test: /\bgit\s+push\b/i,
    title: '上传代码到远程仓库',
    action: '把本地保存的代码上传到远程仓库',
    steps: ['连接远程代码仓库', '上传本地的新提交'],
    risks: ['需要联网', '上传后的内容其他人可能看到'],
  },
  {
    test: /\bgit\s+(?:reset\s+--hard|clean\s+-)/i,
    title: '丢弃本地改动',
    action: '撤销本地还没保存的改动',
    steps: ['找到本地改动', '把这些改动丢弃'],
    risks: ['丢弃后通常找不回来'],
  },
  {
    test: /\bgit\s+commit\b/i,
    title: '保存代码快照',
    action: '把当前的代码改动保存成一个历史记录',
    steps: ['收集已选中的改动', '保存成一条提交记录'],
    risks: [],
  },
  {
    test: /\bgit\s+(?:add|stage)\b/i,
    title: '挑选要保存的改动',
    action: '把改动标记为“准备保存”',
    steps: ['找出改动过的文件', '标记为准备提交'],
    risks: [],
  },
  {
    test: /\bgit\s+clone\b/i,
    title: '下载一个代码仓库',
    action: '从网上下载一份完整的代码仓库',
    steps: ['连接远程仓库', '把代码复制到本地'],
    risks: ['需要联网', '会占用磁盘空间'],
  },
  {
    test: /\bgit\s+(?:status|diff|log|show|branch|remote|rev-parse)\b/i,
    title: '查看代码仓库状态',
    action: '查看代码仓库当前的状态或历史',
    steps: ['读取仓库信息', '把结果显示出来'],
    risks: [],
  },
  {
    test: /\b(?:npm|pnpm|yarn)\s+(?:install|i|ci|add)\b/i,
    title: '安装项目依赖',
    action: '安装这个项目需要的第三方代码包',
    steps: ['读取项目的依赖清单', '从网上下载并安装这些包'],
    risks: ['需要联网', '会新增或改动依赖目录和锁文件'],
  },
  {
    test: /\b(?:pip3?|uv|poetry)\s+(?:pip\s+)?(?:install|add)\b/i,
    title: '安装 Python 依赖',
    action: '安装这段 Python 代码需要的第三方包',
    steps: ['读取依赖信息', '从网上下载并安装'],
    risks: ['需要联网', '会改动 Python 环境'],
  },
  {
    test: /\b(?:npm|pnpm|yarn)\s+run\b|\bnpx\b/i,
    title: '运行项目脚本',
    action: '运行项目里预先写好的一段脚本',
    steps: ['找到对应的脚本', '执行脚本并读取结果'],
    risks: ['脚本可能读写文件或访问网络'],
  },
  {
    test: /\b(?:node|python3?|deno|bun)\b[^\n]*|\b(?:pwsh|powershell)\b[^\n]*\.ps1\b/i,
    title: '运行一段程序',
    action: '让电脑运行一段程序',
    steps: ['准备运行环境', '执行程序', '读取运行结果'],
    risks: ['程序可能读写文件或访问网络'],
  },
  {
    test: /\bcurl\b|\bwget\b|Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b/i,
    title: '联网获取或发送数据',
    action: '通过网络访问一个地址并取回结果',
    steps: ['连接目标地址', '发送请求', '读取返回内容'],
    risks: ['需要联网', '会把请求内容发给对方服务器'],
  },
  {
    test: /\bStart-Process\b|\bschtasks\b|\breg\s+add\b|\bSet-Service\b|\bNew-Service\b|\bsc\s+config\b|\bnetsh\b/i,
    title: '修改系统设置',
    action: '修改电脑的系统级设置或启动项',
    steps: ['打开系统设置入口', '写入新的设置'],
    risks: ['会影响系统或其他程序', '改动后可能需要手动恢复'],
  },
  {
    test: /\bmkdir\b|\bNew-Item\b[^|;]*-ItemType\s+Directory|\bmd\s+/i,
    title: '新建文件夹',
    action: '在指定位置新建一个文件夹',
    steps: ['找到目标位置', '创建文件夹'],
    risks: [],
  },
  {
    test: /\bCopy-Item\b|\brobocopy\b|\bcp\b|\bcopy\b/i,
    title: '复制文件',
    action: '把文件复制到另一个位置',
    steps: ['找到原文件', '复制到目标位置'],
    risks: ['目标位置如果有同名文件，可能被覆盖'],
  },
  {
    test: /\bMove-Item\b|\bmv\b|\bmove\b/i,
    title: '移动或重命名文件',
    action: '把文件移到别的位置，或给它改名',
    steps: ['找到原文件', '移动到目标位置'],
    risks: ['目标位置如果有同名文件，可能被覆盖'],
  },
  {
    test: /\bGet-Content\b|\bcat\b|\btype\b|\bhead\b|\btail\b|\bmore\b/i,
    title: '查看文件内容',
    action: '读取一个文件里的文字并显示出来',
    steps: ['找到文件', '读取内容'],
    risks: [],
  },
  {
    test: /\bGet-ChildItem\b|\bdir\b|\bls\b|\btree\b/i,
    title: '查看目录内容',
    action: '列出某个文件夹里有哪些文件和子文件夹',
    steps: ['找到目标文件夹', '列出里面的内容'],
    risks: [],
  },
  {
    test: /\bSelect-String\b|\bgrep\b|\bfindstr\b/i,
    title: '搜索文字',
    action: '在文件或输出里查找一段文字',
    steps: ['读取要搜索的范围', '查找匹配的文字'],
    risks: [],
  },
  {
    test: /\bSet-Location\b|\bpushd\b|\bcd\b/i,
    title: '切换工作目录',
    action: '把当前工作位置切换到另一个文件夹',
    steps: ['找到目标文件夹', '切换过去'],
    risks: [],
  },
  {
    test: /\bWrite-Output\b|\bWrite-Host\b|\becho\b/i,
    title: '输出一段文字',
    action: '在屏幕上显示一段文字',
    steps: ['准备要显示的文字', '显示出来'],
    risks: [],
  },
  {
    test: /\bTest-Path\b|\bGet-Item\b|\bGet-Command\b|\bwhere\b|\bwhich\b/i,
    title: '检查文件或命令是否存在',
    action: '确认某个文件或命令在电脑上是否存在',
    steps: ['按名字查找', '返回查找结果'],
    risks: [],
  },
]

/* ── 文件类工具 ─────────────────────────────────────────────────────── */

function countLines(text) {
  const value = str(text)
  if (!value) return 0
  return value.split(/\r?\n/).length
}

function fileExplain(tool, args) {
  const filePath = str(args.file_path || args.path || args.filePath || args.file || '')
  const name = baseName(filePath) || '目标文件'
  const content = str(args.content || args.file_text || args.new_string || args.new_str || args.text || '')
  const oldText = str(args.old_string || args.old_str || '')

  if (tool === 'write') {
    const lines = countLines(content)
    return {
      title: content ? '写入文件' : '创建一个空文件',
      purpose: content
        ? `把一段内容保存到文件「${name}」里。`
        : `创建一个空文件「${name}」。`,
      steps: [
        '找到目标位置',
        content ? `写入 ${lines} 行内容` : '创建空文件',
        '保存到磁盘',
      ],
      risks: content ? ['如果这个文件本来有内容，会被整体覆盖'] : [],
      meta: { path: filePath, contentChars: content.length },
    }
  }

  if (tool === 'str_replace_editor') {
    const command = str(args.command || '').toLowerCase()
    if (command === 'view') {
      return {
        title: '查看文件内容',
        purpose: `读取文件「${name}」的内容并显示出来。`,
        steps: ['找到文件', '读取内容'],
        risks: [],
        meta: { path: filePath },
      }
    }
    if (command === 'create') {
      return {
        title: '创建文件',
        purpose: `新建文件「${name}」并写入内容。`,
        steps: ['找到目标位置', '创建文件', '写入内容'],
        risks: ['如果文件本来存在，可能被覆盖'],
        meta: { path: filePath, contentChars: content.length },
      }
    }
    if (command === 'insert') {
      return {
        title: '在文件里插入内容',
        purpose: `在文件「${name}」的指定位置插入一段新内容。`,
        steps: ['打开文件', '找到插入位置', '插入内容并保存'],
        risks: ['插入位置不对时，文件结构可能被破坏'],
        meta: { path: filePath },
      }
    }
    return {
      title: '修改文件',
      purpose: `修改文件「${name}」里的一小段内容。`,
      steps: ['打开文件', '找到旧内容', '替换成新内容', '保存'],
      risks: ['只替换匹配到的部分；如果匹配到多处，可能改到预期之外的位置'],
      meta: { path: filePath, oldChars: oldText.length },
    }
  }

  // edit
  return {
    title: '修改文件',
    purpose: `修改文件「${name}」里的一小段内容。`,
    steps: ['打开文件', '找到旧内容', '替换成新内容', '保存'],
    risks: ['只替换匹配到的旧内容；如果旧内容不唯一，可能改到别的位置'],
    meta: { path: filePath, oldChars: oldText.length },
  }
}

/* ── 主入口 ─────────────────────────────────────────────────────────── */

/**
 * 生成规则解释。
 * @param {{ tool: string, args: object, result: { ok: boolean, exitCode: number|null, outputExcerpt: string } }} input
 * @returns {{ title: string, purpose: string, steps: string[], risks: string[], meta: object }}
 */
export function explainWithRules(input) {
  const tool = str(input && input.tool)
  const args = input && input.args && typeof input.args === 'object' ? input.args : {}
  const result = (input && input.result) || {}
  const ok = result.ok !== false

  // 文件类工具单独处理
  if (tool === 'write' || tool === 'edit' || tool === 'str_replace_editor') {
    const explained = fileExplain(tool, args)
    if (!ok) {
      explained.purpose += '（这次操作没有成功）'
      explained.risks = unique([...explained.risks, '这次操作没有成功，需要查看报错'])
    }
    return explained
  }

  if (tool === 'terminal_send') {
    return {
      title: '向终端输入内容',
      purpose: '把一段内容送进正在运行的终端窗口。',
      steps: ['找到正在运行的终端', '把内容送进去'],
      risks: ['输入会直接作用在当前运行的程序上，可能立即执行'],
      meta: { inputChars: str(args.input || args.text || args.command || '').length },
    }
  }

  // 命令/程序类：把命令和代码放在一起做模式匹配
  const command = str(args.command || args.cmd || '')
  const code = str(args.code || args.script || '')
  const scanned = [command, code].filter(Boolean).join('\n')
  const matched = COMMAND_RULES.filter((rule) => rule.test.test(scanned))

  let title = '执行一条命令'
  let purpose = '让电脑按指令做一件事，然后根据输出决定下一步。'
  let steps = ['把指令交给电脑执行', '读取执行结果']
  let risks = []

  if (matched.length > 0) {
    title = matched.length === 1 ? matched[0].title : `${matched[0].title}等操作`
    purpose = `这条指令会${matched.slice(0, 3).map((rule) => rule.action).join('，然后')}。`
    steps = unique(matched.flatMap((rule) => rule.steps)).slice(0, 4)
    risks = unique(matched.flatMap((rule) => rule.risks))
  } else if (tool === 'run_code') {
    title = '运行一小段程序'
    purpose = '运行一小段程序，用来自动完成一步操作。'
    steps = ['准备运行环境', '执行程序', '读取结果']
    risks = ['程序可能读写文件或访问网络，具体取决于代码内容']
  }

  if (command) steps = [`准备执行：${clip(command.replace(/\s+/g, ' ').trim(), 60)}`, ...steps].slice(0, 4)
  if (!ok) {
    purpose += '（这次执行没有成功）'
    risks = unique([...risks, '这次执行没有成功，需要查看输出里的报错'])
  }

  return {
    title,
    purpose,
    steps,
    risks,
    meta: {
      commandPreview: clip(redact(command.replace(/\s+/g, ' ').trim()), 160),
      codeChars: code.length,
    },
  }
}
