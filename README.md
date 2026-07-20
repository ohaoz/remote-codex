# codex://remote — 手机远程控制本机 Codex CLI

在电脑上跑一个轻量网关，手机浏览器扫码即连，获得两种完整的操控方式：

| 模式 | 说明 |
| --- | --- |
| **对话模式** | 原生手机聊天界面。流式回复、推理摘要、命令/补丁/MCP 工具卡片、审批一键放行、会话恢复/新建、模型切换条与斜杠命令面板（`/status` `/model` `/review` `/compact` `/mcp` 等，与 Codex CLI 同源）、会话内上下文与额度仪表。基于 `codex app-server` 协议（与 VS Code 插件同源），支持 Codex 全部核心能力。 |
| **终端模式** | 真实 PTY 里跑完整的 **Codex TUI**（以及 PowerShell）。xterm.js 渲染 + 快捷键条（Esc/Tab/Ctrl/方向键/^C），TUI 的所有交互（/status、/model、审批弹窗、resume 选择器等）原样可用。断线重连自动回放屏幕。 |

## 快速开始

```bash
npm install
npm start          # 默认端口 7860
```

启动后终端会打印 **访问令牌** 和多个 **二维码**（每个局域网网卡一个）。

手机与电脑连同一 Wi-Fi，扫码即可打开并自动配对（令牌包含在链接的 `#token=` 片段里，也可手动输入令牌登录）。浏览器菜单里选「添加到主屏幕」即可获得类原生 App 体验。

> 前置要求：本机已安装 Codex CLI，Node.js ≥ 18。未登录也能启动——可直接在手机上完成 ChatGPT 账号登录（见下）。

## 架构

```
手机浏览器 (PWA)
   │  WebSocket /ws/events     JSON-RPC 代理 + 事件流 + 审批
   │  WebSocket /ws/term/:id   PTY 字节流 (xterm.js)
   ▼
Node 网关 (server/index.js, 端口 7860, 令牌鉴权)
   ├─ CodexBridge  ──spawn──▶  codex app-server   (对话模式, JSON-RPC v2)
   └─ TerminalManager ─PTY──▶  codex / powershell (终端模式, ConPTY)
```

- `server/codex.js` — 管理 `codex app-server` 子进程：方法白名单代理、事件广播、审批请求暂存（等手机决策）、每线程事件缓存（断线重连回放）、崩溃自动重启。
- `server/terminals.js` — `@lydell/node-pty` 会话管理，40 万字符滚动缓冲。
- `web/` — 无框架单页应用（Anthropic 式暖纸质风格：象牙纸底、衬线标题、陶土橙单点缀色，代码与终端沉入暖黑「窗井」，自动跟随系统深色模式），marked + DOMPurify 渲染 markdown，xterm.js 渲染终端。

## 安全

- 所有 HTTP/WS 接口都要求访问令牌（首次启动生成，存于 `.data/token`；可用环境变量 `CODEX_REMOTE_TOKEN` 覆盖）。
- 令牌校验使用常数时间比较；WS 升级前校验。
- 服务器默认监听 `0.0.0.0:7860`，仅建议在可信局域网使用。

## 从外网访问（可选）

服务本身是普通 HTTP 服务，任选一种隧道方案：

1. **Tailscale（推荐）**：电脑和手机都装 Tailscale，手机直接访问 `http://<电脑的tailscale IP>:7860/#token=...`。零配置、端到端加密。
2. **Cloudflare Tunnel**：`cloudflared tunnel --url http://localhost:7860`，得到公网 HTTPS 地址（务必保管好令牌）。
3. **frp / ngrok** 等自选方案同理。

> 公网暴露时建议放在 HTTPS 之后（隧道方案自带），令牌泄露等于本机 Codex 权限泄露，请谨慎。

## 常用操作

- **新建/恢复会话**：左上角 ≡ 打开会话抽屉，或直接输入 `/new`、`/resume`。
- **切模型/推理强度**：输入框上方的模型切换条（或 `/model`），实时刷新模型目录，设置对下一回合生效；切换条左侧圆环实时显示剩余上下文。
- **会话状态**：输入 `/status` 或点切换条左侧按钮——同一面板内查看会话设置、上下文剩余与账户额度，可一键刷新。
- **斜杠命令**：输入 `/` 唤起命令面板（与 Codex CLI 同源）：`/status` `/model` `/approvals` `/review` `/new` `/resume` `/compact` `/diff` `/mcp` `/skills` `/init`；右侧 `</>` 按钮可查看完整帮助。
- **审批策略/沙箱/目录**：输入框上方胶囊按钮，设置对下一回合生效。
- **审批**：Codex 请求运行命令/写文件/提权时，页面底部弹出陶土色卡片，可选 允许 / 本会话均允许 / 拒绝，带震动提醒。
- **中断回合**：回合进行中发送按钮变为红色停止键。
- **查看本回合改动**：右上角分支图标，弹出统一 diff。
- **终端**：底部「终端」页 → 启动 Codex TUI / PowerShell；右上 ✕ 结束会话。
- **分享接入**：「状态」页有二维码，另一台手机扫码即可接入。
- **登录/切换 Codex 账号**：「状态」页 →「登录 / 切换账号」→「ChatGPT 账号登录」，走与 `codex login` 相同的官方 OAuth 授权：
  - **人在电脑旁（推荐）**：点「在电脑上打开授权页」，授权页会在电脑默认浏览器弹出，登录后手机端自动确认。
  - **只用手机**：点「在手机上打开授权页」，在手机浏览器完成登录授权；随后会跳到一个打不开的 `http://localhost:1455/...` 页面（正常现象），复制地址栏完整网址，回到应用粘贴提交即可。
  - 也可选「使用 API Key」粘贴 OpenAI API Key 登录。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `7860` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `CODEX_REMOTE_TOKEN` | 自动生成 | 固定访问令牌 |
