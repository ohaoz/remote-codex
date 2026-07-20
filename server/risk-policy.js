'use strict';

const crypto = require('node:crypto');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) normalized[key] = canonicalize(value[key]);
    }
    return normalized;
  }
  return value;
}

function canonicalHash(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  return left.length > 0
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

class RiskPolicy {
  constructor(options = {}) {
    this.clock = options.clock || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.confirmationText = String(options.confirmationText || 'CONFIRM');
    this.ttlMs = Math.max(5_000, options.ttlMs || 60_000);
    this.challenges = new Map();
    this.proofs = new Map();
  }

  _now() {
    return Number(typeof this.clock === 'function' ? this.clock() : this.clock.now());
  }

  _random(bytes = 24) {
    return Buffer.from(this.randomBytes(bytes)).toString('base64url');
  }

  _prune() {
    const now = this._now();
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id);
    }
    for (const [hash, proof] of this.proofs) {
      if (proof.expiresAt <= now || proof.usedAt) this.proofs.delete(hash);
    }
  }

  issue(principal, { action, resource, payload }) {
    if (!principal?.deviceId) throw new Error('authenticated device required');
    this._prune();
    const now = this._now();
    const challengeId = `risk_${this._random(12)}`;
    const challenge = {
      challengeId,
      deviceId: principal.deviceId,
      action: String(action),
      resource: String(resource),
      payloadHash: canonicalHash(payload),
      confirmationText: this.confirmationText,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.challenges.set(challengeId, challenge);
    return {
      challengeId,
      confirmationText: challenge.confirmationText,
      expiresAt: challenge.expiresAt,
    };
  }

  confirm(principal, challengeId, confirmationText) {
    this._prune();
    const challenge = this.challenges.get(String(challengeId));
    if (!challenge || challenge.expiresAt <= this._now()) throw new Error('risk challenge expired');
    if (challenge.deviceId !== principal?.deviceId) throw new Error('risk challenge device mismatch');
    if (String(confirmationText) !== challenge.confirmationText) {
      throw new Error('confirmation text does not match');
    }
    this.challenges.delete(challenge.challengeId);
    const proof = this._random(32);
    this.proofs.set(canonicalHash(proof), {
      deviceId: challenge.deviceId,
      action: challenge.action,
      resource: challenge.resource,
      payloadHash: challenge.payloadHash,
      expiresAt: challenge.expiresAt,
      usedAt: null,
    });
    return { proof, expiresAt: challenge.expiresAt };
  }

  consume(principal, { proof, action, resource, payload }) {
    this._prune();
    const hash = canonicalHash(proof);
    const record = this.proofs.get(hash);
    if (!record) throw new Error('risk proof invalid, expired, or used');
    if (record.deviceId !== principal?.deviceId) throw new Error('risk proof device mismatch');
    if (
      record.action !== String(action)
      || record.resource !== String(resource)
      || !safeEqualHex(record.payloadHash, canonicalHash(payload))
    ) {
      throw new Error('risk proof does not match this operation');
    }
    record.usedAt = this._now();
    this.proofs.delete(hash);
    return true;
  }
}

function requiredForRpc(method, params = {}) {
  if (['account/login/start', 'account/logout'].includes(method)) {
    return {
      action: 'account.manage',
      resource: `rpc:${method}`,
      payload: params,
    };
  }
  const dangerousSandbox = (
    params?.sandbox === 'danger-full-access'
    || params?.sandboxPolicy?.type === 'dangerFullAccess'
  );
  if (
    ['thread/start', 'turn/start'].includes(method)
    && params?.approvalPolicy === 'never'
    && dangerousSandbox
  ) {
    return {
      action: 'rpc.dangerous',
      resource: `rpc:${method}`,
      payload: params,
    };
  }
  return null;
}

function isSubset(granted, requested) {
  if (Array.isArray(granted)) {
    if (!Array.isArray(requested)) return false;
    const requestedHashes = new Set(requested.map(canonicalHash));
    return granted.every((entry) => requestedHashes.has(canonicalHash(entry)));
  }
  if (granted && typeof granted === 'object') {
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)) return false;
    return Object.keys(granted).every((key) => (
      Object.prototype.hasOwnProperty.call(requested, key)
      && isSubset(granted[key], requested[key])
    ));
  }
  if (typeof granted === 'boolean' && typeof requested === 'boolean') {
    return !granted || requested;
  }
  return Object.is(granted, requested);
}

function decisionAllowed(decision, available) {
  const desired = canonicalHash(decision);
  return available.some((entry) => canonicalHash(entry) === desired);
}

function validateApprovalResult({ method, params = {}, result = {} }) {
  if (method === 'item/commandExecution/requestApproval') {
    const available = params.availableDecisions;
    if (Array.isArray(available) && available.length && !decisionAllowed(result.decision, available)) {
      return { ok: false, error: 'approval decision is not available for this request' };
    }
  } else if (method === 'item/fileChange/requestApproval') {
    const allowed = ['accept', 'acceptForSession', 'decline', 'cancel'];
    if (!allowed.includes(result.decision)) {
      return { ok: false, error: 'invalid file approval decision' };
    }
  } else if (method === 'item/permissions/requestApproval') {
    if (!isSubset(result.permissions || {}, params.permissions || {})) {
      return { ok: false, error: 'granted permissions exceed the request' };
    }
  } else if (method === 'execCommandApproval') {
    if (!['approved', 'approved_for_session', 'denied'].includes(result.decision)) {
      return { ok: false, error: 'invalid legacy command decision' };
    }
  } else if (method === 'applyPatchApproval') {
    if (!['approved', 'approved_for_session', 'denied'].includes(result.decision)) {
      return { ok: false, error: 'invalid legacy patch decision' };
    }
  }
  return { ok: true };
}

module.exports = {
  RiskPolicy,
  canonicalHash,
  canonicalize,
  isSubset,
  requiredForRpc,
  validateApprovalResult,
};
