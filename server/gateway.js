'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { submitApproval } = require('./approval-protocol');
const { PairRateLimiter } = require('./pairing');
const defaultPolicy = require('./policy');

const ROOT = path.join(__dirname, '..');
const EVENTS_PROTOCOL_VERSION = 2;

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function createTokenAuth(token) {
  const expected = String(token || '');
  return {
    token: expected,
    verify(candidate) {
      return Boolean(expected) && timingSafeEqual(candidate, expected);
    },
  };
}

function lanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

function listDrives(platform = process.platform) {
  if (platform !== 'win32') return ['/'];
  const out = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(root)) out.push(root);
    } catch {}
  }
  return out;
}

/** Mirrors terminals.defaultShellLabel without forcing node-pty to load. */
function shellLabelFor(platform = process.platform, env = process.env) {
  if (platform === 'win32') return 'PowerShell';
  const shell = String(env.SHELL || '/bin/bash');
  return shell.split('/').pop() || 'shell';
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function sessionCookie(token, {
  secure = false,
  maxAgeMs = null,
  clear = false,
} = {}) {
  const parts = [
    `cr_session=${clear ? '' : encodeURIComponent(String(token || ''))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) parts.push('Secure');
  if (clear) {
    parts.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  } else if (maxAgeMs != null) {
    parts.push(`Max-Age=${Math.max(1, Math.floor(Number(maxAgeMs) / 1000))}`);
  }
  return parts.join('; ');
}

function createGateway(options = {}) {
  const ownsBridge = options.ownsBridge ?? !options.bridge;
  const ownsTerminals = options.ownsTerminals ?? !options.terminals;
  const bridge = options.bridge
    || new (require('./codex').CodexBridge)(options.bridgeOptions);
  const terminals = options.terminals
    || new (require('./terminals').TerminalManager)(options.terminalOptions);
  const makeTerminalSyncFrames = options.terminalSyncFrames
    || ((snapshot) => require('./terminals').terminalSyncFrames(snapshot));
  const deviceAuth = options.deviceAuth || null;
  const accessPolicy = options.policy || defaultPolicy;
  const auth = options.auth || createTokenAuth(options.token);
  const clock = options.clock || { now: Date.now };
  const rootDir = options.rootDir || ROOT;
  const configuredPort = Number(options.port ?? 7860);
  const configuredHost = options.host || '0.0.0.0';
  const getLanAddresses = options.lanAddresses || lanAddresses;
  const spawnProcess = options.spawn || spawn;
  const httpGet = options.httpGet || http.get;
  const qrCode = options.qrCode || QRCode;
  const platform = options.platform || process.platform;
  const hostname = options.hostname || os.hostname;
  const homedir = options.homedir || os.homedir;
  const pairLimiter = new PairRateLimiter({
    ...(options.pairRateLimit || {}),
    clock: () => clock.now(),
  });
  const deviceConnections = new Map();
  const sessionConnections = new Map();
  const socketExpiryTimers = new Map();
  const revokeTimers = new Set();

  /**
   * `/api/open-url` may only launch authorization pages that this gateway
   * itself handed to a client via `account/login/start`. Tracking them here
   * closes the "owner device can make the desktop open arbitrary URLs" SSRF /
   * phishing surface: anything not in this short-lived set is rejected.
   */
  const pendingLoginUrls = new Map(); // authUrl -> expiresAt
  const LOGIN_URL_TTL_MS = 10 * 60_000;
  const MAX_PENDING_LOGIN_URLS = 5;

  function rememberLoginRpc(method, result) {
    if (method === 'account/login/start' && typeof result?.authUrl === 'string') {
      pendingLoginUrls.set(result.authUrl, clock.now() + LOGIN_URL_TTL_MS);
      while (pendingLoginUrls.size > MAX_PENDING_LOGIN_URLS) {
        pendingLoginUrls.delete(pendingLoginUrls.keys().next().value);
      }
      return;
    }
    if (method === 'account/login/cancel' || method === 'account/logout') {
      pendingLoginUrls.clear();
    }
  }

  function isPendingLoginUrl(url) {
    const expiresAt = pendingLoginUrls.get(url);
    if (!expiresAt) return false;
    if (expiresAt <= clock.now()) {
      pendingLoginUrls.delete(url);
      return false;
    }
    return true;
  }

  const onBridgeEventForLogin = (evt) => {
    if (evt?.method === 'account/login/completed') pendingLoginUrls.clear();
  };
  bridge.on('event', onBridgeEventForLogin);

  if (!deviceAuth && (!auth || typeof auth.verify !== 'function')) {
    throw new TypeError('auth.verify(candidate, checkedAt) is required');
  }
  if (!clock || typeof clock.now !== 'function') {
    throw new TypeError('clock.now() is required');
  }

  function isAuthorized(candidate) {
    if (!candidate) return false;
    try {
      return Boolean(auth.verify(String(candidate), clock.now()));
    } catch {
      return false;
    }
  }

  function toPrincipal(raw) {
    return raw ? accessPolicy.createPrincipal(raw) : null;
  }

  function requestPrincipal(req) {
    if (!deviceAuth) {
      const candidate = req.headers['x-auth-token'] || req.query.token;
      if (!isAuthorized(candidate)) return null;
      return toPrincipal({
        deviceId: 'legacy-owner',
        name: 'Legacy owner',
        platform: 'legacy',
        scope: 'full-control',
        owner: true,
      });
    }
    const token = parseCookies(req.headers.cookie).cr_session;
    return toPrincipal(deviceAuth.authenticateSession(token));
  }

  function canAccess(principal, action, resource) {
    return !deviceAuth || accessPolicy.can(principal, action, resource);
  }

  function audit(principal, event, critical = false) {
    if (!deviceAuth?.audit) return true;
    return deviceAuth.audit.record({
      actorDeviceId: principal?.deviceId || 'anonymous',
      connectionId: event.connectionId || null,
      action: event.action,
      resource: event.resource,
      result: event.result,
      correlationId: event.correlationId || crypto.randomUUID(),
      risk: event.risk || 'low',
      reason: event.reason || null,
    }, { critical });
  }

  function registerDeviceSocket(ws, req) {
    const deviceId = req.principal?.deviceId;
    if (!deviceId) return;
    let sockets = deviceConnections.get(deviceId);
    if (!sockets) {
      sockets = new Set();
      deviceConnections.set(deviceId, sockets);
    }
    sockets.add(ws);
    const sessionId = req.principal?.sessionId;
    let sessionSockets = null;
    if (sessionId) {
      sessionSockets = sessionConnections.get(sessionId);
      if (!sessionSockets) {
        sessionSockets = new Set();
        sessionConnections.set(sessionId, sessionSockets);
      }
      sessionSockets.add(ws);
    }
    const expiresAt = Number(req.principal?.expiresAt || 0);
    const scheduleExpiry = () => {
      const remaining = expiresAt - clock.now();
      if (remaining <= 0) {
        try { ws.close(4401, 'device session expired'); } catch {}
        return;
      }
      const timer = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_000_000));
      timer.unref?.();
      socketExpiryTimers.set(ws, timer);
    };
    if (expiresAt) scheduleExpiry();
    ws.once('close', () => {
      sockets.delete(ws);
      if (!sockets.size) deviceConnections.delete(deviceId);
      if (sessionSockets) {
        sessionSockets.delete(ws);
        if (!sessionSockets.size) sessionConnections.delete(sessionId);
      }
      const expiryTimer = socketExpiryTimers.get(ws);
      if (expiryTimer) clearTimeout(expiryTimer);
      socketExpiryTimers.delete(ws);
    });
  }

  function closeSessionSockets(sessionId, code = 4401, reason = 'device session ended') {
    const sockets = sessionConnections.get(sessionId);
    if (!sockets) return;
    for (const ws of [...sockets]) {
      try { ws.close(code, reason); } catch {}
    }
  }

  const onDeviceRevoked = (deviceId) => {
    const sockets = deviceConnections.get(deviceId);
    if (!sockets) return;
    for (const ws of [...sockets]) {
      try { ws.close(4403, 'device revoked'); } catch {}
      const timer = setTimeout(() => {
        revokeTimers.delete(timer);
        try {
          if (ws.readyState !== ws.CLOSED) ws.terminate();
        } catch {}
      }, 1_000);
      timer.unref?.();
      revokeTimers.add(timer);
    }
  };
  if (deviceAuth?.on) deviceAuth.on('device-revoked', onDeviceRevoked);

  const app = express();
  app.disable('x-powered-by');

  // The chat UI renders untrusted model/MCP output with hand-escaped
  // innerHTML. A strict CSP is the systemic backstop: even if one call site
  // ever forgets esc(), injected markup cannot execute script.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' ws: wss:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '));
    next();
  });

  app.use('/', express.static(path.join(rootDir, 'web'), { index: 'index.html' }));
  app.use('/vendor/xterm.js', (req, res) => res.sendFile(path.join(rootDir, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js')));
  app.use('/vendor/xterm.css', (req, res) => res.sendFile(path.join(rootDir, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css')));
  app.use('/vendor/addon-fit.js', (req, res) => res.sendFile(path.join(rootDir, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js')));
  app.use('/vendor/marked.js', (req, res) => res.sendFile(path.join(rootDir, 'node_modules', 'marked', 'marked.min.js')));
  app.use('/vendor/purify.js', (req, res) => res.sendFile(path.join(rootDir, 'node_modules', 'dompurify', 'dist', 'purify.min.js')));

  app.post('/api/pair', express.json({ limit: '16kb' }), (req, res) => {
    const { token, code, deviceName, platform: clientPlatform } = req.body || {};
    const pairingCode = String(code || token || '');
    if (!deviceAuth) {
      if (isAuthorized(pairingCode)) return res.json({ ok: true });
      return res.status(401).json({ ok: false, error: '配对码不正确' });
    }

    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const limit = pairLimiter.check(clientIp, pairingCode);
    if (!limit.allowed) {
      res.setHeader('retry-after', String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))));
      return res.status(429).json({ ok: false, error: '尝试次数过多，请稍后再试' });
    }
    try {
      const paired = deviceAuth.pair({
        code: pairingCode,
        deviceName,
        platform: clientPlatform,
      });
      pairLimiter.recordSuccess(clientIp, pairingCode);
      res.setHeader('set-cookie', sessionCookie(paired.sessionToken, {
        secure: req.secure,
        maxAgeMs: paired.sessionExpiresAt - clock.now(),
      }));
      return res.json({
        ok: true,
        device: {
          ...paired.device,
          capabilities: [...accessPolicy.principalCapabilities(paired.device)],
        },
        sessionExpiresAt: paired.sessionExpiresAt,
        migratedLegacyToken: paired.migratedLegacyToken,
      });
    } catch (error) {
      pairLimiter.recordFailure(clientIp, pairingCode);
      audit(null, {
        action: 'device.pair',
        resource: 'pairing-code',
        result: 'denied',
        reason: error.message,
        risk: 'medium',
      });
      return res.status(401).json({ ok: false, error: '配对码不正确' });
    }
  });

  app.use('/api', express.json({ limit: '2mb' }));
  app.use('/api', (req, res, next) => {
    const principal = requestPrincipal(req);
    if (!principal) return res.status(401).json({ error: 'unauthorized' });
    req.principal = principal;
    return next();
  });

  app.get('/api/session', (req, res) => {
    res.json({ device: req.principal });
  });

  app.post('/api/logout', (req, res) => {
    if (deviceAuth && req.principal.sessionId) {
      audit(req.principal, {
        action: 'device.logout',
        resource: `session:${req.principal.sessionId}`,
        result: 'accepted',
      });
      deviceAuth.store.revokeSession(req.principal.sessionId);
      setImmediate(() => closeSessionSockets(req.principal.sessionId));
    }
    res.setHeader('set-cookie', sessionCookie('', { secure: req.secure, clear: true }));
    res.json({ ok: true });
  });

  app.post('/api/ws-ticket', (req, res) => {
    if (!deviceAuth) return res.status(404).json({ error: 'device sessions disabled' });
    const { channel, termId } = req.body || {};
    const action = channel === 'terminal' ? 'terminal.read' : 'events.read';
    if (!canAccess(req.principal, action)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const issued = deviceAuth.issueWsTicket(req.principal, { channel, termId });
      return res.json({ ticket: issued.token, expiresAt: issued.expiresAt });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/devices', (req, res) => {
    if (!canAccess(req.principal, 'devices.manage')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    return res.json({ devices: deviceAuth.listDevices(req.principal) });
  });

  app.post('/api/invites', (req, res) => {
    if (!canAccess(req.principal, 'devices.manage')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const invite = deviceAuth.createInvite(req.principal, {
        scope: req.body?.scope,
        ttlMs: Math.min(5 * 60_000, Number(req.body?.ttlMs) || 5 * 60_000),
      });
      return res.status(201).json(invite);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/devices/:deviceId/revoke', (req, res) => {
    if (!canAccess(req.principal, 'devices.manage')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      deviceAuth.revokeDevice(req.principal, req.params.deviceId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/devices/:deviceId/rename', (req, res) => {
    // Same defense-in-depth style as the other device endpoints: check the
    // capability at the route even though PairingService re-checks it.
    // Renaming your own device is allowed without devices.manage.
    const renamesSelf = req.principal.deviceId === req.params.deviceId;
    if (!renamesSelf && !canAccess(req.principal, 'devices.manage')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 80) {
      return res.status(400).json({ error: '设备名需为 1–80 个字符' });
    }
    try {
      const device = deviceAuth.renameDevice(req.principal, req.params.deviceId, name);
      audit(req.principal, {
        action: 'device.rename',
        resource: `device:${req.params.deviceId}`,
        result: 'accepted',
      });
      return res.json({ device });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  const server = http.createServer(app);
  const wssEvents = new WebSocketServer({ noServer: true });
  const wssTerm = new WebSocketServer({ noServer: true });

  function listeningPort() {
    const address = server.address();
    return address && typeof address === 'object' ? address.port : configuredPort;
  }

  app.get('/api/qr', async (req, res) => {
    const addrs = getLanAddresses();
    const ip = addrs[0] || 'localhost';
    let pairingCode = auth.token || '';
    if (deviceAuth) {
      if (!canAccess(req.principal, 'devices.manage')) {
        return res.status(403).json({ error: 'forbidden' });
      }
      pairingCode = String(req.query.invite || '');
      if (!pairingCode) return res.status(400).json({ error: 'invite code required' });
    }
    const fragment = deviceAuth ? 'invite' : 'token';
    const url = `http://${ip}:${listeningPort()}/#${fragment}=${encodeURIComponent(pairingCode)}`;
    try {
      const png = await qrCode.toBuffer(url, {
        type: 'png',
        width: 400,
        margin: 1,
        color: { dark: '#0A0E13', light: '#FFFFFF' },
      });
      res.setHeader('content-type', 'image/png');
      res.send(png);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/status', (req, res) => {
    if (!canAccess(req.principal, 'status.read')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    res.json({
      bridge: bridge.info(),
      terminals: canAccess(req.principal, 'terminal.read') ? terminals.list() : [],
      approvals: canAccess(req.principal, 'approval.read') ? bridge.listPendingApprovals() : [],
      device: req.principal,
      server: {
        version: require('../package.json').version,
        host: hostname(),
        platform,
        shellLabel: shellLabelFor(platform),
        port: listeningPort(),
        addrs: getLanAddresses(),
        home: homedir(),
        drives: listDrives(platform),
      },
    });
  });

  app.post('/api/rpc', async (req, res) => {
    const { method, params } = req.body || {};
    if (!method || !bridge.isAllowed(method)) {
      return res.status(400).json({ error: `method not allowed: ${method}` });
    }
    if (!canAccess(req.principal, 'rpc', method)) {
      audit(req.principal, {
        action: 'rpc.denied',
        resource: `rpc:${method}`,
        result: 'denied',
        risk: 'medium',
      });
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const enforced = deviceAuth
        ? accessPolicy.enforceRpcParams(req.principal, method, params)
        : params;
      if (deviceAuth && accessPolicy.rpcCapability(method) === 'account.manage') {
        audit(req.principal, {
          action: 'account.manage',
          resource: `rpc:${method}`,
          result: 'attempted',
          risk: 'high',
        }, true);
      }
      const result = await bridge.call(method, enforced);
      rememberLoginRpc(method, result);
      audit(req.principal, {
        action: 'rpc.call',
        resource: `rpc:${method}`,
        result: 'accepted',
      });
      return res.json({ result });
    } catch (error) {
      return res.status(500).json({ error: error.message, code: error.code, data: error.data });
    }
  });

  app.post('/api/open-url', (req, res) => {
    if (!canAccess(req.principal, 'account.manage')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const { url } = req.body || {};
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'invalid url' });
    }
    // Exact-match against auth URLs this gateway returned from
    // account/login/start; arbitrary URLs (including intranet http://) are
    // rejected even for owner devices.
    if (!isPendingLoginUrl(url)) {
      audit(req.principal, {
        action: 'account.open-url',
        resource: 'desktop-browser',
        result: 'denied',
        reason: 'url is not a pending login authorization page',
        risk: 'medium',
      });
      return res.status(400).json({ error: '仅允许打开当前登录流程的授权页，请重新发起登录' });
    }
    try {
      let child;
      if (platform === 'win32') {
        // rundll32 takes the URL as a plain argument — nothing is parsed by
        // cmd.exe, so ^ % " & and friends stay inert.
        child = spawnProcess('rundll32', ['url.dll,FileProtocolHandler', url], {
          detached: true,
          stdio: 'ignore',
        });
      } else if (platform === 'darwin') {
        child = spawnProcess('open', [url], { detached: true, stdio: 'ignore' });
      } else {
        child = spawnProcess('xdg-open', [url], { detached: true, stdio: 'ignore' });
      }
      child.unref();
      audit(req.principal, {
        action: 'account.open-url',
        resource: 'desktop-browser',
        result: 'accepted',
        risk: 'medium',
      });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/login-callback', (req, res) => {
    if (!canAccess(req.principal, 'account.manage')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    let callbackUrl;
    try {
      callbackUrl = new URL(String((req.body || {}).url || ''));
    } catch {
      return res.status(400).json({ error: '无效的网址' });
    }
    // The codex login helper listens exactly on http://localhost:1455.
    // Pinning protocol, host and port keeps this endpoint from being used to
    // probe other local services (limited SSRF).
    if (
      callbackUrl.protocol !== 'http:'
      || !/^(localhost|127\.0\.0\.1)$/i.test(callbackUrl.hostname)
      || (callbackUrl.port || '1455') !== '1455'
    ) {
      return res.status(400).json({ error: '请粘贴以 http://localhost:1455 开头的回调网址' });
    }
    let done = false;
    const finish = (status, body) => {
      if (done) return;
      done = true;
      res.status(status).json(body);
    };
    const forwarded = httpGet(
      {
        host: '127.0.0.1',
        port: '1455',
        path: callbackUrl.pathname + callbackUrl.search,
        timeout: 20000,
      },
      (response) => {
        response.resume();
        response.on('end', () => finish(200, { ok: response.statusCode < 400, status: response.statusCode }));
      },
    );
    forwarded.on('timeout', () => forwarded.destroy(new Error('登录服务响应超时')));
    forwarded.on('error', (error) => {
      finish(502, { error: `转发回调失败：${error.message}（登录会话可能已过期，请重新发起登录）` });
    });
    return undefined;
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    let principal;
    let channel;
    let termId = null;
    if (url.pathname === '/ws/events') {
      channel = 'events';
    } else if (url.pathname.startsWith('/ws/term/')) {
      channel = 'terminal';
      termId = url.pathname.split('/').pop();
    } else {
      socket.destroy();
      return;
    }
    if (deviceAuth) {
      principal = toPrincipal(deviceAuth.consumeWsTicket(
        url.searchParams.get('ticket'),
        { channel, termId },
      ));
    } else if (isAuthorized(url.searchParams.get('token'))) {
      principal = toPrincipal({
        deviceId: 'legacy-owner',
        name: 'Legacy owner',
        platform: 'legacy',
        scope: 'full-control',
        owner: true,
      });
    }
    const required = channel === 'terminal' ? 'terminal.read' : 'events.read';
    if (!principal || !canAccess(principal, required)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    req.principal = principal;
    req.connectionId = crypto.randomUUID();
    if (url.pathname === '/ws/events') {
      wssEvents.handleUpgrade(req, socket, head, (ws) => wssEvents.emit('connection', ws, req));
    } else if (url.pathname.startsWith('/ws/term/')) {
      req.termId = termId;
      wssTerm.handleUpgrade(req, socket, head, (ws) => wssTerm.emit('connection', ws, req));
    }
  });

  function wsSend(ws, message) {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {}
  }

  wssEvents.on('connection', (ws, req) => {
    registerDeviceSocket(ws, req);
    const principal = req.principal;
    wsSend(ws, {
      type: 'hello',
      protocolVersion: EVENTS_PROTOCOL_VERSION,
      streamId: bridge.streamId,
      bridge: bridge.state,
      approvals: canAccess(principal, 'approval.read') ? bridge.listPendingApprovals() : [],
      terminals: canAccess(principal, 'terminal.read') ? terminals.list() : [],
      device: principal,
    });

    ws.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.type === 'rpc') {
        if (!bridge.isAllowed(message.method)) {
          wsSend(ws, {
            type: 'rpc-result',
            reqId: message.reqId,
            error: `method not allowed: ${message.method}`,
          });
          return;
        }
        if (!canAccess(principal, 'rpc', message.method)) {
          wsSend(ws, {
            type: 'rpc-result',
            reqId: message.reqId,
            error: 'forbidden',
            code: 403,
          });
          return;
        }
        try {
          const enforced = deviceAuth
            ? accessPolicy.enforceRpcParams(principal, message.method, message.params)
            : message.params;
          if (deviceAuth && accessPolicy.rpcCapability(message.method) === 'account.manage') {
            audit(principal, {
              connectionId: req.connectionId,
              action: 'account.manage',
              resource: `rpc:${message.method}`,
              result: 'attempted',
              risk: 'high',
            }, true);
          }
          const result = await bridge.call(message.method, enforced);
          rememberLoginRpc(message.method, result);
          wsSend(ws, { type: 'rpc-result', reqId: message.reqId, result });
        } catch (error) {
          wsSend(ws, {
            type: 'rpc-result',
            reqId: message.reqId,
            error: error.message,
            code: error.code,
            data: error.data,
          });
        }
        return;
      }

      if (message.type === 'approval') {
        if (!canAccess(principal, 'approval.submit')) {
          wsSend(ws, {
            type: 'approval-ack',
            rpcId: message.rpcId,
            submissionId: message.submissionId,
            status: 'failed',
            retryable: false,
            error: 'forbidden',
          });
          return;
        }
        const ack = submitApproval({
          bridge,
          message,
          sendAck: (ack) => wsSend(ws, ack),
          publishResolution: (resolution) => bridge.publishApprovalResolution(resolution),
        });
        audit(principal, {
          connectionId: req.connectionId,
          action: 'approval.submit',
          resource: `approval:${message.rpcId}`,
          result: ack.status,
          risk: 'high',
        });
        return;
      }

      if (message.type === 'replay') {
        const isLegacy = message.reqId === undefined
          && message.streamId === undefined
          && message.afterSeq === undefined;
        if (isLegacy) {
          wsSend(ws, {
            type: 'replay',
            threadId: message.threadId,
            events: bridge.cachedEvents(message.threadId),
          });
        } else {
          const replay = bridge.replaySince(message.threadId, message.streamId, message.afterSeq);
          wsSend(ws, { type: 'replay-result', reqId: message.reqId, ...replay });
        }
        return;
      }

      if (message.type === 'term-create') {
        if (!canAccess(principal, 'terminal.create')) {
          wsSend(ws, {
            type: 'term-created',
            error: 'forbidden',
            reqId: message.reqId,
          });
          return;
        }
        try {
          const session = terminals.create(message.kind || 'codex', {
            cwd: message.cwd,
            cols: message.cols,
            rows: message.rows,
            resumeId: message.resumeId,
          });
          wsSend(ws, {
            type: 'term-created',
            term: terminals.describe(session),
            reqId: message.reqId,
          });
          audit(principal, {
            connectionId: req.connectionId,
            action: 'terminal.create',
            resource: `terminal:${session.id}`,
            result: 'accepted',
            risk: 'high',
          });
        } catch (error) {
          wsSend(ws, { type: 'term-created', error: error.message, reqId: message.reqId });
        }
        return;
      }

      if (message.type === 'term-kill' && canAccess(principal, 'terminal.kill')) {
        terminals.kill(message.id);
        audit(principal, {
          connectionId: req.connectionId,
          action: 'terminal.kill',
          resource: `terminal:${message.id}`,
          result: 'accepted',
          risk: 'high',
        });
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
    const onApproval = (entry) => {
      if (!canAccess(principal, 'approval.read')) return;
      wsSend(ws, {
        type: 'approval',
        rpcId: String(entry.id),
        method: entry.method,
        params: entry.params,
        context: entry.context,
        receivedAt: entry.receivedAt,
      });
    };
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
    const onTermCreated = () => {
      if (canAccess(principal, 'terminal.read')) {
        wsSend(ws, { type: 'term-list', terminals: terminals.list() });
      }
    };
    const onTermClosed = onTermCreated;
    const onTermExit = (id, code) => {
      if (canAccess(principal, 'terminal.read')) wsSend(ws, { type: 'term-exit', id, code });
    };

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

  wssTerm.on('connection', (ws, req) => {
    registerDeviceSocket(ws, req);
    const principal = req.principal;
    let writeAudited = false;
    const id = req.termId;
    const session = terminals.get(id);
    if (!session) {
      ws.close(4404, 'no such terminal');
      return;
    }

    const onData = (terminalId, data) => {
      if (terminalId === id && ws.readyState === ws.OPEN) ws.send(data);
    };
    const onExit = (terminalId, code) => {
      if (terminalId === id && ws.readyState === ws.OPEN) ws.close(4000, `exit ${code}`);
    };
    terminals.on('data', onData);
    terminals.on('exit', onExit);

    const snapshot = terminals.snapshot(id);
    for (const frame of makeTerminalSyncFrames(snapshot)) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
    if (!snapshot.alive && ws.readyState === ws.OPEN) {
      ws.close(4000, 'terminal already exited');
    }

    ws.on('message', (raw, isBinary) => {
      const text = raw.toString();
      if (!isBinary && text.startsWith('\u0000')) {
        try {
          const control = JSON.parse(text.slice(1));
          if (control.op === 'resize') {
            if (!canAccess(principal, 'terminal.resize')) {
              ws.close(4408, 'terminal is read-only');
              return;
            }
            terminals.resize(id, control.cols, control.rows);
          }
        } catch {}
        return;
      }
      if (!canAccess(principal, 'terminal.write')) {
        ws.close(4408, 'terminal is read-only');
        return;
      }
      if (!writeAudited) {
        writeAudited = true;
        audit(principal, {
          connectionId: req.connectionId,
          action: 'terminal.write',
          resource: `terminal:${id}`,
          result: 'accepted',
          risk: 'high',
        });
      }
      terminals.write(id, text);
    });
    ws.on('close', () => {
      terminals.off('data', onData);
      terminals.off('exit', onExit);
    });
  });

  function listen({ port = configuredPort, host = configuredHost } = {}) {
    if (server.listening) return Promise.resolve(server.address());
    return new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        resolve(server.address());
      });
    });
  }

  let closePromise = null;
  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      let failure = null;
      try {
        bridge.off('event', onBridgeEventForLogin);
        if (deviceAuth?.off) deviceAuth.off('device-revoked', onDeviceRevoked);
        for (const timer of revokeTimers) clearTimeout(timer);
        revokeTimers.clear();
        for (const timer of socketExpiryTimers.values()) clearTimeout(timer);
        socketExpiryTimers.clear();
        for (const ws of [...wssEvents.clients, ...wssTerm.clients]) {
          try {
            ws.terminate();
          } catch {}
        }
        if (server.listening) {
          await new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeIdleConnections?.();
          });
        }
        await Promise.all([wssEvents, wssTerm].map((wss) => new Promise((resolve) => {
          wss.close(() => resolve());
        })));
      } catch (error) {
        failure = error;
      }
      if (ownsBridge) {
        const disposeBridge = bridge.dispose || bridge.stop;
        if (typeof disposeBridge === 'function') {
          try {
            await disposeBridge.call(bridge);
          } catch (error) {
            failure ||= error;
          }
        }
      }
      if (ownsTerminals) {
        const disposeTerminals = terminals.dispose || terminals.stop;
        if (typeof disposeTerminals === 'function') {
          try {
            await disposeTerminals.call(terminals);
          } catch (error) {
            failure ||= error;
          }
        }
      }
      if (failure) throw failure;
    })();
    return closePromise;
  }

  return {
    app,
    server,
    wssEvents,
    wssTerm,
    bridge,
    terminals,
    auth,
    deviceAuth,
    ownsBridge,
    ownsTerminals,
    listen,
    close,
  };
}

module.exports = {
  EVENTS_PROTOCOL_VERSION,
  createGateway,
  createTokenAuth,
  lanAddresses,
  listDrives,
  timingSafeEqual,
};
