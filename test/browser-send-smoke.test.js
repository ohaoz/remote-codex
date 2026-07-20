'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.values = new Set();
  }

  set(value) {
    this.values = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  add(...names) {
    names.forEach((name) => this.values.add(name));
  }

  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }

  contains(name) {
    return this.values.has(name);
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.contains(name) : Boolean(force);
    if (enabled) this.add(name);
    else this.remove(name);
    return enabled;
  }

  toString() {
    return [...this.values].join(' ');
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = String(value); } };
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.isConnected = false;
    this.value = '';
    this.textContent = '';
    this._innerHTML = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList.set(value);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value ?? '');
    this.children = [];
  }

  appendChild(child) {
    child.parentNode = this;
    child.isConnected = this.isConnected;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    }
    this.parentNode = null;
    this.isConnected = false;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  async click() {
    await this.dispatch('click');
  }

  async dispatch(type) {
    const event = {
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
    };
    const results = (this.listeners.get(type) || []).map((listener) => listener(event));
    await Promise.all(results);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }

  querySelector(selector) {
    return findElement(this.children, selector);
  }

  querySelectorAll(selector) {
    return findElements(this.children, selector);
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.activeElement = null;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  querySelector(selector) {
    const match = /^#([\w-]+)$/.exec(selector);
    if (!match) return null;
    if (!this.elements.has(match[1])) {
      const element = this.createElement('div');
      element.id = match[1];
      element.isConnected = true;
      this.elements.set(match[1], element);
    }
    return this.elements.get(match[1]);
  }

  querySelectorAll() {
    return [];
  }
}

function matchesSelector(element, selector) {
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

function findElement(children, selector) {
  for (const child of children) {
    if (matchesSelector(child, selector)) return child;
    const nested = findElement(child.children, selector);
    if (nested) return nested;
  }
  return null;
}

function findElements(children, selector, found = []) {
  for (const child of children) {
    if (matchesSelector(child, selector)) found.push(child);
    findElements(child.children, selector, found);
  }
  return found;
}

function loadBrowserApp() {
  const document = new FakeDocument();
  const sendButton = document.querySelector('#btn-send');
  for (const className of ['ico-send', 'ico-stop']) {
    const icon = document.createElement('svg');
    icon.className = className;
    sendButton.appendChild(icon);
  }

  const storage = new Map();
  const requests = [];
  const timers = new Map();
  let nextTimerId = 1;
  const wire = {
    outcome: 'success',
    pending: [],
    eventSeqByThread: new Map(),
    responseFor(request) {
      if (request.method === 'thread/start') {
        return {
          thread: { id: 'implicit-thread' },
          model: 'gpt-a',
          reasoningEffort: 'medium',
          cwd: 'G:\\repo',
        };
      }
      if (request.method === 'thread/resume') {
        return {
          thread: { id: request.params.threadId },
          model: 'gpt-a',
          reasoningEffort: 'medium',
          cwd: 'G:\\repo',
        };
      }
      if (request.method === 'thread/read') {
        return { thread: { id: request.params.threadId, turns: [] } };
      }
      if (request.method === 'thread/list') return { data: [] };
      return { turn: { id: 'turn-1' } };
    },
    deliver(message) {
      sandbox.__gatewayMessage = message;
      vm.runInContext(
        'handleGateway(__gatewayMessage, eventSync.snapshot().generation)',
        context,
      );
    },
    resolveNext(method, result) {
      const index = wire.pending.findIndex((request) => request.method === method);
      assert.notEqual(index, -1, `no pending ${method} request`);
      const [request] = wire.pending.splice(index, 1);
      wire.deliver({
        type: 'rpc-result',
        reqId: request.reqId,
        result: result === undefined ? wire.responseFor(request) : result,
      });
      return request;
    },
    rejectNext(method, error = 'network failed', details = {}) {
      const index = wire.pending.findIndex((request) => request.method === method);
      assert.notEqual(index, -1, `no pending ${method} request`);
      const [request] = wire.pending.splice(index, 1);
      wire.deliver({ type: 'rpc-result', reqId: request.reqId, error, ...details });
      return request;
    },
    emitEvent(method, params) {
      const seq = (wire.eventSeqByThread.get(params.threadId) || 0) + 1;
      wire.eventSeqByThread.set(params.threadId, seq);
      wire.deliver({
        type: 'event',
        streamId: 'stream-test',
        threadId: params.threadId,
        seq,
        method,
        params,
      });
    },
    socket: {
      readyState: 1,
      send(raw) {
        const request = JSON.parse(raw);
        requests.push(request);
        if (wire.outcome === 'manual' || request.type !== 'rpc') {
          wire.pending.push(request);
          return;
        }
        queueMicrotask(() => {
          const message = wire.outcome === 'success'
            ? { type: 'rpc-result', reqId: request.reqId, result: wire.responseFor(request) }
            : {
                type: 'rpc-result',
                reqId: request.reqId,
                error: 'invalid turn parameters',
                code: -32602,
              };
          wire.deliver(message);
        });
      },
      close() {},
    },
  };

  class BrowserWebSocket {}
  BrowserWebSocket.OPEN = 1;

  const sandbox = {
    console,
    document,
    location: {
      protocol: 'http:',
      host: 'localhost:7860',
      hash: '',
      pathname: '/',
      reload() {},
    },
    history: { replaceState() {} },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    marked: {
      setOptions() {},
      parse(value) { return String(value); },
    },
    DOMPurify: { sanitize(value) { return String(value); } },
    Terminal: class {},
    FitAddon: { FitAddon: class {} },
    WebSocket: BrowserWebSocket,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    requestAnimationFrame(callback) { callback(); },
    setTimeout(callback, delay = 0) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    queueMicrotask,
    crypto: {
      randomUUID: () => crypto.randomUUID(),
      getRandomValues: (bytes) => crypto.webcrypto.getRandomValues(bytes),
    },
    URL,
    __wire: wire,
    addEventListener() {},
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);

  for (const relativePath of [
    'web/device-session.js',
    'web/session-switch.js',
    'web/reconnect.js',
    'web/approval-state.js',
    'web/pty-reconnect.js',
    'web/session-controls.js',
    'web/send-reliability.js',
    'web/app.js',
  ]) {
    const filename = path.join(root, relativePath);
    if (!fs.existsSync(filename)) continue;
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }

  vm.runInContext(`
    (() => {
      const generation = eventSync.beginSocket();
      eventSync.onHello(generation, { streamId: 'stream-test' }, null);
      state.ws = globalThis.__wire.socket;
      state.wsAlive = true;
      state.bridge = 'ready';
      state.thread = { id: 'thread-1', name: '旧会话' };
      state.threadSettings = { model: 'gpt-a', effort: '', cwd: 'G:\\\\repo' };
      state.models = [
        { model: 'gpt-a', isDefault: true, defaultReasoningEffort: 'medium' },
        { model: 'gpt-b', defaultReasoningEffort: 'low' },
      ];
      state.turnPrefs = { threadId: 'thread-1', model: 'gpt-b', effort: '' };
      state.prefs = {
        model: 'gpt-b',
        effort: '',
        approval: 'on-request',
        sandbox: 'workspace-write',
        cwd: '',
      };
      eventSync.setActiveThread('thread-1');
    })()
  `, context);

  return {
    context,
    document,
    requests,
    wire,
    getStoredDraft() {
      return storage.get('cr.draft') || '';
    },
    evaluate(source) {
      return vm.runInContext(source, context);
    },
    disconnect() {
      return vm.runInContext(`
        (() => {
          const generation = eventSync.snapshot().generation;
          state.wsAlive = false;
          eventSync.onSocketClosed(generation);
          rejectPendingRpcForGeneration(generation, new Error('连接已断开'));
        })()
      `, context);
    },
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
    },
    async runTimers(maxDelay = 5000) {
      await this.flush();
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.delay <= maxDelay);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
      await this.flush();
    },
  };
}

