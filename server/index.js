'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { CodexBridge } = require('./codex');
const { submitApproval } = require('./approval-protocol');
const { TerminalManager, terminalSyncFrames } = require('./terminals');

const PORT = Number(process.env.PORT || 7860);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, '..', '.data');
const ROOT = path.join(__dirname, '..');
const EVENTS_PROTOCOL_VERSION = 2;

// ---------------------------------------------------------------------------
// Access token: generated once, persisted, printed as QR on startup.
// ---------------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
const tokenFile = path.join(DATA_DIR, 'token');
let TOKEN = process.env.CODEX_REMOTE_TOKEN || '';
if (!TOKEN) {
  try { TOKEN = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(tokenFile, TOKEN);
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const info of ifs[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core services
// ---------------------------------------------------------------------------
const bridge = new CodexBridge();
bridge.start().catch(() => {});
const terminals = new TerminalManager();

// ---------------------------------------------------------------------------
// HTTP app
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));

// Static: web UI + vendored browser libs
app.use('/', express.static(path.join(ROOT, 'web'), { index: 'index.html' }));
app.use('/vendor/xterm.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js')));
app.use('/vendor/xterm.css', (req, res) => res.sendFile(path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css')));
app.use('/vendor/addon-fit.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js')));
app.use('/vendor/marked.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules', 'marked', 'marked.min.js')));
app.use('/vendor/purify.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules', 'dompurify', 'dist', 'purify.min.js')));

// Pairing endpoint used by the login screen (no auth: it only validates)
app.post('/api/pair', (req, res) => {
  const { token } = req.body || {};
  if (token && timingSafeEqual(token, TOKEN)) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: '配对码不正确' });
  }
});

