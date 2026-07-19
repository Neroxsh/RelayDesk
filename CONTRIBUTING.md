# Contributing

感谢你愿意改进 RelayDesk。

## 开发环境

- Node.js 22.13 或更高版本
- Windows 11（电脑端桥接的主要测试平台）
- 已登录的 Codex 或 Claude Code（仅真实会话测试需要）

```powershell
npm install
npm run lint
npm test
```

## 提交改动

1. 先开 issue 说明较大的功能或协议改动。
2. 每个 pull request 聚焦一个问题，并补充相应测试。
3. 不要提交 `.env`、`%USERPROFILE%\.relaydesk`、会话记录、密钥或调试截图。
4. 涉及移动端界面时，请至少检查 390 × 844 和桌面尺寸。
5. 涉及消息协议时，请验证断线重连、电脑端重启和重复消息。

界面文案应简短、直接，避免营销口号和不必要的安全术语。图标优先使用项目现有的 Lucide 图标集。