async function createUnresolvedTurnSend(app, text) {
  app.wire.outcome = 'manual';
  app.document.querySelector('#composer-input').value = text;
  const sending = app.evaluate('sendMessage()');
  await app.flush();
  const request = app.requests.find((entry) => entry.method === 'turn/start');
  app.wire.rejectNext('turn/start', 'process exited');
  await sending;
  await app.flush();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    app.wire.resolveNext('thread/read', { thread: { id: 'thread-1', turns: [] } });
    await app.flush();
    if (attempt < 3) await app.runTimers();
  }
  return request;
}

test('browser loads send reliability before the application', () => {
  const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  const reliability = html.indexOf('<script src="/send-reliability.js"></script>');
  const application = html.indexOf('<script src="/app.js"></script>');
  assert.notEqual(reliability, -1, 'send reliability helper script is missing');
  assert.ok(reliability < application, 'send reliability must load before app.js');
});

test('actual browser send path includes model defaults and clears the previous turn diff', async () => {
  const app = loadBrowserApp();
  app.evaluate(`
    state.lastDiff = 'diff --git a/old.js b/old.js';
    renderChangesBadge();
    input.value = 'ship the fix';
  `);

  await app.evaluate('sendMessage()');

  const turnStart = app.requests.find((request) => request.method === 'turn/start');
  assert.ok(turnStart, 'the real send path must issue turn/start');
  assert.equal(turnStart.params.model, 'gpt-b');
  assert.equal(turnStart.params.effort, 'low');
  assert.equal(app.evaluate('state.lastDiff'), '');
  assert.equal(app.document.querySelector('#btn-changes').hidden, true);
  assert.equal(app.document.querySelector('#changes-badge').hidden, true);
});

