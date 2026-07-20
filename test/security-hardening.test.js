'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGateway } = require('../server/gateway');
const { TerminalManager } = require('../server/terminals');
const { ThreadEventLog, CodexBridge } = require('../server/codex');
const { AuthStore } = require('../server/auth-store');
const { AuditLog } = require('../server/audit-log');
const { PairingService } = require('../server/pairing');
const policy = require('../server/policy');

class FakeBridge extends EventEmitter {
  constructor() {
    super();
    this.state = 'ready';
    this.streamId = 'security-stream';
    this.calls = [];
    this.responses = new Map();
  }

  info() { return { state: this.state }; }
  listPendingApprovals() { return []; }
  isAllowed(method) {
    return ['thread/read', 'account/login/start', 'account/login/cancel'].includes(method);
  }
  async call(method, params) {
    this.calls.push({ method, params });
    return this.responses.get(method) || { ok: true };
  }
  cachedEvents() { return []; }
  replaySince(threadId) {
    return {
      threadId,
      streamId: this.streamId,
      events: [],
      resetRequired: false,
      firstAvailableSeq: 1,
      lastSeq: 0,
      toSeq: 0,
      activeTurnId: null,
    };
  }
  publishApprovalResolution() {}
}

class FakeTerminals extends EventEmitter {
  list() { return []; }
  get() { return null; }
}

function tokenGateway(options = {}) {
  const bridge = new FakeBridge();
  const spawned = [];
  const httpRequests = [];
  const gateway = createGateway({
    bridge,
    terminals: new FakeTerminals(),
    auth: {
      token: 'sec-token',
      verify(candidate) { return candidate === 'sec-token'; },
    },
    platform: options.platform || 'win32',
    spawn: (command, args, spawnOptions) => {
      spawned.push({ command, args, spawnOptions });
      return { unref() {} };
    },
    httpGet: (request, onResponse) => {
      httpRequests.push(request);
      const fake = new EventEmitter();
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.resume = () => {};
        onResponse(response);
        response.emit('end');
      });
      fake.destroy = () => {};
      return fake;
    },
  });
  return { gateway, bridge, spawned, httpRequests };
}

