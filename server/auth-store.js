'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCOPES = new Set(['chat-only', 'read-only', 'full-control']);
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

class AuthStoreCorruptError extends Error {
  constructor(filePath, cause) {
    super(`device auth store is corrupt: ${filePath}`);
    this.name = 'AuthStoreCorruptError';
    this.code = 'AUTH_STORE_CORRUPT';
    this.filePath = filePath;
    this.cause = cause;
  }
}

function emptyState() {
  return {
    version: 1,
    bootstrapMigratedAt: null,
    devices: [],
    sessions: [],
    invites: [],
  };
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  return left.length > 0
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

class AuthStore {
  constructor(options = {}) {
    if (!options.filePath) throw new TypeError('filePath is required');
    this.filePath = options.filePath;
    this.fs = options.fs || fs;
    this.clock = options.clock || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.sessionTtlMs = options.sessionTtlMs || DEFAULT_SESSION_TTL_MS;
    this.state = this._load();
  }

  _now() {
    return Number(typeof this.clock === 'function' ? this.clock() : this.clock.now());
  }

  _random(bytes = 24) {
    return Buffer.from(this.randomBytes(bytes)).toString('base64url');
  }

  _hash(secret) {
    return crypto.createHash('sha256').update(String(secret)).digest('hex');
  }

  _load() {
    if (!this.fs.existsSync(this.filePath)) return emptyState();
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      if (
        parsed?.version !== 1
        || !Array.isArray(parsed.devices)
        || !Array.isArray(parsed.sessions)
        || !Array.isArray(parsed.invites)
      ) {
        throw new Error('unsupported auth store schema');
      }
      return parsed;
    } catch (error) {
      const diagnostic = `${this.filePath}.corrupt-${this._now()}`;
      try {
        this.fs.copyFileSync(this.filePath, diagnostic);
      } catch {}
      throw new AuthStoreCorruptError(this.filePath, error);
    }
  }

  _persist() {
    const directory = path.dirname(this.filePath);
    this.fs.mkdirSync(directory, { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}-${this._random(6)}`;
    try {
      this.fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      this.fs.renameSync(temporary, this.filePath);
    } catch (error) {
      try { this.fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  _transaction(mutator) {
    const previous = this.state;
    this.state = JSON.parse(JSON.stringify(previous));
    try {
      const result = mutator(this.state);
      this._persist();
      return result;
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }

  hasOwner() {
    const now = this._now();
    return this.state.devices.some((device) => (
      device.owner
      && !device.revokedAt
      && (!device.expiresAt || device.expiresAt > now)
    ));
  }

  hasActiveOwnerSession() {
    const now = this._now();
    const ownerIds = new Set(this.state.devices.filter((device) => (
      device.owner
      && !device.revokedAt
      && (!device.expiresAt || device.expiresAt > now)
    )).map((device) => device.id));
    return this.state.sessions.some((session) => (
      ownerIds.has(session.deviceId)
      && !session.revokedAt
      && session.expiresAt > now
    ));
  }

  isBootstrapMigrated() {
    return Boolean(this.state.bootstrapMigratedAt);
  }

  markBootstrapMigrated(at = this._now()) {
    if (this.state.bootstrapMigratedAt) return false;
    this.state.bootstrapMigratedAt = at;
    this._persist();
    return true;
  }

  createDevice({
    name,
    platform = 'unknown',
    scope = 'chat-only',
    owner = false,
    expiresAt = null,
  }) {
    if (!SCOPES.has(scope)) throw new Error(`invalid device scope: ${scope}`);
    const now = this._now();
    const device = {
      id: `dev_${this._random(12)}`,
      name: String(name || 'Unnamed device').slice(0, 80),
      platform: String(platform || 'unknown').slice(0, 80),
      scope,
      owner: Boolean(owner),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: expiresAt == null ? null : Number(expiresAt),
      revokedAt: null,
    };
    this.state.devices.push(device);
    this._persist();
    return { ...device };
  }

  enrollDevice({
    device: input,
    inviteCode = null,
    markBootstrapMigrated = false,
    sessionTtlMs = this.sessionTtlMs,
  }) {
    return this._transaction(() => {
      const now = this._now();
      let invitation = null;
      if (inviteCode) invitation = this._consumeInviteRecord(inviteCode, now);
      const scope = invitation?.scope || input.scope || 'chat-only';
      if (!SCOPES.has(scope)) throw new Error(`invalid device scope: ${scope}`);
      const device = {
        id: `dev_${this._random(12)}`,
        name: String(input.name || 'Unnamed device').slice(0, 80),
        platform: String(input.platform || 'unknown').slice(0, 80),
        scope,
        owner: Boolean(invitation?.owner || input.owner),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: input.expiresAt == null ? null : Number(input.expiresAt),
        revokedAt: null,
      };
      const sessionId = `ses_${this._random(12)}`;
      const secret = this._random(32);
      const session = {
        id: sessionId,
        deviceId: device.id,
        secretHash: this._hash(secret),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + Math.max(1, Number(sessionTtlMs)),
        revokedAt: null,
      };
      this.state.devices.push(device);
      this.state.sessions.push(session);
      if (markBootstrapMigrated) {
        if (this.state.bootstrapMigratedAt) throw new Error('bootstrap already migrated');
        this.state.bootstrapMigratedAt = now;
      }
      return {
        device: { ...device },
        sessionToken: `${sessionId}.${secret}`,
        sessionExpiresAt: session.expiresAt,
        invitation: invitation ? { ...invitation } : null,
      };
    });
  }

  getDevice(deviceId) {
    const device = this.state.devices.find((entry) => entry.id === deviceId);
    return device ? { ...device } : null;
  }

  listDevices() {
    return this.state.devices.map((device) => ({ ...device }));
  }

  renameDevice(deviceId, name) {
    const device = this.state.devices.find((entry) => entry.id === deviceId);
    if (!device || device.revokedAt) return null;
    device.name = String(name || '').trim().slice(0, 80) || device.name;
    this._persist();
    return { ...device };
  }

  issueSession(deviceId, { ttlMs = this.sessionTtlMs } = {}) {
    const device = this.state.devices.find((entry) => entry.id === deviceId);
    const now = this._now();
    if (
      !device
      || device.revokedAt
      || (device.expiresAt && device.expiresAt <= now)
    ) {
      throw new Error('device is not active');
    }
    const id = `ses_${this._random(12)}`;
    const secret = this._random(32);
    const session = {
      id,
      deviceId,
      secretHash: this._hash(secret),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + Math.max(1, Number(ttlMs)),
      revokedAt: null,
    };
    this.state.sessions.push(session);
    this._persist();
    return {
      token: `${id}.${secret}`,
      expiresAt: session.expiresAt,
      sessionId: id,
    };
  }

  authenticateSession(token, { touch = true } = {}) {
    const [id, secret, extra] = String(token || '').split('.');
    if (!id || !secret || extra) return null;
    const session = this.state.sessions.find((entry) => entry.id === id);
    if (!session || session.revokedAt) return null;
    const now = this._now();
    if (session.expiresAt <= now || !safeEqualHex(session.secretHash, this._hash(secret))) {
      return null;
    }
    const device = this.state.devices.find((entry) => entry.id === session.deviceId);
    if (
      !device
      || device.revokedAt
      || (device.expiresAt && device.expiresAt <= now)
    ) {
      return null;
    }
    if (touch && now - (session.lastSeenAt || 0) >= 60_000) {
      session.lastSeenAt = now;
      device.lastSeenAt = now;
      this._persist();
    }
    return {
      sessionId: session.id,
      deviceId: device.id,
      name: device.name,
      platform: device.platform,
      scope: device.scope,
      owner: Boolean(device.owner),
      expiresAt: session.expiresAt,
    };
  }

  isSessionActive(sessionId) {
    const session = this.state.sessions.find((entry) => entry.id === sessionId);
    if (!session || session.revokedAt || session.expiresAt <= this._now()) return false;
    const device = this.state.devices.find((entry) => entry.id === session.deviceId);
    return Boolean(
      device
      && !device.revokedAt
      && (!device.expiresAt || device.expiresAt > this._now()),
    );
  }

  revokeSession(sessionId, { revokedAt = this._now() } = {}) {
    const session = this.state.sessions.find((entry) => entry.id === sessionId);
    if (!session || session.revokedAt) return false;
    session.revokedAt = revokedAt;
    this._persist();
    return true;
  }

  revokeDevice(deviceId, { revokedAt = this._now() } = {}) {
    const device = this.state.devices.find((entry) => entry.id === deviceId);
    if (!device || device.revokedAt) return false;
    device.revokedAt = revokedAt;
    for (const session of this.state.sessions) {
      if (session.deviceId === deviceId && !session.revokedAt) session.revokedAt = revokedAt;
    }
    for (const invite of this.state.invites) {
      if (invite.createdByDeviceId === deviceId && !invite.usedAt && !invite.revokedAt) {
        invite.revokedAt = revokedAt;
      }
    }
    this._persist();
    return true;
  }

  createInvite({
    createdByDeviceId,
    scope,
    ttlMs = 5 * 60_000,
  }) {
    if (!SCOPES.has(scope)) throw new Error(`invalid device scope: ${scope}`);
    return this._createInvite({ createdByDeviceId, scope, ttlMs, owner: false });
  }

  createRecoveryInvite({ ttlMs = 5 * 60_000 } = {}) {
    return this._createInvite({
      createdByDeviceId: 'local-recovery',
      scope: 'full-control',
      ttlMs,
      owner: true,
    });
  }

  _createInvite({ createdByDeviceId, scope, ttlMs, owner }) {
    const now = this._now();
    if (createdByDeviceId !== 'local-recovery') {
      const creator = this.state.devices.find((device) => device.id === createdByDeviceId);
      if (
        !creator
        || creator.revokedAt
        || (creator.expiresAt && creator.expiresAt <= now)
      ) {
        throw new Error('inviting device is not active');
      }
    }
    const id = `inv_${this._random(10)}`;
    const secret = this._random(18);
    const invite = {
      id,
      createdByDeviceId,
      scope,
      owner: Boolean(owner),
      secretHash: this._hash(secret),
      createdAt: now,
      expiresAt: now + Math.max(1, Number(ttlMs)),
      usedAt: null,
      revokedAt: null,
    };
    this.state.invites.push(invite);
    this._persist();
    return {
      code: `${id}.${secret}`,
      expiresAt: invite.expiresAt,
      scope,
      owner: Boolean(owner),
    };
  }

  consumeInvite(code) {
    const safeInvite = this._transaction(() => this._consumeInviteRecord(code, this._now()));
    const { secretHash, ...safe } = safeInvite;
    return safe;
  }

  inspectInvite(code) {
    const invite = this._validateInviteRecord(code, this._now());
    const { secretHash, ...safe } = invite;
    return { ...safe };
  }

  _consumeInviteRecord(code, now) {
    const invite = this._validateInviteRecord(code, now);
    invite.usedAt = now;
    return invite;
  }

  _validateInviteRecord(code, now) {
    const [id, secret, extra] = String(code || '').split('.');
    if (!id || !secret || extra) throw new Error('invalid invitation');
    const invite = this.state.invites.find((entry) => entry.id === id);
    if (
      !invite
      || invite.usedAt
      || invite.revokedAt
      || invite.expiresAt <= now
      || !safeEqualHex(invite.secretHash, this._hash(secret))
    ) {
      throw new Error(invite?.expiresAt <= now ? 'invitation expired' : 'invitation invalid or used');
    }
    return invite;
  }
}

module.exports = {
  AuthStore,
  AuthStoreCorruptError,
  DEFAULT_SESSION_TTL_MS,
  SCOPES,
  safeEqualHex,
};
