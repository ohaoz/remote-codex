'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let ReconnectSync;
try {
  ReconnectSync = require('../web/reconnect');
} catch {}

function event(streamId, threadId, seq, method = 'item/agentMessage/delta') {
  return {
    type: 'event',
    streamId,
    threadId,
    seq,
    method,
    params: { threadId, itemId: 'item-1', delta: String(seq) },
  };
}

test('replay and early live events merge by sequence exactly once', () => {
  assert.equal(typeof ReconnectSync?.create, 'function', 'reconnect state machine is missing');
  const sync = ReconnectSync.create();
  const generation = sync.beginSocket();

  const hello = sync.onHello(generation, { streamId: 'stream-a' }, 'thread-1');
  assert.equal(hello.accepted, true);
  assert.equal(sync.snapshot().status, 'syncing');
  assert.deepEqual(
    {
      type: hello.replayRequest.type,
      streamId: hello.replayRequest.streamId,
      afterSeq: hello.replayRequest.afterSeq,
      threadId: hello.replayRequest.threadId,
    },
    {
      type: 'replay',
      streamId: 'stream-a',
      afterSeq: 0,
      threadId: 'thread-1',
    },
  );

  const early = sync.onLiveEvent(generation, event('stream-a', 'thread-1', 2));
  assert.deepEqual(early.events, []);

  const replayed = sync.onReplayResult(generation, {
    type: 'replay-result',
    reqId: hello.replayRequest.reqId,
    streamId: 'stream-a',
    threadId: 'thread-1',
    resetRequired: false,
    reason: null,
    firstAvailableSeq: 1,
    lastSeq: 2,
    toSeq: 2,
    activeTurnId: 'turn-1',
    events: [
      event('stream-a', 'thread-1', 1),
      event('stream-a', 'thread-1', 2),
    ],
  });

  assert.equal(replayed.accepted, true);
  assert.equal(replayed.activeTurnId, 'turn-1');
  assert.deepEqual(replayed.events.map((entry) => entry.seq), [1, 2]);
  assert.equal(sync.snapshot().status, 'synced');
  assert.equal(sync.getLastAppliedSeq('thread-1'), 2);

  const duplicate = sync.onLiveEvent(generation, event('stream-a', 'thread-1', 2));
  assert.deepEqual(duplicate.events, []);
  const next = sync.onLiveEvent(generation, event('stream-a', 'thread-1', 3));
  assert.deepEqual(next.events.map((entry) => entry.seq), [3]);
  assert.equal(sync.getLastAppliedSeq('thread-1'), 3);
});

test('callbacks from a stale socket generation cannot change synchronization state', () => {
  assert.equal(typeof ReconnectSync?.create, 'function', 'reconnect state machine is missing');
  const sync = ReconnectSync.create();
  const staleGeneration = sync.beginSocket();
  const currentGeneration = sync.beginSocket();

  assert.equal(sync.onHello(staleGeneration, { streamId: 'stale' }, null).accepted, false);
  assert.equal(sync.onSocketClosed(staleGeneration).accepted, false);
  assert.equal(sync.snapshot().status, 'reconnecting');

  assert.equal(sync.onHello(currentGeneration, { streamId: 'current' }, null).accepted, true);
  assert.equal(sync.snapshot().status, 'synced');
  assert.equal(sync.snapshot().streamId, 'current');

  assert.equal(sync.onSocketClosed(staleGeneration).accepted, false);
  assert.equal(sync.snapshot().status, 'synced');
  assert.equal(sync.snapshot().streamId, 'current');
});

test('stream reset waits for canonical rebuild then applies available replay and live events', () => {
  assert.equal(typeof ReconnectSync?.create, 'function', 'reconnect state machine is missing');
  const sync = ReconnectSync.create();
  const firstGeneration = sync.beginSocket();
  const firstHello = sync.onHello(firstGeneration, { streamId: 'stream-a' }, 'thread-1');
  const initialEvents = [1, 2, 3].map((seq) => event('stream-a', 'thread-1', seq));
  const initial = sync.onReplayResult(firstGeneration, {
    type: 'replay-result',
    reqId: firstHello.replayRequest.reqId,
    streamId: 'stream-a',
    threadId: 'thread-1',
    resetRequired: false,
    firstAvailableSeq: 1,
    lastSeq: 3,
    toSeq: 3,
    activeTurnId: null,
    events: initialEvents,
  });
  assert.deepEqual(initial.events.map((entry) => entry.seq), [1, 2, 3]);

  sync.onSocketClosed(firstGeneration);
  const secondGeneration = sync.beginSocket();
  const secondHello = sync.onHello(secondGeneration, { streamId: 'stream-b' }, 'thread-1');
  assert.equal(secondHello.replayRequest.streamId, 'stream-a');
  assert.equal(secondHello.replayRequest.afterSeq, 3);

  const needsReset = sync.onReplayResult(secondGeneration, {
    type: 'replay-result',
    reqId: secondHello.replayRequest.reqId,
    streamId: 'stream-b',
    threadId: 'thread-1',
    resetRequired: true,
    reason: 'stream-changed',
    firstAvailableSeq: 1,
    lastSeq: 1,
    toSeq: 1,
    activeTurnId: 'turn-2',
    events: [event('stream-b', 'thread-1', 1, 'turn/started')],
  });
  assert.equal(needsReset.resetRequired, true);
  assert.deepEqual(needsReset.events, []);
  assert.equal(sync.snapshot().status, 'syncing');

  sync.onLiveEvent(secondGeneration, event('stream-b', 'thread-1', 2));
  const rebuilt = sync.completeReset(secondGeneration);

  assert.equal(rebuilt.accepted, true);
  assert.equal(rebuilt.activeTurnId, 'turn-2');
  assert.deepEqual(rebuilt.events.map((entry) => entry.seq), [1, 2]);
  assert.equal(sync.snapshot().status, 'synced');
  assert.equal(sync.snapshot().streamId, 'stream-b');
  assert.equal(sync.getLastAppliedSeq('thread-1'), 2);
});

