# My Pi Extensions

面向 [Pi](https://github.com/earendil-works/pi) 的六个扩展，以及当前 `~/.pi/agent/AGENTS.md` 规则文件的整理归档。

## 包含内容

- `extensions/auto-summary.ts`
  - 注册 `/summary [filename]`：不调用模型，保存当前分支最近一条有文本的助手回复。
  - 注册 `/summary --generate [instructions]`（也支持 `-g`）：使用当前模型把当前分支整理成完整 Markdown 文档。
  - 文件名经过 Windows 安全清理，并以 `-v1.md`、`-v2.md` 的版本形式创建，绝不覆盖已有文件。
  - 生成模式会对会话内容做有界截断，并在超过输入预算时保留开头和最近内容。
  - TUI 中可用 Esc 取消生成；生成结束前会阻塞会话/分支导航。即使回复失败或被取消，也会先记录有效的供应商用量，再决定是否写文档；汇总条目包含币种和结果。
- `extensions/powershell-bash.ts`
  - 在 Windows 上将 Pi 的 `bash` 工具和 `!` / `!!` 执行切换为经过验证的 PowerShell Core 7+（默认 `pwsh.exe`，可通过 `PI_POWERSHELL_EXE` 覆盖），Windows PowerShell 5.1 不受支持。
  - 对命令做 AST 解析，拦截以显式旧版 PowerShell 为目标的调用；输出为 UTF-8 纯文本流，非终止性 cmdlet 错误会使命令以失败退出码结束。
  - 普通 Windows 子进程由 kill-on-close Job 持有直到退出；直接以 WSL 为目标的调用使用客户端进程树清理。默认超时 120 秒；会话关闭时会等待在跑的命令结束。
- `extensions/tps-status.ts`
  > 实现对齐 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
  - 在 TUI 中测量最近一条已完成助手回复的解码速度，通过 `ctx.ui.setStatus("tps", ...)` 发布到状态栏。
  - 计时窗口为首个非空文本/思考增量（或带名称/参数的工具事件）到 `message_end`，排除首字延迟（TTFT）与工具执行时间。
- `extensions/anim-compaction.ts`
  - 上下文压缩触发时（手动 `/compact`、阈值自动、溢出恢复）在编辑器上方显示动画 widget：旋转指示符 + 彗星条 / 均衡器波形 / 追逐点三选一，附带真实压缩耗时与待总结消息数，Esc 取消仍可用。
  - 注册 `/anim` 命令切换样式（无参数弹选择列表，带参数直接设值），持久化写入 `settings.json`（保留其他键，损坏时拒绝写入）。
  - 样式优先级：`PI_COMET_STYLE` 环境变量 > `cometCompactionStyle` > 每次随机；配色随明暗主题自适应；仅 TUI 模式生效。
- `extensions/notify-dot.ts`
  - 回合结束且用户不在当前终端标签时，在标签标题前缀一个标记并响铃一次：`●` 正常完成、`✅` 完成且本轮含压缩、`❌` 出错。
  - 前台判定：终端焦点报告（如支持）→ Windows Terminal 前台探测脚本（窗口标题 → UIA 选中标签 → 祖先窗口检查）→ 按键启发式；探测仅 Windows Terminal 启用。
  - 回到标签后任意输入即清除标记；`PI_NOTIFY_DOT=off` 可整体禁用。
- `extensions/ai-rename.ts`
  - 注册 `/n <名字>` 直接重命名会话（同时更改标签标题），不调用模型。
  - 裸 `/n` 让会话当前模型从主题摘要（全部用户消息 + AI 首条文本回复，有截断）生成短名，清洗后限 40 字符。
  - 调用期间阻塞会话/分支导航；用量与 auto-summary 共用同一记录通道。
- `agent/AGENTS.md`
  - 当前 `~/.pi/agent/AGENTS.md` 的归档副本，保留 Pi Agent 的规则、术语和扩展清单。
- `extensions/AGENTS.md`
  - 只适用于本仓库 `extensions/` 目录的精简规则文件，记录六个扩展的范围、修改约束和验证方式。

## 安装

1. 将 `extensions/` 目录下的全部内容（六个扩展入口与支撑模块）复制到：

   ```text
   ~/.pi/agent/extensions/
   ```

   保持相对布局不变：`shared/usage.ts` 与 `run-script/` 下的进程支撑模块被入口文件按相对路径引用，`notify-dot/foreground-check.ps1` 是 `notify-dot.ts` 运行时 spawn 的前台探测脚本，同样必须同目录存放，不能拆开。

2. `agent/AGENTS.md` 对应本机路径：

   ```text
   ~/.pi/agent/AGENTS.md
   ```

   建议先审阅并合并其中的规则，不要在已有本地规则文件包含个人配置时直接覆盖。

3. 在 Pi 中执行 `/reload`，或重新启动 Pi。

## 使用

```text
/summary [可选文件名]
/summary --generate [可选整理要求]
/anim [可选样式 comet|wave|chase|random]
/n [可选名字]
```

- 默认模式只保存最近一次助手文本回复，不产生新的模型请求。
- `--generate` 会调用当前活动模型，并可能产生 API 用量和费用；会话内容会发送给该模型。
- 两种模式都只在当前工作目录创建新的 Markdown 文件。
- `/anim` 无参数弹出样式选择列表，带参数直接设值并持久化；`anim-compaction` 的动画在压缩时自动出现，无需命令。
- `/n` 带名字直接设置；裸 `/n` 调用当前模型生成短名，可能产生 API 用量和费用。

`powershell-bash`、`tps-status` 与 `notify-dot` 不提供命令；`powershell-bash` 通过 `session_start` 和 `user_bash` 事件接管 PowerShell 执行，`tps-status` 监听消息事件并更新状态栏，`notify-dot` 监听回合结束事件并更新标签标题。

## 行为边界

- 该扩展只负责 Windows Shell 的执行适配，不是权限沙箱，也不会自动拦截危险命令。
- 默认启动 `pwsh.exe`；如需使用其他 PowerShell 可执行文件，可设置 `PI_POWERSHELL_EXE`。
- Shell 输出被设置为 UTF-8 纯文本；当 `PYTHONUTF8` 和 `PYTHONIOENCODING` 未设置时，扩展会为 Python 子进程提供默认值。
- 普通 Windows 子进程由 kill-on-close Job 持有，超时或取消会结束该 Job；直接调用 WSL 的命令只做客户端进程树清理，不保证终止所有 Linux 后代。长时间运行的命令应显式设置合理超时。
- 生成摘要时，当前会话内容可能被发送给活动模型，请根据模型服务的隐私策略使用；裸 `/n` 同理。
- `notify-dot` 的前台探测仅在 Windows Terminal 下生效，其他终端依赖焦点报告（如支持）与按键启发式；标记只在该标签不可见时出现，回到标签不清屏、仅在下次输入时清除。
- 规则文件中的扩展清单来自作者本机环境；如果只安装本仓库的六个扩展，应按实际安装情况维护清单。

## 验证

在已安装 Pi 依赖的环境中，可以使用原扩展目录的 TypeScript 配置进行类型检查：

```powershell
tsc -p "$HOME\.pi\agent\extensions\tsconfig.json"
```

重新加载后，可手动验证：

1. 执行 `/summary test`，确认当前工作目录出现新的 `test-v1.md`（或下一个版本）。
2. 执行 `/summary --generate`，确认使用当前模型生成版本化 Markdown 文件。
3. 让 Pi 执行一个普通 PowerShell 命令，确认使用 PowerShell 输出；也可以设置 `PI_POWERSHELL_EXE` 验证可执行文件覆盖。
4. 在 TUI 中完成一次普通回复，确认状态栏出现 `tps` 值；取消一次回复，确认不显示残值。
5. 执行 `/anim` 切换样式后触发 `/compact`，确认动画 widget 出现、耗时/消息数正常、Esc 可取消。
6. 在 Windows Terminal 中跑一个回合并切到其他标签，结束后确认原标签标题出现完成标记并响铃一次；执行裸 `/n` 确认会话与标签标题被重命名。

## 项目结构

```text
pi-extensions/
├─ extensions/
│  ├─ AGENTS.md
│  ├─ auto-summary.ts
│  ├─ powershell-bash.ts
│  ├─ tps-status.ts
│  ├─ anim-compaction.ts
│  ├─ notify-dot.ts
│  │  └─ foreground-check.ps1
│  ├─ ai-rename.ts
│  ├─ run-script/
│  │  ├─ process.ts
│  │  ├─ powershell.ts
│  │  ├─ job-runner.ps1
│  │  └─ job-runner.cs
│  └─ shared/
│     └─ usage.ts
├─ agent/
│  └─ AGENTS.md
├─ .gitignore
├─ LICENSE
└─ README.md
```

## License

MIT，详见 [`LICENSE`](./LICENSE)。
