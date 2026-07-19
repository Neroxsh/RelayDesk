# RelayDesk

在手机上继续电脑里的 Codex 和 Claude Code。会话仍然运行在自己的电脑上，RelayDesk 只负责加密传输和移动端界面。

[手机端](https://relay.xingshihao.site) · [问题反馈](https://github.com/Neroxsh/RelayDesk/issues)

## 开始使用

目前优先支持 Windows 11，电脑需要安装 Node.js 22 或更高版本，并已能正常使用 Codex 或 Claude Code。

### 从源码安装

```powershell
git clone https://github.com/Neroxsh/RelayDesk.git
cd RelayDesk
npm install
npm run setup
```

### 用 pip 安装

```powershell
pip install git+https://github.com/Neroxsh/RelayDesk.git
relaydesk setup
```

安装完成后会打开电脑控制中心，并显示两个地址：

- 电脑控制中心：`http://127.0.0.1:43127`
- 手机端：`https://relay.xingshihao.site`

手机输入电脑端显示的配对码，再回到电脑确认。确认一次后会保持连接，除非在电脑控制中心主动解除。

## 能做什么

- Codex 和 Claude Code 分开展示，并按项目整理会话。
- 继续历史会话，或直接给当前 Codex 窗口发送指令。
- 手机打开会话时，回答和任务进度会持续同步；切到后台后再次打开会自动补齐。
- 在电脑控制中心查看、确认和解除已连接设备。
- 安全模式只使用工具自身的受限执行；需要自动执行时可按会话切换。

## 常用命令

```powershell
relaydesk setup                 # 安装并启动，Windows 下同时设置开机启动
relaydesk status                # 检查电脑端是否正在运行
relaydesk control               # 打开电脑控制中心
relaydesk start                 # 在当前终端前台运行
relaydesk setup --relay URL     # 使用自己的中继地址
```

从源码运行时，也可以使用 `npm run setup` 和 `npm run agent -- --relay URL`。

## 它如何工作

电脑端桥接只主动连接 HTTPS 中继，不会向公网开放电脑端口。手机与电脑完成配对后，双方通过 P-256 ECDH 建立密钥，并使用 AES-256-GCM 加密消息。中继负责暂存密文和在线状态，无法读取会话正文。

电脑端只接受 RelayDesk 已定义的会话操作，不提供任意终端入口。配对码、设备密钥和已连接设备保存在 `%USERPROFILE%\.relaydesk\config.json`，不会进入项目目录。

```text
手机浏览器  ←── 端到端加密消息 ──→  HTTPS 中继  ←──→  电脑端桥接
                                                    ├─ Codex
                                                    └─ Claude Code
```

## 项目结构

```text
app/          移动端 PWA 与中继 API
agent/        电脑端桥接、会话解析和本机控制中心
scripts/      安装与开机启动
tests/        协议、解析、安全边界和界面回归测试
drizzle/      中继数据库迁移
```

## 本地开发

```powershell
npm install
npm run lint
npm test
npm run dev
```

提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 中的方式报告。

## 当前状态

RelayDesk 仍在早期阶段。Windows、Codex Desktop 和 Claude Code 是当前主要测试组合；macOS/Linux 的开机启动尚未完善。默认中继用于快速体验，团队或公开部署建议使用自己的 Cloudflare 项目和域名。

## License

[MIT](LICENSE)
