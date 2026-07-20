'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let submitApproval;
try {
  ({ submitApproval } = require('../server/approval-protocol'));
} catch {}

test('approval submit sends the requester ack before broadcasting resolution', () => {
  assert.equal(typeof submitApproval, 'function', 'approval protocol helper is missing');
  const order = [];
  const bridge = {
    resolveApproval(rpcId, result, submissionId) {
      assert.equal(rpcId, 'rpc-1');
      assert.deepEqual(result, { decision: 'accept' });
      assert.equal(submissionId, 'submission-1');
      return {
        status: 'accepted',
        retryable: false,
        rpcId,
        submissionId,
        resolvedBySubmissionId: submissionId,
      };
    },
  };

  const ack = submitApproval({
    bridge,
    message: {
      type: 'approval',
      rpcId: 'rpc-1',
      submissionId: 'submission-1',
      result: { decision: 'accept' },
    },
    sendAck(message) {
      order.push({ type: 'ack', message });
    },
    publishResolution(message) {
      order.push({ type: 'resolution', message });
    },
  });

  assert.equal(ack.status, 'accepted');
  assert.deepEqual(order.map((entry) => entry.type), ['ack', 'resolution']);
  assert.deepEqual(order[0].message, {
    type: 'approval-ack',
    status: 'accepted',
    retryable: false,
    rpcId: 'rpc-1',
    submissionId: 'submission-1',
    resolvedBySubmissionId: 'submission-1',
  });
  assert.deepEqual(order[1].message, {
    type: 'approval-resolved',
    rpcId: 'rpc-1',
    submissionId: 'submission-1',
    resolvedBySubmissionId: 'submission-1',
  });
});

test('failed or duplicate approval submissions do not rebroadcast resolution', () => {
  assert.equal(typeof submitApproval, 'function', 'approval protocol helper is missing');
  for (const status of ['failed', 'already-resolved', 'not-found']) {
    const sent = [];
    submitApproval({
      bridge: {
        resolveApproval() {
          return {
            status,
            retryable: status === 'failed',
            rpcId: 'rpc-1',
            submissionId: 'submission-2',
            resolvedBySubmissionId: status === 'already-resolved' ? 'submission-1' : null,
          };
        },
      },
      message: {
        rpcId: 'rpc-1',
        submissionId: 'submission-2',
        result: { decision: 'decline' },
      },
      sendAck(message) {
        sent.push(message.type);
      },
      publishResolution(message) {
        sent.push(message.type);
      },
    });
    assert.deepEqual(sent, ['approval-ack'], `unexpected broadcast for ${status}`);
  }
});

test('missing submission ids are rejected without touching the bridge', () => {
  assert.equal(typeof submitApproval, 'function', 'approval protocol helper is missing');
  let called = false;
  const sent = [];
  const ack = submitApproval({
    bridge: {
      resolveApproval() {
        called = true;
      },
    },
    message: { rpcId: 'rpc-1', result: { decision: 'accept' } },
    sendAck(message) {
      sent.push(message);
    },
    publishResolution() {
      throw new Error('must not publish');
    },
  });

  assert.equal(called, false);
  assert.equal(ack.status, 'failed');
  assert.equal(ack.retryable, false);
  assert.match(ack.error, /submissionId/);
  assert.equal(sent.length, 1);
});
