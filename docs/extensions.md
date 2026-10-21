# 扩展详细说明

[返回 README](../README.md)

各扩展的用法、配置与行为边界。安装步骤和常用命令见 README；模块职责与维护约束见 [扩展规则](../extensions/AGENTS.md)。

## 安装与迁移

推荐通过 [README 中的 Git 包命令](../README.md#安装与更新) 安装和更新。Pi 管理的包目录只存放分发代码；更新可能重置并清理整个包目录，个人密钥、配置和自定义修改不要保存在其中。

从旧的手动复制方式迁移，只需处理一次：

1. 如果使用旧 `~/.pi/agent/extensions/web-search/.env`，先将 `api_key` 与可选的 `base_url` 保存到 `~/.pi/agent/config/pi-extensions/.env.web-search`。不要覆盖已有个人配置；有两份时先核对内容。
2. 将旧安装中本仓库已有的入口 `.ts` 文件移到 Pi 自动发现目录之外备份，避免旧副本与包同时注册命令和工具。只处理 README 表中列出的扩展入口，保留其他扩展、个人规则和配置。辅助目录可能被其他扩展共用，无需删除。
3. 执行 README 中的 `pi install` 命令，再重启 Pi 或执行 `/reload`。使用 `pi list` 确认包已登记。
4. 后续只更新包；个人配置继续从固定用户目录读取。

如果继续手动安装，将仓库 `extensions/` 的内容复制到 `~/.pi/agent/extensions/`，保持相对布局完整。配套 `.ps1` 和 `.cs` 文件也需要复制。手动安装同样支持新的个人配置位置，并兼容原来的 `web-search/.env`。

文中的 `~/.pi/agent` 指 Pi 当前使用的 agent 目录；设置了 `PI_CODING_AGENT_DIR` 时，个人配置与 Pi 凭据随该目录解析。`/anim` 样式仍保存在该目录的 `settings.json` 中。

## auto-summary

文件：[`extensions/auto-summary.ts`](../extensions/auto-summary.ts)

- 注册 `/summary`（无参数）：不调用模型，保存当前分支最近一条有文本的助手回复；文件名自动取自回复标题或会话名。
- 注册 `/summary [instructions]`：使用当前模型把当前分支整理成完整 Markdown 文档，参数直接作为整理要求传给模型（无任何旗标，不存在 `--generate` 或 `-g`）。
- 文件名经过 Windows 安全清理，并以 `-v1.md`、`-v2.md` 的版本形式创建，绝不覆盖已有文件。
- 生成模式会对会话内容做有界截断，并在超过输入预算时保留开头和最近内容。
- TUI 中可用 Esc 取消生成；生成结束前会阻塞会话/分支导航。通过 Pi 的原生模型注册表发起请求，复用调用时的认证、服务地址和虚拟模型路由；即使回复失败或被取消，也会先记录有效用量，再决定是否写文档。用量写入 `extension-usage`，包含实际响应的供应商、模型、币种和结果。

## powershell-bash

文件：[`extensions/powershell-bash.ts`](../extensions/powershell-bash.ts)

- 在 Windows 上将 Pi 的 `bash`、原生 `powershell` 工具和 `!` / `!!` 执行接入同一个经过验证的 PowerShell Core 7+ 执行器（默认 `pwsh.exe`，可通过 `PI_POWERSHELL_EXE` 覆盖），Windows PowerShell 5.1 不受支持。原生 `powershell` 保持按需启用，可通过 Pi 的 `--tools`、`defaultTools` 或工具选择 API 启用。
- 对命令做 AST 解析，拦截以显式旧版 PowerShell 为目标的调用；输出为 UTF-8 纯文本流，非终止性 cmdlet 错误会使命令以失败退出码结束。
- 普通 Windows 子进程由 kill-on-close Job 持有直到退出；直接以 WSL 为目标的调用使用客户端进程树清理。默认超时 120 秒；会话关闭时会等待在跑的命令结束。
- 结果附带 `execution` 状态：操作 ID、管理进程 PID、起止时间、耗时、退出码、日志位置和清理范围。摘要区分成功、非零退出、超时及取消；单个输出日志上限 64 MiB。状态描述的是被观测的管理进程，不能证明提权进程、WSL Linux 后代或业务修改已经完成。
- `/harness tools` 查看工具注册、启用与嵌套可调用情况；`/harness execution [操作ID]` 查看已记录的执行状态，省略 ID 显示最近五次。命令不自动启用工具，也不查询当前 OS 进程状态。
- 每轮提供当前 `run-script` 可用性；本包不提供 `run-script` 入口，若没有另外安装，应先保存脚本、显式检查语法，再按路径执行。直接调用外部程序后需立即检查 `$LASTEXITCODE`；cmdlet 的 fail-fast 不会自动传播所有原生程序失败。

## tps-status

文件：[`extensions/tps-status.ts`](../extensions/tps-status.ts)

> 实现对齐 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

- 在 TUI 中测量最近一条已完成助手回复的解码速度，通过 `ctx.ui.setStatus("tps", ...)` 发布到状态栏。
- 计时窗口为首个非空文本/思考增量（或带名称/参数的工具事件）到 `message_end`，排除首字延迟（TTFT）与工具执行时间。

## anim-compaction

文件：[`extensions/anim-compaction.ts`](../extensions/anim-compaction.ts)

- 上下文压缩触发时（手动 `/compact`、阈值自动、溢出恢复）在编辑器上方显示动画 widget：旋转指示符 + 彗星条 / 均衡器波形 / 追逐点三选一，附带金色压缩耗时、待总结消息数、压缩前 token 数，以及自动/溢出触发徽标；Esc 取消仍可用，不重复内置提示行。
- 注册 `/anim` 命令切换样式（无参数弹选择列表并标记当前项，带参数直接设值），持久化写入 `settings.json`（保留其他键、拒绝损坏 JSON，序列化写入并经同目录临时文件原子替换）。
- 样式优先级：`PI_COMET_STYLE` 环境变量 > `cometCompactionStyle` > 每次随机；配色随明暗主题自适应；仅 TUI 模式生效。

## notify-dot

文件：[`extensions/notify-dot.ts`](../extensions/notify-dot.ts)

- 回合结束且用户不在当前终端标签时，在标签标题前缀一个标记并响铃一次：`●` 正常完成、`✅` 完成且本轮含压缩、`❌` 出错；阻塞式 UI 确认框也会可见等待（`🔐` 确认类、`❓` 其他），未见标记优先级 ❌ > 🔐 > ❓ > ✅ > ●。
- 前台判定：终端焦点报告（如支持）→ Windows Terminal 前台探测脚本（窗口标题 → UIA 选中标签 → 祖先窗口检查）→ 按键启发式；探测仅 Windows Terminal 启用。
- 前台探测脚本从扩展自身目录定位，支持 Git 包安装位置和手动复制位置。
- 收到焦点进入报告时，返回标签即可清除标记，全屏模式也生效；终端不提供报告时仍按输入和前台探测回退。任意输入、提交新提示词、会话开始/关闭时也会清除；`PI_NOTIFY_DOT=off` 可整体禁用。
- `/notifydiag` 按需打开焦点诊断，观察 stdin、Pi 现有输入缓冲与扩展输入层，支持一次模拟完成和重新启用焦点报告。日志保存在 Pi agent 目录，仅记录有界元数据和计数，不记录键入文本；关闭或会话退出时移除观察器及定时器。提示结束后的迟到探测不会恢复已结束提示的标记。

## ai-rename

文件：[`extensions/ai-rename.ts`](../extensions/ai-rename.ts)

- 注册 `/n <名字>` 直接重命名会话（同时更改标签标题），不调用模型。
- 裸 `/n` 让会话当前模型从主题摘要（全部用户消息 + AI 首条文本回复，有截断）生成短名，清洗后限 40 字符。
- 调用期间阻塞会话/分支导航；生成中再次运行 `/n` 会提示等待而不是并发发起第二次调用。与 auto-summary 共用 Pi 原生模型注册表请求、用量记录和操作生命周期；用量跟随实际响应的供应商与模型，失败会显示通知。

## permission-gate

文件：[`extensions/permission-gate.ts`](../extensions/permission-gate.ts)

- 拦截凭据文件（`auth.json` / `.env` 等）的读取与搜索，以及 `bash`、原生 `powershell` 工具中的高置信度危险 Shell 命令；模板 `.env` 允许通过。启发式策略，不是沙箱。
- 危险命令在 TUI 中弹出紧凑确认覆盖层：按危险级别着色的标题（⛔高危/⚠中危 + 中文规则名）、≤3 行命令预览（命中片段反色）、目标与后果合并信息行，横向选项 `[n]` 拦截（默认选中）/`[y]` 放行一次/`[a]` 本会话放行，←/→ 导航 + 回车确认 + 字母快捷键。
- `[a]` 将命令 sha256 记入会话级白名单，后续相同命令自动放行（仅审计记录）；取消后的迟到批准被忽略；审计条目只存源哈希不存命令原文。

## web-search

文件：[`extensions/web-search.ts`](../extensions/web-search.ts)

- 注册两个只读工具：`web_search`（计数 1–10，支持 `site:` / 引号 / `-` 排除语法；模型内容为带评分/权威度的编号结果 + 摘要）和 `web_fetch`（URL 校验 http/https 且不带凭据，按 20k 字符/页分页）。
- 注册 `/websearch <query>` 直接搜索覆盖层（不经过模型）、`/websearch fetch <n|url>` 拉取上一次搜索的第 n 条、`/websearch status` 查看计费调用数、缓存命中、预估费用及当日额度。TUI 中使用可取消加载界面，Esc、会话切换及关闭会取消请求。
- 计费：DeepSeek Search API，5元/1000 成功且非空的请求；失败、空内容及缓存命中不计费。每次计费操作写入一条明确为 CNY 的 `extension-usage` 服务费用，不虚构 token。
- 搜索按原始 query + count 缓存，网页按原始 URL 缓存；TTL 为 10 分钟，两类缓存各最多 50 项、约 16 MiB。网页 `offset` 续读在缓存中本地分页，不重复请求或计费；会话切换清空缓存。
- `PI_WEBSEARCH_DAILY_LIMIT` 默认 300，0 关闭；按当前 Pi 进程的本地自然日重置，并预留并发请求名额。失败、空内容或取消释放名额，达到额度后仍可读取免费缓存。重启清零，多个进程不共享额度。
- 成功与错误响应均限 4 MiB，严格按 UTF-8 解码并校验结构；所有重试共用 90 秒期限，取消不重试、不回填缓存。普通镜像识别保留 URL 路径与查询参数，仅忽略片段。
- 凭据依次解析：个人配置 `~/.pi/agent/config/pi-extensions/.env.web-search` → 旧扩展目录 `web-search/.env` → Pi auth.json 的 `deepseek` API key；默认服务地址为 `https://api.deepseek.com`。`api_key` 和 `base_url` 分别按该顺序回退，个人文件可以只覆盖其中一项。密钥不出现在日志、工具详情与错误中。

需要搜索时，在上述个人配置位置创建文件，填入：

```dotenv
base_url=https://api.deepseek.com
api_key=填写你自己的密钥
```

也可以参照 [配置示例](web-search.env.example)。如果已有 Pi 的 `deepseek` API key 且使用默认服务地址，无需另建文件。配置读取不会自动创建、迁移或覆盖文件；修改配置后执行 `/reload` 或重启 Pi。

## write-transforms

文件：[`extensions/write-transforms.ts`](../extensions/write-transforms.ts)

- 接管 Pi 的 `read`、`edit`、`write`，保留原生参数和 diff 展示。成功的 UTF-8 文本读取记录文件版本与实际展示的行范围；图片、失败或取消的读取，以及未展示的超长行，不取得阅读许可。
- `edit` 前需读取当前文件版本，局部 read 即可。这是文件版本约束，没有限制只能修改已读行。覆盖已有文件的 `write` 需完整读取，可分页累计；新文件可直接创建。
- `oldText` 先要求唯一精确匹配，失败后只容忍 CRLF/LF 和 ASCII 行尾空格、Tab 差异；缩进、引号与 Unicode 字符保持严格匹配。所有修改块基于同一原文件定位，拒绝歧义、重叠及无变化修改。
- 修改经 Pi 文件队列串行执行；写入前核对文件身份与版本，原地写入后逐字节回读。结果不确定时清除阅读许可，要求重新 read，不自动重试或回滚。它不提供跨进程的原子写入保证。
- edit 成功后继承原来的完整或局部阅读级别；write 成功后，新版本视为完整已知。会话开始、分支导航、成功压缩及关闭会清空阅读状态。
- Shell 和脚本读文件不授予阅读许可，通过它们写文件也不受此约束。自动内容转换管线当前为空。

## plugin-manager

文件：[`extensions/plugin-manager.ts`](../extensions/plugin-manager.ts)

- `/plugins` 在 TUI 中打开扩展管理器；Tab / Shift+Tab 切换 All、Unselected、Selected、Settings，输入搜索，↑/↓移动，空格切换，Enter 查看详情，Esc 返回或关闭。关闭会丢弃未保存的草稿。
- `/plugins status` 只读查看配置与当前工具；`/plugins reload` 等待空闲后调用 Pi 的重新加载。管理列表包含本地和已安装包中的自定义扩展，不安装依赖或联网发现资源。
- Scope 表示扩展来源 Global / Project；Settings 中的 Save to 选择保存位置，初始 Project。Ctrl+S 保存：Global 修改个人默认且保留项目覆盖，项目专属草稿继续保留；Project 写入 Pi 原生项目选择，需已有项目信任。详情中对全局扩展按 R 可选回个人默认，再保存到 Project 移除对应覆盖。选择变更需关闭后 `/reload` 或重启 Pi 才生效。
- Mode 初始为 Default；手动保存 Auto 后，在会话启动完成及保存时补入符合条件的工具，保留已启用工具。切回 Default 停止后续自动补入，已启用工具保持启用。
- Auto 仅处理配置中启用的全局扩展，工具须明确提供默认启用元数据且为 direct / model-only；遵守 `defaultTools`、CLI 工具限制及历史明确移除。包内 `web_search` / `web_fetch` 提供元数据；另行安装并提供同一契约的 `run-script` 也可参与。本包不额外安装 `run-script`，不自动补入可选 `powershell`、核心、项目、MCP 或无契约工具，不调用模型或工具。
- 扩展选择保存在 Pi 原生全局或项目 `settings.json`；Mode 与记忆的 Save to 独立保存在 Pi agent 目录的 `plugin-manager.json`，不会随包更新被覆盖。仅打开界面不创建文件；保存保留其他配置和包资源筛选。配置损坏或外部冲突会报错；两类文件分别写入，部分保存失败后应重新打开核对结果，不回滚已保存内容。

## agent/AGENTS.md

文件：[`agent/AGENTS.md`](../agent/AGENTS.md)

- 当前 `~/.pi/agent/AGENTS.md` 的归档副本，保留 Pi Agent 的规则、术语和扩展清单。

## extensions/AGENTS.md

文件：[`extensions/AGENTS.md`](../extensions/AGENTS.md)

- 只适用于本仓库 `extensions/` 目录的精简规则文件，记录十个扩展的范围、修改约束和验证方式。

## 行为边界

- `powershell-bash` 负责 Windows Shell 的执行适配；危险命令确认由 `permission-gate` 提供，两者都不是权限沙箱。
- 默认启动 `pwsh.exe`；如需使用其他 PowerShell 可执行文件，可设置 `PI_POWERSHELL_EXE`。
- Shell 输出被设置为 UTF-8 纯文本；当 `PYTHONUTF8` 和 `PYTHONIOENCODING` 未设置时，扩展会为 Python 子进程提供默认值。
- 普通 Windows 子进程由 kill-on-close Job 持有，超时或取消会结束该 Job；直接调用 WSL 的命令只做客户端进程树清理，不保证终止所有 Linux 后代。长时间运行的命令应显式设置合理超时。
- 生成摘要时，当前会话内容可能被发送给活动模型，请根据模型服务的隐私策略使用；裸 `/n` 同理。
- `notify-dot` 的前台探测仅在 Windows Terminal 下生效，其他终端依赖焦点报告（如支持）与按键启发式；标记在用户离开时提示，收到返回标签的焦点报告即可清除，未收到报告时仍可通过输入清除。
- `permission-gate` 是启发式策略而非沙箱：动态拼接、混淆或未覆盖的危险命令不保证被拦；白名单按命令哈希匹配，参数变化即视为新命令。
- `web-search` 依赖 DeepSeek Search API 并按成功次数计费；查询内容由模型构造并发送给该服务，请按隐私策略使用。限额与凭据见 [web-search](#web-search)。
- 规则文件中的扩展清单来自作者本机环境；如果只安装本仓库的十个扩展，应按实际安装情况维护清单。
