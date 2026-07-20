'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { AuthStore } = require('../server/auth-store');
const { PairingService } = require('../server/pairing');
const { AuditLog } = require('../server/audit-log');
const policy = require('../server/policy');

let createGateway;
try {
  ({ createGateway } = require('../server/gateway'));
} catch {}

class FakeBridge extends EventEmitter {
  constructor() {
    super();
    this.state = 'ready';
    this.streamId = 'device-stream';
    this.calls = [];
  }

  info() { return { state: this.state }; }
  listPendingApprovals() { return []; }
  isAllowed() { return true; }
  async call(method, params) {
    this.calls.push({ method, params });
    return { ok: true };
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
  constructor() {
    super();
    this.created = [];
    this.writes = [];
  }
  list() { return [{ id: '7', alive: true }]; }
  create(kind, options) {
    const terminal = { id: String(this.created.length + 1), kind, ...options, alive: true };
    this.created.push(terminal);
    return terminal;
  }
  describe(session) { return session; }
  get(id) { return String(id) === '7' ? { id: '7', alive: true } : null; }
  snapshot(id) {
    return {
      id: String(id),
      alive: true,
      generation: 'fake-terminal',
      firstAvailableOffset: 0,
      lastOffset: 0,
      buffer: '',
      truncated: false,
    };
  }
  kill() { return true; }
  write(id, data) { this.writes.push({ id, data }); }
  resize() {}
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-gateway-auth-'));
}

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : '';
}