test('failed browser send restores the draft and exposes manual recovery actions', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'failure';
  app.document.querySelector('#composer-input').value = 'do not lose this';

  await app.evaluate('sendMessage()');

  const bubble = app.document.querySelector('#chat-list').children[0];
  assert.equal(app.document.querySelector('#composer-input').value, 'do not lose this');
  assert.ok(bubble.classList.contains('failed'), 'failed sends must not look successful');
  const retry = findElement(bubble.children, '.send-retry');
  const restore = findElement(bubble.children, '.send-restore');
  assert.ok(retry, 'failed sends need an explicit retry action');
  assert.ok(restore, 'failed sends need a restore-to-composer action');

  app.document.querySelector('#composer-input').value = '';
  await restore.click();
  assert.equal(app.document.querySelector('#composer-input').value, 'do not lose this');

  app.wire.outcome = 'success';
  await retry.click();
  assert.equal(
    app.requests.filter((request) => request.method === 'turn/start').length,
    2,
    'retry must run only after the user explicitly clicks it',
  );
  assert.equal(bubble.classList.contains('failed'), false);
  assert.equal(app.document.querySelector('#composer-input').value, '');
});

test('live user messages from other devices render while own echoes stay deduplicated', async () => {
  const app = loadBrowserApp();
  const list = app.document.querySelector('#chat-list');

  app.wire.emitEvent('item/started', {
    threadId: 'thread-1',
    turnId: 'turn-remote',
    item: {
      type: 'userMessage',
      id: 'remote-user-1',
      clientId: 'another-device-nonce-1-1',
      content: [{ type: 'text', text: '来自另一台设备的消息' }],
    },
  });
  await app.flush();
  assert.equal(list.children.length, 1, 'a foreign live user message must render');
  assert.match(list.children[0].innerHTML, /来自另一台设备的消息/);
  assert.ok(list.children[0].classList.contains('msg-user'));

  app.wire.outcome = 'manual';
  app.document.querySelector('#composer-input').value = 'my own message';
  const sending = app.evaluate('sendMessage()');
  await app.flush();
  const request = app.requests.find((entry) => entry.method === 'turn/start');
  assert.equal(list.children.length, 2, 'sending appends exactly one local bubble');

  app.wire.emitEvent('item/started', {
    threadId: 'thread-1',
    turnId: 'turn-own',
    item: {
      type: 'userMessage',
      id: 'own-user-1',
      clientId: request.params.clientUserMessageId,
      content: [{ type: 'text', text: 'my own message' }],
    },
  });
  await app.flush();
  assert.equal(
    list.children.length,
    2,
    'the live echo of an own message must not duplicate the local bubble',
  );

  app.wire.resolveNext('turn/start');
  await sending;
  assert.equal(list.children.length, 2);
});

test('official thread names and sparse account limit events merge into live browser state', () => {
  const app = loadBrowserApp();
  app.evaluate(`
    state.rateLimits = {
      rateLimits: {
        limitId: 'codex',
        planType: 'pro',
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 100 },
        secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 200 },
      },
      rateLimitsByLimitId: { codex: { planType: 'pro' } },
    };
    handleCodexEvent('thread/name/updated', {
      threadId: 'thread-1',
      threadName: '官方会话名',
    });
    handleCodexEvent('account/rateLimits/updated', {
      rateLimits: {
        limitId: 'codex',
        planType: null,
        primary: { usedPercent: 55, windowDurationMins: null, resetsAt: 300 },
      },
    });
  `);

  assert.equal(app.evaluate('state.thread.name'), '官方会话名');
  assert.deepEqual(
    JSON.parse(app.evaluate('JSON.stringify(state.rateLimits)')),
    {
      rateLimits: {
        limitId: 'codex',
        planType: 'pro',
        primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 300 },
        secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 200 },
      },
      rateLimitsByLimitId: { codex: { planType: 'pro' } },
    },
  );
});

test('implicit thread creation blocks new and resume switches until its send is bound', async () => {
  for (const switchCall of ['newThread()', "resumeThread('other-thread')"]) {
    const app = loadBrowserApp();
    app.wire.outcome = 'manual';
    app.evaluate(`
      state.thread = null;
      state.threadSettings = null;
      state.turnPrefs = { threadId: null, model: '', effort: '' };
      eventSync.setActiveThread(null);
      input.value = 'bind this send';
    `);

    const sending = app.evaluate('sendMessage()');
    await app.flush();
    if (app.wire.pending.some((request) => request.method === 'thread/list')) {
      app.wire.resolveNext('thread/list', { data: [] });
      await app.flush();
    }
    app.evaluate(switchCall);
    await app.flush();

    assert.equal(
      app.requests.filter((request) => request.method === 'thread/start').length,
      1,
      `${switchCall} must not start another thread while the implicit send is pending`,
    );
    assert.equal(
      app.requests.filter((request) => request.method === 'thread/resume').length,
      0,
      `${switchCall} must not resume over the pending send`,
    );

    app.wire.resolveNext('thread/start');
    await app.flush();
    const turnStart = app.requests.find((request) => request.method === 'turn/start');
    assert.equal(turnStart.params.threadId, 'implicit-thread');
    app.wire.resolveNext('turn/start');
    await sending;
    assert.equal(app.evaluate('state.thread.id'), 'implicit-thread');
  }
});

