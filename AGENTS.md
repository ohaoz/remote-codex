# AGENTS.md

## Cursor Cloud specific instructions

`codex-remote` (codex://remote) is a single Node.js product: a gateway (`server/index.js`) that
serves a vanilla-JS mobile web app (`web/`) and lets a phone browser control the local Codex CLI
via WebSockets. There is no database; state is flat files in `.data/` (dev checkout) — `auth.json`,
`audit.jsonl`, `token`, `pair.png`.

### Run / test / build
- Install deps: `npm install` (runs automatically via the startup update script).
- Tests: `npm test` (Node's built-in runner, `node --test`; ~143 tests, no external services needed —
  the Codex bridge and PTY are stubbed).
- There is no lint or build step (only `start` and `test` scripts exist in `package.json`).
- Start the gateway: `npm start` → listens on `0.0.0.0:7860` (override with `PORT`/`HOST`).

### Pairing (needed to use the web UI)
- On first start the gateway prints a one-time Owner pairing/recovery code and QR. Set
  `CODEX_REMOTE_TOKEN=<code>` before `npm start` to pin a known code for testing.
- Open `http://localhost:7860/#token=<code>` in a browser — the token in the URL hash auto-pairs the
  browser as the Owner device (writes `.data/auth.json`, logs `device.bootstrap-owner` in
  `.data/audit.jsonl`). The Owner code is consumed after the first device pairs.
- If all Owner sessions are lost, restarting prints a fresh 5-minute recovery code.

### Chat / terminal features require the external Codex CLI (not a repo dependency)
- The chat mode spawns `codex app-server` and the terminal mode can spawn the `codex` TUI. These need
  the Codex CLI installed globally on the host: `npm install -g @openai/codex`. Without it the web UI
  loads and pairing works, but chat shows "codex-app-server 未就绪" (not ready).
- Even with the CLI installed, real chat/model calls need a Codex login (ChatGPT OAuth) or an OpenAI
  API key — this must be provided by the user and cannot be done unattended.
- Terminal mode can instead open a plain shell (`$SHELL`/`/bin/bash`), which works without the Codex CLI.