// Everything below requires the token
app.use('/api', (req, res, next) => {
  const t = req.headers['x-auth-token'] || req.query.token;
  if (t && timingSafeEqual(t, TOKEN)) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.get('/api/qr', async (req, res) => {
  const addrs = lanAddresses();
  const ip = addrs[0] || 'localhost';
  const url = `http://${ip}:${PORT}/#token=${TOKEN}`;
  try {
    const png = await QRCode.toBuffer(url, { type: 'png', width: 400, margin: 1, color: { dark: '#0A0E13', light: '#FFFFFF' } });
    res.setHeader('content-type', 'image/png');
    res.send(png);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function listDrives() {
  if (process.platform !== 'win32') return ['/'];
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':\\';
    try { if (fs.existsSync(root)) out.push(root); } catch {}
  }
  return out;
}

app.get('/api/status', (req, res) => {
  res.json({
    bridge: bridge.info(),
    terminals: terminals.list(),
    approvals: bridge.listPendingApprovals(),
    server: {
      version: require('../package.json').version,
      host: os.hostname(), platform: process.platform, port: PORT, addrs: lanAddresses(),
      home: os.homedir(), drives: listDrives(),
    },
  });
});

app.post('/api/rpc', async (req, res) => {
  const { method, params } = req.body || {};
  if (!method || !bridge.isAllowed(method)) {
    return res.status(400).json({ error: `method not allowed: ${method}` });
  }
  try {
    const result = await bridge.call(method, params);
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code, data: e.data });
  }
});

// Open a URL in the default browser *on this computer* (used by the ChatGPT
// OAuth login flow: the localhost callback must land on this machine).
app.post('/api/open-url', (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'invalid url' });
  }
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Relay the OAuth callback for phone-side login. After authorizing on the
// phone the browser is redirected to http://localhost:1455/auth/callback?...
// which only exists on this computer — the user pastes that URL here and we
// replay it against the local login server started by `codex app-server`.
app.post('/api/login-callback', (req, res) => {
  let u;
  try { u = new URL(String((req.body || {}).url || '')); } catch {
    return res.status(400).json({ error: '无效的网址' });
  }
  if (!/^(localhost|127\.0\.0\.1)$/i.test(u.hostname)) {
    return res.status(400).json({ error: '请粘贴以 http://localhost:1455 开头的回调网址' });
  }
  let done = false;
  const finish = (code, body) => { if (!done) { done = true; res.status(code).json(body); } };
  const fwd = http.get(
    { host: '127.0.0.1', port: u.port || '1455', path: u.pathname + u.search, timeout: 20000 },
    (r) => {
      r.resume();
      r.on('end', () => finish(200, { ok: r.statusCode < 400, status: r.statusCode }));
    }
  );
  fwd.on('timeout', () => fwd.destroy(new Error('登录服务响应超时')));
  fwd.on('error', (e) => finish(502, { error: `转发回调失败：${e.message}（登录会话可能已过期，请重新发起登录）` }));
});

// ---------------------------------------------------------------------------
// WebSocket gateway
//   /ws/events    — codex app-server event stream + approvals + rpc
//   /ws/term/:id  — raw PTY byte stream
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wssEvents = new WebSocketServer({ noServer: true });
const wssTerm = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token || !timingSafeEqual(token, TOKEN)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (url.pathname === '/ws/events') {
    wssEvents.handleUpgrade(req, socket, head, (ws) => wssEvents.emit('connection', ws, req));
  } else if (url.pathname.startsWith('/ws/term/')) {
    const id = url.pathname.split('/').pop();
    req.termId = id;
    wssTerm.handleUpgrade(req, socket, head, (ws) => wssTerm.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// --- events channel ---------------------------------------------------------
function wsSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

wssEvents.on('connection', (ws) => {
  wsSend(ws, {
    type: 'hello',
    protocolVersion: EVENTS_PROTOCOL_VERSION,
    streamId: bridge.streamId,
    bridge: bridge.state,
    approvals: bridge.listPendingApprovals(),
    terminals: terminals.list(),
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // JSON-RPC proxy over WS: {type:'rpc', reqId, method, params}
    if (msg.type === 'rpc') {
      if (!bridge.isAllowed(msg.method)) {
        return wsSend(ws, { type: 'rpc-result', reqId: msg.reqId, error: `method not allowed: ${msg.method}` });
      }
      try {
        const result = await bridge.call(msg.method, msg.params);
        wsSend(ws, { type: 'rpc-result', reqId: msg.reqId, result });
      } catch (e) {
        wsSend(ws, { type: 'rpc-result', reqId: msg.reqId, error: e.message, code: e.code, data: e.data });
      }
      return;
    }

    // Approval decision: {type:'approval', rpcId, submissionId, result}
    if (msg.type === 'approval') {
      submitApproval({
        bridge,
        message: msg,
        sendAck: (ack) => wsSend(ws, ack),
        publishResolution: (resolution) => bridge.publishApprovalResolution(resolution),
      });
      return;
    }

    // Sequence-aware replay used by current clients. Keep the old response
    // shape for legacy clients that only send {type:'replay', threadId}.
    if (msg.type === 'replay') {
      const isLegacy = msg.reqId === undefined
        && msg.streamId === undefined
        && msg.afterSeq === undefined;
      if (isLegacy) {
        wsSend(ws, { type: 'replay', threadId: msg.threadId, events: bridge.cachedEvents(msg.threadId) });
      } else {
        const replay = bridge.replaySince(msg.threadId, msg.streamId, msg.afterSeq);
        wsSend(ws, { type: 'replay-result', reqId: msg.reqId, ...replay });
      }
      return;
    }

    // Terminal management
    if (msg.type === 'term-create') {
      try {
        const s = terminals.create(msg.kind || 'codex', { cwd: msg.cwd, cols: msg.cols, rows: msg.rows, resumeId: msg.resumeId });
        wsSend(ws, { type: 'term-created', term: terminals.describe(s), reqId: msg.reqId });
      } catch (e) {
        wsSend(ws, { type: 'term-created', error: e.message, reqId: msg.reqId });
      }
      return;
    }
    if (msg.type === 'term-kill') {
      terminals.kill(msg.id);
      return;
    }
  });

  const onEvent = (evt) => wsSend(ws, {
    type: 'event',
    streamId: evt.streamId,
    threadId: evt.threadId,
    seq: evt.seq,
    method: evt.method,
    params: evt.params,
  });
  const onApproval = (entry) => wsSend(ws, {
    type: 'approval',
    rpcId: String(entry.id),
    method: entry.method,
    params: entry.params,
    context: entry.context,
    receivedAt: entry.receivedAt,
  });
  const onApprovalResolved = (resolution) => {
    const normalized = typeof resolution === 'object' && resolution
      ? resolution
      : { rpcId: String(resolution) };
    wsSend(ws, {
      type: 'approval-resolved',
      rpcId: String(normalized.rpcId),
      submissionId: normalized.submissionId || null,
      resolvedBySubmissionId: normalized.resolvedBySubmissionId || normalized.submissionId || null,
    });
  };
  const onStatus = (state, extra) => wsSend(ws, {
    type: 'bridge-status',
    state,
    streamId: bridge.streamId,
    approvals: bridge.listPendingApprovals(),
    ...extra,
  });
  const onTermCreated = (term) => wsSend(ws, { type: 'term-list', terminals: terminals.list() });
  const onTermClosed = () => wsSend(ws, { type: 'term-list', terminals: terminals.list() });
  const onTermExit = (id, code) => wsSend(ws, { type: 'term-exit', id, code });

  bridge.on('event', onEvent);
  bridge.on('approval', onApproval);
  bridge.on('approval-resolved', onApprovalResolved);
  bridge.on('status', onStatus);
  terminals.on('created', onTermCreated);
  terminals.on('closed', onTermClosed);
  terminals.on('exit', onTermExit);

  ws.on('close', () => {
    bridge.off('event', onEvent);
    bridge.off('approval', onApproval);
    bridge.off('approval-resolved', onApprovalResolved);
    bridge.off('status', onStatus);
    terminals.off('created', onTermCreated);
    terminals.off('closed', onTermClosed);
    terminals.off('exit', onTermExit);
  });
});

// --- terminal channel --------------------------------------------------------
wssTerm.on('connection', (ws, req) => {
  const id = req.termId;
  const session = terminals.get(id);
  if (!session) {
    ws.close(4404, 'no such terminal');
    return;
  }

  const onData = (tid, data) => { if (tid === id && ws.readyState === ws.OPEN) ws.send(data); };
  const onExit = (tid, code) => { if (tid === id && ws.readyState === ws.OPEN) ws.close(4000, `exit ${code}`); };
  terminals.on('data', onData);
  terminals.on('exit', onExit);

  // Snapshot protocol is sync-begin / ANSI replay / sync-end. Register live
  // listeners first; this synchronous block then establishes a no-gap handoff.
  const snapshot = terminals.snapshot(id);
  for (const frame of terminalSyncFrames(snapshot)) {
    if (ws.readyState === ws.OPEN) ws.send(frame);
  }
  if (!snapshot.alive && ws.readyState === ws.OPEN) {
    ws.close(4000, 'terminal already exited');
  }

  ws.on('message', (raw, isBinary) => {
    const text = raw.toString();
    // Control frames start with \x00 JSON, everything else is keystrokes
    if (!isBinary && text.startsWith('\u0000')) {
      try {
        const ctl = JSON.parse(text.slice(1));
        if (ctl.op === 'resize') terminals.resize(id, ctl.cols, ctl.rows);
      } catch {}
      return;
    }
    terminals.write(id, text);
  });
  ws.on('close', () => {
    terminals.off('data', onData);
    terminals.off('exit', onExit);
  });
});

// ---------------------------------------------------------------------------
// Startup banner with QR pairing codes
// ---------------------------------------------------------------------------
server.listen(PORT, HOST, async () => {
  const addrs = lanAddresses();
  const lines = [];
  lines.push('');
  lines.push('  ██████╗ ██████╗ ██████╗ ███████╗██╗  ██╗    Codex Remote');
  lines.push('  ██╔═══╝ ██╔══██╗██╔══██╗██╔════╝╚██╗██╔╝    手机远程控制 Codex CLI');
  lines.push('  ██║     ██║  ██║██║  ██║█████╗   ╚███╔╝ ');
  lines.push('  ██║     ██║  ██║██║  ██║██╔══╝   ██╔██╗ ');
  lines.push('  ╚██████╗╚██████╔╝██████╔╝███████╗██╔╝╚██╗   http://localhost:' + PORT);
  lines.push('   ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝');
  lines.push('');
  console.log(lines.join('\n'));
  console.log('  访问令牌 (token):', TOKEN);
  console.log('');
  for (const ip of addrs) {
    const url = `http://${ip}:${PORT}/#token=${TOKEN}`;
    console.log(`  手机扫码直连  ${url}`);
    try {
      console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    } catch {}
  }
  // Also save a scannable PNG next to the token for easy access
  if (addrs.length) {
    try {
      await QRCode.toFile(path.join(DATA_DIR, 'pair.png'),
        `http://${addrs[0]}:${PORT}/#token=${TOKEN}`,
        { type: 'png', width: 480, margin: 2 });
      console.log(`  二维码图片已保存：${path.join(DATA_DIR, 'pair.png')}`);
    } catch {}
  }
  if (!addrs.length) {
    console.log('  未检测到局域网 IPv4 地址，请检查网络。');
  }
  console.log('  （手机与电脑需在同一局域网；外网访问请配合 Tailscale / frp 等，详见 README）');
});
