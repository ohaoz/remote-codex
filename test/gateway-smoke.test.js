'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const WebSocket = require('ws');

const root = path.join(__dirname, '..');

class FakeBridge extends EventEmitter {
  constructor() {
    super();
    this.state = 'ready';
    this.streamId = 'fake-stream';
    this.startCalls = 0;
    this.stopCalls = 0;
    this.calls = [];
  }

  async start() {
    this.startCalls += 1;
  }

  info() {
    return { state: this.state, fake: true };
  }

  listPendingApprovals() {
    return [];
  }

  isAllowed(method) {
    return method === 'thread/read';
  }

  async call(method, params) {
    this.calls.push({ method, params });
    return { ok: true };
  }

  cachedEvents() {
    return [];
  }

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

  async stop() {
    this.stopCalls += 1;
  }
}

class FakeTerminals extends EventEmitter {
  constructor() {
    super();
    this.disposeCalls = 0;
  }

  list() {
    return [];
  }

  get() {
    return null;
  }

  dispose() {
    this.disposeCalls += 1;
  }
}

test('requiring the gateway and startup modules has no process side effects', () => {
  const script = `
    const fs = require('node:fs');
    const http = require('node:http');
    const childProcess = require('node:child_process');
    fs.writeFileSync = () => { throw new Error('WRITE_SIDE_EFFECT'); };
    http.Server.prototype.listen = () => { throw new Error('LISTEN_SIDE_EFFECT'); };
    childProcess.spawn = () => { throw new Error('SPAWN_SIDE_EFFECT'); };
    const gateway = require(${JSON.stringify(path.join(root, 'server', 'gateway.js'))});
    const startup = require(${JSON.stringify(path.join(root, 'server', 'index.js'))});
    if (typeof gateway.createGateway !== 'function') throw new Error('factory missing');
    if (typeof startup.main !== 'function') throw new Error('startup main missing');
    process.stdout.write('side-effect-free');
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'side-effect-free');
});

test('injected gateway serves pair, status, and event websocket without real Codex', async () => {
  const { createGateway } = require('../server/gateway');
  const bridge = new FakeBridge();
  const terminals = new FakeTerminals();
  const authChecks = [];
  const gateway = createGateway({
    bridge,
    terminals,
    auth: {
      token: 'smoke-token',
      verify(candidate, checkedAt) {
        authChecks.push({ candidate, checkedAt });
        return candidate === this.token;
      },
    },
    clock: { now: () => 424242 },
  });

  assert.equal(gateway.server.listening, false);
  assert.equal(bridge.startCalls, 0, 'the factory must not spawn Codex');

  let socket;
  try {
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const address = gateway.server.address();
    const base = `http://127.0.0.1:${address.port}`;

    const paired = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'smoke-token' }),
    });
    assert.equal(paired.status, 200);
    assert.deepEqual(await paired.json(), { ok: true });

    const rejected = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token' }),
    });
    assert.equal(rejected.status, 401);

    const status = await fetch(`${base}/api/status`, {
      headers: { 'x-auth-token': 'smoke-token' },
    });
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.deepEqual(body.bridge, { state: 'ready', fake: true });
    assert.deepEqual(body.terminals, []);
    assert.equal(body.server.port, address.port);

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/events?token=smoke-token`);
    const [helloRaw] = await once(socket, 'message');
    const hello = JSON.parse(helloRaw.toString());
    assert.equal(hello.type, 'hello');
    assert.equal(hello.streamId, 'fake-stream');

    bridge.emit('event', {
      streamId: 'fake-stream',
      threadId: 'thread-1',
      seq: 1,
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    });
    const [eventRaw] = await once(socket, 'message');
    const event = JSON.parse(eventRaw.toString());
    assert.equal(event.type, 'event');
    assert.equal(event.seq, 1);
    assert.equal(event.method, 'turn/started');

    assert.ok(
      authChecks.some((entry) => entry.checkedAt === 424242),
      'the injected auth verifier must receive the injected clock value',
    );
  } finally {
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close();
      await once(socket, 'close');
    }
    await gateway.close();
  }

  assert.equal(gateway.server.listening, false);
});

test('gateway close disposes owned resources but preserves injected dependencies', async () => {
  const { createGateway } = require('../server/gateway');
  const injectedBridge = new FakeBridge();
  const injectedTerminals = new FakeTerminals();
  const injected = createGateway({
    bridge: injectedBridge,
    terminals: injectedTerminals,
    token: 'injected-token',
  });
  await injected.listen({ host: '127.0.0.1', port: 0 });
  await injected.close();
  assert.equal(injectedBridge.stopCalls, 0);
  assert.equal(injectedTerminals.disposeCalls, 0);

  const ownedBridge = new FakeBridge();
  const ownedTerminals = new FakeTerminals();
  const owned = createGateway({
    bridge: ownedBridge,
    terminals: ownedTerminals,
    ownsBridge: true,
    ownsTerminals: true,
    token: 'owned-token',
  });
  await owned.listen({ host: '127.0.0.1', port: 0 });
  await owned.close();
  assert.equal(ownedBridge.stopCalls, 1);
  assert.equal(ownedTerminals.disposeCalls, 1);
  await owned.close();
  assert.equal(ownedBridge.stopCalls, 1);
  assert.equal(ownedTerminals.disposeCalls, 1);
});

test('gateway close attempts every owned cleanup when one disposer fails', async () => {
  const { createGateway } = require('../server/gateway');
  const bridge = new FakeBridge();
  bridge.stop = async () => {
    bridge.stopCalls += 1;
    throw new Error('bridge cleanup failed');
  };
  const terminals = new FakeTerminals();
  const gateway = createGateway({
    bridge,
    terminals,
    ownsBridge: true,
    ownsTerminals: true,
    token: 'cleanup-token',
  });
  await gateway.listen({ host: '127.0.0.1', port: 0 });

  await assert.rejects(gateway.close(), /bridge cleanup failed/);
  assert.equal(bridge.stopCalls, 1);
  assert.equal(terminals.disposeCalls, 1);
});

test('main rolls back the gateway when listen fails', async () => {
  const { main } = require('../server/index');
  const bridge = new FakeBridge();
  const terminals = new FakeTerminals();
  const fakeGateway = {
    server: { address: () => null },
    closeCalls: 0,
    async listen() {
      throw new Error('listen failed');
    },
    async close() {
      this.closeCalls += 1;
    },
  };

  await assert.rejects(
    main({
      token: 'main-token',
      port: -1,
      bridge,
      terminals,
      startBridge: false,
      printBanner: false,
      gatewayFactory: () => fakeGateway,
    }),
    /listen failed|options\.port|range/i,
  );
  assert.equal(fakeGateway.closeCalls, 1);
});

test('main rolls back the gateway when banner rendering fails', async () => {
  const { main } = require('../server/index');
  const bridge = new FakeBridge();
  const terminals = new FakeTerminals();
  const fakeGateway = {
    server: { address: () => ({ port: 43210 }) },
    closeCalls: 0,
    async listen() {},
    async close() {
      this.closeCalls += 1;
    },
  };

  try {
    await assert.rejects(
      main({
        token: 'main-token',
        port: 0,
        bridge,
        terminals,
        startBridge: false,
        gatewayFactory: () => fakeGateway,
        printStartupFn: async () => {
          throw new Error('banner failed');
        },
        logger: {
          log() {
            throw new Error('banner failed');
          },
        },
      }),
      /banner failed/,
    );
  } finally {
    const servers = process._getActiveHandles().filter(
      (handle) => handle?.constructor?.name === 'Server' && handle.listening,
    );
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
  assert.equal(fakeGateway.closeCalls, 1);
});