async function request(base, route, { method = 'GET', cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function rejectedWebSocket(url, expectedStatus = 401) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => reject(new Error('websocket unexpectedly opened')));
    socket.once('error', () => {});
    socket.once('unexpected-response', (_request, response) => {
      try {
        assert.equal(response.statusCode, expectedStatus);
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function createDeviceGateway(options = {}) {
  assert.equal(typeof createGateway, 'function', 'device-aware gateway is missing');
  const dir = tempDir();
  const store = new AuthStore({ filePath: path.join(dir, 'auth.json') });
  const audit = new AuditLog({ filePath: path.join(dir, 'audit.jsonl') });
  const pairing = new PairingService({
    store,
    legacyToken: 'legacy-bootstrap',
    audit,
  });
  const bridge = new FakeBridge();
  const terminals = new FakeTerminals();
  const gateway = createGateway({
    bridge,
    terminals,
    deviceAuth: pairing,
    policy,
    pairRateLimit: options.pairRateLimit,
    terminalSyncFrames: () => [],
  });
  return { dir, store, pairing, bridge, terminals, gateway };
}

test('legacy bootstrap creates one owner cookie and websocket tickets are single-use', async () => {
  const context = createDeviceGateway();
  await context.gateway.listen({ host: '127.0.0.1', port: 0 });
  const port = context.gateway.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let socket;

  try {
    const paired = await request(base, '/api/pair', {
      method: 'POST',
      body: {
        token: 'legacy-bootstrap',
        deviceName: 'Owner phone',
        platform: 'ios',
      },
    });
    assert.equal(paired.status, 200);
    const cookie = cookieFrom(paired);
    assert.match(cookie, /^cr_session=/);
    assert.match(paired.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(paired.headers.get('set-cookie'), /SameSite=Strict/i);
    const pairBody = await paired.json();
    assert.equal(pairBody.device.owner, true);
    assert.equal('sessionToken' in pairBody, false);

    const replay = await request(base, '/api/pair', {
      method: 'POST',
      body: { token: 'legacy-bootstrap', deviceName: 'Replay' },
    });
    assert.equal(replay.status, 401);

    const session = await request(base, '/api/session', { cookie });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).device.name, 'Owner phone');

    const issued = await request(base, '/api/ws-ticket', {
      method: 'POST',
      cookie,
      body: { channel: 'events' },
    });
    assert.equal(issued.status, 200);
    const ticket = (await issued.json()).ticket;
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws/events?ticket=${encodeURIComponent(ticket)}`);
    const [raw] = await once(socket, 'message');
    assert.equal(JSON.parse(raw.toString()).type, 'hello');

    await rejectedWebSocket(
      `ws://127.0.0.1:${port}/ws/events?ticket=${encodeURIComponent(ticket)}`,
      401,
    );
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.close();
      await once(socket, 'close');
    }
    await context.gateway.close();
  }
});

test('owner invites scoped devices and revocation immediately closes their sockets', async () => {
  const context = createDeviceGateway();
  await context.gateway.listen({ host: '127.0.0.1', port: 0 });
  const port = context.gateway.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let guestSocket;

  try {
    const ownerPair = await request(base, '/api/pair', {
      method: 'POST',
      body: { token: 'legacy-bootstrap', deviceName: 'Owner' },
    });
    const ownerCookie = cookieFrom(ownerPair);

    const inviteResponse = await request(base, '/api/invites', {
      method: 'POST',
      cookie: ownerCookie,
      body: { scope: 'read-only' },
    });
    assert.equal(inviteResponse.status, 201);
    const invitation = await inviteResponse.json();

    const guestPair = await request(base, '/api/pair', {
      method: 'POST',
      body: {
        token: invitation.code,
        deviceName: 'Guest',
        platform: 'android',
      },
    });
    assert.equal(guestPair.status, 200);
    const guestCookie = cookieFrom(guestPair);
    const guest = (await guestPair.json()).device;
    assert.equal(guest.scope, 'read-only');

    const guestTicketResponse = await request(base, '/api/ws-ticket', {
      method: 'POST',
      cookie: guestCookie,
      body: { channel: 'events' },
    });
    const guestTicket = (await guestTicketResponse.json()).ticket;
    guestSocket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/events?ticket=${encodeURIComponent(guestTicket)}`,
    );
    await once(guestSocket, 'message');

    const revoked = await request(base, `/api/devices/${guest.id}/revoke`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {},
    });
    assert.equal(revoked.status, 200);
    const [code] = await once(guestSocket, 'close');
    assert.equal(code, 4403);

    const denied = await request(base, '/api/status', { cookie: guestCookie });
    assert.equal(denied.status, 401);
  } finally {
    if (guestSocket?.readyState === WebSocket.OPEN) guestSocket.terminate();
    await context.gateway.close();
  }
});

test('gateway enforces scoped RPC and terminal capabilities server-side', async () => {
  const context = createDeviceGateway();
  await context.gateway.listen({ host: '127.0.0.1', port: 0 });
  const port = context.gateway.server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const ownerPair = await request(base, '/api/pair', {
      method: 'POST',
      body: { token: 'legacy-bootstrap', deviceName: 'Owner' },
    });
    const ownerCookie = cookieFrom(ownerPair);
    const invite = await request(base, '/api/invites', {
      method: 'POST',
      cookie: ownerCookie,
      body: { scope: 'chat-only' },
    });
    const code = (await invite.json()).code;
    const chatPair = await request(base, '/api/pair', {
      method: 'POST',
      body: { token: code, deviceName: 'Chat phone' },
    });
    const chatCookie = cookieFrom(chatPair);

    const fsDenied = await request(base, '/api/rpc', {
      method: 'POST',
      cookie: chatCookie,
      body: { method: 'fs/readDirectory', params: { path: 'C:\\' } },
    });
    assert.equal(fsDenied.status, 403);

    const turn = await request(base, '/api/rpc', {
      method: 'POST',
      cookie: chatCookie,
      body: {
        method: 'turn/start',
        params: {
          threadId: 't1',
          approvalPolicy: 'on-request',
          sandboxPolicy: { type: 'dangerFullAccess' },
        },
      },
    });
    assert.equal(turn.status, 200);
    const call = context.bridge.calls.at(-1);
    assert.equal(call.method, 'turn/start');
    assert.deepEqual(call.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.equal(call.params.approvalPolicy, 'never');

    const devicesDenied = await request(base, '/api/devices', { cookie: chatCookie });
    assert.equal(devicesDenied.status, 403);
  } finally {
    await context.gateway.close();
  }
});

test('pair failures are rate-limited with Retry-After', async () => {
  const context = createDeviceGateway({
    pairRateLimit: { perIp: 2, perCode: 2, global: 3, windowMs: 60_000 },
  });
  await context.gateway.listen({ host: '127.0.0.1', port: 0 });
  const port = context.gateway.server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(base, '/api/pair', {
        method: 'POST',
        body: { token: 'wrong-code', deviceName: 'Attacker' },
      });
      assert.equal(response.status, 401);
    }
    const limited = await request(base, '/api/pair', {
      method: 'POST',
      body: { token: 'wrong-code', deviceName: 'Attacker' },
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  } finally {
    await context.gateway.close();
  }
});

test('read-only terminal attachment can observe but server rejects all input', async () => {
  const context = createDeviceGateway();
  await context.gateway.listen({ host: '127.0.0.1', port: 0 });
  const port = context.gateway.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let socket;

  try {
    const ownerPair = await request(base, '/api/pair', {
      method: 'POST',
      body: { token: 'legacy-bootstrap', deviceName: 'Owner' },
    });
    const ownerCookie = cookieFrom(ownerPair);
    const invite = await request(base, '/api/invites', {
      method: 'POST',
      cookie: ownerCookie,
      body: { scope: 'read-only' },
    });
    const guestPair = await request(base, '/api/pair', {
      method: 'POST',
      body: { token: (await invite.json()).code, deviceName: 'Observer' },
    });
    const guestCookie = cookieFrom(guestPair);
    const ticketResponse = await request(base, '/api/ws-ticket', {
      method: 'POST',
      cookie: guestCookie,
      body: { channel: 'terminal', termId: '7' },
    });
    const ticket = (await ticketResponse.json()).ticket;
    socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/term/7?ticket=${encodeURIComponent(ticket)}`,
    );
    await once(socket, 'open');
    socket.send('whoami\r');
    const [code] = await once(socket, 'close');
    assert.equal(code, 4408);
    assert.deepEqual(context.terminals.writes, []);
  } finally {
    if (socket?.readyState === WebSocket.OPEN) socket.terminate();
    await context.gateway.close();
  }
});

test('logging out revokes the cookie session and closes its active websocket', async () => {
  const context = createDeviceGateway();
  await context.gateway.listen({ host: '127.0.0.1', port: 0 });
  const port = context.gateway.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let socket;

  try {
    const paired = await request(base, '/api/pair', {
      method: 'POST',
      body: { token: 'legacy-bootstrap', deviceName: 'Owner' },
    });
    const cookie = cookieFrom(paired);
    const ticketResponse = await request(base, '/api/ws-ticket', {
      method: 'POST',
      cookie,
      body: { channel: 'events' },
    });
    const ticket = (await ticketResponse.json()).ticket;
    socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/events?ticket=${encodeURIComponent(ticket)}`,
    );
    await once(socket, 'message');

    const closed = once(socket, 'close');
    const logout = await request(base, '/api/logout', {
      method: 'POST',
      cookie,
      body: {},
    });
    assert.equal(logout.status, 200);
    const [code] = await closed;
    assert.equal(code, 4401);
    assert.equal((await request(base, '/api/status', { cookie })).status, 401);
  } finally {
    if (socket?.readyState === WebSocket.OPEN) socket.terminate();
    await context.gateway.close();
  }
});
