# codex://remote — 手机远程控制本机 Codex CLI

在电脑上跑一个轻量网关，手机浏览器扫码配对，获得两种完整的操控方式：

| 模式 | 说明 |
| --- | --- |
| **对话模式** | 原生手机聊天界面。流式回复、推理摘要、命令/补丁/MCP 工具卡片、审批一键放行、会话恢复/新建、模型切换条与斜杠命令面板（`/status` `/model` `/review` `/compact` `/mcp` 等，与 Codex CLI 同源）、会话内上下文与额度仪表。基于 `codex app-server` 协议（与 VS Code 插件同源），支持 Codex 全部核心能力。 |
| **终端模式** | 真实 PTY 里跑完整的 **Codex TUI**（以及 PowerShell）。xterm.js 渲染 + 快捷键条（Esc/Tab/Ctrl/方向键/^C），TUI 的所有交互（/status、/model、审批弹窗、resume 选择器等）原样可用。断线重连自动回放屏幕。 |

> 前置要求：Node.js ≥ 18，本机已安装 Codex CLI（`npm install -g @openai/codex`）。Codex 未登录也能启动——可直接在手机上完成 ChatGPT 账号登录（见下）。

## 快速开始

### 方式一：命令行安装（无需克隆仓库）

```bash
# 首次安装（二选一）
npm install -g codex-remote                                    # 从 npm（发布后）
npm install -g git+https://github.com/ohaoz/remote-codex.git  # 或直接装 GitHub 仓库

# 以后每次只需
codex-remote
```

### 方式二：源码运行

```bash
git clone https://github.com/ohaoz/remote-codex.git
cd remote-codex
npm install
npm start          # 默认端口 7860
```

启动后终端会打印**一次性 Owner 配对码**和二维码（每个局域网网卡一个，另存一份 `pair.png` 于数据目录）。

手机与电脑连同一 Wi-Fi，扫码即可打开并自动配对——**第一台配对的设备成为 Owner 设备**，配对码随即作废销毁。浏览器菜单里选「添加到主屏幕」即可获得类原生 App 体验。

### CLI 命令

| 命令 | 说明 |
| --- | --- |
| `codex-remote`（或 `codex-remote start`） | 启动网关，首次打印配对二维码 |
| `codex-remote qr` | Owner 尚未配对时，重新打印配对二维码 |
| `codex-remote --help` | 帮助 |

## 给其他设备授权

Owner 配对完成后，配对码不再存在；新设备一律通过**一次性邀请**接入：

1. Owner 手机打开「状态」页 → SHARE 分享接入；
2. 选择权限档位创建邀请：**仅聊天** / **只读** / **完整控制**；
3. 新设备扫邀请二维码（或手输邀请码），**5 分钟内有效、只能用一次**。

| 权限档位 | 能做什么 |
| --- | --- |
| 仅聊天 | 只能对话；发起的回合强制运行在只读沙箱、不可触发审批 |
| 只读 | 对话 + 查看账户/文件/终端画面；同样强制只读沙箱 |
| 完整控制 | 与 Owner 等同的操作能力（对话、审批、终端读写），但不能管理设备/账号 |

设备可随时在「状态 → 设备与权限」里改名或撤销；撤销立即断开该设备的连接。

## 架构

```
手机浏览器 (PWA)
   │  WebSocket /ws/events     JSON-RPC 代理 + 事件流 + 审批（一次性 ticket 鉴权）
   │  WebSocket /ws/term/:id   PTY 字节流 (xterm.js)
   ▼
Node 网关 (server/index.js + server/gateway.js, 端口 7860)
   ├─ PairingService / AuthStore   设备配对、Cookie 会话、邀请、审计
   ├─ CodexBridge  ──spawn──▶  codex app-server   (对话模式, JSON-RPC v2)
   └─ TerminalManager ─PTY──▶  codex / powershell (终端模式, ConPTY)
```