test('event-first disconnect preserves nonce-matched started delivery proof', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.document.querySelector('#composer-input').value = 'event before response';

  const sending = app.evaluate('sendMessage()');
  await app.flush();
  const request = app.requests.find((entry) => entry.method === 'turn/start');
  const clientId = request.params.clientUserMessageId || 'expected-client-id';
  app.wire.emitEvent('turn/started', {
    threadId: 'thread-1',
    turn: {
      id: 'turn-event-first',
      status: 'inProgress',
      items: [{ type: 'userMessage', id: 'user-1', clientId, content: [] }],
    },
  });
  await app.flush();
  app.disconnect();
  await sending;

  const bubble = app.document.querySelector('#chat-list').children[0];
  const actions = findElement(bubble.children, '.local-send-actions');
  assert.equal(
    app.evaluate("[...state.sendOperations.values()][0]?.status"),
    'started',
  );
  assert.equal(
    app.evaluate("[...state.sendOperations.values()][0]?.deliveryProven"),
    true,
  );
  assert.equal(bubble.classList.contains('unknown'), false);
  assert.equal(bubble.classList.contains('failed'), false);
  assert.equal(actions.hidden, true);

  app.evaluate(`reconcileLocalSendsWithCanonicalThread(${JSON.stringify({
    id: 'thread-1',
    turns: [{
      id: 'turn-event-first',
      status: 'inProgress',
      items: [{ type: 'userMessage', id: 'user-1', clientId, content: [] }],
    }],
  })})`);
  assert.equal(bubble.classList.contains('unknown'), false);
  assert.equal(bubble.classList.contains('failed'), false);
  assert.equal(actions.hidden, true);
});

test('canonical absence cannot erase nonce-matched started delivery proof', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.document.querySelector('#composer-input').value = 'event was not canonical';

  const sending = app.evaluate('sendMessage()');
  await app.flush();
  const request = app.requests.find((entry) => entry.method === 'turn/start');
  const clientId = request.params.clientUserMessageId || 'expected-client-id';
  app.wire.emitEvent('turn/started', {
    threadId: 'thread-1',
    turn: {
      id: 'provisional-turn',
      status: 'inProgress',
      items: [{ type: 'userMessage', id: 'provisional-user', clientId, content: [] }],
    },
  });
  app.disconnect();
  await sending;

  app.evaluate("reconcileLocalSendsWithCanonicalThread({ id: 'thread-1', turns: [] })");

  const bubble = app.document.querySelector('#chat-list').children[0];
  const actions = findElement(bubble.children, '.local-send-actions');
  const retry = findElement(bubble.children, '.send-retry');
  assert.equal(app.evaluate('state.activeTurnId'), 'provisional-turn');
  assert.equal(
    app.evaluate("[...state.sendOperations.values()][0]?.deliveryProven"),
    true,
  );
  assert.equal(
    app.evaluate("[...state.sendOperations.values()][0]?.startedTurnId"),
    'provisional-turn',
  );
  assert.equal(bubble.classList.contains('failed'), false);
  assert.equal(actions.hidden, true);
  assert.equal(retry.hidden, true);
});

test('canonical absence settles unproven send as unresolved without blind retry', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.document.querySelector('#composer-input').value = 'reconcile before retry';

  const sending = app.evaluate('sendMessage()');
  await app.flush();
  app.disconnect();
  await sending;

  const bubble = app.document.querySelector('#chat-list').children[0];
  const actions = findElement(bubble.children, '.local-send-actions');
  assert.ok(bubble.classList.contains('unknown'));
  assert.equal(actions.hidden, true);
  assert.equal(app.document.querySelector('#composer-input').value, '');

  app.evaluate("reconcileLocalSendsWithCanonicalThread({ id: 'thread-1', turns: [] })");
  const retry = findElement(bubble.children, '.send-retry');
  assert.ok(bubble.classList.contains('unresolved'));
  assert.equal(actions.hidden, false);
  assert.equal(retry.hidden, true);
  assert.equal(app.evaluate('state.pendingSendOperation'), null);
  assert.equal(app.document.querySelector('#composer-input').value, 'reconcile before retry');
});

test('process-exited RPC response remains unknown pending canonical reconciliation', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.document.querySelector('#composer-input').value = 'process may have received this';

  const sending = app.evaluate('sendMessage()');
  await app.flush();
  app.wire.rejectNext('turn/start', 'process exited');
  await sending;

  const bubble = app.document.querySelector('#chat-list').children[0];
  const actions = findElement(bubble.children, '.local-send-actions');
  assert.ok(bubble.classList.contains('unknown'));
  assert.equal(actions.hidden, true);
  assert.equal(app.document.querySelector('#composer-input').value, '');
});

