# dsh-code-explainer

把 DeepSeek Harness（DSH）里 agent 实际执行的命令、程序和文件修改，翻译成不懂代码的人也能看懂的中文。

每条工具调用卡片下方会多出一张默认收起的说明卡：

```text
▸ 这段代码在干什么   安装项目依赖                     本地规则 · 展开可补充
    这条指令会安装这个项目需要的第三方代码包。
    · 读取项目的依赖清单
    · 从网上下载并安装这些包
    可能的影响：需要联网；会新增或改动依赖目录和锁文件
    本地规则解释
```

原始命令、diff、输出仍然留在 DSH 自带的工具卡里，解释卡不重复展示代码。

## 解释什么

| 工具 | 说明 |
| --- | --- |
| `pwsh` / `bash` | 命令目的、关键动作、风险（删除、联网、装包、上传、改系统设置等） |
| `run_code` | 程序大致在做什么；能识别代码里的常见文件/网络操作 |
| `write` | 往哪个文件写入、大概多少内容、是否覆盖原文件 |
| `edit` / `str_replace_editor` | 修改哪个文件、替换哪一段、可能的副作用 |
| `terminal_send` | 向正在运行的终端输入内容，以及为什么可能立即生效 |

`read`、搜索、纯查询类工具默认不解释，避免刷屏。工具名单可在配置里改。

## 安装

要求：DSH `>= 0.2.0`，Node `>= 20`。

```powershell
# 方式一：命令行（与现有第三方插件相同）
dsh plugin --profile desktop add "link:<本仓库目录的绝对路径>"

# 方式二：插件管理器
plugin_manager install_bundle target='<本仓库目录的绝对路径>'
```

装完刷新 DSH 页面（`Ctrl+Shift+R`）或重启宿主。卸载：

```powershell
dsh plugin --profile desktop remove dsh-code-explainer
```

> 本插件的 `package.json` 声明了 `dsh.bundle.patch`，宿主会把 `cordis.patch.yml` 里的条目挂到 profile 层；不需要改 DSH 安装目录。

## 配置

编辑 `cordis.patch.yml` 里的 `config`，或在安装时由 profile 传入：

```yaml
- insert:
    - id: dsh-code-explainer
      name: './index.js'
      config:
        llm: onExpand
        # provider: deepseek-official
        # model: deepseek-chat
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时完全不上报解释 |
| `llm` | `onExpand` | `onExpand` 首次展开卡片才请求 AI；`auto` 工具结果落地就请求；`off` 只用本地规则 |
| `provider` / `model` | 空 | 显式指定辅助调用模型；留空则复用当前会话最近一次请求的模型路由，再兜底到第一个可用模型 |
| `maxInputChars` | `6000` | 发给模型的输入上限 |
| `maxOutputTokens` | `500` | 模型输出上限 |
| `timeoutMs` | `20000` | 单次 AI 调用超时 |
| `concurrency` | `2` | `auto` 模式下的并发上限 |
| `tools` | 见 `rules.js` | 需要解释的工具名列表 |

## 工作方式

### 宿主半身（`index.js`）

1. 监听 `tools/result`（只读观察事件，回调 `(exec, result)`，不阻断工具执行）。
2. 从 `exec.name` / `exec.arguments` / `exec.agent.session.id` 和 `result.content` 里取出工具名、参数、退出码、输出摘要。
3. **本地规则**立即生成一版解释（零成本、零等待）。
4. 如果配置允许，再通过 `ctx.llm.stream()` 调用模型补充一版更通俗的解释。
5. 结果放在内存（最多 500 条），AI 解释追加写入 `~/.dsh/dsh-code-explainer/explanations.jsonl`。

### 浏览器半身（`client.js`）

- DSH 的插槽里没有“在内置工具卡下方追加内容”的位置；`tool.call.toolview` 会整卡替换内置卡片。
- 工具卡外层有稳定属性 `data-chat-call-id` 与 `data-chat-anchor-key="call:<id>"`，本插件在内置卡片之后插入自己的折叠卡，并用 `MutationObserver` 在 React 重渲染后挂回去。
- 卡片默认收起；第一次展开时才请求 AI 补充，之后复用缓存。

### 本地 HTTP 接口

前缀：`/dsh-code-explainer/api`，只接受回环地址。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活检查 |
| GET | `/state` | 开关、LLM 模式、记录数、模型是否可用 |
| GET | `/explanations?callIds=a,b` | 按调用 id 批量取解释（只返回展示字段） |
| POST | `/explain` | `{callId}`，按需生成 AI 补充解释 |

## 隐私、成本与降级

- **凭据**：`sk-...`、`ghp_...`、`github_pat_...`、`Bearer ...`、`api_key/token/password=...` 在展示、落盘、发给模型前都会替换成 `***`。
- **成本**：默认 `onExpand`，不展开卡片就不调用模型；相同内容按哈希缓存，重复命令不重复请求。
- **降级**：AI 不可用、超时、返回为空或无法解析时，保留本地规则解释并在卡片上标注；绝不会影响工具执行。
- **不写会话**：辅助调用不修改用户当前的模型选择，也不向会话日志追加事件。

## 验证到什么程度

已经做过：

- `node --check index.js / rules.js / client.js / test/smoke.mjs` 全部通过。
- `node test/smoke.mjs` 通过，覆盖：规则解释、凭据掩码、`tools/result` 监听、子调用跳过、HTTP 查询、AI 补充、哈希缓存、无 LLM 降级、落盘脱敏。
- 扩展点结论来自本机 DSH `0.2.1-rc.5` 的源码与产物（`dsh-tools`、`dsh-llm`、`dsh-client-ui-tool`、`dsh-session`、`dsh-agent-loop`）。

**没有验证**：

- 没有把插件实际装进 DSH profile，也没有在真实页面里看过卡片位置与折叠效果。
- 没有跑过真实模型请求；AI 路径只用一个返回固定 JSON 的假 `ctx.llm` 验证了协议形状。
- 没有验证 DSH 升级后的 DOM 属性与插槽是否保持不变。

因此当前状态是「代码可安装、宿主逻辑有离线证据、UI 未实机验收」。

## 已知边界

- 依赖 `data-chat-call-id` 这个 DOM 契约；宿主大改结构时需要同步修改 `client.js` 的选择器。
- 只解释根工具调用；`run_code` 内部和子代理里的子调用不会单独出卡。
- 重启后从磁盘加载的历史记录能显示解释，但因为没有原始参数，不再支持继续点开做 AI 补充。
- 会话模型路由来自 `session/event` 的 `request/header`；插件加载前的历史会话没有捕获到路由时，会兜底到第一个可用模型。
- “通俗”程度取决于模型本身；提示词禁止术语和代码复述，但不能保证每次完全做到。

## 开发与测试

```powershell
node --check index.js
node --check rules.js
node --check client.js
node test/smoke.mjs
```

测试使用临时目录（`DSH_CODE_EXPLAINER_DIR`），不会写入真实的 `~/.dsh` 数据。

## License

MIT
