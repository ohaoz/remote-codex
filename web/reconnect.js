'use strict';

(function exposeReconnectSync(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReconnectSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  class ReconnectState {
    constructor() {
      this.status = 'reconnecting';
      this.generation = 0;
      this.streamId = null;
      this.serverStreamId = null;
      this.activeThreadId = null;
      this.lastAppliedSeq = new Map();
      this.pending = null;
      this.bufferedLive = new Map();
      this.nextReplayId = 1;
    }

    snapshot() {
      return {
        status: this.status,
        generation: this.generation,
        streamId: this.streamId,
        serverStreamId: this.serverStreamId,
        activeThreadId: this.activeThreadId,
        pendingThreadId: this.pending?.threadId || null,
      };
    }

    isCurrentGeneration(generation) {
      return generation === this.generation;
    }

    getLastAppliedSeq(threadId) {
      return this.lastAppliedSeq.get(threadId) || 0;
    }

    setActiveThread(threadId) {
      this.activeThreadId = threadId || null;
    }

    beginSocket() {
      this.generation += 1;
      this.status = 'reconnecting';
      this.serverStreamId = null;
      this.pending = null;
      this.bufferedLive.clear();
      return this.generation;
    }

    onSocketClosed(generation) {
      if (!this.isCurrentGeneration(generation)) return this._ignored();
      this.status = 'reconnecting';
      this.serverStreamId = null;
      this.pending = null;
      this.bufferedLive.clear();
      return { accepted: true, events: [], status: this.status };
    }

    onHello(generation, hello, threadId) {
      if (!this.isCurrentGeneration(generation)) return this._ignored();
      this.serverStreamId = hello?.streamId || null;
      this.activeThreadId = threadId || null;

      if (!threadId) {
        if (this.streamId && this.serverStreamId && this.streamId !== this.serverStreamId) {
          this.lastAppliedSeq.clear();
        }
        this.streamId = this.serverStreamId;
        this.status = 'synced';
        this.pending = null;
        this.bufferedLive.clear();
        return { accepted: true, events: [], status: this.status };
      }

      return this.startThreadSync(generation, threadId, this.serverStreamId);
    }

    startThreadSync(generation, threadId, serverStreamId = this.serverStreamId) {
      if (!this.isCurrentGeneration(generation) || !threadId || !serverStreamId) {
        return this._ignored();
      }

      this.serverStreamId = serverStreamId;
      this.status = 'syncing';
      this.bufferedLive.clear();

      const requestedStreamId = this.streamId || serverStreamId;
      const afterSeq = requestedStreamId === this.streamId
        ? this.getLastAppliedSeq(threadId)
        : 0;
      const reqId = `replay-${generation}-${this.nextReplayId++}`;
      const replayRequest = {
        type: 'replay',
        reqId,
        threadId,
        streamId: requestedStreamId,
        afterSeq,
      };
      this.pending = {
        reqId,
        threadId,
        requestedStreamId,
        afterSeq,
        result: null,
      };
      return {
        accepted: true,
        events: [],
        status: this.status,
        replayRequest,
      };
    }

    onStreamChanged(generation, streamId, threadId = this.activeThreadId) {
      if (!this.isCurrentGeneration(generation)) return this._ignored();
      if (!streamId || streamId === this.serverStreamId && this.status === 'syncing') {
        return { accepted: true, events: [], status: this.status };
      }
      this.serverStreamId = streamId;
      if (!threadId) {
        if (this.streamId && this.streamId !== streamId) this.lastAppliedSeq.clear();
        this.streamId = streamId;
        this.status = 'synced';
        return { accepted: true, events: [], status: this.status };
      }
      if (streamId === this.streamId && this.status === 'synced') {
        return { accepted: true, events: [], status: this.status };
      }
      return this.startThreadSync(generation, threadId, streamId);
    }

    onLiveEvent(generation, event) {
      if (!this.isCurrentGeneration(generation)) return this._ignored();

      const threadId = event?.threadId || null;
      const seq = Number(event?.seq);
      if (!threadId || !Number.isSafeInteger(seq) || seq <= 0) {
        return { accepted: true, events: [event], status: this.status };
      }

      if (this.status === 'syncing') {
        if (
          this.pending
          && threadId === this.pending.threadId
          && event.streamId === this.serverStreamId
        ) {
          this._bufferLive(event);
        }
        return { accepted: true, events: [], status: this.status };
      }

      if (this.status !== 'synced' || threadId !== this.activeThreadId) {
        return { accepted: true, events: [], status: this.status };
      }

      if (event.streamId !== this.streamId) {
        const started = this.startThreadSync(generation, threadId, event.streamId);
        if (started.accepted) this._bufferLive(event);
        return started;
      }

      const lastSeq = this.getLastAppliedSeq(threadId);
      if (seq <= lastSeq) {
        return { accepted: true, events: [], status: this.status };
      }
      if (seq === lastSeq + 1) {
        this.lastAppliedSeq.set(threadId, seq);
        return { accepted: true, events: [event], status: this.status };
      }

      const started = this.startThreadSync(generation, threadId, event.streamId);
      if (started.accepted) this._bufferLive(event);
      return started;
    }

    onReplayResult(generation, result) {
      if (
        !this.isCurrentGeneration(generation)
        || !this.pending
        || result?.reqId !== this.pending.reqId
        || result?.threadId !== this.pending.threadId
      ) {
        return this._ignored();
      }

      const normalized = {
        ...result,
        streamId: result.streamId || this.serverStreamId,
        events: Array.isArray(result.events) ? result.events : [],
      };
      if (
        !normalized.resetRequired
        && this.streamId
        && normalized.streamId !== this.streamId
      ) {
        normalized.resetRequired = true;
        normalized.reason = 'stream-changed';
        normalized.firstAvailableSeq = normalized.firstAvailableSeq || 1;
      }
      const firstAvailableSeq = Number(normalized.firstAvailableSeq);
      if (
        !normalized.resetRequired
        && Number.isSafeInteger(firstAvailableSeq)
        && firstAvailableSeq > this.pending.afterSeq + 1
      ) {
        normalized.resetRequired = true;
        normalized.reason = 'sequence-gap';
      }
      this.pending.result = normalized;

      if (normalized.resetRequired) {
        return {
          accepted: true,
          events: [],
          status: this.status,
          resetRequired: true,
          reason: normalized.reason || 'reset-required',
          activeTurnId: normalized.activeTurnId || null,
        };
      }
      return this._finishPending(false);
    }

    completeReset(generation, options = {}) {
      if (
        !this.isCurrentGeneration(generation)
        || !this.pending?.result
        || !this.pending.result.resetRequired
      ) {
        return this._ignored();
      }
      const hasCanonicalActiveTurn = Object.prototype.hasOwnProperty.call(options, 'canonicalActiveTurnId');
      return this._finishPending(
        true,
        hasCanonicalActiveTurn ? options.canonicalActiveTurnId : undefined,
      );
    }

    _bufferLive(event) {
      if (!this.bufferedLive.has(event.seq)) this.bufferedLive.set(event.seq, event);
    }

    _finishPending(canonicalResetDone, canonicalActiveTurnId) {
      const pending = this.pending;
      const result = pending.result;
      const threadId = pending.threadId;
      const nextStreamId = result.streamId || this.serverStreamId;
      const reset = canonicalResetDone || !this.streamId || nextStreamId !== this.streamId;
      const replayEvents = result.events
        .concat([...this.bufferedLive.values()])
        .filter((event) => (
          event
          && event.threadId === threadId
          && event.streamId === nextStreamId
          && Number.isSafeInteger(Number(event.seq))
          && Number(event.seq) > 0
        ))
        .sort((a, b) => Number(a.seq) - Number(b.seq));
      const uniqueEvents = [];
      const seen = new Set();
      for (const event of replayEvents) {
        const seq = Number(event.seq);
        if (seen.has(seq)) continue;
        seen.add(seq);
        uniqueEvents.push(event);
      }

      let cursor;
      let events;
      if (reset) {
        const firstAvailableSeq = Number(result.firstAvailableSeq);
        cursor = Number.isSafeInteger(firstAvailableSeq) && firstAvailableSeq > 0
          ? firstAvailableSeq - 1
          : 0;
        events = uniqueEvents.filter((event) => Number(event.seq) > cursor);
        if (events.length) cursor = Number(events[events.length - 1].seq);
        else cursor = Math.max(cursor, Number(result.toSeq) || 0);
      } else {
        cursor = this.getLastAppliedSeq(threadId);
        events = [];
        for (const event of uniqueEvents) {
          const seq = Number(event.seq);
          if (seq <= cursor) continue;
          if (seq !== cursor + 1) {
            result.resetRequired = true;
            result.reason = 'sequence-gap';
            result.firstAvailableSeq = seq;
            return {
              accepted: true,
              events: [],
              status: this.status,
              resetRequired: true,
              reason: result.reason,
              activeTurnId: result.activeTurnId || null,
            };
          }
          events.push(event);
          cursor = seq;
        }
        if ((Number(result.toSeq) || 0) > cursor) {
          result.resetRequired = true;
          result.reason = 'sequence-gap';
          result.firstAvailableSeq = cursor + 1;
          return {
            accepted: true,
            events: [],
            status: this.status,
            resetRequired: true,
            reason: result.reason,
            activeTurnId: result.activeTurnId || null,
          };
        }
      }

      if (this.streamId !== nextStreamId) this.lastAppliedSeq.clear();
      this.streamId = nextStreamId;
      this.serverStreamId = nextStreamId;
      this.lastAppliedSeq.set(threadId, cursor);
      let activeTurnId = canonicalResetDone && canonicalActiveTurnId !== undefined
        ? canonicalActiveTurnId
        : (result.activeTurnId || null);
      const replayWatermark = Number(result.toSeq) || 0;
      for (const event of uniqueEvents) {
        if (Number(event.seq) <= replayWatermark) continue;
        if (event.method === 'turn/started') {
          activeTurnId = event.params?.turn?.id || event.params?.turnId || null;
        } else if (event.method === 'turn/completed') {
          const completedTurnId = event.params?.turn?.id || event.params?.turnId || null;
          if (!completedTurnId || !activeTurnId || completedTurnId === activeTurnId) {
            activeTurnId = null;
          }
        }
      }
      this.pending = null;
      this.bufferedLive.clear();
      this.status = 'synced';
      return {
        accepted: true,
        events,
        status: this.status,
        resetRequired: false,
        reason: null,
        activeTurnId,
        threadId,
        streamId: nextStreamId,
        toSeq: cursor,
      };
    }

    _ignored() {
      return { accepted: false, events: [], status: this.status };
    }
  }

  function create() {
    return new ReconnectState();
  }

  return { create, ReconnectState };
});