test('healthy unknown turn actively polls canonical truth until it is accepted', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.document.querySelector('#composer-input').value = 'poll for canonical turn';

  const sending = app.evaluate('sendMessage()');
  await app.flush();
  const turnRequest = app.requests.find((request) => request.method === 'turn/start');
  app.wire.rejectNext('turn/start', 'process exited');
  await sending;
  await app.flush();

  assert.ok(app.wire.pending.some((request) => request.method === 'thread/read'));
  app.wire.resolveNext('thread/read', { thread: { id: 'thread-1', turns: [] } });
  await app.flush();
  await app.runTimers();
  assert.ok(app.wire.pending.some((request) => request.method === 'thread/read'));

  app.wire.resolveNext('thread/read', {
    thread: {
      id: 'thread-1',
      turns: [{
        id: 'canonical-turn',
        status: 'inProgress',
        items: [{
          type: 'userMessage',
          id: 'canonical-user',
          clientId: turnRequest.params.clientUserMessageId,
          content: [],
        }],
      }],
    },
  });
  await app.flush();

  const bubble = app.document.querySelector('#chat-list').children[0];
  assert.equal(bubble.classList.contains('unknown'), false);
  assert.equal(bubble.classList.contains('failed'), false);
  assert.equal(
    app.requests.filter((request) => request.method === 'turn/start').length,
    1,
  );
});

test('healthy unknown turn polling ends unresolved without enabling retry', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.document.querySelector('#composer-input').value = 'bounded reconciliation';

  const sending = app.evaluate('sendMessage()');
  await app.flush();
  app.wire.rejectNext('turn/start', 'process exited');
  await sending;
  await app.flush();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    app.wire.resolveNext('thread/read', { thread: { id: 'thread-1', turns: [] } });
    await app.flush();
    if (attempt < 3) await app.runTimers();
  }
  await app.runTimers();

  const bubble = app.document.querySelector('#chat-list').children[0];
  const actions = findElement(bubble.children, '.local-send-actions');
  const retry = findElement(bubble.children, '.send-retry');
  assert.ok(bubble.classList.contains('unresolved'));
  assert.equal(actions.hidden, false);
  assert.equal(retry.hidden, true);
  assert.equal(app.evaluate('state.pendingSendOperation'), null);
  assert.equal(app.document.querySelector('#composer-input').disabled, false);
  assert.equal(
    app.requests.filter((request) => request.method === 'thread/read').length,
    3,
  );
  assert.equal(
    app.requests.filter((request) => request.method === 'turn/start').length,
    1,
  );
});

test('bounded reconciliation read failures end unresolved without enabling blind retry', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.document.querySelector('#composer-input').value = 'canonical read keeps failing';

  const sending = app.evaluate('sendMessage()');
  await app.flush();
  app.wire.rejectNext('turn/start', 'process exited');
  await sending;
  await app.flush();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    app.wire.rejectNext('thread/read', 'process exited');
    await app.flush();
    if (attempt < 3) await app.runTimers();
  }

  const bubble = app.document.querySelector('#chat-list').children[0];
  const actions = findElement(bubble.children, '.local-send-actions');
  const retry = findElement(bubble.children, '.send-retry');
  assert.ok(bubble.classList.contains('unresolved'));
  assert.match(findElement(bubble.children, '.local-send-status').textContent, /结果未知/);
  assert.equal(actions.hidden, false);
  assert.equal(retry.hidden, true);
  assert.equal(app.evaluate('state.pendingSendOperation'), null);
  assert.equal(
    app.requests.filter((request) => request.method === 'turn/start').length,
    1,
  );
});

test('late nonce-matched turn upgrades unresolved delivery to started without retry', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.document.querySelector('#composer-input').value = 'late positive evidence';

  const sending = app.evaluate('sendMessage()');
  await app.flush();
  const request = app.requests.find((entry) => entry.method === 'turn/start');
  app.wire.rejectNext('turn/start', 'process exited');
  await sending;
  await app.flush();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    app.wire.resolveNext('thread/read', { thread: { id: 'thread-1', turns: [] } });
    await app.flush();
    if (attempt < 3) await app.runTimers();
  }
  const bubble = app.document.querySelector('#chat-list').children[0];
  assert.ok(bubble.classList.contains('unresolved'));

  app.wire.emitEvent('turn/started', {
    threadId: 'thread-1',
    turn: {
      id: 'late-started-turn',
      status: 'inProgress',
      items: [{
        type: 'userMessage',
        id: 'late-user',
        clientId: request.params.clientUserMessageId,
        content: [],
      }],
    },
  });
  await app.flush();

  const actions = findElement(bubble.children, '.local-send-actions');
  const retry = findElement(bubble.children, '.send-retry');
  assert.equal(
    app.evaluate("[...state.sendOperations.values()][0]?.status"),
    'started',
  );
  assert.equal(
    app.evaluate("[...state.sendOperations.values()][0]?.deliveryProven"),
    true,
  );
  assert.equal(bubble.classList.contains('unresolved'), false);
  assert.equal(bubble.classList.contains('failed'), false);
  assert.equal(actions.hidden, true);
  assert.equal(retry.hidden, true);
  assert.equal(app.evaluate('state.activeTurnId'), 'late-started-turn');

  app.wire.emitEvent('turn/completed', {
    threadId: 'thread-1',
    turn: {
      id: 'late-started-turn',
      status: 'completed',
      items: [],
    },
  });
  await app.flush();
  assert.equal(app.evaluate('state.sendOperations.size'), 0);
  assert.equal(findElement(bubble.children, '.local-send-status').hidden, true);
});

