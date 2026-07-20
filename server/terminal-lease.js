'use strict';

const crypto = require('node:crypto');

class TerminalLeaseManager {
  constructor(options = {}) {
    this.clock = options.clock || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.leaseTtlMs = Math.max(1, options.leaseTtlMs || 30_000);
    this.reconnectGraceMs = Math.max(1, options.reconnectGraceMs || 10_000);
    this.leases = new Map();
  }

  _now() {
    return Number(typeof this.clock === 'function' ? this.clock() : this.clock.now());
  }

  _newLeaseId() {
    return Buffer.from(this.randomBytes(24)).toString('base64url');
  }

  _current(terminalId) {
    const key = String(terminalId);
    const lease = this.leases.get(key);
    if (lease && lease.expiresAt <= this._now()) {
      this.leases.delete(key);
      return null;
    }
    return lease || null;
  }

  acquire({
    terminalId,
    deviceId,
    connectionId,
    leaseId = null,
    force = false,
    canForce = false,
  }) {
    const key = String(terminalId);
    const now = this._now();
    const current = this._current(key);
    if (current) {
      const sameLease = (
        current.deviceId === deviceId
        && current.leaseId === leaseId
      );
      const sameConnection = (
        current.deviceId === deviceId
        && current.connectionId === connectionId
      );
      if (sameLease || sameConnection) {
        current.connectionId = connectionId;
        current.expiresAt = now + this.leaseTtlMs;
        current.graceUntil = null;
        return this._result(current, { granted: true, resumed: sameLease });
      }
      if (!(force && canForce)) {
        return this._result(current, { granted: false });
      }
    }

    const lease = {
      terminalId: key,
      leaseId: this._newLeaseId(),
      deviceId,
      connectionId,
      acquiredAt: now,
      expiresAt: now + this.leaseTtlMs,
      graceUntil: null,
    };
    this.leases.set(key, lease);
    return this._result(lease, {
      granted: true,
      takeover: Boolean(current),
      previousWriterDeviceId: current?.deviceId || null,
    });
  }

  _result(lease, extra = {}) {
    return {
      terminalId: lease.terminalId,
      leaseId: lease.leaseId,
      writerDeviceId: lease.deviceId,
      expiresAt: lease.expiresAt,
      ...extra,
    };
  }

  validate({
    terminalId,
    leaseId,
    deviceId,
    connectionId = null,
    allowDeviceOnly = false,
  }) {
    const lease = this._current(terminalId);
    if (
      !lease
      || lease.leaseId !== leaseId
      || lease.deviceId !== deviceId
    ) {
      return false;
    }
    if (!allowDeviceOnly && lease.connectionId !== connectionId) return false;
    lease.expiresAt = this._now() + this.leaseTtlMs;
    return true;
  }

  disconnect(connectionId) {
    const now = this._now();
    for (const lease of this.leases.values()) {
      if (lease.connectionId !== connectionId) continue;
      lease.connectionId = null;
      lease.graceUntil = now + this.reconnectGraceMs;
      lease.expiresAt = lease.graceUntil;
    }
  }

  release({ terminalId, leaseId, deviceId }) {
    const key = String(terminalId);
    const lease = this._current(key);
    if (!lease || lease.leaseId !== leaseId || lease.deviceId !== deviceId) return false;
    this.leases.delete(key);
    return true;
  }

  removeTerminal(terminalId) {
    return this.leases.delete(String(terminalId));
  }

  snapshot(terminalId) {
    const lease = this._current(terminalId);
    return lease ? this._result(lease) : null;
  }
}

module.exports = {
  TerminalLeaseManager,
};
