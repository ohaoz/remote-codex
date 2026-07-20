'use strict';
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { JsonRpcProcess } = require('./jsonrpc');

const APP_VERSION = require('../package.json').version;

/** Locate the native codex executable (fast + reliable for PTY/app-server). */
function findCodexExe() {
  const candidates = [];
  const npmRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex');
  if (process.platform === 'win32' && process.env.APPDATA) {
    const vendorRoot = path.join(npmRoot, 'node_modules', '@openai', 'codex-win32-x64', 'vendor');
    try {
      for (const triple of fs.readdirSync(vendorRoot)) {
        candidates.push(path.join(vendorRoot, triple, 'bin', 'codex.exe'));
      }
    } catch {}
  }
  try {
    // Generic npm layout (mac/linux)
    const vendorRoot = path.join(npmRoot, 'vendor');
    for (const triple of fs.readdirSync(vendorRoot)) {
      candidates.push(path.join(vendorRoot, triple, 'codex'));
    }
  } catch {}
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

/** Build the spawn spec for `codex <args>`. */
function codexSpawnSpec(args) {
  const exe = findCodexExe();
  if (exe) return { command: exe, args };
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'codex', ...args] };
  }
  return { command: 'codex', args };
}

// Methods web clients may proxy straight through to app-server.
const RPC_ALLOWLIST = new Set([
  'thread/start', 'thread/resume', 'thread/list', 'thread/read', 'thread/fork',
  'thread/archive', 'thread/unarchive', 'thread/delete', 'thread/name/set',
  'thread/compact/start', 'thread/rollback', 'thread/turns/list', 'thread/items/list',
  'thread/backgroundTerminals/list', 'thread/backgroundTerminals/terminate', 'thread/backgroundTerminals/clean',
  'turn/start', 'turn/steer', 'turn/interrupt',
  'model/list', 'collaborationMode/list', 'permissionProfile/list',
  'account/read', 'account/rateLimits/read', 'account/usage/read', 'getAuthStatus',
  'account/login/start', 'account/login/cancel', 'account/logout',
  'fs/readDirectory', 'fuzzyFileSearch', 'getConversationSummary', 'gitDiffToRemote',
  'review/start', 'skills/list', 'mcpServerStatus/list', 'experimentalFeature/list',
  'config/read',
]);

// Server->client requests that require a human decision.
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
  'applyPatchApproval',
  'execCommandApproval',
]);

const MAX_CACHED_EVENTS_PER_THREAD = 3000;
const MAX_TRACKED_THREADS = 30;
const MAX_EVICTED_THREAD_MARKERS = 1000;
const MAX_APPROVAL_TOMBSTONES = 500;
const APPROVAL_TOMBSTONE_TTL_MS = 5 * 60 * 1000;
const MAX_INDEXED_ITEMS = 5000;

function createStreamId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

/**
 * In-memory event log for one app-server lifecycle.
 *
 * Sequence numbers are monotonic per thread within a stream. A reset discards
 * every event from the previous lifecycle, while retaining no replayable
 * payload that could accidentally leak into the new stream.
 */
class ThreadEventLog {
  constructor(options = {}) {
    this.maxEventsPerThread = Math.max(1, options.maxEventsPerThread || MAX_CACHED_EVENTS_PER_THREAD);
    this.maxThreads = Math.max(1, options.maxThreads || MAX_TRACKED_THREADS);
    this.maxEvictedThreadMarkers = Math.max(
      this.maxThreads,
      options.maxEvictedThreadMarkers || MAX_EVICTED_THREAD_MARKERS,
    );
    this.reset(options.streamId || createStreamId());
  }

  reset(streamId = createStreamId()) {
    this.streamId = streamId;
    this.threads = new Map();
    this.evictedThreads = new Map();
  }

  _threadIdOf(params) {
    if (!params) return null;
    return params.threadId || (params.thread && params.thread.id) || null;
  }

  _rememberEviction(threadId, state) {
    this.evictedThreads.delete(threadId);
    this.evictedThreads.set(threadId, {
      lastSeq: state.lastSeq,
      activeTurnId: state.activeTurnId,
    });
    while (this.evictedThreads.size > this.maxEvictedThreadMarkers) {
      this.evictedThreads.delete(this.evictedThreads.keys().next().value);
    }
  }

  _touch(threadId, state) {
    this.threads.delete(threadId);
    this.threads.set(threadId, state);
  }