test('late started proof clears the unchanged restored composer draft and persistence', async () => {
  const app = loadBrowserApp();
  const text = 'clear this restored draft';
  const request = await createUnresolvedTurnSend(app, text);
  const composer = app.document.querySelector('#composer-input');
  assert.equal(composer.value, text);
  assert.equal(app.getStoredDraft(), text);

  app.wire.emitEvent('turn/started', {
    threadId: 'thread-1',
    turn: {
      id: 'late-clear-turn',
      status: 'inProgress',
      items: [{
        type: 'userMessage',
        id: 'late-clear-user',
        clientId: request.params.clientUserMessageId,
        content: [],
      }],
    },
  });
  await app.flush();

  assert.equal(composer.value, '');
  assert.equal(app.getStoredDraft(), '');
});

test('late completed proof preserves an edited composer draft and persistence', async () => {
  const app = loadBrowserApp();
  const original = 'original unresolved draft';
  const replacement = 'new user draft';
  const request = await createUnresolvedTurnSend(app, original);
  const composer = app.document.querySelector('#composer-input');
  composer.value = replacement;
  await composer.dispatch('input');
  assert.equal(app.getStoredDraft(), replacement);

  app.wire.emitEvent('turn/completed', {
    threadId: 'thread-1',
    turn: {
      id: 'late-completed-turn',
      status: 'completed',
      items: [{
        type: 'userMessage',
        id: 'late-completed-user',
        clientId: request.params.clientUserMessageId,
        content: [],
      }],
    },
  });
  await app.flush();

  assert.equal(composer.value, replacement);
  assert.equal(app.getStoredDraft(), replacement);
});

test('matching turn start evidence cannot become retryable after contradictory rejection', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.document.querySelector('#composer-input').value = 'positive turn evidence';

  const sending = app.evaluate('sendMessage()');
  await app.flush();
  const request = app.requests.find((entry) => entry.method === 'turn/start');
  app.wire.emitEvent('turn/started', {
    threadId: 'thread-1',
    turn: {
      id: 'positive-turn',
      status: 'inProgress',
      items: [{
        type: 'userMessage',
        id: 'positive-user',
        clientId: request.params.clientUserMessageId,
        content: [],
      }],
    },
  });
  app.wire.rejectNext('turn/start', 'invalid params', { code: -32602 });
  await sending;
  await app.flush();
  assert.ok(
    app.wire.pending.some((entry) => entry.method === 'thread/read'),
    app.evaluate(`JSON.stringify({
      status: [...state.sendOperations.values()][0]?.status,
      deliveryProven: [...state.sendOperations.values()][0]?.deliveryProven,
      reconcileRunning: [...state.sendOperations.values()][0]?.reconcileRunning,
      sync: eventSync.snapshot().status,
      wsAlive: state.wsAlive,
      bridge: state.bridge,
    })`),
  );
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.ok(
      app.wire.pending.some((entry) => entry.method === 'thread/read'),
      `missing canonical read at attempt ${attempt}: ${app.evaluate(`JSON.stringify({
        status: [...state.sendOperations.values()][0]?.status,
        reconcileRunning: [...state.sendOperations.values()][0]?.reconcileRunning,
        reconcileAttempts: [...state.sendOperations.values()][0]?.reconcileAttempts,
      })`)}`,
    );
    app.wire.resolveNext('thread/read', { thread: { id: 'thread-1', turns: [] } });
    await app.flush();
    if (attempt < 3) await app.runTimers();
  }

  const bubble = app.document.querySelector('#chat-list').children[0];
  const actions = findElement(bubble.children, '.local-send-actions');
  const retry = findElement(bubble.children, '.send-retry');
  assert.equal(
    app.evaluate("[...state.sendOperations.values()][0]?.status"),
    'started',
  );
  assert.equal(
    app.evaluate("[...state.sendOperations.values()][0]?.deliveryProven"),
    true,
  );
  assert.equal(
    app.evaluate("[...state.sendOperations.values()][0]?.startedTurnId"),
    'positive-turn',
  );
  assert.equal(bubble.classList.contains('unknown'), false);
  assert.equal(bubble.classList.contains('failed'), false);
  assert.equal(actions.hidden, true);
  assert.equal(retry.hidden, true);
});

