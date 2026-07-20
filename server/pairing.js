'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

function timingSafeTextEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

class PairRateLimiter {
  constructor(options = {}) {
    this.perIp = Math.max(1, options.perIp || 8);
    this.perCode = Math.max(1, options.perCode || 8);
    this.global = Math.max(1, options.global || 40);
    this.windowMs = Math.max(1_000, options.windowMs || 60_000);
    this.clock = options.clock || Date.now;
    this.failures = [];
  }

  _now() {
    return Number(typeof this.clock === 'function' ? this.clock() : this.clock.now());
  }

  _codeKey(code) {
    return crypto.createHash('sha256').update(String(code || '')).digest('hex');
  }

  _prune(now = this._now()) {
    const threshold = now - this.windowMs;
    this.failures = this.failures.filter((entry) => entry.at > threshold);
  }

  check(ip, code) {
    const now = this._now();
    this._prune(now);
    const codeKey = this._codeKey(code);
    const byIp = this.failures.filter((entry) => entry.ip === ip);
    const byCode = this.failures.filter((entry) => entry.codeKey === codeKey);
    const blocked = (
      byIp.length >= this.perIp
      || byCode.length >= this.perCode
      || this.failures.length >= this.global
    );
    const oldest = [...byIp, ...byCode, ...this.failures]
      .reduce((minimum, entry) => Math.min(minimum, entry.at), now);
    return {
      allowed: !blocked,
      retryAfterMs: blocked ? Math.max(1, oldest + this.windowMs - now) : 0,
    };
  }

  recordFailure(ip, code) {
    const now = this._now();
    this._prune(now);
    this.failures.push({ at: now, ip, codeKey: this._codeKey(code) });
  }

  recordSuccess(ip, code) {
    const codeKey = this._codeKey(code);
    this.failures = this.failures.filter((entry) => (
      entry.ip !== ip && entry.codeKey !== codeKey
    ));
  }
}

