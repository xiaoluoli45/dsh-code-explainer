# dsh-code-explainer

把 DeepSeek Harness（DSH）里 agent 实际执行的代码，**逐行**翻译成不懂编程的人也能看懂的中文。

解释直接写在工具卡代码块的每一行末尾，灰色注释样式，不额外占用版面：

```typescript
const r = await tools.ops_bash({      // 调用命令行工具，把结果存起来，await（等待异步完成）表示等这步跑完再继续
  command: "Get-ChildItem -LiteralPath 'D:\\project'",  // 列出文件夹里有哪些文件，command（命令，必填）其余参数可选
  description: "List directory contents",  // 给这次操作加一句说明，这是可选参数，按需给
  timeoutMs: 60000                     // 最多等 60 秒，timeoutMs（超时毫秒）防止命令卡死
});
console.log(JSON.stringify(r, null, 2));   // 把结果打印出来，console.log（控制台打印）最直接查看结果
```

空行、纯括号、纯注释行不会硬加说明；太长的注释会随代码一起换行，不会盖住原代码。

工具跑完的**输出区**也解释，但按输出类型区别对待：

```text
输入（灰 //）  command: "Get-ChildItem -LiteralPath 'D:\\project'"   // 列出文件夹里有哪些文件

输出（蓝 →）   const r = await tools.ops_bash({                     → 调用命令行工具，把结果存起来
               console.log(JSON.stringify(r, null, 2));              → 把结果打印出来
```

- 输出是**代码**（读到的源码、脚本片段、diff）：逐行加行尾说明，用蓝色 `→`，和输入区分。
- 输出是**普通文本**（目录清单、日志、纯数据）：块首加一句「这段输出是……」，只给关键行加说明（报错、退出码、找不到文件等），不逐行硬凑。

## 行尾注释承担两层信息

代码块下方不再有教学面板，所有说明都写在行尾同一句注释里：

- 前半句说清「这行在做什么」，必要时用半句补「为什么这么写 / 这是什么通用写法」。
- 同一种写法反复出现时，只在第一次出现的那行解释；后面标「（同上）」，避免整页重复。
- 术语第一次出现给中文对照（如 `await（等待异步完成）`），后续不再解释。
- 注释是灰色伪元素，在行尾，不进入 `textContent`；复制和选中拿到的仍是原始代码。
- 长行允许注释换到下一行，但代码本身保持原样，不会被挤掉。
- 顶部「注释：开/关」总开关保留，关掉后回到原始纯代码视图。

```text
await 第一次出现   // 调用命令行工具，把结果存起来，await（等待异步完成）表示等这步跑完再继续
同写法第二次出现   // 等第二步做完（同上）
```

## 长什么样

- 注释挂在每一行的行尾（CSS `::after`），颜色比代码淡，和语法高亮并存。
- 输入用灰色 `//`，输出用蓝色 `→`，一眼能分清哪条说的是「要执行的代码」、哪条说的是「执行结果」。
- 代码块下方没有额外面板；「为什么这么写」已经并进对应行的行尾注释。
- 代码块右上角多一个「注释：开 / 注释：关」开关，点一下可以在所有代码块和输出区隐藏/显示注释，状态记在浏览器 `localStorage`。
- 复制按钮复制到的仍然是**原始代码**：注释不在 DOM 文本里，不会被复制；选中代码时也不会带上注释。
- 不再有工具卡下方的独立说明卡，避免同一件事出现两套解释。

## 解释什么

| 对象 | 例子 |
| --- | --- |
| 命令行 | `Get-ChildItem` → 列出文件夹里有哪些文件；`Remove-Item -Recurse` → 删除指定的文件或文件夹；`npm install` → 安装项目需要的第三方代码包 |
| 工具调用 | `await tools.ops_bash({...})` → 调用命令行工具，把结果存起来 |
| 参数行 | `command:` → 要执行的命令；`description:` → 给这次操作加一句说明；`timeoutMs: 60000` → 最多等 60 秒 |
| 常见语句 | `console.log(...)` → 把结果打印出来；`return` → 把结果交回去；`if (...)` → 先判断一个条件；`for (...)` → 重复处理每一项 |
| 赋值/等待 | `const x = await ...` → 等这一步做完，把结果存起来 |
| 模块/API | `await import("node:fs")` → 动态加载文件系统模块，返回模块对象，`node:` 前缀表示内置模块；`fs.readFileSync("a.txt","utf8")` → 读取文件内容，`utf8` 是编码选项；`path.join(...)` → 拼路径；`process.env.X` → 读环境变量 |

