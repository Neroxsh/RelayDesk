# RelayDesk

在手机浏览器里继续电脑上的 Codex。无需安装手机 App，也无需在手机登录 ChatGPT。

[打开手机端](https://relay.xingshihao.site) · [问题反馈](https://github.com/Neroxsh/RelayDesk/issues)

## 可以做什么

- 按项目查看电脑上的 Codex 会话。
- 继续历史会话，并实时看到回复和执行进度。
- 向 Windows 上当前打开的 Codex 窗口发送消息。
- 选择 Codex 模型、思考强度、工作区权限和快速通道。
- 查看 Codex 返回的账号套餐与使用额度窗口。
- 一次配对，之后直接打开手机网页。

## 系统要求

- Windows 10、Windows 11 或 macOS。
- Node.js 22.13 或更高版本。
- 已安装并登录 Codex CLI。Windows 可同时使用 Codex 桌面应用。

## 安装

```powershell
git clone https://github.com/Neroxsh/RelayDesk.git
cd RelayDesk
npm install
npm run setup
```

也可以通过 Python 包入口安装：

```powershell
pip install git+https://github.com/Neroxsh/RelayDesk.git
relaydesk setup
```

安装结束后会打开电脑控制中心：

```text
http://127.0.0.1:43127
```

手机打开 `https://relay.xingshihao.site`，输入电脑显示的 16 位配对码，再回到电脑确认。

Windows 10/11 会写入当前用户的开机启动项。macOS 会安装当前用户的 LaunchAgent。更新代码后重新运行 `npm run setup -- --yes` 即可刷新启动配置。

## 会话没有出现

RelayDesk 会依次检查 `CODEX_HOME`、当前用户的 `.codex` 目录、XDG 配置目录和 Windows 的 Codex 数据目录。若 Codex 使用了自定义位置，可在电脑控制中心填写 `.codex` 或 `sessions` 目录。

## 运行方式

```text
手机浏览器 ── 端到端加密 ── 中继 ── 电脑上的 RelayDesk ── Codex
```

会话内容由手机与电脑端加密和解密。中继负责转发密文。电脑端只提供预定义的会话操作，不开放任意终端接口。

设备配置保存在用户目录的 `.relaydesk/config.json`。配对码和设备密钥不要发给他人。

## 开发

```powershell
npm run dev
npm test
```

默认中继便于快速体验。公开发布或团队部署时，建议使用自己的中继与域名。