async function withGateway(context, run) {
  await context.gateway.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${context.gateway.server.address().port}`;
  try {
    await run(base);
  } finally {
    await context.gateway.close();
  }
}

function authedPost(base, route, body) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      'x-auth-token': 'sec-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/* ------------------------- M4: security headers ------------------------- */

test('every response carries CSP and hardening headers', async () => {
  const context = tokenGateway();
  await withGateway(context, async (base) => {
    const response = await fetch(`${base}/api/status`, {
      headers: { 'x-auth-token': 'sec-token' },
    });
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  });
});

/* --------------------- M1a/M2: /api/open-url gating --------------------- */

test('open-url refuses URLs that were never issued by account/login/start', async () => {
  const context = tokenGateway();
  await withGateway(context, async (base) => {
    for (const url of [
      'https://evil.example.com/phish',
      'http://192.168.1.1/router-admin',
      'http://localhost:9200/_cat/indices',
    ]) {
      const response = await authedPost(base, '/api/open-url', { url });
      assert.equal(response.status, 400, `${url} must be rejected`);
    }
    assert.equal(context.spawned.length, 0, 'nothing may be spawned for rejected URLs');
  });
});

test('open-url opens exactly the pending auth URL without any shell parsing', async () => {
  const context = tokenGateway({ platform: 'win32' });
  const authUrl = 'https://auth.example.com/authorize?a=1&b=^%"cd';
  context.bridge.responses.set('account/login/start', { loginId: 'l1', authUrl });
  await withGateway(context, async (base) => {
    const started = await authedPost(base, '/api/rpc', {
      method: 'account/login/start',
      params: { type: 'chatgpt' },
    });
    assert.equal(started.status, 200);

    const opened = await authedPost(base, '/api/open-url', { url: authUrl });
    assert.equal(opened.status, 200);
    assert.equal(context.spawned.length, 1);
    const { command, args } = context.spawned[0];
    assert.equal(command, 'rundll32');
    assert.deepEqual(args, ['url.dll,FileProtocolHandler', authUrl]);
    assert.ok(
      !command.toLowerCase().includes('cmd'),
      'the Windows opener must not route through cmd.exe',
    );

    // Cancelling the login invalidates the previously issued URL.
    await authedPost(base, '/api/rpc', {
      method: 'account/login/cancel',
      params: { loginId: 'l1' },
    });
    const reopened = await authedPost(base, '/api/open-url', { url: authUrl });
    assert.equal(reopened.status, 400);
    assert.equal(context.spawned.length, 1);
  });
});

test('open-url uses argument-array openers on unix too', async () => {
  const context = tokenGateway({ platform: 'linux' });
  const authUrl = 'https://auth.example.com/authorize?x=1';
  context.bridge.responses.set('account/login/start', { loginId: 'l2', authUrl });
  await withGateway(context, async (base) => {
    await authedPost(base, '/api/rpc', { method: 'account/login/start', params: {} });
    const opened = await authedPost(base, '/api/open-url', { url: authUrl });
    assert.equal(opened.status, 200);
    assert.deepEqual(context.spawned[0].args, [authUrl]);
    assert.equal(context.spawned[0].command, 'xdg-open');
  });
});

/* ------------------ M1b: /api/login-callback pinning -------------------- */

test('login-callback only forwards to http://127.0.0.1:1455', async () => {
  const context = tokenGateway();
  await withGateway(context, async (base) => {
    for (const url of [
      'http://localhost:9200/auth/callback?code=1', // other local port
      'https://localhost:1455/auth/callback?code=1', // wrong protocol
      'http://169.254.169.254/latest/meta-data', // not localhost at all
      'ftp://localhost:1455/auth/callback',
    ]) {
      const response = await authedPost(base, '/api/login-callback', { url });
      assert.equal(response.status, 400, `${url} must be rejected`);
    }
    assert.equal(context.httpRequests.length, 0);

    const accepted = await authedPost(base, '/api/login-callback', {
      url: 'http://localhost:1455/auth/callback?code=ok',
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true, status: 200 });
    assert.equal(context.httpRequests.length, 1);
    assert.equal(context.httpRequests[0].host, '127.0.0.1');
    assert.equal(context.httpRequests[0].port, '1455');
    assert.equal(context.httpRequests[0].path, '/auth/callback?code=ok');
  });
});

/* --------------------- M3: rename device hardening ---------------------- */

function deviceGateway() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-security-'));
  const store = new AuthStore({ filePath: path.join(dir, 'auth.json') });
  const audit = new AuditLog({ filePath: path.join(dir, 'audit.jsonl') });
  const pairing = new PairingService({ store, legacyToken: 'boot-owner', audit });
  const gateway = createGateway({
    bridge: new FakeBridge(),
    terminals: new FakeTerminals(),
    deviceAuth: pairing,
    policy,
  });
  return { gateway, pairing };
}

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : '';
}

async function pairDevice(base, code, name) {
  const response = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: name }),
  });
  assert.equal(response.status, 200);
  return { cookie: cookieFrom(response), body: await response.json() };
}

test('rename is capability-checked at the route and validates the name', async () => {
  const context = deviceGateway();
  await context.gateway.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${context.gateway.server.address().port}`;
  try {
    const owner = await pairDevice(base, 'boot-owner', 'Owner phone');
    const invite = await fetch(`${base}/api/invites`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'chat-only' }),
    });
    assert.equal(invite.status, 201);
    const inviteBody = await invite.json();
    const member = await pairDevice(base, inviteBody.code, 'Member phone');

    const rename = (cookie, deviceId, name) => fetch(
      `${base}/api/devices/${encodeURIComponent(deviceId)}/rename`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      },
    );

    const ownerId = owner.body.device.id;
    const memberId = member.body.device.id;

    // A member may rename itself, but nobody else.
    assert.equal((await rename(member.cookie, memberId, '我的手机')).status, 200);
    assert.equal((await rename(member.cookie, ownerId, 'hijack')).status, 403);

    // Bad names are rejected before touching the store.
    assert.equal((await rename(owner.cookie, memberId, '')).status, 400);
    assert.equal((await rename(owner.cookie, memberId, '  ')).status, 400);
    assert.equal((await rename(owner.cookie, memberId, 'x'.repeat(81))).status, 400);
    assert.equal((await rename(owner.cookie, memberId, 12345)).status, 400);

    const renamed = await rename(owner.cookie, memberId, '客厅平板');
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).device.name, '客厅平板');
  } finally {
    await context.gateway.close();
  }
});