test('synchronous socket send failure leaves no dangling RPC entry', async () => {
  const app = loadBrowserApp();
  app.wire.socket.send = () => {
    throw new Error('socket closed during send');
  };
  app.document.querySelector('#composer-input').value = 'race the socket close';

  await app.evaluate('sendMessage()');

  assert.equal(app.evaluate('state.pendingRpc.size'), 0);
  const bubble = app.document.querySelector('#chat-list').children[0];
  assert.ok(bubble.classList.contains('unknown'));
});

test('two page instances cannot generate the same client user message id', async () => {
  const first = loadBrowserApp();
  const second = loadBrowserApp();
  first.wire.outcome = 'manual';
  second.wire.outcome = 'manual';
  first.document.querySelector('#composer-input').value = 'first instance';
  second.document.querySelector('#composer-input').value = 'second instance';

  first.evaluate('sendMessage()');
  second.evaluate('sendMessage()');
  await Promise.all([first.flush(), second.flush()]);

  const firstId = first.requests.find((request) => request.method === 'turn/start').params.clientUserMessageId;
  const secondId = second.requests.find((request) => request.method === 'turn/start').params.clientUserMessageId;
  assert.notEqual(firstId, secondId);
});

test('an old page instance turn cannot confirm the new page pending send', async () => {
  const oldPage = loadBrowserApp();
  const newPage = loadBrowserApp();
  oldPage.wire.outcome = 'manual';
  newPage.wire.outcome = 'manual';
  oldPage.document.querySelector('#composer-input').value = 'old page turn';
  newPage.document.querySelector('#composer-input').value = 'new page turn';

  oldPage.evaluate('sendMessage()');
  newPage.evaluate('sendMessage()');
  await Promise.all([oldPage.flush(), newPage.flush()]);
  const oldClientId = oldPage.requests.find(
    (request) => request.method === 'turn/start',
  ).params.clientUserMessageId;

  newPage.wire.emitEvent('turn/started', {
    threadId: 'thread-1',
    turn: {
      id: 'old-page-turn',
      status: 'inProgress',
      items: [{ type: 'userMessage', id: 'old-user', clientId: oldClientId, content: [] }],
    },
  });
  await newPage.flush();

  assert.equal(newPage.evaluate('state.pendingSendOperation.status'), 'starting-turn');
  const bubble = newPage.document.querySelector('#chat-list').children[0];
  assert.equal(findElement(bubble.children, '.local-send-status').textContent, '正在发送…');
});

test('uncertain implicit thread creation never claims a concurrent listed thread', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.evaluate(`
    state.thread = null;
    state.threadSettings = null;
    state.turnPrefs = { threadId: null, model: '', effort: '' };
    eventSync.setActiveThread(null);
    input.value = 'recover created thread';
  `);

  const sending = app.evaluate('sendMessage()');
  await app.flush();
  if (app.wire.pending.some((request) => request.method === 'thread/list')) {
    app.wire.resolveNext('thread/list', { data: [] });
    await app.flush();
  }
  app.wire.rejectNext('thread/start', 'process exited');
  await sending;
  await app.flush();

  if (app.wire.pending.some((request) => request.method === 'thread/list')) {
    app.wire.resolveNext('thread/list', {
      data: [{ id: 'other-client-thread', cwd: 'G:\\repo', updatedAt: 100 }],
    });
    await app.flush();
  }
  await app.runTimers();

  const bubble = app.document.querySelector('#chat-list').children[0];
  assert.equal(
    app.requests.filter((request) => request.method === 'thread/start').length,
    1,
  );
  assert.equal(
    app.requests.filter((request) => request.method === 'thread/list').length,
    0,
  );
  assert.equal(
    app.requests.filter((request) => request.method === 'thread/resume').length,
    0,
  );
  assert.equal(
    app.requests.filter((request) => request.method === 'turn/start').length,
    0,
  );
  assert.ok(bubble.classList.contains('unresolved'));
});

test('uncertain implicit thread creation settles unresolved and unlocks without retry', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.evaluate(`
    state.thread = null;
    state.threadSettings = null;
    state.turnPrefs = { threadId: null, model: '', effort: '' };
    eventSync.setActiveThread(null);
    input.value = 'do not duplicate thread creation';
  `);

  const sending = app.evaluate('sendMessage()');
  await app.flush();
  if (app.wire.pending.some((request) => request.method === 'thread/list')) {
    app.wire.resolveNext('thread/list', { data: [] });
    await app.flush();
  }
  app.wire.rejectNext('thread/start', 'process exited');
  await sending;
  await app.flush();
  await app.runTimers();

  const bubble = app.document.querySelector('#chat-list').children[0];
  const actions = findElement(bubble.children, '.local-send-actions');
  const retry = findElement(bubble.children, '.send-retry');
  assert.ok(bubble.classList.contains('unresolved'));
  assert.equal(actions.hidden, false);
  assert.equal(retry.hidden, true);
  assert.equal(app.evaluate('state.pendingSendOperation'), null);
  assert.equal(app.document.querySelector('#composer-input').disabled, false);
  assert.equal(app.document.querySelector('#btn-new-thread').disabled, false);
  assert.equal(
    app.requests.filter((request) => request.method === 'thread/start').length,
    1,
  );
});

