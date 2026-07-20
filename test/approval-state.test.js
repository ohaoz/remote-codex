'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let ApprovalState;
try {
  ApprovalState = require('../web/approval-state');
} catch {}

function makeFlow() {
  let next = 1;
  return ApprovalState.create({
    createSubmissionId: () => `submission-${next++}`,
  });
}

test('approval remains submitting until a matching ack confirms it', () => {
  assert.equal(typeof ApprovalState?.create, 'function', 'approval state helper is missing');
  const flow = makeFlow();
  flow.add({ rpcId: 'rpc-1', method: 'item/commandExecution/requestApproval' });

  const submission = flow.begin('rpc-1', { decision: 'accept' });
  assert.equal(submission.submissionId, 'submission-1');
  assert.equal(flow.get('rpc-1').status, 'submitting');
  assert.equal(flow.get('rpc-1').disabled, true);

  const stale = flow.ack({
    rpcId: 'rpc-1',
    submissionId: 'another-submission',
    status: 'accepted',
  });
  assert.equal(stale.accepted, false);
  assert.equal(flow.get('rpc-1').status, 'submitting');

  const confirmed = flow.ack({
    rpcId: 'rpc-1',
    submissionId: 'submission-1',
    status: 'accepted',
  });
  assert.equal(confirmed.accepted, true);
  assert.equal(flow.get('rpc-1').status, 'confirmed');
  assert.equal(flow.get('rpc-1').message, '已确认');
});

test('retryable failure keeps the same submission id and decision', () => {
  assert.equal(typeof ApprovalState?.create, 'function', 'approval state helper is missing');
  const flow = makeFlow();
  flow.add({ rpcId: 'rpc-1' });
  const first = flow.begin('rpc-1', { decision: 'decline' });

  flow.ack({
    rpcId: 'rpc-1',
    submissionId: first.submissionId,
    status: 'failed',
    retryable: true,
    error: 'temporary write failure',
  });
  assert.equal(flow.get('rpc-1').status, 'failed');
  assert.equal(flow.get('rpc-1').disabled, false);

  const retry = flow.retry('rpc-1');
  assert.equal(retry.submissionId, first.submissionId);
  assert.deepEqual(retry.result, { decision: 'decline' });
  assert.equal(flow.get('rpc-1').status, 'submitting');
});

test('resolution before ack is remembered but does not remove the submitting card', () => {
  assert.equal(typeof ApprovalState?.create, 'function', 'approval state helper is missing');
  const flow = makeFlow();
  flow.add({ rpcId: 'rpc-1' });
  const submission = flow.begin('rpc-1', { decision: 'accept' });

  flow.resolved({
    rpcId: 'rpc-1',
    submissionId: submission.submissionId,
    resolvedBySubmissionId: submission.submissionId,
  });
  assert.equal(flow.get('rpc-1').status, 'submitting');
  assert.equal(flow.get('rpc-1').resolutionPendingAck, true);

  flow.ack({
    rpcId: 'rpc-1',
    submissionId: submission.submissionId,
    status: 'accepted',
  });
  assert.equal(flow.get('rpc-1').status, 'confirmed');
  assert.equal(flow.get('rpc-1').handledElsewhere, false);
});

test('another client resolution becomes an explicit handled-elsewhere state', () => {
  assert.equal(typeof ApprovalState?.create, 'function', 'approval state helper is missing');
  const flow = makeFlow();
  flow.add({ rpcId: 'rpc-1' });

  flow.resolved({
    rpcId: 'rpc-1',
    submissionId: 'client-a',
    resolvedBySubmissionId: 'client-a',
  });
  const entry = flow.get('rpc-1');
  assert.equal(entry.status, 'confirmed');
  assert.equal(entry.handledElsewhere, true);
  assert.equal(entry.message, '已由其他客户端处理');
  assert.equal(entry.disabled, true);
});

test('socket loss turns in-flight submissions into retryable failures', () => {
  assert.equal(typeof ApprovalState?.create, 'function', 'approval state helper is missing');
  const flow = makeFlow();
  flow.add({ rpcId: 'rpc-1' });
  const submission = flow.begin('rpc-1', { decision: 'accept' });

  flow.connectionLost();
  assert.equal(flow.get('rpc-1').status, 'failed');
  assert.equal(flow.get('rpc-1').retryable, true);
  assert.equal(flow.retry('rpc-1').submissionId, submission.submissionId);
});

test('a new lifecycle may reuse an rpc id without inheriting confirmed state', () => {
  assert.equal(typeof ApprovalState?.create, 'function', 'approval state helper is missing');
  const flow = makeFlow();
  flow.add({ rpcId: '1', receivedAt: 100 });
  flow.resolved({ rpcId: '1', submissionId: 'old-client' });
  assert.equal(flow.get('1').status, 'confirmed');

  flow.add({ rpcId: '1', receivedAt: 200, method: 'item/fileChange/requestApproval' });
  assert.equal(flow.get('1').status, 'idle');
  assert.equal(flow.get('1').approval.receivedAt, 200);
});

test('same-submission duplicate ack confirms retry without blaming another client', () => {
  assert.equal(typeof ApprovalState?.create, 'function', 'approval state helper is missing');
  const flow = makeFlow();
  flow.add({ rpcId: 'rpc-1' });
  const submission = flow.begin('rpc-1', { decision: 'accept' });
  flow.connectionLost();
  flow.retry('rpc-1');

  flow.ack({
    rpcId: 'rpc-1',
    submissionId: submission.submissionId,
    resolvedBySubmissionId: submission.submissionId,
    status: 'already-resolved',
  });

  assert.equal(flow.get('rpc-1').status, 'confirmed');
  assert.equal(flow.get('rpc-1').handledElsewhere, false);
  assert.equal(flow.get('rpc-1').message, '已确认');
});

test('different-submission duplicate ack identifies another client', () => {
  assert.equal(typeof ApprovalState?.create, 'function', 'approval state helper is missing');
  const flow = makeFlow();
  flow.add({ rpcId: 'rpc-1' });
  const submission = flow.begin('rpc-1', { decision: 'accept' });

  flow.ack({
    rpcId: 'rpc-1',
    submissionId: submission.submissionId,
    resolvedBySubmissionId: 'other-client',
    status: 'already-resolved',
  });

  assert.equal(flow.get('rpc-1').handledElsewhere, true);
  assert.equal(flow.get('rpc-1').message, '已由其他客户端处理');
});
