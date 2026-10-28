# Claude Code 与 CC Switch 的支持范围

RelayDesk 根据本机能力启用功能，不将所有版本视为兼容。Claude 没安装、目录不可读或可选记录损坏时，不影响 Codex 会话。

| 功能 | 检测方式 | 已验证 | 不支持时 |
| --- | --- | --- | --- |
| Claude 历史 | `.claude/projects` 的主会话 JSONL，忽略子代理与 thinking | Claude Code 2.1.197 的本机会话 | 不识别的文件不显示 |
| 继续 Claude 会话 | 本机 `--help` 同时具备 print、resume、stream-json、dontAsk 和 allowedTools | 2.1.197 接口检测，模拟 CLI 的创建、恢复、错误与落盘回归 | 保留历史，提示升级，不发送 |
| 新建会话 | 另检测 `--session-id` | 2.1.197 接口、模拟 CLI 全流程 | 禁用新建入口 |
| 思考强度 | 从 `--effort` 帮助段提取当前版本列出的档位 | 2.1.197；另覆盖没有 effort 的旧接口样本 | 隐藏选项，不传未知参数 |
| CC Switch 供应商列表 | 只读 SQLite 和 `live-state.json`；路由模式显示实际路由供应商 | CC Switch 4.0.4 / schema 20 | 不改库，提示不可用 |
| Claude 全局供应商切换 | 兼容 CLI 5.11.2，核对 schema 20、CLI 版本、运行状态 | 在隔离的 schema 20 数据库真实运行 CLI：供应商指针、Claude 配置一起切换，保留 effort，schema 不变 | 拒绝未知 schema、路由模式、运行中的 CC Switch 桌面或忙碌的 Claude |

旧版本的帮助样本测试不等于对应全部版本的真实端到端验证。其他版本只有通过能力检测才能启用；未来新增格式需要补充真实样本和回归，不能仅凭版本号推测。

## 手机使用

1. 正常安装、登录并配置 Claude Code，电脑控制中心可指定 `.claude` 或 `projects` 目录。
2. 手机切到 **Claude Code**，选择历史会话；或点 **新建 Claude 会话**，输入电脑上已有的项目绝对路径。
3. 原会话如果仍在电脑终端打开，先退出该会话再从手机恢复。RelayDesk 不向已有黑窗口注入按键，也不同时启动两个写入同一会话的进程。手机的新任务在后台运行，可以在手机停止；停止按钮不会中断电脑上独立启动的 Claude。
4. 默认只放行读取和编辑工具。命令执行可能被 Claude 拒绝，手机会显示权限提示；选择完全访问时，手机会再次确认。CLAUDE.md、hooks、插件、项目和用户配置沿用本机 Claude Code 的正常加载行为。

模型选项显示本机全局配置中的别名与实际映射。会话上一轮模型和下一条消息配置分别显示。CLI 支持某一 effort 不代表所有第三方模型都接受它，上游拒绝时仍会显示执行错误。第三方余额、Claude 订阅额度暂未接入，不借用 Codex 的用量。

## 可选的 CC Switch 全局切换

当前只适配 **Windows x64、直接连接模式、schema 20**，操作对象是 **Claude Code** 的供应商；不切换 Codex、Gemini 或 Claude Desktop。

```powershell
npm run setup:ccswitch
```

Python 安装入口使用 `relaydesk setup-ccswitch`。两种入口使用同一个带哈希校验的安装脚本。

安装脚本从 [CC Switch CLI v5.11.2 官方发布页](https://github.com/SaladDay/cc-switch-cli/releases/tag/v5.11.2) 下载固定版本，并核对 GitHub 发布资产的 SHA-256；工具放在 `~/.relaydesk/tools`，不替换桌面程序，不自动改变供应商。5.11.3 使用 schema 22，不能拿它自动升级 schema 20 的桌面用户数据库。

全局切换前，先在 CC Switch 关闭路由模式，然后从托盘退出桌面程序，等待 Claude 工作完成。手机刷新状态后可选供应商；成功后修改的是电脑的全局配置，重新打开 CC Switch 可看到新选择。已经打开的 Claude 终端可能需要重启才能使用新配置。

运行中的 CC Switch 桌面版有当前供应商缓存，4.0.4 没有面向外部的全局切换 API。当前适配器不在它运行时写配置，避免 CLI 与桌面互相覆盖。路由、聚合、其他 schema 和 macOS 的全局切换暂不开放；这些情况下仍可查看供应商、使用当前配置运行 Claude。

密钥始终留在电脑，手机只收到供应商 ID、名称、当前选择和兼容状态。切换复用现有端到端加密与请求去重；未知数据库版本只读，不自动迁移。

可通过电脑代理环境变量指定自定义安装位置：`CLAUDE_CONFIG_DIR`、`RELAYDESK_CLAUDE_EXECUTABLE`（原生程序或 npm CLI 的 JS 文件）、`CC_SWITCH_CONFIG_DIR`、`RELAYDESK_CC_SWITCH_CLI_PATH`。自定义路径仍需通过版本和 schema 核验。

官方接口依据：[Claude Code 程序化使用](https://code.claude.com/docs/en/headless)、[CC Switch 对 CLI 的说明](https://github.com/farion1231/cc-switch#is-there-a-command-line-or-headless-version)。