- `server/gateway.js` — HTTP/WS 网关：静态资源、配对/会话/邀请/设备管理 API、按设备权限过滤的 RPC 代理。
- `server/codex.js` — 管理 `codex app-server` 子进程：方法白名单、事件广播、审批请求暂存、每线程事件缓存（断线重连回放）、崩溃自动重启。
- `server/auth-store.js` / `server/pairing.js` / `server/policy.js` — 设备信任状态（原子落盘）、一次性配对/邀请、权限档位与 RPC 能力映射。
- `server/terminals.js` — `@lydell/node-pty` 会话管理，40 万字符滚动缓冲。
- `web/` — 无框架单页应用（Anthropic 式暖纸质风格），marked + DOMPurify 渲染 markdown，xterm.js 渲染终端。

## 安全

- **设备配对制，没有永久令牌**：首启打印的 Owner 码一次有效，配对后自动销毁；后续设备走一次性邀请（5 分钟）。
- **会话凭据**：HttpOnly + SameSite=Strict Cookie（默认 30 天）；WebSocket 用一次性短时 ticket 升级，URL 里不出现长期凭据。
- **按设备权限执行**：每个 RPC 按权限档位放行；受限设备发起的对话强制只读沙箱 + 禁用审批；终端对无写权限的设备是只读画面（写入即断开）。
- **审计日志**：配对、邀请、撤销、登录、终端写入等关键动作追加写入数据目录的 `audit.jsonl`。
- **恢复机制**：所有 Owner 会话失效后，重启服务会打印 5 分钟有效的恢复码重新绑定 Owner。
- **限流**：配对接口按 IP / 配对码 / 全局三层滑动窗口限流。
- 服务器默认监听 `0.0.0.0:7860`，建议仅在可信局域网使用；公网暴露务必配合 HTTPS 隧道。

## 从外网访问（可选）

1. **Tailscale（推荐）**：电脑和手机都装 Tailscale，手机直接访问 `http://<电脑的tailscale IP>:7860/`。零配置、端到端加密。
2. **Cloudflare Tunnel**：`cloudflared tunnel --url http://localhost:7860`，得到公网 HTTPS 地址。
3. **frp / ngrok** 等自选方案同理。

## 常用操作

- **新建/恢复会话**：左上角 ≡ 打开会话抽屉，或直接输入 `/new`、`/resume`。
- **切模型/推理强度**：输入框上方的模型切换条（或 `/model`），设置对下一回合生效。
- **会话状态**：输入 `/status`——同一面板查看会话设置、上下文剩余与账户额度。
- **斜杠命令**：输入 `/` 唤起命令面板：`/status` `/model` `/approvals` `/review` `/new` `/resume` `/compact` `/diff` `/mcp` `/skills` `/init`。
- **审批策略/沙箱/目录**：输入框上方胶囊按钮，设置对下一回合生效。
- **审批**：Codex 请求运行命令/写文件时，页面底部弹出卡片，可选 允许 / 本会话均允许 / 拒绝，带震动提醒。
- **中断回合**：回合进行中发送按钮变为红色停止键。
- **查看本回合改动**：右上角分支图标，弹出统一 diff。
- **终端**：底部「终端」页 → 启动 Codex TUI / PowerShell；右上 ✕ 结束会话。
- **设备管理**：「状态」页 → 设备与权限：查看、改名、撤销设备；分享接入创建邀请。
- **登录/切换 Codex 账号**：「状态」页 →「登录 / 切换账号」→「ChatGPT 账号登录」，走与 `codex login` 相同的官方 OAuth 授权：
  - **人在电脑旁（推荐）**：点「在电脑上打开授权页」，授权页在电脑默认浏览器弹出，登录后手机端自动确认。
  - **只用手机**：点「在手机上打开授权页」，完成授权后会跳到打不开的 `http://localhost:1455/...` 页面（正常现象），复制完整网址回应用粘贴提交。
  - 也可选「使用 API Key」粘贴 OpenAI API Key 登录。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `7860` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `CODEX_REMOTE_DATA_DIR` | 见下 | 设备信任状态/审计日志目录 |
| `CODEX_REMOTE_TOKEN` | 自动生成 | 指定首次 Owner 配对码内容（一次性，配对后作废） |

数据目录默认规则：源码目录运行（存在 `.git` 或已有 `.data`）→ `<项目>/.data`；全局安装运行 → `~/.codex-remote`（升级不丢配对状态）。
