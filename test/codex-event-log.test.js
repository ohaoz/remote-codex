'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ThreadEventLog, CodexBridge } = require('../server/codex');

class FakeRpcProcess extends EventEmitter {
  constructor() {
    super();
    this.startCalls = 0;
    this.killCalls = 0;
  }

  start() {
    this.startCalls += 1;
  }

  async request() {
    return { ready: true };
  }

  notify() {}

  kill() {
    this.killCalls += 1;
    this.emit('exit', { code: 0 });
  }
}

test('thread event log assigns monotonic sequence numbers and tracks active turn', () => {
  const log = new ThreadEventLog({
    streamId: 'stream-a',
    maxEventsPerThread: 10,
    maxThreads: 10,
  });

  const started = log.append('turn/started', {
    threadId: 'thread-1',
    turn: { id: 'turn-1' },
  });
  const delta = log.append('item/agentMessage/delta', {
    threadId: 'thread-1',
    itemId: 'item-1',
    delta: 'hello',
  });

  assert.deepEqual(
    [started.seq, delta.seq],
    [1, 2],
  );
  assert.equal(started.streamId, 'stream-a');
  assert.equal(started.threadId, 'thread-1');

  const active = log.replaySince('thread-1', 'stream-a', 0);
  assert.equal(active.activeTurnId, 'turn-1');
  assert.equal(active.firstAvailableSeq, 1);
  assert.equal(active.lastSeq, 2);
  assert.equal(active.toSeq, 2);
  assert.deepEqual(active.events.map((event) => event.seq), [1, 2]);

  log.append('turn/completed', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'completed' },
  });
  assert.equal(log.replaySince('thread-1', 'stream-a', 2).activeTurnId, null);
});

test('thread event log reports truncation and returns the available suffix', () => {
  const log = new ThreadEventLog({
    streamId: 'stream-a',
    maxEventsPerThread: 2,
    maxThreads: 10,
  });

  for (let index = 1; index <= 3; index += 1) {
    log.append('item/agentMessage/delta', {
      threadId: 'thread-1',
      itemId: 'item-1',
      delta: String(index),
    });
  }

  const replay = log.replaySince('thread-1', 'stream-a', 0);
  assert.equal(replay.resetRequired, true);
  assert.equal(replay.reason, 'cache-truncated');
  assert.equal(replay.truncated, true);
  assert.equal(replay.firstAvailableSeq, 2);
  assert.equal(replay.lastSeq, 3);
  assert.deepEqual(replay.events.map((event) => event.seq), [2, 3]);
});

test('thread event log detects stream resets and never replays the old lifecycle', () => {
  const log = new ThreadEventLog({
    streamId: 'stream-a',
    maxEventsPerThread: 10,
    maxThreads: 10,
  });
  log.append('item/started', {
    threadId: 'thread-1',
    item: { id: 'item-1', type: 'agentMessage' },
  });

  log.reset('stream-b');
  const replay = log.replaySince('thread-1', 'stream-a', 1);

  assert.equal(replay.streamId, 'stream-b');
  assert.equal(replay.resetRequired, true);
  assert.equal(replay.reason, 'stream-changed');
  assert.deepEqual(replay.events, []);
  assert.equal(replay.firstAvailableSeq, 1);
  assert.equal(replay.lastSeq, 0);
  assert.equal(replay.toSeq, 0);
});

test('thread event log makes cache eviction detectable', () => {
  const log = new ThreadEventLog({
    streamId: 'stream-a',
    maxEventsPerThread: 10,
    maxThreads: 1,
  });
  log.append('item/started', {
    threadId: 'thread-1',
    item: { id: 'item-1', type: 'agentMessage' },
  });
  log.append('item/started', {
    threadId: 'thread-2',
    item: { id: 'item-2', type: 'agentMessage' },
  });

  const replay = log.replaySince('thread-1', 'stream-a', 0);
  assert.equal(replay.resetRequired, true);
  assert.equal(replay.reason, 'cache-evicted');
  assert.equal(replay.truncated, true);
});

test('CodexBridge emits the sequenced event envelope and rotates its stream', () => {
  const streamIds = ['stream-a', 'stream-b'];
  const bridge = new CodexBridge({
    createStreamId: () => streamIds.shift(),
    maxCachedEventsPerThread: 10,
    maxTrackedThreads: 10,
  });
  const events = [];
  bridge.on('event', (event) => events.push(event));

  bridge._onNotification({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
  });
  assert.equal(events[0].streamId, 'stream-a');
  assert.equal(events[0].threadId, 'thread-1');
  assert.equal(events[0].seq, 1);

  bridge._beginEventStream();
  bridge._onNotification({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn: { id: 'turn-2' } },
  });
  assert.equal(events[1].streamId, 'stream-b');
  assert.equal(events[1].seq, 1);
  assert.equal(bridge.replaySince('thread-1', 'stream-a', 1).reason, 'stream-changed');
});

test('CodexBridge stop kills its child once and suppresses auto-restart', async () => {
  const rpc = new FakeRpcProcess();
  const scheduled = [];
  const bridge = new CodexBridge({
    createRpcProcess: () => rpc,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      timer.cleared = true;
    },
  });

  assert.equal(typeof bridge.stop, 'function', 'CodexBridge.stop is missing');
  await bridge.start();
  await bridge.stop();
  await bridge.stop();

  assert.equal(rpc.killCalls, 1);
  assert.equal(scheduled.length, 0, 'an intentional stop must not schedule restart');
  assert.equal(bridge.state, 'stopped');
});

test('CodexBridge stop cancels a previously scheduled restart', async () => {
  const rpc = new FakeRpcProcess();
  const scheduled = [];
  let factoryCalls = 0;
  const bridge = new CodexBridge({
    createRpcProcess: () => {
      factoryCalls += 1;
      return rpc;
    },
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      timer.cleared = true;
    },
  });

  assert.equal(typeof bridge.dispose, 'function', 'CodexBridge.dispose is missing');
  await bridge.start();
  rpc.emit('exit', { code: 1 });
  assert.equal(scheduled.length, 1);

  await bridge.dispose();
  await bridge.dispose();
  assert.equal(scheduled[0].cleared, true);
  scheduled[0].callback();
  await Promise.resolve();
  assert.equal(factoryCalls, 1, 'disposed bridge must ignore stale restart callbacks');
});