/* ----------------------- M5: memory upper bounds ------------------------ */

class FakePty extends EventEmitter {
  onData(handler) { this.on('data', handler); }
  onExit(handler) { this.on('exit', handler); }
  write() {}
  resize() {}
  kill() { this.emit('exit', { exitCode: 0 }); }
}

test('terminal manager caps live sessions and recycles dead ones', () => {
  const procs = [];
  const manager = new TerminalManager({
    spawn: () => {
      const proc = new FakePty();
      procs.push(proc);
      return proc;
    },
    maxLiveSessions: 2,
    maxDeadSessions: 1,
  });
  const closed = [];
  manager.on('closed', (id) => closed.push(id));

  const first = manager.create('shell');
  manager.create('shell');
  assert.throws(() => manager.create('shell'), /上限/);

  // An exited session frees a live slot…
  procs[0].emit('exit', { exitCode: 0 });
  const third = manager.create('shell');
  assert.ok(third.id);

  // …and dead sessions beyond the retention cap are recycled oldest-first.
  procs[1].emit('exit', { exitCode: 0 });
  procs[2].emit('exit', { exitCode: 0 });
  manager.create('shell');
  const retained = manager.list();
  assert.equal(retained.filter((session) => !session.alive).length, 1);
  assert.ok(closed.length >= 1);
  assert.ok(!retained.some((session) => session.id === first.id), 'oldest dead session is dropped');
});

test('thread event log enforces a per-thread payload budget without changing the wire shape', () => {
  const log = new ThreadEventLog({
    streamId: 'stream-a',
    maxEventsPerThread: 100,
    maxCharsPerThread: 400,
    maxThreads: 5,
  });

  for (let index = 1; index <= 5; index += 1) {
    log.append('item/agentMessage/delta', {
      threadId: 'thread-1',
      itemId: 'item-1',
      delta: `${index}`.repeat(100),
    });
  }

  const replay = log.replaySince('thread-1', 'stream-a', 0);
  assert.equal(replay.lastSeq, 5);
  assert.equal(replay.truncated, true);
  assert.equal(replay.resetRequired, true);
  assert.ok(replay.events.length < 5, 'oldest oversized events must be dropped');
  assert.equal(replay.events.at(-1).seq, 5);
  assert.deepEqual(
    Object.keys(replay.events.at(-1)).sort(),
    ['method', 'params', 'seq', 'streamId', 'threadId'],
    'byte accounting must not leak extra fields into replayed events',
  );
});

test('bridge stderr tail bounds both line count and line size', async () => {
  class FakeRpcProcess extends EventEmitter {
    start() {}
    async request() { return { ready: true }; }
    notify() {}
    kill() {}
  }
  const rpc = new FakeRpcProcess();
  const bridge = new CodexBridge({ createRpcProcess: () => rpc });
  await bridge.start();

  rpc.emit('stderr', 'x'.repeat(100000));
  for (let index = 0; index < 60; index += 1) rpc.emit('stderr', `line-${index}`);

  assert.equal(bridge.stderrTail.length, 50);
  assert.ok(bridge.stderrTail.every((line) => line.length <= 8192));
  await bridge.dispose();
});
