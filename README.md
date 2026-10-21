# My Pi Extensions

面向 [Pi](https://github.com/earendil-works/pi) 的十个扩展，以及当前 `~/.pi/agent/AGENTS.md` 规则文件的整理归档。

## 包含内容

| 扩展 | 功能 |
| --- | --- |
| `auto-summary` | `/summary` 保存最近回复，或按要求生成版本化 Markdown。 |
| `powershell-bash` | 提供增强的 PowerShell 7 执行器、执行状态与 `/harness` 诊断。 |
| `tps-status` | 在终端状态栏显示助手回复的生成速度。 |
| `anim-compaction` | 压缩上下文时显示动画与统计，`/anim` 切换样式。 |
| `notify-dot` | 用标题标记提示完成、出错或等待确认，支持焦点清除及 `/notifydiag` 诊断。 |
| `ai-rename` | `/n` 自动生成会话名称，或直接设置名称。 |
| `permission-gate` | 拦截敏感文件访问，对高置信度危险命令请求确认。 |
| `web-search` | 提供搜索、网页分页和 `/websearch` 直接查询。 |
| `write-transforms` | 增强 `read/edit/write`：读取版本约束、保守匹配与写后校验。 |
| `plugin-manager` | `/plugins` 管理扩展选择，可选 Auto 为旧会话补入符合条件的工具。 |

各扩展的详细用法、配置、费用与行为边界见 [扩展详细说明](docs/extensions.md)。

## 安装与更新

前置要求：Pi（当前适配 1.3.0）、Node.js、Git、PowerShell 7；`notify-dot` 的前台探测仅在 Windows Terminal 下生效。

首次安装，在终端执行：

```powershell
pi install git:github.com/whitejoce/pi-extensions
```

Pi 会记录包来源并加载清单中的十个扩展。使用 `pi list` 查看安装记录，`pi config` 或会话内的 `/plugins` 选择启用的扩展。

`write-transforms` 要求 edit 前读取当前文件版本、覆盖 write 前完整读取；Shell 和脚本访问不经过这层约束。具体规则见 [文件修改约束](docs/extensions.md#write-transforms)。

后续更新：

```powershell
pi update git:github.com/whitejoce/pi-extensions
```

`pi update --extensions` 可更新所有已安装的扩展包；单独 `pi update` 更新的是 Pi 本身。安装或更新后，在已打开的 Pi 中执行 `/reload`，或重启 Pi。

搜索的个人配置保存在 `~/.pi/agent/config/pi-extensions/.env.web-search`，详见 [web-search 配置](docs/extensions.md#web-search)。配置与包代码分开，更新无需重新填写密钥。`agent/AGENTS.md` 是供审阅的规则归档，包安装不会覆盖个人规则文件。

从手动复制方式迁移，或继续手动安装，见 [安装与迁移](docs/extensions.md#安装与迁移)。

## 使用

```text
/summary
/summary [可选整理要求]
/anim [可选样式 comet|wave|chase|random]
/n [可选名字]
/websearch <query>
/websearch fetch <n|url>
/websearch status
/harness tools
/harness execution [操作ID]
/notifydiag
/plugins
/plugins status
/plugins reload
```

- `/summary` 无参数时保存最近一次助手文本回复；带参数时调用当前模型生成文档。两种模式都在当前工作目录创建版本化 Markdown 文件。
- `/anim` 无参数时选择样式，带参数时直接设置；压缩动画会自动显示。
- `/n` 带名字时直接设置，单独执行时调用当前模型生成名称。
- `/websearch` 直接调用 DeepSeek Search API；模型也可以使用 `web_search` / `web_fetch` 工具。
- `/plugins` 管理扩展启用与保存位置，默认 Default；Auto 可补入旧会话遗漏且符合条件的工具。选择变更保存后需重新加载，详见 [扩展管理](docs/extensions.md#plugin-manager)。

摘要生成、自动命名和搜索可能产生费用，并向对应模型或搜索服务发送内容。计费、缓存和取消方式见 [扩展详细说明](docs/extensions.md)。

## 验证

维护者可以使用系统 Node.js、TypeScript 和已有的 Pi 安装运行离线类型检查与包回归。将参数替换为实际安装的 `@earendil-works/pi-coding-agent` 目录：

```powershell
.\tests\run.ps1 -PiPackageDir '实际的 Pi 包目录'
```

检查不会安装依赖或改写 Pi 配置。

重新加载后，可手动验证：

1. 执行 `/summary`，确认当前工作目录出现新的版本化 Markdown 文件（文件名自动生成）。
2. 执行 `/summary 整理成要点清单`（任意整理要求），确认使用当前模型生成版本化 Markdown 文档。
3. 让 Pi 通过 `bash` 执行一个普通 PowerShell 命令，再按需启用 `powershell` 验证同一命令；确认两个入口都使用增强执行器，也可以设置 `PI_POWERSHELL_EXE` 验证可执行文件覆盖。
4. 在 TUI 中完成一次普通回复，确认状态栏出现 `tps` 值；取消一次回复，确认不显示残值。
5. 执行 `/anim` 切换样式后触发 `/compact`，确认动画 widget 出现、耗时/消息数正常、Esc 可取消。
6. 在 Windows Terminal 中跑一个回合并切到其他标签，结束后确认原标签标题出现完成标记并响铃一次；执行裸 `/n` 确认会话与标签标题被重命名。
7. 让模型读取 `auth.json`，确认访问被拦截；分别通过 `bash` 和启用后的 `powershell` 对测试目录发起危险命令，确认弹出确认层且 `[n]` 默认选中。仅在可安全删除的测试目录中验证 `[a]` 后相同命令自动放行。
8. 执行 `/websearch status` 确认计费与当日额度显示；执行一次 `/websearch <query>`，确认覆盖层出结果且 Esc 可取消。重复查询、继续读取缓存网页的后续分页，确认不再计费。
9. 在测试文件上确认未 read 的 edit 被拒绝、局部 read 后可 edit、覆盖 write 需要完整读取；外部改动后应要求重新 read。
10. 打开 `/plugins`，人工检查标签切换、搜索、选中项和 Settings；选择适当的保存位置后用 Ctrl+S 保存，关闭并 `/reload` 后核对启用结果。

`/notifydiag` 的焦点诊断、返回标签时清除标记、`/harness` 提示及 edit 的 diff 展示请人工检查。

## 项目结构

```text
pi-extensions/
├─ extensions/           # 十个扩展入口及支撑模块
│  └─ AGENTS.md          # 扩展清单、模块职责与维护约束
├─ docs/
│  └─ extensions.md      # 详细用法、配置与行为边界
├─ tests/               # 离线包发现、路径与配置回归
├─ agent/
│  └─ AGENTS.md          # Pi Agent 规则归档
├─ package.json          # Pi 包清单，明确十个扩展入口
├─ .gitignore
├─ LICENSE
└─ README.md
```

## License

MIT，详见 [`LICENSE`](./LICENSE)。
