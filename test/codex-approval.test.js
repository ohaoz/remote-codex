'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexBridge } = require('../server/codex');

function makeBridge(options = {}) {
  return new CodexBridge({
    createStreamId: () => 'stream-test',
    ...options,
  });
}

test('approval context exposes only indexed thread, command, and file facts', () => {
  const bridge = makeBridge();
  bridge.rpc = { respond() {} };

  bridge._onNotification({
    method: 'thread/started',
    params: {
      thread: {
        id: 'thread-1',
        cwd: 'G:\\work',
        source: 'vscode',
        threadSource: 'remote-control',
      },
    },
  });
  bridge._onNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'command-1',
        type: 'commandExecution',
        cwd: 'G:\\work\\subdir',
        source: 'agent',
        command: 'npm test',
      },
    },
  });
  bridge._onNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'patch-1',
        type: 'fileChange',
        changes: [
          { path: 'src/a.js', kind: { type: 'update' }, diff: '' },
          { path: 'src/b.js', kind: { type: 'add' }, diff: '' },
        ],
      },
    },
  });

  bridge._onServerRequest({
    id: 41,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'command-1',
      command: 'npm test',
    },
  });
  bridge._onServerRequest({
    id: 42,
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
    },
  });

  const [command, files] = bridge.listPendingApprovals();
  assert.deepEqual(command.context, {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'command-1',
    cwd: 'G:\\work\\subdir',
    files: null,
    threadSource: 'vscode',
    commandSource: 'agent',
    fieldSources: {
      threadId: 'params.threadId',
      turnId: 'params.turnId',
      itemId: 'params.itemId',
      cwd: 'item.cwd',
      files: null,
      threadSource: 'thread.source',
      commandSource: 'item.source',
    },
  });
  assert.deepEqual(files.context.files, ['src/a.js', 'src/b.js']);
  assert.equal(files.context.cwd, 'G:\\work');
  assert.equal(files.context.fieldSources.files, 'item.changes[].path');
  assert.equal(files.context.fieldSources.cwd, 'thread.cwd');
});

test('approval context leaves unknown values null instead of guessing', () => {
  const bridge = makeBridge();
  bridge.rpc = { respond() {} };
  bridge._onServerRequest({
    id: 7,
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'unknown-thread', turnId: 'turn-x', itemId: 'item-x' },
  });

  const pending = bridge.listPendingApprovals()[0];
  assert.equal(pending.context.cwd, null);
  assert.equal(pending.context.files, null);
  assert.equal(pending.context.threadSource, null);
  assert.equal(pending.context.commandSource, null);
  assert.equal(pending.context.fieldSources.cwd, null);
});

test('failed app-server response keeps approval pending for same-submission retry', () => {
  const bridge = makeBridge();
  let attempts = 0;
  bridge.rpc = {
    respond() {
      attempts += 1;
      if (attempts === 1) throw new Error('pipe closed');
    },
  };
  bridge._onServerRequest({
    id: 8,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
  });

  const failed = bridge.resolveApproval('8', { decision: 'accept' }, 'submission-a');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retryable, true);
  assert.match(failed.error, /pipe closed/);
  assert.equal(bridge.listPendingApprovals().length, 1);

  const accepted = bridge.resolveApproval('8', { decision: 'accept' }, 'submission-a');
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.submissionId, 'submission-a');
  assert.equal(bridge.listPendingApprovals().length, 0);

  const duplicate = bridge.resolveApproval('8', { decision: 'accept' }, 'submission-a');
  assert.equal(duplicate.status, 'already-resolved');
  assert.equal(duplicate.resolvedBySubmissionId, 'submission-a');
});

test('two clients racing an approval produce one acceptance and one tombstone result', () => {
  const bridge = makeBridge();
  const writes = [];
  bridge.rpc = { respond(id, result) { writes.push({ id, result }); } };
  bridge._onServerRequest({
    id: 9,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
  });

  const first = bridge.resolveApproval('9', { decision: 'accept' }, 'client-a');
  const second = bridge.resolveApproval('9', { decision: 'decline' }, 'client-b');

  assert.equal(first.status, 'accepted');
  assert.equal(second.status, 'already-resolved');
  assert.equal(second.resolvedBySubmissionId, 'client-a');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].result, { decision: 'accept' });
});

test('server resolution notification preserves the accepted submission identity', () => {
  const bridge = makeBridge();
  bridge.rpc = { respond() {} };
  bridge._onServerRequest({
    id: 10,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
  });

  assert.equal(
    bridge.resolveApproval('10', { decision: 'accept' }, 'client-a').status,
    'accepted',
  );
  bridge._onNotification({
    method: 'serverRequest/resolved',
    params: { threadId: 'thread-1', requestId: 10 },
  });

  const duplicate = bridge.resolveApproval('10', { decision: 'accept' }, 'client-a');
  assert.equal(duplicate.status, 'already-resolved');
  assert.equal(duplicate.resolvedBySubmissionId, 'client-a');
});

test('approval tombstones are bounded and expire', () => {
  let now = 1000;
  const bridge = makeBridge({
    maxApprovalTombstones: 2,
    approvalTombstoneTtlMs: 50,
    now: () => now,
  });
  bridge.rpc = { respond() {} };

  for (let id = 1; id <= 3; id += 1) {
    bridge._onServerRequest({
      id,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: `item-${id}` },
    });
    assert.equal(
      bridge.resolveApproval(String(id), { decision: 'accept' }, `submission-${id}`).status,
      'accepted',
    );
  }

  assert.equal(bridge.resolveApproval('1', {}, 'late').status, 'not-found');
  assert.equal(bridge.resolveApproval('2', {}, 'late').status, 'already-resolved');
  now += 51;
  assert.equal(bridge.resolveApproval('2', {}, 'late').status, 'not-found');
});