class PairingService extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.store) throw new TypeError('store is required');
    this.store = options.store;
    this.legacyToken = String(options.legacyToken || '');
    this.clock = options.clock || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.audit = options.audit || null;
    this.onLegacyConsumed = options.onLegacyConsumed || (() => {});
    this.wsTicketTtlMs = options.wsTicketTtlMs || 30_000;
    this.sessionTtlMs = options.sessionTtlMs;
    this.wsTickets = new Map();
  }

  _now() {
    return Number(typeof this.clock === 'function' ? this.clock() : this.clock.now());
  }

  _random(bytes = 24) {
    return Buffer.from(this.randomBytes(bytes)).toString('base64url');
  }

  _hash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
  }

  _audit(event, critical = false) {
    if (!this.audit) return true;
    return this.audit.record(event, { critical });
  }

  _safeDevice(device) {
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      scope: device.scope,
      owner: Boolean(device.owner),
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      expiresAt: device.expiresAt,
      revokedAt: device.revokedAt,
    };
  }

  pair({ code, deviceName, platform = 'unknown' }) {
    const now = this._now();
    let migration = false;
    let enrolled;

    if (!this.store.hasOwner()) {
      if (
        this.store.isBootstrapMigrated()
        || !this.legacyToken
        || !timingSafeTextEqual(code, this.legacyToken)
      ) {
        throw new Error('legacy token invalid, used, or migrated');
      }
      this._audit({
        actorDeviceId: 'local-bootstrap',
        action: 'device.bootstrap-owner',
        resource: 'owner',
        result: 'accepted',
        correlationId: `pair_${now}`,
        risk: 'high',
      }, true);
      enrolled = this.store.enrollDevice({
        device: {
          name: deviceName || 'Owner device',
          platform,
          scope: 'full-control',
          owner: true,
        },
        markBootstrapMigrated: true,
        sessionTtlMs: this.sessionTtlMs,
      });
      migration = true;
    } else {
      const invitation = this.store.inspectInvite(code);
      this._audit({
        actorDeviceId: invitation.createdByDeviceId,
        action: 'device.pair',
        resource: `invite:${invitation.id}`,
        result: 'accepted',
        correlationId: invitation.id,
        risk: 'medium',
      }, true);
      enrolled = this.store.enrollDevice({
        device: {
          name: deviceName || 'Paired device',
          platform,
        },
        inviteCode: code,
        sessionTtlMs: this.sessionTtlMs,
      });
    }

    if (migration) {
      this.legacyToken = '';
      this.onLegacyConsumed();
    }
    return {
      device: this._safeDevice(enrolled.device),
      sessionToken: enrolled.sessionToken,
      sessionExpiresAt: enrolled.sessionExpiresAt,
      migratedLegacyToken: migration,
    };
  }

  authenticateSession(token) {
    return this.store.authenticateSession(token);
  }

  createInvite(principal, { scope, ttlMs = 5 * 60_000 }) {
    if (!principal?.owner) throw new Error('devices.manage required');
    this._audit({
      actorDeviceId: principal.deviceId,
      action: 'device.invite',
      resource: `scope:${scope}`,
      result: 'accepted',
      correlationId: `invite_${this._now()}`,
      risk: 'medium',
    }, true);
    return this.store.createInvite({
      createdByDeviceId: principal.deviceId,
      scope,
      ttlMs,
    });
  }

  listDevices(principal) {
    if (!principal?.owner) throw new Error('devices.manage required');
    return this.store.listDevices().map((device) => this._safeDevice(device));
  }

  renameDevice(principal, deviceId, name) {
    if (!principal || (principal.deviceId !== deviceId && !principal.owner)) {
      throw new Error('device rename forbidden');
    }
    const device = this.store.renameDevice(deviceId, name);
    if (!device) throw new Error('device not found');
    return this._safeDevice(device);
  }

  revokeDevice(principal, deviceId) {
    if (!principal?.owner) throw new Error('devices.manage required');
    const target = this.store.getDevice(deviceId);
    if (!target || target.revokedAt) throw new Error('device not found');
    if (target.owner) {
      const activeOwners = this.store.listDevices().filter((device) => (
        device.owner && !device.revokedAt && device.id !== deviceId
      ));
      if (!activeOwners.length) throw new Error('cannot revoke the last owner device');
    }
    this._audit({
      actorDeviceId: principal.deviceId,
      action: 'device.revoke',
      resource: `device:${deviceId}`,
      result: 'accepted',
      correlationId: `revoke_${this._now()}`,
      risk: 'high',
    }, true);
    this.store.revokeDevice(deviceId);
    this.emit('device-revoked', deviceId);
    return true;
  }

  issueWsTicket(principal, {
    channel,
    termId = null,
    ttlMs = this.wsTicketTtlMs,
  }) {
    if (!principal?.deviceId || !['events', 'terminal'].includes(channel)) {
      throw new Error('invalid websocket ticket request');
    }
    const token = this._random(32);
    const now = this._now();
    this.wsTickets.set(this._hash(token), {
      deviceId: principal.deviceId,
      sessionId: principal.sessionId,
      scope: principal.scope,
      owner: Boolean(principal.owner),
      sessionExpiresAt: principal.expiresAt || null,
      name: principal.name,
      platform: principal.platform,
      channel,
      termId: termId == null ? null : String(termId),
      createdAt: now,
      expiresAt: now + Math.max(1, Number(ttlMs)),
    });
    this._pruneWsTickets(now);
    return { token, expiresAt: now + Math.max(1, Number(ttlMs)) };
  }

  _pruneWsTickets(now = this._now()) {
    for (const [hash, ticket] of this.wsTickets) {
      if (ticket.expiresAt <= now) this.wsTickets.delete(hash);
    }
    while (this.wsTickets.size > 1000) {
      this.wsTickets.delete(this.wsTickets.keys().next().value);
    }
  }

  consumeWsTicket(token, { channel, termId = null }) {
    const hash = this._hash(token);
    const ticket = this.wsTickets.get(hash);
    this.wsTickets.delete(hash);
    if (!ticket || ticket.expiresAt <= this._now()) return null;
    if (
      ticket.channel !== channel
      || ticket.termId !== (termId == null ? null : String(termId))
    ) {
      return null;
    }
    if (!this.store.isSessionActive(ticket.sessionId)) return null;
    const device = this.store.getDevice(ticket.deviceId);
    if (!device || device.revokedAt) return null;
    return {
      sessionId: ticket.sessionId,
      deviceId: ticket.deviceId,
      name: ticket.name,
      platform: ticket.platform,
      scope: ticket.scope,
      owner: ticket.owner,
      expiresAt: ticket.sessionExpiresAt,
    };
  }
}

module.exports = {
  PairRateLimiter,
  PairingService,
  timingSafeTextEqual,
};
