'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let RiskPolicy;
let canonicalHash;
let requiredForRpc;
let validateApprovalResult;
try {
  ({
    RiskPolicy,
    canonicalHash,
    requiredForRpc,
    validateApprovalResult,
  } = require('../server/risk-policy'));
} catch {}

test('risk proof is bound to device, action, resource, payload, expiry, and one use', () => {
  assert.equal(typeof RiskPolicy, 'function', 'RiskPolicy is missing');
  let now = 1_000;
  const risks = new RiskPolicy({
    clock: () => now,
    confirmationText: 'MY-PC',
    ttlMs: 60_000,
  });
  const owner = { deviceId: 'owner', owner: true };
  const payload = { sandbox: 'danger-full-access', approvalPolicy: 'never' };
  const challenge = risks.issue(owner, {
    action: 'rpc.dangerous',
    resource: 'rpc:turn/start',
    payload,
  });
  assert.equal(challenge.confirmationText, 'MY-PC');
  assert.throws(
    () => risks.confirm(owner, challenge.challengeId, 'wrong'),
    /confirmation/i,
  );
  const confirmed = risks.confirm(owner, challenge.challengeId, 'MY-PC');

  assert.throws(
    () => risks.consume({ deviceId: 'other' }, {
      proof: confirmed.proof,
      action: 'rpc.dangerous',
      resource: 'rpc:turn/start',
      payload,
    }),
    /device|proof/i,
  );
  assert.equal(risks.consume(owner, {
    proof: confirmed.proof,
    action: 'rpc.dangerous',
    resource: 'rpc:turn/start',
    payload,
  }), true);
  assert.throws(
    () => risks.consume(owner, {
      proof: confirmed.proof,
      action: 'rpc.dangerous',
      resource: 'rpc:turn/start',
      payload,
    }),
    /used|proof/i,
  );

  const expiring = risks.issue(owner, {
    action: 'terminal.takeover',
    resource: 'terminal:7',
    payload: { force: true },
  });
  const expiringProof = risks.confirm(owner, expiring.challengeId, 'MY-PC');
  now += 60_001;
  assert.throws(
    () => risks.consume(owner, {
      proof: expiringProof.proof,
      action: 'terminal.takeover',
      resource: 'terminal:7',
      payload: { force: true },
    }),
    /expired|proof/i,
  );
});

test('canonical payload hashing is stable but changes on mutation', () => {
  assert.equal(
    canonicalHash({ b: 2, a: { y: true, x: [1, 2] } }),
    canonicalHash({ a: { x: [1, 2], y: true }, b: 2 }),
  );
  assert.notEqual(canonicalHash({ value: 1 }), canonicalHash({ value: 2 }));
});

test('dangerous RPC combinations and account mutations require challenges', () => {
  assert.deepEqual(
    requiredForRpc('turn/start', {
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })?.action,
    'rpc.dangerous',
  );
  assert.deepEqual(
    requiredForRpc('thread/start', {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })?.action,
    'rpc.dangerous',
  );
  assert.equal(requiredForRpc('turn/start', {
    approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'workspaceWrite' },
  }), null);
  assert.equal(requiredForRpc('account/logout', {})?.action, 'account.manage');
  assert.equal(requiredForRpc('account/login/start', { type: 'apiKey' })?.action, 'account.manage');
});

test('approval decisions respect available decisions and permission grants stay subsets', () => {
  assert.equal(typeof validateApprovalResult, 'function');
  assert.equal(validateApprovalResult({
    method: 'item/commandExecution/requestApproval',
    params: { availableDecisions: ['accept', 'decline'] },
    result: { decision: 'accept' },
  }).ok, true);
  assert.equal(validateApprovalResult({
    method: 'item/commandExecution/requestApproval',
    params: { availableDecisions: ['accept', 'decline'] },
    result: { decision: 'acceptForSession' },
  }).ok, false);

  assert.equal(validateApprovalResult({
    method: 'item/permissions/requestApproval',
    params: {
      permissions: {
        network: { enabled: false },
        fileSystem: { read: ['/workspace'], write: [] },
      },
    },
    result: {
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ['/workspace'], write: [] },
      },
      scope: 'turn',
    },
  }).ok, false);
});