  _evictOverflow() {
    while (this.threads.size > this.maxThreads) {
      const threadId = this.threads.keys().next().value;
      const state = this.threads.get(threadId);
      this.threads.delete(threadId);
      this._rememberEviction(threadId, state);
    }
  }

  append(method, params) {
    const threadId = this._threadIdOf(params);
    if (!threadId) {
      return {
        streamId: this.streamId,
        threadId: null,
        seq: null,
        method,
        params,
      };
    }

    let state = this.threads.get(threadId);
    if (!state) {
      const evicted = this.evictedThreads.get(threadId);
      state = {
        events: [],
        lastSeq: evicted ? evicted.lastSeq : 0,
        firstAvailableSeq: evicted ? evicted.lastSeq + 1 : 1,
        activeTurnId: evicted ? evicted.activeTurnId : null,
        truncated: !!evicted,
        evicted: !!evicted,
      };
      this.evictedThreads.delete(threadId);
    }

    const record = {
      streamId: this.streamId,
      threadId,
      seq: state.lastSeq + 1,
      method,
      params,
    };
    state.lastSeq = record.seq;
    state.events.push(record);

    if (method === 'turn/started') {
      state.activeTurnId = params?.turn?.id || params?.turnId || null;
    } else if (method === 'turn/completed') {
      const completedTurnId = params?.turn?.id || params?.turnId || null;
      if (!completedTurnId || !state.activeTurnId || completedTurnId === state.activeTurnId) {
        state.activeTurnId = null;
      }
    }

    if (state.events.length > this.maxEventsPerThread) {
      state.events.splice(0, state.events.length - this.maxEventsPerThread);
      state.truncated = true;
    }
    state.firstAvailableSeq = state.events.length ? state.events[0].seq : state.lastSeq + 1;

    this._touch(threadId, state);
    this._evictOverflow();
    return record;
  }

  replaySince(threadId, requestedStreamId, afterSeq = 0) {
    const requestedSeq = Number.isSafeInteger(Number(afterSeq)) && Number(afterSeq) >= 0
      ? Number(afterSeq)
      : 0;
    const result = {
      streamId: this.streamId,
      threadId,
      requestedStreamId: requestedStreamId || this.streamId,
      afterSeq: requestedSeq,
      resetRequired: false,
      reason: null,
      events: [],
      firstAvailableSeq: 1,
      lastSeq: 0,
      toSeq: 0,
      truncated: false,
      activeTurnId: null,
    };

    if (requestedStreamId && requestedStreamId !== this.streamId) {
      result.resetRequired = true;
      result.reason = 'stream-changed';
      return result;
    }

    const state = this.threads.get(threadId);
    if (!state) {
      const evicted = this.evictedThreads.get(threadId);
      if (evicted) {
        result.resetRequired = true;
        result.reason = 'cache-evicted';
        result.truncated = true;
        result.firstAvailableSeq = evicted.lastSeq + 1;
        result.lastSeq = evicted.lastSeq;
        result.toSeq = evicted.lastSeq;
        result.activeTurnId = evicted.activeTurnId;
      } else if (requestedSeq > 0) {
        result.resetRequired = true;
        result.reason = 'cache-missing';
        result.truncated = true;
      }
      return result;
    }

    const firstAvailableSeq = state.firstAvailableSeq;
    Object.assign(result, {
      firstAvailableSeq,
      lastSeq: state.lastSeq,
      toSeq: state.lastSeq,
      truncated: state.truncated,
      activeTurnId: state.activeTurnId,
    });

    if (requestedSeq > state.lastSeq) {
      result.resetRequired = true;
      result.reason = 'cursor-ahead';
    } else if (requestedSeq < firstAvailableSeq - 1) {
      result.resetRequired = true;
      result.reason = state.evicted ? 'cache-evicted' : 'cache-truncated';
    }
    result.events = state.events.filter((event) => event.seq > requestedSeq);
    return result;
  }
}

/**
 * Owns the `codex app-server` child process.
 * - proxies whitelisted JSON-RPC calls
 * - fans out notifications to web sockets
 * - parks approval requests until a human answers from a phone
 * - caches active-turn events per thread so reconnecting clients can replay
 */
class CodexBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.rpc = null;
    this.state = 'stopped'; // stopped | starting | ready | error
    this.initInfo = null;
    this.pendingApprovals = new Map(); // rpcId -> { id, method, params, receivedAt }
    this.resolvedApprovals = new Map(); // rpcId -> short-lived resolution tombstone
    this.threadContexts = new Map(); // threadId -> verified cwd/source fields
    this.itemContexts = new Map(); // threadId:itemId -> verified command/file fields
    this._now = options.now || Date.now;
    this.maxApprovalTombstones = Math.max(1, options.maxApprovalTombstones || MAX_APPROVAL_TOMBSTONES);
    this.approvalTombstoneTtlMs = Math.max(1, options.approvalTombstoneTtlMs || APPROVAL_TOMBSTONE_TTL_MS);
    this.maxIndexedItems = Math.max(1, options.maxIndexedItems || MAX_INDEXED_ITEMS);
    this._createStreamId = options.createStreamId || createStreamId;
    this.eventLog = new ThreadEventLog({
      streamId: this._createStreamId(),
      maxEventsPerThread: options.maxCachedEventsPerThread,
      maxThreads: options.maxTrackedThreads,
      maxEvictedThreadMarkers: options.maxEvictedThreadMarkers,
    });
    this.threadEvents = this.eventLog.threads;
    this._hasStartedLifecycle = false;
    this.restartDelay = 1000;
    this.stderrTail = [];
  }

  async start() {
    if (this.state === 'starting' || this.state === 'ready') return;
    if (this._hasStartedLifecycle) this._beginEventStream();
    else this._hasStartedLifecycle = true;
    this.state = 'starting';
    this.emit('status', this.state);
    const spec = codexSpawnSpec(['app-server']);
    this.rpc = new JsonRpcProcess(spec.command, spec.args, { env: { ...process.env, RUST_LOG: process.env.RUST_LOG || 'error' } });
    this.rpc.on('notification', (n) => this._onNotification(n));
    this.rpc.on('request', (r) => this._onServerRequest(r));
    this.rpc.on('stderr', (s) => {
      this.stderrTail.push(s);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });
    this.rpc.on('exit', ({ code }) => {
      const wasReady = this.state === 'ready';
      this.state = 'stopped';
      this.pendingApprovals.clear();
      this.emit('status', this.state, { code });
      // Auto-restart with backoff
      const delay = wasReady ? 1000 : Math.min((this.restartDelay *= 2), 30000);
      setTimeout(() => { this.start().catch(() => {}); }, delay);
    });
    this.rpc.start();
    try {
      this.initInfo = await this.rpc.request('initialize', {
        clientInfo: { name: 'codex-remote', title: 'Codex Remote', version: APP_VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, 30000);
      this.rpc.notify('initialized');
      this.state = 'ready';
      this.restartDelay = 1000;
      this.emit('status', this.state);
    } catch (e) {
      this.state = 'error';
      this.emit('status', this.state, { error: e.message });
      try { this.rpc.kill(); } catch {}
    }
  }

  isAllowed(method) {
    return RPC_ALLOWLIST.has(method);
  }

  async call(method, params) {
    if (this.state !== 'ready') throw new Error('codex app-server 未就绪');
    const result = await this.rpc.request(method, params);
    this._indexRpcResult(method, params, result);
    return result;
  }

  _threadIdOf(params) {
    if (!params) return null;
    return params.threadId || params.conversationId || (params.thread && params.thread.id) || null;
  }

  get streamId() {
    return this.eventLog.streamId;
  }

  _beginEventStream() {
    this.eventLog.reset(this._createStreamId());
    this.threadEvents = this.eventLog.threads;
    this.pendingApprovals.clear();
    this.resolvedApprovals.clear();
    this.threadContexts.clear();
    this.itemContexts.clear();
    return this.streamId;
  }

  _onNotification({ method, params }) {
    this._indexNotification(method, params);
    const event = this.eventLog.append(method, params);
    if (method === 'serverRequest/resolved' && params && params.requestId !== undefined) {
      const rpcId = String(params.requestId);
      this.pendingApprovals.delete(rpcId);
      const resolution = this._recordApprovalTombstone(rpcId, null, 'server-notification');
      this.emit('approval-resolved', resolution);
    }
    this.emit('event', event);
  }

  _onServerRequest({ id, method, params }) {
    if (method === 'currentTime/read') {
      this.rpc.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    if (APPROVAL_METHODS.has(method)) {
      const key = String(id);
      const entry = {
        id,
        method,
        params,
        receivedAt: this._now(),
        context: this._buildApprovalContext(method, params),
      };
      this.pendingApprovals.set(key, entry);
      this.emit('approval', entry);
      return;
    }
    // Anything else we cannot satisfy (attestation, token refresh, dynamic tools).
    this.rpc.respondError(id, -32601, `codex-remote does not handle ${method}`);
  }

  /** Human decision arriving from a web client. */
  resolveApproval(rpcId, result, submissionId) {
    const key = String(rpcId);
    this._pruneApprovalTombstones();
    const entry = this.pendingApprovals.get(key);
    if (!entry) {
      const tombstone = this.resolvedApprovals.get(key);
      if (tombstone) {
        return {
          status: 'already-resolved',
          retryable: false,
          rpcId: key,
          submissionId,
          resolvedBySubmissionId: tombstone.submissionId,
          resolvedAt: tombstone.resolvedAt,
        };
      }
      return {
        status: 'not-found',
        retryable: false,
        rpcId: key,
        submissionId,
        resolvedBySubmissionId: null,
      };
    }
    try {
      this.rpc.respond(entry.id, result);
    } catch (e) {
      return {
        status: 'failed',
        retryable: true,
        rpcId: key,
        submissionId,
        resolvedBySubmissionId: null,
        error: e.message,
      };
    }
    this.pendingApprovals.delete(key);
    const tombstone = this._recordApprovalTombstone(key, submissionId, 'client-submission');
    return {
      status: 'accepted',
      retryable: false,
      rpcId: key,
      submissionId,
      resolvedBySubmissionId: tombstone.submissionId,
      resolvedAt: tombstone.resolvedAt,
    };
  }

  publishApprovalResolution(resolution) {
    this.emit('approval-resolved', resolution);
  }

  listPendingApprovals() {
    return [...this.pendingApprovals.values()].map((e) => ({
      rpcId: String(e.id),
      method: e.method,
      params: e.params,
      receivedAt: e.receivedAt,
      context: this._buildApprovalContext(e.method, e.params),
    }));
  }

  _indexRpcResult(method, params, result) {
    if (result?.thread) this._indexThread(result.thread);
    if (method === 'thread/read' && result?.thread) this._indexThreadItems(result.thread);
    if (params?.threadId && typeof result?.cwd === 'string') {
      const current = this.threadContexts.get(String(params.threadId)) || {};
      this._setThreadContext(String(params.threadId), { ...current, cwd: result.cwd });
    }
  }

  _indexNotification(method, params) {
    if (method === 'thread/started' && params?.thread) {
      this._indexThread(params.thread);
      return;
    }
    if (method === 'thread/settings/updated') {
      const threadId = this._threadIdOf(params);
      const cwd = params?.threadSettings?.cwd ?? params?.cwd;
      if (threadId && typeof cwd === 'string') {
        const current = this.threadContexts.get(String(threadId)) || {};
        this._setThreadContext(String(threadId), { ...current, cwd });
      }
      return;
    }
    if ((method === 'item/started' || method === 'item/completed') && params?.item) {
      this._indexItem(params.threadId, params.turnId, params.item);
    }
  }

  _indexThread(thread) {
    if (!thread?.id) return;
    const context = this.threadContexts.get(String(thread.id)) || {};
    this._setThreadContext(String(thread.id), {
      ...context,
      cwd: typeof thread.cwd === 'string' ? thread.cwd : context.cwd,
      source: thread.source !== undefined ? thread.source : context.source,
      threadSource: thread.threadSource !== undefined ? thread.threadSource : context.threadSource,
    });
    this._indexThreadItems(thread);
  }

  _indexThreadItems(thread) {
    if (!thread?.id) return;
    for (const turn of thread.turns || []) {
      for (const item of turn.items || []) {
        this._indexItem(thread.id, turn.id, item);
      }
    }
  }

  _setThreadContext(threadId, context) {
    this.threadContexts.delete(threadId);
    this.threadContexts.set(threadId, context);
    while (this.threadContexts.size > MAX_TRACKED_THREADS * 4) {
      this.threadContexts.delete(this.threadContexts.keys().next().value);
    }
  }

  _itemKey(threadId, itemId) {
    return `${threadId || ''}:${itemId || ''}`;
  }

  _indexItem(threadId, turnId, item) {
    if (!item?.id) return;
    const files = item.type === 'fileChange'
      ? [...new Set((item.changes || []).map((change) => change?.path).filter((value) => typeof value === 'string'))]
      : null;
    const context = {
      threadId: threadId ? String(threadId) : null,
      turnId: turnId ? String(turnId) : null,
      itemId: String(item.id),
      cwd: typeof item.cwd === 'string' ? item.cwd : null,
      files,
      commandSource: item.type === 'commandExecution' && item.source !== undefined
        ? item.source
        : null,
    };
    const key = this._itemKey(context.threadId, context.itemId);
    this.itemContexts.delete(key);
    this.itemContexts.set(key, context);
    while (this.itemContexts.size > this.maxIndexedItems) {
      this.itemContexts.delete(this.itemContexts.keys().next().value);
    }
  }

  _buildApprovalContext(method, params = {}) {
    const threadId = this._threadIdOf(params);
    const turnId = params.turnId ?? null;
    const itemId = params.itemId ?? params.callId ?? null;
    const thread = threadId ? this.threadContexts.get(String(threadId)) : null;
    const item = itemId
      ? this.itemContexts.get(this._itemKey(threadId ? String(threadId) : null, String(itemId)))
      : null;
    const legacyFiles = params.fileChanges && typeof params.fileChanges === 'object'
      ? Object.keys(params.fileChanges)
      : null;

    let cwd = null;
    let cwdSource = null;
    if (typeof params.cwd === 'string') {
      cwd = params.cwd;
      cwdSource = 'params.cwd';
    } else if (typeof item?.cwd === 'string') {
      cwd = item.cwd;
      cwdSource = 'item.cwd';
    } else if (typeof thread?.cwd === 'string') {
      cwd = thread.cwd;
      cwdSource = 'thread.cwd';
    }

    let files = null;
    let filesSource = null;
    if (legacyFiles) {
      files = legacyFiles;
      filesSource = 'params.fileChanges';
    } else if (Array.isArray(item?.files)) {
      files = item.files.slice();
      filesSource = 'item.changes[].path';
    }

    return {
      threadId: threadId ? String(threadId) : null,
      turnId: turnId !== null && turnId !== undefined ? String(turnId) : null,
      itemId: itemId !== null && itemId !== undefined ? String(itemId) : null,
      cwd,
      files,
      threadSource: thread?.source ?? null,
      commandSource: item?.commandSource ?? null,
      fieldSources: {
        threadId: params.threadId !== undefined
          ? 'params.threadId'
          : params.conversationId !== undefined ? 'params.conversationId' : null,
        turnId: params.turnId !== undefined ? 'params.turnId' : null,
        itemId: params.itemId !== undefined
          ? 'params.itemId'
          : params.callId !== undefined ? 'params.callId' : null,
        cwd: cwdSource,
        files: filesSource,
        threadSource: thread?.source !== undefined ? 'thread.source' : null,
        commandSource: item?.commandSource !== null && item?.commandSource !== undefined
          ? 'item.source'
          : null,
      },
    };
  }

  _recordApprovalTombstone(rpcId, submissionId, source) {
    this._pruneApprovalTombstones();
    const key = String(rpcId);
    const previous = this.resolvedApprovals.get(key);
    const tombstone = {
      rpcId: key,
      submissionId: submissionId || previous?.submissionId || null,
      source,
      resolvedAt: this._now(),
    };
    this.resolvedApprovals.delete(key);
    this.resolvedApprovals.set(key, tombstone);
    while (this.resolvedApprovals.size > this.maxApprovalTombstones) {
      this.resolvedApprovals.delete(this.resolvedApprovals.keys().next().value);
    }
    return tombstone;
  }

  _pruneApprovalTombstones() {
    const cutoff = this._now() - this.approvalTombstoneTtlMs;
    for (const [rpcId, tombstone] of this.resolvedApprovals) {
      if (tombstone.resolvedAt > cutoff) continue;
      this.resolvedApprovals.delete(rpcId);
    }
  }

  cachedEvents(threadId) {
    const state = this.threadEvents.get(threadId);
    return state ? state.events : [];
  }

  replaySince(threadId, requestedStreamId, afterSeq) {
    return this.eventLog.replaySince(threadId, requestedStreamId, afterSeq);
  }

  info() {
    return {
      state: this.state,
      streamId: this.streamId,
      init: this.initInfo,
      codexExe: findCodexExe(),
      stderrTail: this.stderrTail.slice(-10).join(''),
    };
  }
}

module.exports = { CodexBridge, ThreadEventLog, codexSpawnSpec, findCodexExe };