test('truncated replay resumes from first available sequence after canonical rebuild', () => {
  assert.equal(typeof ReconnectSync?.create, 'function', 'reconnect state machine is missing');
  const sync = ReconnectSync.create();
  const generation = sync.beginSocket();
  const hello = sync.onHello(generation, { streamId: 'stream-a' }, 'thread-1');

  const needsReset = sync.onReplayResult(generation, {
    type: 'replay-result',
    reqId: hello.replayRequest.reqId,
    streamId: 'stream-a',
    threadId: 'thread-1',
    resetRequired: true,
    reason: 'cache-truncated',
    truncated: true,
    firstAvailableSeq: 5,
    lastSeq: 6,
    toSeq: 6,
    activeTurnId: 'turn-1',
    events: [
      event('stream-a', 'thread-1', 5),
      event('stream-a', 'thread-1', 6),
    ],
  });
  assert.equal(needsReset.reason, 'cache-truncated');

  const rebuilt = sync.completeReset(generation);
  assert.deepEqual(rebuilt.events.map((entry) => entry.seq), [5, 6]);
  assert.equal(sync.getLastAppliedSeq('thread-1'), 6);
});

test('canonical active turn survives a stream reset with an empty new event log', () => {
  assert.equal(typeof ReconnectSync?.create, 'function', 'reconnect state machine is missing');
  const sync = ReconnectSync.create();
  const generation = sync.beginSocket();
  const hello = sync.onHello(generation, { streamId: 'stream-new' }, 'thread-1');

  sync.onReplayResult(generation, {
    type: 'replay-result',
    reqId: hello.replayRequest.reqId,
    streamId: 'stream-new',
    threadId: 'thread-1',
    resetRequired: true,
    reason: 'cache-missing',
    firstAvailableSeq: 1,
    lastSeq: 0,
    toSeq: 0,
    activeTurnId: null,
    events: [],
  });
  const rebuilt = sync.completeReset(generation, { canonicalActiveTurnId: 'turn-live' });

  assert.equal(rebuilt.activeTurnId, 'turn-live');
  assert.equal(sync.snapshot().status, 'synced');
});

test('buffered completion overrides replay and canonical active-turn truth', () => {
  assert.equal(typeof ReconnectSync?.create, 'function', 'reconnect state machine is missing');
  const sync = ReconnectSync.create();
  const generation = sync.beginSocket();
  const hello = sync.onHello(generation, { streamId: 'stream-a' }, 'thread-1');

  sync.onReplayResult(generation, {
    type: 'replay-result',
    reqId: hello.replayRequest.reqId,
    streamId: 'stream-a',
    threadId: 'thread-1',
    resetRequired: true,
    reason: 'cache-truncated',
    firstAvailableSeq: 1,
    lastSeq: 1,
    toSeq: 1,
    activeTurnId: 'turn-1',
    events: [
      {
        type: 'event',
        streamId: 'stream-a',
        threadId: 'thread-1',
        seq: 1,
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      },
    ],
  });
  sync.onLiveEvent(generation, {
    type: 'event',
    streamId: 'stream-a',
    threadId: 'thread-1',
    seq: 2,
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
  });

  const rebuilt = sync.completeReset(generation, { canonicalActiveTurnId: 'turn-1' });
  assert.equal(rebuilt.activeTurnId, null);
  assert.deepEqual(rebuilt.events.map((entry) => entry.seq), [1, 2]);
});

test('a replay sequence gap requires canonical reset before synchronization completes', () => {
  assert.equal(typeof ReconnectSync?.create, 'function', 'reconnect state machine is missing');
  const sync = ReconnectSync.create();
  const generation = sync.beginSocket();
  const hello = sync.onHello(generation, { streamId: 'stream-a' }, 'thread-1');

  const gap = sync.onReplayResult(generation, {
    type: 'replay-result',
    reqId: hello.replayRequest.reqId,
    streamId: 'stream-a',
    threadId: 'thread-1',
    resetRequired: false,
    firstAvailableSeq: 2,
    lastSeq: 2,
    toSeq: 2,
    activeTurnId: null,
    events: [event('stream-a', 'thread-1', 2)],
  });

  assert.equal(gap.resetRequired, true);
  assert.equal(gap.reason, 'sequence-gap');
  assert.equal(sync.snapshot().status, 'syncing');
  assert.deepEqual(sync.completeReset(generation).events.map((entry) => entry.seq), [2]);
});
