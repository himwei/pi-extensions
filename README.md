# My Pi Extensions

面向 [Pi](https://github.com/earendil-works/pi) 的八个扩展，以及当前 `~/.pi/agent/AGENTS.md` 规则文件的整理归档。

## 包含内容

| 扩展 | 功能 |
| --- | --- |
| `auto-summary` | `/summary` 保存最近回复，或按要求生成版本化 Markdown。 |
| `powershell-bash` | 为 `bash`、`powershell` 和 `!` / `!!` 提供增强的 PowerShell 7 执行器。 |
| `tps-status` | 在终端状态栏显示助手回复的生成速度。 |
| `anim-compaction` | 压缩上下文时显示动画与统计，`/anim` 切换样式。 |
| `notify-dot` | 离开终端标签后，通过标题标记提示完成、出错或等待确认。 |
| `ai-rename` | `/n` 自动生成会话名称，或直接设置名称。 |
| `permission-gate` | 拦截敏感文件访问，对高置信度危险命令请求确认。 |
| `web-search` | 提供搜索、网页分页和 `/websearch` 直接查询。 |

各扩展的详细用法、配置、费用与行为边界见 [扩展详细说明](docs/extensions.md)。

## 安装

前置要求：Pi（当前适配 1.3.0）、Node.js、PowerShell 7；`notify-dot` 的前台探测仅在 Windows Terminal 下生效。

1. 将 `extensions/` 目录下的全部内容（八个扩展入口与支撑模块）复制到：

   ```text
   ~/.pi/agent/extensions/
   ```

   保持相对布局不变：`shared/`、`powershell-bash/`、`run-script/`、`notify-dot/`、`anim-compaction/settings.ts`、`permission-gate/`、`web-search/` 下的支撑模块被入口文件按相对路径引用（`notify-dot/foreground-check.ps1` 为运行时 spawn 的探测脚本），不能拆开存放。如需使用 web-search，可在 `extensions/web-search/.env` 填入 `base_url` / `api_key`（已被 `.gitignore` 排除，不会入库）。

2. `agent/AGENTS.md` 对应本机路径：

   ```text
   ~/.pi/agent/AGENTS.md
   ```

   建议先审阅并合并其中的规则，不要在已有本地规则文件包含个人配置时直接覆盖。

3. 在 Pi 中执行 `/reload`，或重新启动 Pi。

## 使用

```text
/summary
/summary [可选整理要求]
/anim [可选样式 comet|wave|chase|random]
/n [可选名字]
/websearch <query>
/websearch fetch <n|url>
/websearch status
```

- `/summary` 无参数时保存最近一次助手文本回复；带参数时调用当前模型生成文档。两种模式都在当前工作目录创建版本化 Markdown 文件。
- `/anim` 无参数时选择样式，带参数时直接设置；压缩动画会自动显示。
- `/n` 带名字时直接设置，单独执行时调用当前模型生成名称。
- `/websearch` 直接调用 DeepSeek Search API；模型也可以使用 `web_search` / `web_fetch` 工具。

摘要生成、自动命名和搜索可能产生费用，并向对应模型或搜索服务发送内容。计费、缓存和取消方式见 [扩展详细说明](docs/extensions.md)。

## 验证

在已安装 Pi 依赖的环境中，可以使用原扩展目录的 TypeScript 配置进行类型检查：

```powershell
tsc -p "$HOME\.pi\agent\extensions\tsconfig.json"
```

重新加载后，可手动验证：

1. 执行 `/summary`，确认当前工作目录出现新的版本化 Markdown 文件（文件名自动生成）。
2. 执行 `/summary 整理成要点清单`（任意整理要求），确认使用当前模型生成版本化 Markdown 文档。
3. 让 Pi 通过 `bash` 执行一个普通 PowerShell 命令，再按需启用 `powershell` 验证同一命令；确认两个入口都使用增强执行器，也可以设置 `PI_POWERSHELL_EXE` 验证可执行文件覆盖。
4. 在 TUI 中完成一次普通回复，确认状态栏出现 `tps` 值；取消一次回复，确认不显示残值。
5. 执行 `/anim` 切换样式后触发 `/compact`，确认动画 widget 出现、耗时/消息数正常、Esc 可取消。
6. 在 Windows Terminal 中跑一个回合并切到其他标签，结束后确认原标签标题出现完成标记并响铃一次；执行裸 `/n` 确认会话与标签标题被重命名。
7. 让模型读取 `auth.json`，确认访问被拦截；分别通过 `bash` 和启用后的 `powershell` 对测试目录发起危险命令，确认弹出确认层且 `[n]` 默认选中。仅在可安全删除的测试目录中验证 `[a]` 后相同命令自动放行。
8. 执行 `/websearch status` 确认计费与当日额度显示；执行一次 `/websearch <query>`，确认覆盖层出结果且 Esc 可取消。重复查询、继续读取缓存网页的后续分页，确认不再计费。

## 项目结构

```text
pi-extensions/
├─ extensions/           # 八个扩展入口及支撑模块
│  └─ AGENTS.md          # 扩展清单、模块职责与维护约束
├─ docs/
│  └─ extensions.md      # 详细用法、配置与行为边界
├─ agent/
│  └─ AGENTS.md          # Pi Agent 规则归档
├─ .gitignore
├─ LICENSE
└─ README.md
```

## License

MIT，详见 [`LICENSE`](./LICENSE)。
