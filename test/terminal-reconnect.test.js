'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { TerminalManager, terminalSyncFrames } = require('../server/terminals');
let PtyReconnect;
try {
  PtyReconnect = require('../web/pty-reconnect');
} catch {}

class FakePty extends EventEmitter {
  onData(handler) {
    this.on('data', handler);
  }

  onExit(handler) {
    this.on('exit', handler);
  }

  write() {}
  resize() {}
  kill() {}
}

test('terminal snapshots include generation and absolute output watermarks', () => {
  const proc = new FakePty();
  const manager = new TerminalManager({
    spawn: () => proc,
    scrollbackLimit: 5,
    now: () => 1234,
  });
  const session = manager.create('shell', { cwd: 'G:\\work' });

  proc.emit('data', 'abc');
  proc.emit('data', 'defg');
  const snapshot = manager.snapshot(session.id);

  assert.equal(snapshot.terminalId, session.id);
  assert.equal(snapshot.generation, 1);
  assert.equal(snapshot.firstAvailableOffset, 2);
  assert.equal(snapshot.lastOffset, 7);
  assert.equal(snapshot.buffer, 'cdefg');
  assert.equal(snapshot.alive, true);
  assert.equal(manager.describe(session).generation, 1);
  assert.equal(manager.describe(session).lastOffset, 7);
});

test('terminal sync frames bracket ANSI replay exactly once', () => {
  const frames = terminalSyncFrames({
    terminalId: '1',
    generation: 4,
    firstAvailableOffset: 10,
    lastOffset: 17,
    buffer: '\u001b[2Jprompt>',
    alive: true,
  });

  assert.equal(frames.length, 3);
  assert.deepEqual(JSON.parse(frames[0].slice(1)), {
    op: 'sync-begin',
    terminalId: '1',
    generation: 4,
    firstAvailableOffset: 10,
    lastOffset: 17,
    alive: true,
  });
  assert.equal(frames[1], '\u001b[2Jprompt>');
  assert.deepEqual(JSON.parse(frames[2].slice(1)), {
    op: 'sync-end',
    terminalId: '1',
    generation: 4,
    lastOffset: 17,
  });
});

test('PTY reconnect resets once per snapshot and ignores stale sockets', () => {
  assert.equal(typeof PtyReconnect?.create, 'function', 'PTY reconnect helper is missing');
  const reconnect = PtyReconnect.create({ baseDelayMs: 100, maxDelayMs: 800 });
  const first = reconnect.begin('term-1');

  assert.equal(reconnect.onSocketOpen(first).accepted, true);
  const begin = reconnect.onSyncBegin(first, {
    terminalId: 'term-1',
    generation: 9,
    firstAvailableOffset: 0,
    lastOffset: 4,
  });
  assert.equal(begin.reset, true);
  assert.equal(begin.status, 'syncing');
  assert.equal(reconnect.onSyncBegin(first, {
    terminalId: 'term-1',
    generation: 9,
  }).reset, false);

  assert.equal(reconnect.onData(first, 'ansi').write, 'ansi');
  const end = reconnect.onSyncEnd(first, {
    terminalId: 'term-1',
    generation: 9,
    lastOffset: 4,
  });
  assert.equal(end.status, 'live');

  const second = reconnect.begin('term-1');
  assert.equal(reconnect.onData(first, 'stale').accepted, false);
  assert.equal(reconnect.onSyncBegin(second, {
    terminalId: 'term-1',
    generation: 9,
    firstAvailableOffset: 0,
    lastOffset: 4,
  }).reset, true);
});

test('abnormal PTY closes back off while user, exit, and 404 closes stay blocked', () => {
  assert.equal(typeof PtyReconnect?.create, 'function', 'PTY reconnect helper is missing');
  const reconnect = PtyReconnect.create({ baseDelayMs: 100, maxDelayMs: 800 });

  let generation = reconnect.begin('term-1');
  let closed = reconnect.onSocketClose(generation, { code: 1006, reason: '' });
  assert.equal(closed.reconnect, true);
  assert.equal(closed.delayMs, 100);
  assert.equal(closed.status, 'reconnecting');

  generation = reconnect.begin('term-1', { retry: true });
  closed = reconnect.onSocketClose(generation, { code: 1006, reason: '' });
  assert.equal(closed.delayMs, 200);

  for (const close of [
    { intent: 'back', code: 1000 },
    { intent: 'kill', code: 1000 },
    { intent: 'exit', code: 4000 },
    { code: 4404, reason: 'no such terminal' },
  ]) {
    const flow = PtyReconnect.create({ baseDelayMs: 100 });
    const current = flow.begin('term-1');
    if (close.intent) flow.stop(close.intent);
    const result = flow.onSocketClose(current, close);
    assert.equal(result.reconnect, false, `unexpected reconnect for ${close.intent || close.code}`);
    assert.equal(result.status, 'blocked');
    assert.equal(
      flow.snapshot().blockedReason,
      close.intent || (close.code === 4404 ? 'not-found' : 'exit'),
    );
  }
});

test('a successful PTY sync resets exponential backoff', () => {
  assert.equal(typeof PtyReconnect?.create, 'function', 'PTY reconnect helper is missing');
  const reconnect = PtyReconnect.create({ baseDelayMs: 100, maxDelayMs: 800 });
  let generation = reconnect.begin('term-1');
  assert.equal(reconnect.onSocketClose(generation, { code: 1006 }).delayMs, 100);
  generation = reconnect.begin('term-1', { retry: true });
  reconnect.onSocketOpen(generation);
  reconnect.onSyncBegin(generation, { terminalId: 'term-1', generation: 1 });
  reconnect.onSyncEnd(generation, { terminalId: 'term-1', generation: 1 });
  assert.equal(reconnect.snapshot().attempt, 0);
  assert.equal(reconnect.onSocketClose(generation, { code: 1006 }).delayMs, 100);
});
