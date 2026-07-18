# RelayDesk

RelayDesk 是一个独立的手机远程工作台：电脑端常驻桥接程序读取本机 Codex / Claude Code 会话，手机端通过 6 位一次性配对码连接，然后可以查看历史、跟随当前会话并继续发送指令。

## 它如何工作

- 电脑端只主动访问公网中继，不监听公网端口。
- 配对码有效期 10 分钟、单次使用，并带有猜码限速。
- 手机与电脑使用 P-256 ECDH 派生 AES-256-GCM 会话密钥；中继数据库只保存加密信封。
- 手机端只能执行预定义的会话操作，不能提交任意系统命令。
- “安全模式”默认拒绝需要额外授权的操作；“完全控制”会在手机端再次确认。

## 目录

- `app/`：可安装到手机桌面的 PWA 和中继 API。
- `agent/`：运行在 Windows 电脑上的桥接程序。
- `scripts/install-agent.ps1`：安装开机常驻并生成配对码。
- `db/` 与 `drizzle/`：中继数据库结构与迁移。

## 发布与安装

1. 发布网页和中继服务，得到 HTTPS 地址。
2. 在电脑上执行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install-agent.ps1 -RelayUrl "https://你的中继地址"
   ```

3. 电脑会显示 6 位配对码。手机打开中继地址并输入配对码。
4. 在手机浏览器菜单中选择“添加到主屏幕”，之后会像普通 App 一样打开。

再次配对新手机时：

```powershell
npm run pair -- --relay "https://你的中继地址"
```

## 本地开发

```powershell
npm install
npm run db:generate
npm run build
npm test
```

电脑桥接程序默认读取：

- `%USERPROFILE%\.codex\sessions`
- `%USERPROFILE%\.claude\projects`

本机凭据和配对后的设备密钥保存在 `%USERPROFILE%\.relaydesk\config.json`，不会写入项目目录或上传为明文。

## 当前边界

- 第一版通过提供商原生的“恢复会话”命令继续对话；不会向一个已打开的终端窗口模拟键盘输入。
- 中继按单实例设计，适合个人使用；若要多人或多副本部署，应增加集中式限速和消息清理任务。
- 公网必须使用 HTTPS。不要在裸 HTTP、公共共享电脑或不可信项目上启用“完全控制”。
