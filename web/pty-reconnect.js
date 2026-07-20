'use strict';

(function exposePtyReconnect(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PtyReconnect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  class PtyReconnectState {
    constructor(options = {}) {
      this.baseDelayMs = Math.max(1, options.baseDelayMs || 500);
      this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs || 10000);
      this.generation = 0;
      this.terminalId = null;
      this.terminalGeneration = null;
      this.status = 'idle';
      this.intent = null;
      this.blockedReason = null;
      this.attempt = 0;
      this.syncStarted = false;
    }

    snapshot() {
      return {
        generation: this.generation,
        terminalId: this.terminalId,
        terminalGeneration: this.terminalGeneration,
        status: this.status,
        intent: this.intent,
        blockedReason: this.blockedReason,
        attempt: this.attempt,
      };
    }

    isCurrentGeneration(generation) {
      return generation === this.generation;
    }

    begin(terminalId, options = {}) {
      this.generation += 1;
      this.terminalId = String(terminalId);
      this.terminalGeneration = null;
      this.status = options.retry ? 'reconnecting' : 'connecting';
      this.intent = null;
      this.blockedReason = null;
      this.syncStarted = false;
      if (!options.retry) this.attempt = 0;
      return this.generation;
    }

    onSocketOpen(generation) {
      if (!this.isCurrentGeneration(generation)) return this._ignored();
      this.status = 'syncing';
      return { accepted: true, status: this.status };
    }

    onSyncBegin(generation, metadata = {}) {
      if (!this.isCurrentGeneration(generation)) return this._ignored();
      if (
        metadata.terminalId !== undefined
        && String(metadata.terminalId) !== this.terminalId
      ) {
        return this._ignored();
      }
      if (this.syncStarted) {
        return { accepted: true, reset: false, status: this.status };
      }
      this.syncStarted = true;
      this.terminalGeneration = metadata.generation ?? null;
      this.status = 'syncing';
      return {
        accepted: true,
        reset: true,
        status: this.status,
        metadata,
      };
    }

    onData(generation, data) {
      if (!this.isCurrentGeneration(generation)) return this._ignored();
      return { accepted: true, status: this.status, write: data };
    }

    onSyncEnd(generation, metadata = {}) {
      if (!this.isCurrentGeneration(generation) || !this.syncStarted) return this._ignored();
      if (
        metadata.terminalId !== undefined
        && String(metadata.terminalId) !== this.terminalId
      ) {
        return this._ignored();
      }
      if (
        metadata.generation !== undefined
        && this.terminalGeneration !== null
        && metadata.generation !== this.terminalGeneration
      ) {
        return this._ignored();
      }
      this.status = 'live';
      this.blockedReason = null;
      this.attempt = 0;
      return { accepted: true, status: this.status, metadata };
    }

    stop(intent = 'back') {
      this.intent = intent;
      this.blockedReason = intent;
      this.status = 'blocked';
      this.syncStarted = false;
      return { accepted: true, reconnect: false, status: this.status, reason: intent };
    }

    onSocketClose(generation, close = {}) {
      if (!this.isCurrentGeneration(generation)) {
        return { ...this._ignored(), reconnect: false };
      }
      const code = Number(close.code) || 0;
      const reason = String(close.reason || '');
      const blockedReason = this.intent
        || (code === 4404 ? 'not-found' : null)
        || (code === 4000 ? 'exit' : null)
        || (code === 1000 ? 'closed' : null);

      this.syncStarted = false;
      if (blockedReason) {
        this.blockedReason = blockedReason;
        this.status = 'blocked';
        return {
          accepted: true,
          reconnect: false,
          status: this.status,
          reason: blockedReason,
          code,
        };
      }

      const delayMs = Math.min(this.baseDelayMs * (2 ** this.attempt), this.maxDelayMs);
      this.attempt += 1;
      this.blockedReason = null;
      this.status = 'reconnecting';
      return {
        accepted: true,
        reconnect: true,
        delayMs,
        status: this.status,
        reason: reason || 'connection-lost',
        code,
      };
    }

    _ignored() {
      return { accepted: false, status: this.status };
    }
  }

  function create(options) {
    return new PtyReconnectState(options);
  }

  return { create, PtyReconnectState };
});