test('unrelated turn events cannot confirm a pending local send', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.document.querySelector('#composer-input').value = 'only my turn';

  app.evaluate('sendMessage()');
  await app.flush();
  app.wire.emitEvent('turn/started', {
    threadId: 'other-thread',
    turn: {
      id: 'other-turn',
      status: 'inProgress',
      items: [{ type: 'userMessage', id: 'other-user', clientId: 'someone-else', content: [] }],
    },
  });
  app.wire.emitEvent('turn/started', {
    threadId: 'thread-1',
    turn: {
      id: 'same-thread-other-turn',
      status: 'inProgress',
      items: [{ type: 'userMessage', id: 'other-user-2', clientId: 'someone-else', content: [] }],
    },
  });
  await app.flush();

  const bubble = app.document.querySelector('#chat-list').children[0];
  assert.ok(bubble.classList.contains('sending'));
  assert.equal(bubble.classList.contains('failed'), false);
});

test('late turn start RPC success cannot erase diff produced after the matching start event', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.evaluate(`
    state.lastDiff = 'diff --git a/old.js b/old.js';
    renderChangesBadge();
    input.value = 'make a new diff';
  `);

  const sending = app.evaluate('sendMessage()');
  await app.flush();
  const request = app.requests.find((entry) => entry.method === 'turn/start');
  const clientId = request.params.clientUserMessageId || 'expected-client-id';
  app.wire.emitEvent('turn/started', {
    threadId: 'thread-1',
    turn: {
      id: 'turn-with-diff',
      status: 'inProgress',
      items: [{ type: 'userMessage', id: 'user-diff', clientId, content: [] }],
    },
  });
  app.wire.emitEvent('turn/diff/updated', {
    threadId: 'thread-1',
    turnId: 'turn-with-diff',
    diff: 'diff --git a/new.js b/new.js',
  });
  app.wire.resolveNext('turn/start', { turn: { id: 'turn-with-diff' } });
  await sending;

  assert.equal(app.evaluate('state.lastDiff'), 'diff --git a/new.js b/new.js');
});

test('explicit local-default model selection resolves to catalog defaults on the next turn', async () => {
  const app = loadBrowserApp();
  app.evaluate(`
    state.models = [
      { model: 'gpt-a', isDefault: false, defaultReasoningEffort: 'high' },
      { model: 'gpt-b', isDefault: true, defaultReasoningEffort: 'low' },
    ];
    state.threadSettings = { model: 'gpt-a', effort: 'high', cwd: 'G:\\\\repo' };
    state.turnPrefs = { threadId: 'thread-1', model: '__local_default__', effort: '' };
    state.prefs.model = '__local_default__';
    state.prefs.effort = '';
    input.value = 'use the machine default';
  `);

  await app.evaluate('sendMessage()');

  const request = app.requests.find((entry) => entry.method === 'turn/start');
  assert.equal(request.params.model, 'gpt-b');
  assert.equal(request.params.effort, 'low');
});

test('explicit default effort selection restores catalog effort from active high', async () => {
  const app = loadBrowserApp();
  app.evaluate(`
    state.models = [{
      model: 'gpt-a',
      isDefault: true,
      defaultReasoningEffort: 'medium',
    }];
    state.threadSettings = { model: 'gpt-a', effort: 'high', cwd: 'G:\\\\repo' };
    state.turnPrefs = { threadId: 'thread-1', model: '', effort: '__default_effort__' };
    input.value = 'restore default effort';
  `);

  await app.evaluate('sendMessage()');

  const request = app.requests.find((entry) => entry.method === 'turn/start');
  assert.equal(request.params.model, 'gpt-a');
  assert.equal(request.params.effort, 'medium');
});

test('new thread creation does not inherit the current thread model override', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.evaluate(`
    state.turnPrefs = { threadId: 'thread-1', model: 'gpt-b', effort: 'low' };
    state.prefs.model = 'gpt-b';
    state.prefs.effort = 'low';
  `);

  app.evaluate('newThread()');
  await app.flush();

  const request = app.requests.find((entry) => entry.method === 'thread/start');
  assert.equal(Object.hasOwn(request.params, 'model'), false);
});

test('thread resume does not inherit the current thread model override', async () => {
  const app = loadBrowserApp();
  app.wire.outcome = 'manual';
  app.evaluate(`
    state.turnPrefs = { threadId: 'thread-1', model: 'gpt-b', effort: 'low' };
    state.prefs.model = 'gpt-b';
    state.prefs.effort = 'low';
  `);

  app.evaluate("resumeThread('history-thread')");
  await app.flush();

  const request = app.requests.find((entry) => entry.method === 'thread/resume');
  assert.equal(Object.hasOwn(request.params, 'model'), false);
});