规则覆盖不到的复杂行，交给模型补一句（见下）。

## 安装

要求：DSH `>= 0.2.0`，Node `>= 20`。

```powershell
dsh plugin --profile desktop add "link:<本仓库目录的绝对路径>"
```

装完刷新 DSH 页面（`Ctrl+R`）或重启宿主。卸载：

```powershell
dsh plugin --profile desktop remove dsh-code-explainer
```

> `package.json` 声明了 `dsh.bundle.patch`，宿主会把 `cordis.patch.yml` 挂到 profile 层；不需要改 DSH 安装目录。

## 配置

编辑 `cordis.patch.yml`，或安装时由 profile 传入：

```yaml
- insert:
    - id: dsh-code-explainer
      name: './index.js'
      config:
        llm: auto
        # provider: deepseek-official
        # model: deepseek-chat
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时插件完全不工作 |
| `llm` | `auto` | `auto` 规则判不出的行自动请模型补；`off` 只用本地规则，不调用模型 |
| `provider` / `model` | 空 | 显式指定补充用的模型；留空优先复用当前会话最近一次请求的模型路由，再兜底到第一个可用模型 |
| `maxInputChars` | `8000` | 发给模型的输入上限 |
| `maxOutputTokens` | `900` | 模型输出上限 |
| `timeoutMs` | `25000` | 单次模型调用超时 |
| `concurrency` | `2` | 模型补充的并发上限 |

页面里的「注释：开/关」是给人用的可见开关，状态存在浏览器本地；`enabled` 是插件级开关，管的是要不要启动。

## 工作方式

### 浏览器半身（`client.js`）

1. 在 `[data-chat-call-id]` 里的 `.md-code-block` 上找到**输入**代码块，取出每行文本（`pre > code > span.line`）。
2. `POST /line-notes` 拿逐行说明；对每个 `.line` 只写 `data-dce-note` 属性。
3. 说明由 CSS 伪元素渲染：`content: "  // " attr(data-dce-note)`。伪元素不进入 `textContent`，所以复制按钮（读 `pre.textContent`）拿到的仍是原代码，选中也不会带注释。长行按可见宽度加 `data-dce-long="1"`，注释换到下一行。
4. **输出区**（`[class*="ioText"]`）先分类：代码 → 去掉 `1: ` 行号后按行说明（蓝色 `→`）；JSON/日志/清单/普通文本 → 输出块上方插一行 `.dce-io-head` 总述，关键行写 `data-dce-onote`。按行拆分时只用 `<span class="dce-ol">` 保留原文字与换行，说明仍走伪元素。
   - 总述**插在 ioSection 外侧**：作为 `ioCard` 的子节点、紧挨在输出那个 `ioSection` 前面。宿主的 `ioSection` 是 `display:grid; grid-template-columns:max-content 1fr` 的「标签 + 正文」两格，**往里多塞一个子节点**，自动排布就会把 `ioText` 挤到第二行第一列，正文被甩到下面、上面留一片空白。`test/output-card.mjs` 就是守这条结构的回归测试。
5. `MutationObserver` 观察会话 DOM；React 重渲染后自动补回属性。每 3 秒还会兜底扫一次。
6. 开关按钮插在代码块自己的标题栏里（`[data-code-block-banner]`），不额外加卡片。
7. 工具卡还在运行时（`data-state="running"`）只取规则结果，等状态结束再请模型补，避免半截代码反复调用模型。

### 宿主半身（`index.js`）

1. `POST /line-notes` 收到代码文本后，先用本地规则逐行给动作说明（零成本、零等待），再用 `enrichLineNotes` 把通用写法、术语对照压进同一句行尾注释。
   - **语言判定不只看标签**：工具卡的代码块大多没有 `lang`，所以标签缺席时按内容特征判方言：逐行看像不像 PowerShell 语句（`$var =` 赋值、`Get-ChildItem` 形式的动词-名词 Cmdlet、`| Cmdlet` 管道、`$env:` / `$_` / `$ErrorActionPreference` 这类自动变量），也逐行看像不像 JS（`const` / `import` / `console.` / `=>` / 收尾括号）。PowerShell 语句至少 2 行、且比 JS 语句多（只有一行的块，只要那行是 PowerShell 也算），才把整块当 shell 讲；否则退回 JS 规则。判定前先摘掉记录里带出来的提示符（`PS C:\work>`、`PS>`），Cmdlet 不分大小写，`$btn = $("#id")` 这种 jQuery 不算 PowerShell 赋值，`||` 不算管道。行数对峙比打分更稳：一段 JS 里夹一句 PowerShell 字符串时，打分版会整块误判成 shell。
2. 规则给不出动作说明的行，用 `ctx.llm.stream()` 请模型按行号补一句；结果按内容哈希缓存，同一段代码不重复请求。
3. 模型输出是 `{"notes":{"行号":"说明"}}`；解析失败、超时、没有可用模型时保留规则结果，不阻塞页面。
4. AI 补出的行直接进入同一个 `notes` 数组，前端不再需要额外字段。补充结果写入 `~/.dsh/dsh-code-explainer/line-notes.jsonl`（最多读回最近 800 条）。

### 本地 HTTP 接口

前缀 `/dsh-code-explainer/api`，只接受回环地址。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活检查 |
| GET | `/state` | 开关、模型模式、缓存条数、模型是否可用 |
| POST | `/line-notes` | `{code, lang, ai}` → 逐行说明 `notes`（已含为什么）；`ai:false` 只给规则结果，模型补充异步进行 |
| GET | `/line-notes?hash=…` | 取补充后的最新结果（前端在 `aiStatus=running` 时轮询） |

## 隐私、成本与降级

- **凭据**：`sk-...`、`ghp_...`、`github_pat_...`、`Bearer ...`、`api_key/token/password=...` 在展示、落盘、发给模型前都替换成 `***`。
- **成本**：规则优先；只有规则判不出的行才请求模型，且按代码内容哈希缓存，重复代码不重复请求；`llm: off` 可完全关闭模型调用。
- **降级**：模型不可用、超时、返回为空或 JSON 解析失败时，页面保留规则说明，不会影响工具执行，也不会改用户当前的模型选择。
- **不写会话**：辅助调用不向会话日志追加事件。

## 验证到什么程度

已经做过：

- `node --check index.js / rules.js / client.js / test/smoke.mjs` 通过。
- `node test/smoke.mjs` 通过：逐行规则、具体 API 识别（`import()`/`require()`、`fs`、`path`、`process`）、同写法去重、未识别标注、凭据掩码、HTTP、模型补充、哈希缓存、运行中不请模型、无模型降级、落盘脱敏。
- `node test/output-card.mjs` 通过：用最小 DOM 桩复刻宿主的 ioCard > ioSection >（ioLabel + ioText）结构，断言总述挂在外侧、ioSection 始终只有两个子节点、拆行不改原文。把旧实现塞回 ioSection 里跑，这条测试立刻红。
- `node test/powershell.mjs` 通过：无标签的 PowerShell 代码按 shell 规则解释（`$ErrorActionPreference` 赋值、`Start-Sleep`、`New-Object`、`Get-ChildItem | Where-Object`、`Out-File` 都给具体说明），JS 的赋值/减法/按位或不会被误判。
- 代码块 DOM 契约（`.md-code-block` / `[data-code-block-banner]` / `pre > code > span.line` / 复制读 `pre.textContent`）来自 DSH `0.2.1-rc.5` 前端产物的实现。
- **DSH 0.2.1-rc.5 实测**（插件 0.4.0，`run_code` 执行 `const fs = await import("node:fs"); console.log(fs.readdirSync("D:\\project\\demo").slice(0, 3));`）：
  - 该行行尾注释为「动态加载 文件系统模块 fs，返回模块对象，后面用 fs 调用；node: 前缀表示 Node 内置模块」，不再只讲 `await`/`const`；
  - 同一段里第二次 `import("node:fs")` 标成「（同上）」；`try {` 行标「试着做下面的操作，try/catch（先试，出错就接住）」；
  - 代码块下方直接是输出区，没有「为什么这么写」按钮或面板；
  - 长注释换到下一行，代码本身没有被挤掉；
  - 点复制按钮后剪贴板得到的是完整原始代码，不含任何注释；
  - 截图仅用于本地验证，不随仓库发布。
- 修正过：`ops_bash` 的输入 JSON 与输出共用同一 DOM 结构，已按「输入/输出」标签过滤；面板时代代码块高度被压缩的问题随面板删除一并消失。
- 修正过（0.4.2）：工具卡的代码块几乎都没有 `lang` 标签，PowerShell 语句一律按 JS 规则处理、一句都判不出（#4 采样 1630 行里具体说明只有 5.6%）。现在标签缺席时按内容判方言。实测同一批样本（25 个最大的会话记录、15 个含 PowerShell 特征的代码块、378 行），PowerShell 行有说明的比例从 6.6%（25 行）升到 20.6%（78 行）。
- 修正过（0.4.1）：输出区的总述原本插进 `ioSection` 内部，等于给两列 grid 加了第三个子节点，正文被挤到下一行、上面留一大片空白。现在改成插在 `ioSection` 外侧，并补了 `test/output-card.mjs`。

**没有验证**（离线测试不能替代）：

- 假 `ctx.llm` 只验证协议形状，不代表真实模型可用；真实模型对具体 API 的解释效果仍要在 DSH 里实测。
- 宿主升级后的代码块 DOM 是否保持同样结构，未验证。

## 已知边界

- 依赖宿主代码块的 DOM 契约（`span.line`、`data-code-block-banner`）；DSH 前端大改时需要同步改选择器。
- 输出区版式依赖宿主 `ioSection` 是「两列 grid」这一事实：插件只往它外面加节点，绝不插进去；宿主若改成 flex，`test/output-card.mjs` 需要同步。
- 内容判方言是启发式：PowerShell 与其它脚本长得像时会漏判（仍按 JS 讲），继续补特征时要注意别把 JS 误判成 shell。
- 多行字符串里的行也会被当作独立代码行判断，可能出现不准确的注释。
- 长行注释是否换行，按代码块可见宽度和字符数估算（约 7.2px/字符）；不同字号或等比缩放时可能提前/延后换行。
- 一行里有多个表达式嵌套时只讲外层：如 `fs.readFileSync(path.join(__dirname, "a.json"), "utf8")`，可能把 `path.join` 里的字符串误当成文件路径和编码选项。
- `require("node:fs").readdirSync(".")` 这类链式调用只讲加载模块，不讲后面的方法。
- 条件表达式、可选链、模板字符串、Promise 链、数组 `map/filter` 链目前多半只给一句通用说明，尚未逐个成分拆解。
- 规则和模型都没覆盖的调用会标「未识别：xxx」，只标出调用名，不解释参数。
- 同一写法去重按单个代码块统计；输入和输出两个代码块会各自解释一次。
- 只处理会话里工具卡内的代码块，不处理 markdown 正文里的代码块。
- 「注释：开/关」是浏览器本地状态，不跟随账号同步。
- 注释的通俗程度取决于规则覆盖和模型本身；提示词禁止术语和复述代码，但不能保证每条都完美。

## 开发与测试

```powershell
node --check index.js
node --check rules.js
node --check client.js
node test/smoke.mjs
node test/output-card.mjs
node test/powershell.mjs
```

冒烟测试使用临时目录（`DSH_CODE_EXPLAINER_DIR`），不会写入真实的 `~/.dsh` 数据。

## License

MIT © 2026 xiaoluoli45

本项目以 MIT 协议开源，可自由使用、修改和分发，保留版权与许可声明即可。完整条款见 [LICENSE](LICENSE)。
