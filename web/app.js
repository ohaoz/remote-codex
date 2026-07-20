/* codex://remote — mobile cockpit for the local Codex CLI */
'use strict';

/* ============================== helpers ============================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, ms);
}

function relTime(unixSec) {
  if (!unixSec) return '';
  const d = Date.now() / 1000 - unixSec;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

function md(text) {
  try {
    return DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }));
  } catch {
    return esc(text);
  }
}

function baseName(p) {
  if (!p) return '';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/* ============================== state ============================== */
const store = {
  get token() { return localStorage.getItem('cr.token') || ''; },
  set token(v) { v ? localStorage.setItem('cr.token', v) : localStorage.removeItem('cr.token'); },
  get prefs() { try { return JSON.parse(localStorage.getItem('cr.prefs') || '{}'); } catch { return {}; } },
  set prefs(v) { localStorage.setItem('cr.prefs', JSON.stringify(v)); },
};

const state = {
  ws: null,
  wsAlive: false,
  reqId: 1,
  pendingRpc: new Map(),
  pendingReplayReset: null,
  bridge: 'stopped',
  serverInfo: null,

  models: [],
  modelsLoading: false,
  sessionRefreshError: '',
  prefs: Object.assign({ model: '', effort: '', approval: 'on-request', sandbox: 'workspace-write', cwd: '' }, store.prefs),

  thread: null,          // current thread object
  threadSettings: null,  // model/effort etc from start/resume response
  activeTurnId: null,
  threadSwitching: false,
  items: new Map(),      // itemId -> renderer state
  approvals: new Map(),  // rpcId -> approval entry
  lastDiff: '',
  tokenUsage: null,

  term: {
    list: [],
    current: null,
    ws: null,
    xterm: null,
    fit: null,
    ctrlLatch: false,
    reconnectTimer: null,
    baseTitle: '',
  },
  page: 'chat',
};

const eventSync = ReconnectSync.create();
const approvalFlow = ApprovalState.create();
const ptySync = PtyReconnect.create({ baseDelayMs: 500, maxDelayMs: 10000 });

function savePrefs() { store.prefs = state.prefs; }

/* ============================== transport ============================== */
function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}?token=${encodeURIComponent(store.token)}`;
}

function connectEvents() {
  const previousGeneration = eventSync.snapshot().generation;
  if (state.ws) {
    try { state.ws.close(); } catch {}
    approvalFlow.connectionLost();
    renderAllApprovalStates();
  }
  state.wsAlive = false;
  rejectPendingRpcForGeneration(previousGeneration, new Error('连接已替换'));
  rejectTermCreateWaitersForGeneration(previousGeneration);
  state.pendingReplayReset = null;
  const generation = eventSync.beginSocket();
  renderLinkState();
  const ws = new WebSocket(wsUrl('/ws/events'));
  state.ws = ws;
  ws.onopen = () => {
    if (!eventSync.isCurrentGeneration(generation) || state.ws !== ws) return;
    state.wsAlive = true;
    connectEvents._retry = 800;
    renderLinkState();
  };
  ws.onclose = () => {
    if (!eventSync.isCurrentGeneration(generation) || state.ws !== ws) return;
    state.wsAlive = false;
    state.ws = null;
    state.pendingReplayReset = null;
    eventSync.onSocketClosed(generation);
    approvalFlow.connectionLost();
    renderAllApprovalStates();
    rejectPendingRpcForGeneration(generation, new Error('连接已断开'));
    rejectTermCreateWaitersForGeneration(generation);
    renderLinkState();
    const delay = Math.min((connectEvents._retry = (connectEvents._retry || 800) * 1.6), 12000);
    setTimeout(() => {
      if (store.token && eventSync.isCurrentGeneration(generation)) connectEvents();
    }, delay);
  };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    if (!eventSync.isCurrentGeneration(generation) || state.ws !== ws) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleGateway(msg, generation);
  };
}

function rpc(method, params, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const generation = eventSync.snapshot().generation;
    const ws = state.ws;
    if (!state.wsAlive || !ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('连接已断开'));
    }
    const reqId = state.reqId++;
    const timer = setTimeout(() => {
      state.pendingRpc.delete(reqId);
      reject(new Error(`请求超时: ${method}`));
    }, timeoutMs);
    state.pendingRpc.set(reqId, { resolve, reject, timer, generation, method });
    ws.send(JSON.stringify({ type: 'rpc', reqId, method, params }));
  });
}

function rejectPendingRpcForGeneration(generation, error) {
  for (const [reqId, pending] of state.pendingRpc) {
    if (pending.generation !== generation) continue;
    state.pendingRpc.delete(reqId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

function wsSend(obj) {
  return wsSendForGeneration(eventSync.snapshot().generation, obj);
}

function wsSendForGeneration(generation, obj) {
  const ws = state.ws;
  if (
    !state.wsAlive
    || !eventSync.isCurrentGeneration(generation)
    || !ws
    || ws.readyState !== WebSocket.OPEN
  ) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function applyEventSyncResult(result, generation) {
  if (!result?.accepted || !eventSync.isCurrentGeneration(generation)) return;
  if (result.replayRequest) wsSendForGeneration(generation, result.replayRequest);
  for (const event of result.events || []) {
    handleCodexEvent(event.method, event.params, true);
  }
  if (Object.prototype.hasOwnProperty.call(result, 'activeTurnId')) {
    setTurnActive(result.activeTurnId);
  }
  renderLinkState();
}

function canonicalActiveTurnId(thread) {
  const turns = thread?.turns || [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].status === 'inProgress') return turns[index].id || null;
  }
  return null;
}

async function handleReplayResult(msg, generation) {
  const result = eventSync.onReplayResult(generation, msg);
  if (!result.accepted) return;
  if (!result.resetRequired) {
    applyEventSyncResult(result, generation);
    return;
  }

  renderLinkState();
  state.pendingReplayReset = { msg, generation };
  if (state.bridge === 'ready') await finishCanonicalReset();
}

async function finishCanonicalReset() {
  const pending = state.pendingReplayReset;
  if (
    !pending
    || state.bridge !== 'ready'
    || !eventSync.isCurrentGeneration(pending.generation)
  ) return;
  state.pendingReplayReset = null;
  const { msg, generation } = pending;
  try {
    const read = await rpc('thread/read', { threadId: msg.threadId, includeTurns: true });
    if (
      !eventSync.isCurrentGeneration(generation)
      || state.thread?.id !== msg.threadId
    ) return;
    const thread = read.thread;
    const activeTurnId = canonicalActiveTurnId(thread);
    state.thread = { ...state.thread, ...thread };
    renderHistory(thread, { includeInProgress: true });
    setTurnActive(activeTurnId);
    const completed = eventSync.completeReset(generation, {
      canonicalActiveTurnId: activeTurnId,
    });
    applyEventSyncResult(completed, generation);
  } catch (error) {
    if (!eventSync.isCurrentGeneration(generation)) return;
    toast('同步会话失败：' + error.message, 4000);
    try { state.ws?.close(); } catch {}
  }
}

function reconcileGatewayApprovals(approvals) {
  const pending = Array.isArray(approvals) ? approvals : [];
  approvalFlow.reconcile(pending.map((entry) => entry.rpcId));
  pending.forEach(addApproval);
  renderAllApprovalStates();
  for (const entry of approvalFlow.values()) {
    if (entry.status === 'confirmed') scheduleConfirmedApprovalRemoval(entry.rpcId);
  }
}

function handleGateway(msg, generation = eventSync.snapshot().generation) {
  if (!eventSync.isCurrentGeneration(generation)) return;
  switch (msg.type) {
    case 'hello': {
      state.bridge = msg.bridge;
      renderBridgeState();
      state.term.list = msg.terminals || [];
      renderTermList();
      reconcileGatewayApprovals(msg.approvals);
      applyEventSyncResult(eventSync.onHello(
        generation,
        msg,
        state.thread?.id || null,
      ), generation);
      onGatewayReady();
      break;
    }
    case 'rpc-result': {
      const p = state.pendingRpc.get(msg.reqId);
      if (p && p.generation === generation) {
        state.pendingRpc.delete(msg.reqId);
        clearTimeout(p.timer);
        msg.error ? p.reject(Object.assign(new Error(msg.error), { code: msg.code, data: msg.data })) : p.resolve(msg.result);
      }
      break;
    }
    case 'bridge-status':
      state.bridge = msg.state;
      renderBridgeState();
      if (Array.isArray(msg.approvals)) reconcileGatewayApprovals(msg.approvals);
      if (msg.streamId) {
        applyEventSyncResult(eventSync.onStreamChanged(
          generation,
          msg.streamId,
          state.thread?.id || null,
        ), generation);
      }
      if (msg.state === 'ready' && state.pendingReplayReset) {
        finishCanonicalReset();
      }
      break;
    case 'event': {
      applyEventSyncResult(eventSync.onLiveEvent(generation, msg), generation);
      break;
    }
    case 'approval':
      addApproval(msg);
      break;
    case 'approval-ack': {
      const handled = approvalFlow.ack(msg);
      if (handled.accepted) {
        renderApprovalState(msg.rpcId);
        scheduleConfirmedApprovalRemoval(msg.rpcId);
      }
      break;
    }
    case 'approval-resolved': {
      const handled = approvalFlow.resolved(msg);
      if (handled.accepted) {
        renderApprovalState(msg.rpcId);
        if (!handled.pendingAck) scheduleConfirmedApprovalRemoval(msg.rpcId);
      }
      break;
    }
    case 'replay-result':
      handleReplayResult(msg, generation);
      break;
    case 'replay':
      (msg.events || []).forEach((e) => handleCodexEvent(e.method, e.params, true));
      break;
    case 'term-list':
      state.term.list = msg.terminals || [];
      renderTermList();
      break;
    case 'term-created':
      // handled by promise in createTerminal
      if (termCreateWaiters.has(msg.reqId)) {
        const w = termCreateWaiters.get(msg.reqId);
        termCreateWaiters.delete(msg.reqId);
        msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.term);
      }
      break;
    case 'term-exit':
      if (state.term.current === msg.id) {
        ptySync.stop('exit');
        clearTimeout(state.term.reconnectTimer);
        renderTermConnectionState(`已退出 · code ${msg.code}`);
        toast(`终端已退出 (code ${msg.code})`);
      }
      break;
  }
}

async function onGatewayReady() {
  refreshStatusPage().catch(() => {});
  loadModels().then(renderModelBar).catch(() => {});
  if (!state.serverInfo) {
    try {
      const r = await fetch('/api/status', { headers: { 'x-auth-token': store.token } });
      state.serverInfo = await r.json();
      if (!state.prefs.cwd && state.serverInfo?.server) {
        // default working dir: user home reported later via directory browser
      }
      renderStatusCards();
    } catch {}
  }
}

/* ============================== link indicator ============================== */
function setLink(mode) {
  renderLinkState(mode);
}

function renderLinkState() {
  const dot = $('#link-dot');
  const host = $('#tele-host');
  const status = eventSync.snapshot().status;
  dot.className = 'pulse-dot' + (status === 'synced' ? ' on' : status === 'syncing' ? '' : ' err');
  host.textContent = {
    reconnecting: '重连中…',
    syncing: '同步中…',
    synced: `已同步 · ${location.host}`,
  }[status] || '重连中…';
  refreshMutationLocks();
  renderStatusCards();
  renderBridgeState();
}

function renderBridgeState() {
  const chipModel = $('#tele-model');
  if (state.bridge !== 'ready') {
    chipModel.hidden = false;
    chipModel.textContent = state.bridge === 'starting' ? 'codex 启动中' : 'codex 离线';
  } else if (state.threadSettings?.model) {
    chipModel.hidden = false;
    chipModel.textContent = state.threadSettings.model + (state.threadSettings.effort ? ` · ${state.threadSettings.effort}` : '');
  } else {
    chipModel.hidden = true;
  }
  renderModelBar();
}

/* ============================== login flow ============================== */
async function tryPair(token) {
  const res = await fetch('/api/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return res.ok;
}

async function boot() {
  // token via URL fragment (QR flow): #token=xxx
  const m = location.hash.match(/token=([^&]+)/);
  if (m) {
    store.token = decodeURIComponent(m[1]);
    history.replaceState(null, '', location.pathname);
  }
  if (store.token && await tryPair(store.token).catch(() => false)) {
    enterApp();
  } else {
    store.token = '';
    $('#view-login').hidden = false;
  }
}

$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#pair-token').value.trim();
  const err = $('#pair-error');
  err.hidden = true;
  if (!token) return;
  if (await tryPair(token).catch(() => false)) {
    store.token = token;
    $('#view-login').hidden = true;
    enterApp();
  } else {
    err.textContent = '令牌不正确，请重试。';
    err.hidden = false;
  }
});

function enterApp() {
  $('#view-login').hidden = true;
  $('#view-app').hidden = false;
  connectEvents();
}

$('#btn-logout').addEventListener('click', () => {
  store.token = '';
  location.reload();
});

/* ============================== tabs & pages ============================== */
$$('.tab').forEach((tab) => tab.addEventListener('click', () => switchPage(tab.dataset.page)));
function switchPage(page) {
  state.page = page;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === page));
  $('#page-chat').hidden = page !== 'chat';
  $('#page-term').hidden = page !== 'term';
  $('#page-status').hidden = page !== 'status';
  if (page === 'term' && state.term.current) setTimeout(fitTerm, 60);
  if (page === 'status') refreshStatusPage().catch(() => {});
}

/* ============================== sheet & drawer ============================== */
const sheet = { open(title, bodyBuilder) {
  $('#sheet-title').textContent = title;
  const body = $('#sheet-body');
  body.innerHTML = '';
  bodyBuilder(body);
  $('#sheet-mask').hidden = false;
  $('#sheet').hidden = false;
  requestAnimationFrame(() => { $('#sheet-mask').classList.add('show'); $('#sheet').classList.add('show'); });
}, close() {
  // Abandon an in-flight ChatGPT login when its sheet is dismissed
  if (state.pendingLoginId) {
    const id = state.pendingLoginId;
    state.pendingLoginId = null;
    rpc('account/login/cancel', { loginId: id }).catch(() => {});
  }
  $('#sheet-mask').classList.remove('show'); $('#sheet').classList.remove('show');
  setTimeout(() => { $('#sheet-mask').hidden = true; $('#sheet').hidden = true; }, 240);
} };
$('#sheet-mask').addEventListener('click', () => sheet.close());

const drawer = { open() {
  $('#drawer-mask').hidden = false;
  requestAnimationFrame(() => { $('#drawer-mask').classList.add('show'); $('#drawer').classList.add('show'); });
  loadThreads();
}, close() {
  $('#drawer-mask').classList.remove('show'); $('#drawer').classList.remove('show');
  setTimeout(() => { $('#drawer-mask').hidden = true; }, 240);
} };
$('#btn-drawer').addEventListener('click', () => drawer.open());
$('#drawer-mask').addEventListener('click', () => drawer.close());

/* ============================== threads ============================== */
async function loadThreads() {
  const list = $('#thread-list');
  list.innerHTML = '<div class="thread-loading">载入中…</div>';
  try {
    const res = await rpc('thread/list', { limit: 40, sortKey: 'updated_at', sortDirection: 'desc' });
    list.innerHTML = '';
    if (!res.data?.length) {
      list.innerHTML = '<div class="thread-loading">还没有历史会话</div>';
      return;
    }
    for (const th of res.data) {
      const item = el('button', 'thread-item' + (state.thread?.id === th.id ? ' current' : ''));
      item.innerHTML = `
        <span class="th-title">${esc(th.name || th.preview || '(空会话)')}</span>
        <span class="th-meta"><span>${relTime(th.updatedAt)}</span><span>${esc(baseName(th.cwd))}</span></span>`;
      item.addEventListener('click', () => { drawer.close(); resumeThread(th.id); });
      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = `<div class="thread-loading">加载失败：${esc(e.message)}</div>`;
  }
}

$('#btn-new-thread').addEventListener('click', async () => {
  drawer.close();
  await newThread().catch((e) => toast('新建会话失败：' + e.message));
});

function threadStartOverrides() {
  const o = {};
  if (state.prefs.model) o.model = state.prefs.model;
  if (state.prefs.cwd) o.cwd = state.prefs.cwd;
  if (state.prefs.approval) o.approvalPolicy = state.prefs.approval;
  if (state.prefs.sandbox) o.sandbox = state.prefs.sandbox;
  return o;
}

async function newThread() {
  if (mutationsLocked()) { toast('连接正在同步，请稍候'); return; }
  if (state.threadSwitching) return;
  await SessionSwitch.runThreadSwitch({
    setPending: setThreadSwitching,
    async load() {
      return rpc('thread/start', threadStartOverrides());
    },
    commit(res) {
      resetChat();
      adoptThread(res, true);
    },
  });
  toast('已创建新会话');
}

async function resumeThread(threadId) {
  if (eventSync.snapshot().status !== 'synced') { toast('连接正在同步，请稍候'); return; }
  if (state.threadSwitching || state.thread?.id === threadId) return;
  const tail = el('div', 'turn-status', '<span class="spin"></span> 正在载入会话…');
  $('#chat-tail').appendChild(tail);
  try {
    await SessionSwitch.runThreadSwitch({
      setPending: setThreadSwitching,
      async load() {
        const res = await rpc('thread/resume', Object.assign({ threadId }, threadStartOverrides(), { cwd: undefined }));
        const read = await rpc('thread/read', { threadId, includeTurns: true });
        return { res, thread: read.thread };
      },
      commit({ res, thread }) {
        resetChat();
        adoptThread(res, false);
        renderHistory(thread);
      },
    });
  } catch (e) {
    toast('恢复会话失败：' + e.message);
  } finally {
    tail.remove();
  }
}

function adoptThread(res, isNew) {
  state.thread = res.thread;
  state.threadSettings = {
    model: res.model, effort: res.reasoningEffort,
    approvalPolicy: res.approvalPolicy, sandbox: res.sandbox,
    cwd: res.cwd,
  };
  state.activeTurnId = null;
  state.tokenUsage = null;
  eventSync.setActiveThread(state.thread?.id || null);
  renderBridgeState();
  renderChips();
  $('#chat-empty').hidden = true;
  renderOpenSessionStatus();
  syncCurrentThread();
}

function syncCurrentThread() {
  const snapshot = eventSync.snapshot();
  if (!state.thread?.id || !snapshot.serverStreamId || !state.wsAlive) return;
  applyEventSyncResult(eventSync.startThreadSync(
    snapshot.generation,
    state.thread.id,
    snapshot.serverStreamId,
  ), snapshot.generation);
}

function resetChat() {
  state.items.clear();
  state.activeTurnId = null;
  state.lastDiff = '';
  $('#chat-list').innerHTML = '';
  $('#chat-tail').innerHTML = '';
  $('#chat-empty').hidden = false;
  $('#btn-changes').hidden = true;
  updateSendButton();
}

function setThreadSwitching(pending) {
  state.threadSwitching = pending;
  input.disabled = pending;
  input.setAttribute('aria-busy', pending ? 'true' : 'false');
  renderExecutionContext();
  refreshMutationLocks();
}

function renderExecutionContext() {
  const thread = state.thread;
  const session = thread
    ? (thread.name || thread.preview || `会话 ${thread.id.slice(0, 8)}…`)
    : '新会话';
  const cwd = thread
    ? (state.threadSettings?.cwd || '默认目录')
    : (state.prefs.cwd || '默认目录');
  $('#exec-session').textContent = state.threadSwitching ? `切换中（当前仍为 ${session}）` : session;
  $('#exec-cwd').textContent = cwd;
  $('#execution-context').classList.toggle('switching', state.threadSwitching);
}

/* ============================== history rendering ============================== */
function renderHistory(thread, options = {}) {
  $('#chat-empty').hidden = true;
  const listEl = $('#chat-list');
  listEl.innerHTML = '';
  state.items.clear();
  for (const turn of thread.turns || []) {
    const inProgress = turn.status === 'inProgress';
    for (const item of turn.items || []) {
      if (inProgress && !options.includeInProgress) continue;
      renderItem(item, !inProgress, true);
    }
    if (turn.status === 'failed' && turn.error) {
      appendChat(el('div', 'turn-status err', `✗ ${esc(turn.error.message)}`));
    }
  }
  scrollBottom(true);
  return canonicalActiveTurnId(thread);
}

/* ============================== chat sending ============================== */
const input = $('#composer-input');
input.addEventListener('input', autoGrow);
input.addEventListener('input', renderCommandSuggest);
input.addEventListener('blur', () => {
  // Suggestion taps preventDefault on pointerdown, so a real blur means the
  // user left the composer — drop the palette.
  setTimeout(() => {
    if (document.activeElement === input) return;
    const strip = $('#command-suggest');
    if (strip) { strip.hidden = true; strip.innerHTML = ''; }
  }, 180);
});
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 132) + 'px';
}
input.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.isComposing) {
    const matches = SessionControls.matchCommands(input.value);
    if (matches.length) {
      e.preventDefault();
      acceptCommandSuggestion(matches[0]);
      return;
    }
  }
  if (e.key === 'Escape') {
    const strip = $('#command-suggest');
    if (strip && !strip.hidden) { strip.hidden = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

/* ---------- slash command autocomplete strip ---------- */
function renderCommandSuggest() {
  const strip = $('#command-suggest');
  if (!strip) return;
  const matches = SessionControls.matchCommands(input.value);
  if (!matches.length) {
    strip.hidden = true;
    strip.innerHTML = '';
    return;
  }
  strip.innerHTML = '';
  for (const command of matches) {
    const row = el('button', 'cmd-suggest-row');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.innerHTML = `
      <code>${esc(command.command)}</code>
      <span class="cs-copy"><strong>${esc(command.title)}</strong><em>${esc(command.description)}</em></span>
      ${command.acceptsArgs ? `<span class="cs-hint mono">${esc(command.argHint || '…')}</span>` : ''}`;
    // Keep the composer keyboard open while tapping a suggestion.
    row.addEventListener('pointerdown', (e) => e.preventDefault());
    row.addEventListener('click', () => acceptCommandSuggestion(command));
    strip.appendChild(row);
  }
  strip.hidden = false;
}

function acceptCommandSuggestion(command) {
  const strip = $('#command-suggest');
  if (command.acceptsArgs) {
    input.value = command.command + ' ';
    autoGrow();
    renderCommandSuggest();
    input.focus();
    return;
  }
  input.value = '';
  autoGrow();
  if (strip) { strip.hidden = true; strip.innerHTML = ''; }
  input.blur(); // dismiss the mobile keyboard so the opened sheet is visible
  runLocalCommand({ command: command.command, action: command.action, args: '' });
}
$('#btn-send').addEventListener('click', () => {
  if (state.activeTurnId) interruptTurn();
  else sendMessage();
});

$$('.hint-chip').forEach((c) => c.addEventListener('click', () => {
  input.value = c.dataset.hint;
  autoGrow();
  input.focus();
}));

function turnOverrides() {
  const o = SessionControls.resolveTurnModelOverrides({
    models: state.models,
    prefs: state.prefs,
    threadSettings: state.threadSettings,
  });
  if (state.prefs.approval) o.approvalPolicy = state.prefs.approval;
  if (state.prefs.sandbox) {
    o.sandboxPolicy = {
      'read-only': { type: 'readOnly', networkAccess: false },
      'workspace-write': { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      'danger-full-access': { type: 'dangerFullAccess' },
    }[state.prefs.sandbox];
  }
  return o;
}

/* ---------- session-local slash commands (mirrors Codex CLI) ---------- */
async function runLocalCommand(command) {
  switch (command?.action) {
    case 'status':
      await openSessionStatus({ refresh: true });
      return true;
    case 'model':
      await openModelPicker();
      return true;
    case 'approvals':
      openApprovalPicker();
      return true;
    case 'review':
      await openReviewPicker(command.args || '');
      return true;
    case 'new':
      await newThread().catch((e) => toast('新建会话失败：' + e.message));
      return true;
    case 'resume':
      drawer.open();
      return true;
    case 'compact':
      await runCompact();
      return true;
    case 'diff':
      openDiffSheet();
      return true;
    case 'mcp':
      await openMcpStatus();
      return true;
    case 'skills':
      await openSkillsSheet();
      return true;
    case 'init':
      await runInitAgents();
      return true;
    default:
      return false;
  }
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;
  const localCommand = SessionControls.parseSlashCommand(text);
  if (localCommand) {
    input.value = '';
    autoGrow();
    renderCommandSuggest();
    await runLocalCommand(localCommand);
    return;
  }
  // Slash-like but unknown: keep the draft so it can be corrected.
  if (SessionControls.isSlashLike(text)) {
    toast(`未知命令 ${text.split(/\s+/)[0]}，输入 / 可查看全部命令`, 3600);
    return;
  }
  input.value = '';
  autoGrow();
  renderCommandSuggest();
  await dispatchUserMessage(text);
}

async function dispatchUserMessage(text) {
  if (mutationsLocked()) { toast('连接正在同步，请稍候'); return; }
  if (state.threadSwitching) { toast('会话正在切换，请稍候'); return; }
  if (state.bridge !== 'ready') { toast('Codex 引擎未就绪，请稍候'); return; }
  try {
    if (!state.thread) {
      const res = await rpc('thread/start', threadStartOverrides());
      adoptThread(res, true);
    }
    $('#chat-empty').hidden = true;
    appendChat(el('div', 'msg-user', esc(text)));
    scrollBottom(true);
    setTurnActive('pending');
    await rpc('turn/start', Object.assign({
      threadId: state.thread.id,
      input: [{ type: 'text', text, text_elements: [] }],
    }, turnOverrides()), 30 * 60 * 1000);
  } catch (e) {
    setTurnActive(null);
    toast('发送失败：' + e.message);
  }
}

async function interruptTurn() {
  if (mutationsLocked()) { toast('连接正在同步，请稍候'); return; }
  if (!state.thread || !state.activeTurnId || state.activeTurnId === 'pending') return;
  try {
    await rpc('turn/interrupt', { threadId: state.thread.id, turnId: state.activeTurnId });
  } catch (e) {
    toast('中断失败：' + e.message);
  }
}

function setTurnActive(turnId) {
  state.activeTurnId = turnId;
  updateSendButton();
  const tail = $('#chat-tail');
  tail.innerHTML = '';
  if (turnId) {
    const s = el('div', 'turn-status', '<span class="spin"></span> <span id="turn-hint">Codex 正在工作…</span>');
    tail.appendChild(s);
  }
}

function updateSendButton() {
  const btn = $('#btn-send');
  const stop = !!state.activeTurnId;
  const locked = mutationsLocked();
  btn.disabled = locked;
  btn.setAttribute('aria-busy', locked ? 'true' : 'false');
  btn.classList.toggle('stop', stop);
  $('.ico-send', btn).hidden = stop;
  $('.ico-stop', btn).hidden = !stop;
}

function mutationsLocked() {
  return !state.wsAlive
    || eventSync.snapshot().status !== 'synced'
    || state.bridge !== 'ready'
    || state.threadSwitching;
}

function refreshMutationLocks() {
  const locked = mutationsLocked();
  if (typeof input !== 'undefined' && input) {
    input.disabled = locked;
    input.setAttribute('aria-busy', locked ? 'true' : 'false');
  }
  const newThreadButton = $('#btn-new-thread');
  if (newThreadButton) newThreadButton.disabled = locked;
  const newCodexButton = $('#btn-new-codex-tui');
  if (newCodexButton) newCodexButton.disabled = locked;
  const newShellButton = $('#btn-new-shell');
  if (newShellButton) newShellButton.disabled = locked;
  const modelSwitchButton = $('#btn-model-switch');
  if (modelSwitchButton) modelSwitchButton.disabled = locked;
  updateSendButton();
  renderAllApprovalStates();
}

/* ============================== chat DOM ============================== */
function appendChat(node) {
  $('#chat-list').appendChild(node);
}

let stickBottom = true;
const scroller = $('#chat-scroll');
scroller.addEventListener('scroll', () => {
  stickBottom = scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 80;
});
function scrollBottom(force) {
  if (force || stickBottom) scroller.scrollTop = scroller.scrollHeight;
}

/* ============================== codex event stream ============================== */
function isCurrentThread(params) {
  return state.thread && params && (params.threadId === state.thread.id || params.thread?.id === state.thread.id);
}

function handleCodexEvent(method, params, replay = false) {
  // Session-global signals
  if (method === 'account/rateLimits/updated') {
    state.rateLimits = params;
    renderOpenSessionStatus();
    return;
  }
  if (method === 'account/login/completed') {
    state.pendingLoginId = null;
    sheet.close();
    if (params.success) {
      toast('登录成功，账号已切换');
      state.models = [];          // catalog differs per account
      state.account = null;
      state.rateLimits = null;
      renderChips();
    } else {
      toast('登录失败：' + (params.error || '未知原因'), 4000);
    }
    refreshStatusPage().catch(() => {});
    return;
  }
  if (method === 'account/updated') { refreshStatusPage().catch(() => {}); return; }
  if (!isCurrentThread(params)) return;

  switch (method) {
    case 'turn/started':
      setTurnActive(params.turn.id);
      break;
    case 'turn/completed': {
      setTurnActive(null);
      const t = params.turn;
      if (t.status === 'failed' && t.error) appendChat(el('div', 'turn-status err', `✗ ${esc(t.error.message)}`));
      if (t.status === 'interrupted') appendChat(el('div', 'turn-status', '■ 已中断'));
      scrollBottom();
      break;
    }
    case 'error':
      appendChat(el('div', 'turn-status err', `✗ ${esc(params.error?.message || '未知错误')}${params.willRetry ? '（自动重试中）' : ''}`));
      scrollBottom();
      break;
    case 'item/started':
      onItemStarted(params.item);
      break;
    case 'item/completed':
      onItemCompleted(params.item);
      break;
    case 'item/agentMessage/delta':
      onAgentDelta(params.itemId, params.delta);
      break;
    case 'item/reasoning/summaryTextDelta':
      onThoughtDelta(params.itemId, params.delta);
      break;
    case 'item/commandExecution/outputDelta':
      onCmdOutput(params.itemId, params.delta);
      break;
    case 'turn/plan/updated':
      onPlanUpdated(params);
      break;
    case 'turn/diff/updated':
      state.lastDiff = params.diff || '';
      renderChangesBadge();
      break;
    case 'thread/tokenUsage/updated':
      state.tokenUsage = params.tokenUsage;
      renderOpenSessionStatus();
      break;
    case 'thread/name/updated':
      if (state.thread) state.thread.name = params.name;
      renderExecutionContext();
      renderOpenSessionStatus();
      break;
    case 'thread/settings/updated':
      if (params.threadSettings) {
        state.threadSettings = Object.assign({}, state.threadSettings, params.threadSettings);
        renderBridgeState();
        renderChips();
        renderOpenSessionStatus();
      }
      break;
  }
}

/* ---------- item renderers ---------- */
function ensureItem(itemId, factory) {
  let entry = state.items.get(itemId);
  if (!entry) {
    entry = factory();
    entry.id = itemId;
    state.items.set(itemId, entry);
    appendChat(entry.el);
    scrollBottom();
  }
  return entry;
}

function onItemStarted(item) {
  renderItem(item, false);
}
function onItemCompleted(item) {
  renderItem(item, true);
}

function renderItem(item, completed, fromHistory = false) {
  switch (item.type) {
    // Live userMessage items are skipped: the composer already appended the
    // bubble locally when the user hit send.
    case 'userMessage': return fromHistory ? renderUserItem(item) : undefined;
    case 'agentMessage': return renderAgentItem(item, completed);
    case 'reasoning': return renderThoughtItem(item, completed);
    case 'commandExecution': return renderCmdItem(item, completed);
    case 'fileChange': return renderPatchItem(item, completed);
    case 'mcpToolCall': return renderMcpItem(item, completed);
    case 'webSearch': return renderSearchItem(item, completed);
    case 'imageView': return renderMiscItem(item, '查看图片', item.path);
    case 'enteredReviewMode': return renderMiscItem(item, '进入审查模式', item.review);
    case 'exitedReviewMode': return renderMiscItem(item, '审查完成', '');
    case 'contextCompaction': return renderMiscItem(item, '上下文压缩', '历史已压缩以释放空间');
    case 'plan': return renderAgentItem({ ...item, text: item.text }, completed);
    default: break;
  }
}

function renderCompletedItem(item) { renderItem(item, true, true); }

function renderUserItem(item) {
  const text = (item.content || []).map((c) => c.type === 'text' ? c.text : `[${c.type}]`).join('\n');
  ensureItem(item.id, () => ({ el: el('div', 'msg-user', esc(text)) }));
}

function renderAgentItem(item, completed) {
  const entry = ensureItem(item.id, () => ({ el: el('div', 'msg-agent streaming'), text: '', canonical: false }));
  if (completed) {
    if (item.text !== undefined && item.text !== null) entry.text = item.text;
    entry.canonical = true;
    entry.el.classList.remove('streaming');
    entry.el.innerHTML = md(entry.text || item.text || '');
  } else if (!entry.canonical && item.text !== undefined && item.text !== null) {
    entry.text = item.text;
    if (entry.text) entry.el.innerHTML = md(entry.text);
  } else if (entry.text) {
    entry.el.innerHTML = md(entry.text);
  }
  scrollBottom();
}

function onAgentDelta(itemId, delta) {
  const entry = ensureItem(itemId, () => ({ el: el('div', 'msg-agent streaming'), text: '', canonical: false }));
  if (entry.canonical) return;
  entry.text = (entry.text || '') + delta;
  throttleRender(entry);
}

const renderQueue = new Set();
function throttleRender(entry) {
  renderQueue.add(entry);
  if (throttleRender._t) return;
  throttleRender._t = setTimeout(() => {
    throttleRender._t = null;
    for (const e of renderQueue) e.el.innerHTML = md(e.text);
    renderQueue.clear();
    scrollBottom();
  }, 120);
}

function makeThoughtEntry() {
  const box = el('details', 'msg-thought');
  box.hidden = true; // stays hidden until it has content
  box.innerHTML = '<summary>THINKING · 推理</summary><div class="thought-body"></div>';
  const body = $('.thought-body', box);
  return {
    el: box,
    body,
    text: '',
    canonical: false,
    renderTarget: { el: body, text: '' },
  };
}

function renderThoughtItem(item, completed) {
  const entry = ensureItem(item.id, makeThoughtEntry);
  const joined = (item.summary || []).join('\n\n');
  if (completed) {
    entry.text = joined;
    entry.canonical = true;
  } else if (!entry.canonical && joined) {
    entry.text = joined;
  }
  entry.renderTarget.text = entry.text;
  entry.el.hidden = !entry.text;
  entry.body.innerHTML = md(entry.text);
  scrollBottom();
}

function onThoughtDelta(itemId, delta) {
  const entry = ensureItem(itemId, makeThoughtEntry);
  if (entry.canonical) return;
  entry.text = (entry.text || '') + delta;
  entry.el.hidden = !entry.text;
  entry.renderTarget.text = entry.text;
  throttleRender(entry.renderTarget);
}

const ICONS = {
  cmd: '<svg class="act-ico" viewBox="0 0 24 24"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  patch: '<svg class="act-ico" viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>',
  tool: '<svg class="act-ico" viewBox="0 0 24 24"><path d="M14 7l3 3m-9 9l-4 1 1-4L15 6a2 2 0 0 1 3 3L8 19z"/></svg>',
  search: '<svg class="act-ico" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>',
  chevron: '<svg class="act-chevron" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
};

function makeAct(icon, label, stateText) {
  const box = el('div', 'act running');
  box.innerHTML = `
    <button class="act-head">${icon}<span class="act-label mono"></span><span class="act-state">${esc(stateText || 'RUNNING')}</span>${ICONS.chevron}</button>
    <div class="act-body" hidden></div>`;
  $('.act-label', box).textContent = label;
  $('.act-head', box).addEventListener('click', () => {
    const open = box.dataset.open === '1';
    box.dataset.open = open ? '0' : '1';
    $('.act-body', box).hidden = open;
  });
  return box;
}

function setActState(box, cls, text) {
  box.classList.remove('running', 'ok', 'fail');
  box.classList.add(cls);
  $('.act-state', box).textContent = text;
}

function renderCmdItem(item, completed) {
  const entry = ensureItem(item.id, () => {
    const box = makeAct(ICONS.cmd, item.command || 'command', 'RUNNING');
    const out = el('pre', 'act-out');
    $('.act-body', box).appendChild(out);
    return { el: box, out, outText: '', canonical: false };
  });
  if (item.command) $('.act-label', entry.el).textContent = item.command;
  if (completed) {
    const agg = item.aggregatedOutput ?? '';
    entry.outText = agg;
    entry.out.textContent = agg.slice(-20000);
    entry.canonical = true;
    if (item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null)) {
      setActState(entry.el, 'ok', `EXIT 0${item.durationMs ? ' · ' + (item.durationMs / 1000).toFixed(1) + 's' : ''}`);
    } else if (item.status === 'declined') {
      setActState(entry.el, 'fail', 'DECLINED');
    } else {
      setActState(entry.el, 'fail', `EXIT ${item.exitCode ?? '?'}`);
    }
  }
  scrollBottom();
}

function onCmdOutput(itemId, delta) {
  const entry = state.items.get(itemId);
  if (!entry || !entry.out) return;
  if (entry.canonical) return;
  entry.outText = (entry.outText || '') + delta;
  if (entry.outText.length > 40000) entry.outText = entry.outText.slice(-40000);
  entry.out.textContent = entry.outText;
  entry.out.scrollTop = entry.out.scrollHeight;
}

function renderDiffInto(container, changes) {
  container.innerHTML = '';
  for (const ch of changes || []) {
    const f = el('div', 'diff-file');
    const kind = ch.kind?.type || 'update';
    const kindCls = kind === 'add' ? 'add' : kind === 'delete' ? 'del' : '';
    f.innerHTML = `<div class="diff-fname"><span class="diff-kind ${kindCls}">${{ add: '新增', delete: '删除', update: '修改' }[kind] || kind}</span><span>${esc(ch.path)}</span></div>`;
    const body = el('pre', 'diff-body');
    const lines = String(ch.diff || '').split('\n').slice(0, 400);
    body.innerHTML = lines.map((l) => {
      const cls = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
      return `<span class="dl ${cls}">${esc(l) || ' '}</span>`;
    }).join('');
    f.appendChild(body);
    container.appendChild(f);
  }
}

function renderPatchItem(item, completed) {
  const entry = ensureItem(item.id, () => {
    const n = (item.changes || []).length;
    const box = makeAct(ICONS.patch, `补丁 · ${n} 个文件`, 'APPLYING');
    return { el: box };
  });
  const n = (item.changes || []).length;
  $('.act-label', entry.el).textContent = `补丁 · ${n} 个文件`;
  renderDiffInto($('.act-body', entry.el), item.changes);
  if (completed) {
    if (item.status === 'completed') setActState(entry.el, 'ok', 'APPLIED');
    else if (item.status === 'declined') setActState(entry.el, 'fail', 'DECLINED');
    else setActState(entry.el, 'fail', String(item.status || 'FAILED').toUpperCase());
  }
  scrollBottom();
}

function renderMcpItem(item, completed) {
  const entry = ensureItem(item.id, () => {
    const box = makeAct(ICONS.tool, `${item.server} · ${item.tool}`, 'CALLING');
    const out = el('pre', 'act-out');
    $('.act-body', box).appendChild(out);
    return { el: box, out };
  });
  if (completed) {
    setActState(entry.el, item.status === 'completed' ? 'ok' : 'fail', String(item.status).toUpperCase());
    try {
      const r = item.result ? JSON.stringify(item.result, null, 2) : (item.error?.message || '');
      entry.out.textContent = (r || '').slice(0, 8000);
    } catch {}
  }
  scrollBottom();
}

function renderSearchItem(item, completed) {
  const entry = ensureItem(item.id, () => makeActEntry(ICONS.search, `搜索 · ${item.query || ''}`, 'SEARCHING'));
  if (item.query) $('.act-label', entry.el).textContent = `搜索 · ${item.query}`;
  if (completed) setActState(entry.el, 'ok', 'DONE');
  scrollBottom();
}
function makeActEntry(icon, label, st) { return { el: makeAct(icon, label, st) }; }

function renderMiscItem(item, label, sub) {
  const entry = ensureItem(item.id, () => makeActEntry(ICONS.tool, label, 'DONE'));
  setActState(entry.el, 'ok', 'DONE');
  if (sub) {
    const body = $('.act-body', entry.el);
    body.innerHTML = `<pre class="act-out">${esc(sub)}</pre>`;
  }
}

/* ---------- plan ---------- */
function onPlanUpdated(params) {
  const key = 'plan:' + params.turnId;
  const entry = ensureItem(key, () => ({ el: el('div', 'plan-card') }));
  const rows = (params.plan || []).map((s) => {
    const cls = s.status === 'completed' ? 'done' : s.status === 'inProgress' ? 'doing' : '';
    const mark = s.status === 'completed' ? '[x]' : s.status === 'inProgress' ? '[>]' : '[ ]';
    return `<div class="plan-step ${cls}"><span class="pmark">${mark}</span><span>${esc(s.step)}</span></div>`;
  }).join('');
  entry.el.innerHTML = `<div class="mark-eyebrow" style="margin-bottom:6px">PLAN · 计划</div>${rows}`;
  scrollBottom();
}

/* ---------- diff badge ---------- */
function renderChangesBadge() {
  const btn = $('#btn-changes');
  const files = (state.lastDiff.match(/^diff --git /gm) || []).length;
  btn.hidden = !files;
  const badge = $('#changes-badge');
  badge.hidden = !files;
  badge.textContent = files;
}
function openDiffSheet() {
  if (!state.lastDiff) { toast('本回合还没有文件变更'); return; }
  sheet.open('本回合文件变更', (body) => {
    const holder = el('div', 'act', '');
    holder.style.border = 'none';
    const changes = splitUnifiedDiff(state.lastDiff);
    renderDiffInto(holder, changes);
    body.appendChild(holder);
  });
}
$('#btn-changes').addEventListener('click', () => openDiffSheet());
function splitUnifiedDiff(diff) {
  const out = [];
  const parts = diff.split(/^diff --git .*$/m).slice(1);
  const headers = diff.match(/^diff --git a\/(.*) b\/(.*)$/gm) || [];
  headers.forEach((h, i) => {
    const m = h.match(/^diff --git a\/(.*) b\/(.*)$/);
    out.push({ path: m ? m[2] : `file ${i + 1}`, kind: { type: 'update' }, diff: (parts[i] || '').trim() });
  });
  return out;
}

/* ============================== approvals ============================== */
function addApproval(entry) {
  entry = { ...entry, rpcId: String(entry.rpcId) };
  const previousFlow = approvalFlow.get(entry.rpcId);
  const existing = state.approvals.has(entry.rpcId);
  const existingCard = $(`#approval-dock [data-rpc-id="${CSS.escape(entry.rpcId)}"]`);
  state.approvals.set(entry.rpcId, entry);
  const flow = approvalFlow.add(entry);
  const needsReplacement = existing && (
    !previousFlow
    || flow !== previousFlow
    || !existingCard
  );
  if (existing && !needsReplacement) {
    renderApprovalState(entry.rpcId);
    return;
  }
  existingCard?.remove();
  const card = buildApprovalCard(entry);
  card.dataset.rpcId = entry.rpcId;
  const status = el('div', 'approval-submit-status');
  status.hidden = true;
  status.innerHTML = '<span class="approval-submit-message"></span><button class="appr-retry" type="button">重试提交</button>';
  $('.appr-retry', status).addEventListener('click', () => retryApproval(entry.rpcId));
  card.appendChild(status);
  $('#approval-dock').appendChild(card);
  renderApprovalState(entry.rpcId);
  renderApprovalBadge();
  if (navigator.vibrate) navigator.vibrate(80);
  scrollBottom();
}

function removeApproval(rpcId, decided = true) {
  state.approvals.delete(String(rpcId));
  approvalFlow.remove(String(rpcId));
  const card = $(`#approval-dock [data-rpc-id="${CSS.escape(String(rpcId))}"]`);
  if (card) card.remove();
  renderApprovalBadge();
}

function renderApprovalBadge() {
  const n = approvalFlow.values().filter((entry) => entry.status !== 'confirmed').length;
  const b = $('#tab-chat-badge');
  b.hidden = !n;
  b.textContent = n;
}

function decide(rpcId, result) {
  if (mutationsLocked()) { toast('连接正在同步，暂不能提交审批'); return; }
  let submission;
  try {
    submission = approvalFlow.begin(rpcId, result);
  } catch (error) {
    toast(error.message);
    return;
  }
  renderApprovalState(rpcId);
  if (!wsSend({
    type: 'approval',
    rpcId: submission.rpcId,
    submissionId: submission.submissionId,
    result: submission.result,
  })) {
    approvalFlow.connectionLost();
    renderApprovalState(rpcId);
  }
}

function retryApproval(rpcId) {
  if (mutationsLocked()) { toast('连接正在同步，暂不能重试'); return; }
  let submission;
  try {
    submission = approvalFlow.retry(rpcId);
  } catch (error) {
    toast(error.message);
    return;
  }
  renderApprovalState(rpcId);
  if (!wsSend({
    type: 'approval',
    rpcId: submission.rpcId,
    submissionId: submission.submissionId,
    result: submission.result,
  })) {
    approvalFlow.connectionLost();
    renderApprovalState(rpcId);
  }
}

function renderApprovalState(rpcId) {
  const flow = approvalFlow.get(rpcId);
  const card = $(`#approval-dock [data-rpc-id="${CSS.escape(String(rpcId))}"]`);
  if (!flow || !card) return;
  card.classList.toggle('submitting', flow.status === 'submitting');
  card.classList.toggle('confirmed', flow.status === 'confirmed');
  card.classList.toggle('failed', flow.status === 'failed');
  const locked = mutationsLocked();
  $$('.approval-actions .appr-btn', card).forEach((button) => {
    button.disabled = locked || flow.status !== 'idle';
  });
  const status = $('.approval-submit-status', card);
  if (status) {
    status.hidden = flow.status === 'idle';
    $('.approval-submit-message', status).textContent = flow.message || flow.error || '';
    const retry = $('.appr-retry', status);
    retry.hidden = !(flow.status === 'failed' && flow.retryable);
    retry.disabled = locked;
  }
  renderApprovalBadge();
}

function renderAllApprovalStates() {
  for (const entry of approvalFlow.values()) renderApprovalState(entry.rpcId);
}

function scheduleConfirmedApprovalRemoval(rpcId) {
  const flow = approvalFlow.get(rpcId);
  if (!flow || flow.status !== 'confirmed') return;
  clearTimeout(flow.removeTimer);
  flow.removeTimer = setTimeout(() => {
    const current = approvalFlow.get(rpcId);
    if (current?.status === 'confirmed') removeApproval(rpcId, false);
  }, flow.handledElsewhere ? 3600 : 1400);
}

function buildApprovalCard(entry) {
  const { method, params } = entry;
  const card = el('div', 'approval-card');

  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    const cmd = method === 'execCommandApproval' ? (params.command || []).join(' ') : (params.command || '');
    const isLegacy = method === 'execCommandApproval';
    const cwd = params.cwd || entry.context?.cwd;
    card.innerHTML = `
      <div class="approval-kicker">approval · 命令执行请求</div>
      <div class="approval-title">Codex 请求运行命令</div>
      <pre class="approval-cmd">${esc(cmd)}</pre>
      ${params.reason ? `<div class="approval-reason">${esc(params.reason)}</div>` : ''}
      ${cwd ? `<div class="approval-reason mono">目录：${esc(cwd)}</div>` : ''}
      <div class="approval-actions">
        <button class="appr-btn yes" data-d="yes">允许</button>
        <button class="appr-btn yes-all" data-d="yes-session">本会话均允许</button>
        <button class="appr-btn no" data-d="no">拒绝</button>
      </div>`;
    card.addEventListener('click', (e) => {
      const d = e.target.closest('[data-d]')?.dataset.d;
      if (!d) return;
      const map = isLegacy
        ? { yes: { decision: 'approved' }, 'yes-session': { decision: 'approved_for_session' }, no: { decision: 'denied' } }
        : { yes: { decision: 'accept' }, 'yes-session': { decision: 'acceptForSession' }, no: { decision: 'decline' } };
      decide(entry.rpcId, map[d]);
    });
    return card;
  }

  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    const isLegacy = method === 'applyPatchApproval';
    const files = isLegacy
      ? Object.keys(params.fileChanges || {})
      : (Array.isArray(entry.context?.files) ? entry.context.files : []);
    card.innerHTML = `
      <div class="approval-kicker">approval · 文件修改请求</div>
      <div class="approval-title">Codex 请求写入文件</div>
      ${files.length ? `<pre class="approval-cmd">${esc(files.join('\n'))}</pre>` : ''}
      ${params.reason ? `<div class="approval-reason">${esc(params.reason)}</div>` : ''}
      ${params.grantRoot ? `<div class="approval-reason mono">授权目录：${esc(params.grantRoot)}</div>` : ''}
      <div class="approval-actions">
        <button class="appr-btn yes" data-d="yes">允许</button>
        <button class="appr-btn yes-all" data-d="yes-session">本会话均允许</button>
        <button class="appr-btn no" data-d="no">拒绝</button>
      </div>`;
    card.addEventListener('click', (e) => {
      const d = e.target.closest('[data-d]')?.dataset.d;
      if (!d) return;
      const map = isLegacy
        ? { yes: { decision: 'approved' }, 'yes-session': { decision: 'approved_for_session' }, no: { decision: 'denied' } }
        : { yes: { decision: 'accept' }, 'yes-session': { decision: 'acceptForSession' }, no: { decision: 'decline' } };
      decide(entry.rpcId, map[d]);
    });
    return card;
  }

  if (method === 'item/tool/requestUserInput') {
    const qs = params.questions || [];
    const blocks = qs.map((q, i) => {
      const opts = (q.options || []).map((o, j) =>
        `<label class="appr-option"><input type="radio" name="q${i}" value="${esc(o.value ?? o.label ?? '')}" ${j === 0 ? 'checked' : ''}> ${esc(o.label ?? o.value ?? '')}</label>`).join('');
      return `<div class="approval-title">${esc(q.header || '')} ${esc(q.question)}</div>
        ${opts}
        ${(!q.options || q.isOther) ? `<input class="appr-input" data-q="${i}" type="${q.isSecret ? 'password' : 'text'}" placeholder="输入回答…">` : ''}`;
    }).join('<hr style="border:none;border-top:1px solid var(--line-soft);margin:10px 0">');
    card.innerHTML = `
      <div class="approval-kicker">input · Codex 在等待你的回答</div>
      ${blocks}
      <div class="approval-actions"><button class="appr-btn yes" data-d="submit">提交回答</button></div>`;
    $('[data-d="submit"]', card).addEventListener('click', () => {
      const answers = {};
      qs.forEach((q, i) => {
        const radio = card.querySelector(`input[name="q${i}"]:checked`);
        const free = card.querySelector(`.appr-input[data-q="${i}"]`);
        const v = (free && free.value.trim()) || (radio && radio.value) || '';
        answers[q.id] = { answers: v ? [v] : [] };
      });
      decide(entry.rpcId, { answers });
    });
    return card;
  }

  if (method === 'item/permissions/requestApproval') {
    card.innerHTML = `
      <div class="approval-kicker">approval · 权限提升请求</div>
      <div class="approval-title">Codex 请求额外权限</div>
      ${params.reason ? `<div class="approval-reason">${esc(params.reason)}</div>` : ''}
      <pre class="approval-cmd">${esc(JSON.stringify(params.permissions, null, 2))}</pre>
      <div class="approval-actions">
        <button class="appr-btn yes" data-d="turn">允许（本回合）</button>
        <button class="appr-btn yes-all" data-d="session">允许（本会话）</button>
        <button class="appr-btn no" data-d="no">拒绝</button>
      </div>`;
    card.addEventListener('click', (e) => {
      const d = e.target.closest('[data-d]')?.dataset.d;
      if (!d) return;
      if (d === 'no') decide(entry.rpcId, { permissions: {}, scope: 'turn' });
      else decide(entry.rpcId, { permissions: params.permissions || {}, scope: d });
    });
    return card;
  }

  if (method === 'mcpServer/elicitation/request') {
    card.innerHTML = `
      <div class="approval-kicker">mcp · ${esc(params.serverName || '')} 请求确认</div>
      <div class="approval-title">${esc(params.message || '')}</div>
      ${params.mode === 'url' ? `<div class="approval-reason mono">${esc(params.url)}</div>` : ''}
      <div class="approval-actions">
        <button class="appr-btn yes" data-d="accept">同意</button>
        <button class="appr-btn no" data-d="decline">拒绝</button>
      </div>`;
    card.addEventListener('click', (e) => {
      const d = e.target.closest('[data-d]')?.dataset.d;
      if (!d) return;
      decide(entry.rpcId, { action: d, content: d === 'accept' ? {} : null, _meta: null });
    });
    return card;
  }

  card.innerHTML = `
    <div class="approval-kicker">approval · ${esc(method)}</div>
    <pre class="approval-cmd">${esc(JSON.stringify(params, null, 2).slice(0, 1500))}</pre>
    <div class="approval-actions">
      <button class="appr-btn no" data-d="cancel">取消请求</button>
    </div>`;
  $('[data-d="cancel"]', card).addEventListener('click', () => decide(entry.rpcId, { decision: 'cancel' }));
  return card;
}

/* ============================== chips & sheets ============================== */
function renderChips() {
  const p = state.prefs;
  $('#chip-cwd').textContent = `▤ ${p.cwd ? baseName(p.cwd) : '默认目录'}`;
  $('#chip-cwd').classList.toggle('set', !!p.cwd);
  const approvalLabel = { untrusted: '谨慎审批', 'on-request': '按需审批', never: '免审批' }[p.approval] || '审批';
  $('#chip-approval').textContent = `✓ ${approvalLabel}`;
  $('#chip-approval').classList.toggle('set', p.approval !== 'on-request');
  const sboxLabel = { 'read-only': '只读', 'workspace-write': '工作区可写', 'danger-full-access': '完全访问' }[p.sandbox] || p.sandbox;
  $('#chip-sandbox').textContent = `⛨ ${sboxLabel}`;
  $('#chip-sandbox').classList.toggle('set', p.sandbox !== 'workspace-write');
  renderExecutionContext();
  renderModelBar();
}

async function loadModels(force = false) {
  if (!force && state.models.length) return state.models;
  if (state.modelsLoading && loadModels._pending) return loadModels._pending;
  state.modelsLoading = true;
  renderModelBar();
  loadModels._pending = rpc('model/list', { limit: 50 })
    .then((res) => {
      state.models = res.data || [];
      return state.models;
    })
    .finally(() => {
      state.modelsLoading = false;
      loadModels._pending = null;
      renderModelBar();
    });
  return loadModels._pending;
}

function renderModelBar() {
  const button = $('#btn-model-switch');
  if (!button) return;
  const selection = SessionControls.resolveModelSelection({
    models: state.models,
    prefs: state.prefs,
    threadSettings: state.threadSettings,
  });
  $('#model-current').textContent = selection.displayName;
  $('#effort-current').textContent = selection.selectedEffort || '默认推理';
  $('#model-switch-label').textContent = selection.pending ? '下回合将使用' : '当前模型';
  button.classList.toggle('pending', selection.pending);
  button.setAttribute('aria-busy', state.modelsLoading ? 'true' : 'false');
  renderContextRing();
}

/**
 * Tiny live gauge on the session-status button: remaining context percent.
 * Falls back to the plain icon until token usage is known.
 */
function renderContextRing() {
  const ring = $('#context-ring');
  const icon = $('#session-status-icon');
  const button = $('#btn-session-status');
  if (!ring || !icon || !button) return;
  const usage = state.tokenUsage;
  const windowTokens = Number(usage?.modelContextWindow) || 0;
  if (!state.thread || !windowTokens) {
    ring.hidden = true;
    icon.style.display = '';
    button.setAttribute('aria-label', '打开并刷新会话状态');
    return;
  }
  const used = Math.min(Math.max(0, Number(usage?.last?.totalTokens) || 0), windowTokens);
  const remaining = Math.max(0, 100 - Math.round((used / windowTokens) * 100));
  ring.hidden = false;
  icon.style.display = 'none';
  ring.style.setProperty('--pct', remaining);
  ring.classList.toggle('low', remaining <= 20);
  $('#context-ring-value').textContent = remaining;
  button.setAttribute('aria-label', `会话状态 · 剩余上下文 ${remaining}%`);
}

function optRow(title, sub, selected) {
  const b = el('button', 'opt-row' + (selected ? ' selected' : ''));
  b.innerHTML = `<span class="o-main"><span class="o-title">${esc(title)}</span>${sub ? `<span class="o-sub">${esc(sub)}</span>` : ''}</span><span class="o-check">✓</span>`;
  return b;
}

async function openModelPicker() {
  if (mutationsLocked()) { toast('连接正在同步，请稍候'); return; }
  let panel;
  sheet.open('模型与推理强度', (body) => {
    panel = el('div', 'session-panel-state', '<span class="spin"></span> 正在刷新模型目录…');
    body.appendChild(panel);
  });
  try {
    const models = await loadModels(true);
    if (panel?.isConnected) renderModelPicker(panel, models);
  } catch (error) {
    if (panel?.isConnected) {
      panel.className = 'session-panel-state error';
      panel.textContent = `模型列表获取失败：${error.message}`;
    }
  }
}

function renderModelPicker(panel, models) {
  panel.className = '';
  panel.innerHTML = '';
  const visible = SessionControls.getVisibleModels(models);
  const currentModel = state.prefs.model || state.threadSettings?.model || '';
  const head = el('div', 'model-picker-head');
  head.innerHTML = '<span>选择将用于下一回合的模型</span>';
  const refresh = el('button', 'model-picker-refresh', '刷新目录');
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    try { renderModelPicker(panel, await loadModels(true)); }
    catch (error) { toast('刷新失败：' + error.message); }
  });
  head.appendChild(refresh);
  panel.appendChild(head);

  const list = el('div', 'model-picker-list');
  const defaultRow = optRow('默认模型', '跟随本机 Codex 配置', !state.prefs.model);
  defaultRow.addEventListener('click', () => {
    state.prefs.model = '';
    state.prefs.effort = '';
    savePrefs();
    renderChips();
    renderModelPicker(panel, models);
  });
  list.appendChild(defaultRow);
  for (const model of visible) {
    const slug = model.model || model.id;
    const row = optRow(model.displayName || slug, model.description, currentModel === slug);
    row.addEventListener('click', () => {
      state.prefs.model = slug;
      state.prefs.effort = SessionControls.reconcileEffort(models, slug, state.prefs.effort);
      savePrefs();
      renderChips();
      renderModelPicker(panel, models);
    });
    list.appendChild(row);
  }
  panel.appendChild(list);

  const selectedModel = state.prefs.model || state.threadSettings?.model || '';
  const efforts = SessionControls.getEffortOptions(models, selectedModel);
  const effortPanel = el('div', 'effort-picker');
  effortPanel.innerHTML = `<div class="effort-picker-title"><span>推理强度</span><span>${efforts.length ? '来自实时模型目录' : '该模型未提供选项'}</span></div>`;
  const options = el('div', 'effort-options');
  const automatic = el('button', 'effort-option' + (!state.prefs.effort ? ' selected' : ''), '默认');
  automatic.addEventListener('click', () => {
    state.prefs.effort = '';
    savePrefs();
    renderChips();
    renderModelPicker(panel, models);
  });
  options.appendChild(automatic);
  for (const effort of efforts) {
    const option = el('button', 'effort-option' + (state.prefs.effort === effort.id ? ' selected' : ''), effort.id);
    option.title = effort.description;
    option.addEventListener('click', () => {
      state.prefs.effort = effort.id;
      savePrefs();
      renderChips();
      renderModelPicker(panel, models);
    });
    options.appendChild(option);
  }
  effortPanel.appendChild(options);
  panel.appendChild(effortPanel);
  panel.appendChild(el('div', 'model-picker-note', '模型与推理强度将在下一回合生效；当前正在运行的回合不会改变。'));
}

$('#btn-model-switch').addEventListener('click', () => openModelPicker());

function renderSessionDetail(root) {
  if (!root) return;
  const snapshot = SessionControls.createSessionSnapshot({
    thread: state.thread,
    threadSettings: state.threadSettings,
    prefs: state.prefs,
    tokenUsage: state.tokenUsage,
    account: state.account,
    rateLimits: state.rateLimits,
  });
  const session = snapshot.session;
  const account = snapshot.account;
  const context = session.context;
  const contextBlock = context
    ? `<div class="meter"><div class="m-head"><span>剩余上下文 ${context.remainingTokens.toLocaleString()} tokens</span><span class="mono">${context.remainingPercent}%</span></div>
        <div class="m-bar"><div class="m-fill ${context.usedPercent > 85 ? 'hot' : ''}" style="width:${context.usedPercent}%"></div></div>
        <div class="meter-sub">已用 ${context.usedTokens.toLocaleString()} / 窗口 ${context.windowTokens.toLocaleString()}</div></div>`
    : statRow('剩余上下文', '发送一条消息后开始统计', '');
  const quota = account.windows.map((window) => {
    const reset = window.resetsAt
      ? ` · ${quotaResetLabel(new Date(window.resetsAt * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}`
      : '';
    return `<div class="meter"><div class="m-head"><span>${esc(window.label)}${esc(reset)}</span><span class="mono">已用 ${window.usedPercent}%</span></div>
      <div class="m-bar"><div class="m-fill ${window.usedPercent > 85 ? 'hot' : ''}" style="width:${window.usedPercent}%"></div></div></div>`;
  }).join('');
  root.innerHTML = `
    ${state.sessionRefreshError ? `<div class="session-panel-state error">${esc(state.sessionRefreshError)}</div>` : ''}
    <div class="session-detail-hero">
      <div class="mark-eyebrow">SESSION · 当前会话</div>
      <div class="session-detail-name">${esc(session.name)}</div>
      ${session.id ? `<div class="session-detail-id">${esc(session.id)}</div>` : ''}
    </div>
    <div class="session-detail-group">
      <div class="mark-eyebrow">CONTEXT · 上下文</div>
      <div class="session-detail-card">
        ${contextBlock}
        ${statRow('累计 tokens', session.totalTokens.toLocaleString())}
      </div>
    </div>
    <div class="session-detail-group">
      <div class="mark-eyebrow">RUNTIME · 运行设置</div>
      <div class="session-detail-card">
        ${statRow('工作目录', esc(session.cwd))}
        ${statRow('模型', esc(session.model))}
        ${statRow('推理强度', esc(session.effort))}
        ${statRow('审批策略', esc(session.approval))}
        ${statRow('沙箱', esc(session.sandbox))}
      </div>
    </div>
    <div class="session-detail-group">
      <div class="mark-eyebrow">ACCOUNT · 账户额度</div>
      <div class="session-detail-card">
        ${statRow('账户', esc(account.identity))}
        ${quota || statRow('额度', '暂无数据', 'warn')}
      </div>
      <div class="session-quota-note">额度属于当前登录账户，随所有会话共享；输入 /status 或点左下状态钮可随时刷新。</div>
    </div>
    <div class="session-panel-actions">
      <button class="btn-ghost" data-session-refresh>↻ 刷新状态</button>
      <button class="btn-ghost" data-session-model>⌬ 切换模型</button>
    </div>`;
  $('[data-session-refresh]', root).addEventListener('click', () => openSessionStatus({ refresh: true }));
  $('[data-session-model]', root).addEventListener('click', () => openModelPicker());
}

function quotaResetLabel(reset) {
  return reset ? `重置 ${reset}` : '';
}

function renderOpenSessionStatus() {
  renderContextRing();
  const root = $('#sheet-body [data-session-detail]');
  if (root) renderSessionDetail(root);
}

async function openSessionStatus({ refresh = true } = {}) {
  let root;
  sheet.open('会话状态', (body) => {
    root = el('div');
    root.dataset.sessionDetail = '1';
    root.innerHTML = '<div class="session-panel-state"><span class="spin"></span> 正在刷新会话状态…</div>';
    body.appendChild(root);
  });
  state.sessionRefreshError = '';
  if (refresh) {
    const errors = [];
    if (state.thread?.id) {
      try {
        let read;
        try {
          read = await rpc('thread/read', { threadId: state.thread.id, includeTurns: true });
        } catch {
          // Fresh threads are not materialized until the first message; retry
          // without history instead of surfacing a scary error.
          read = await rpc('thread/read', { threadId: state.thread.id });
        }
        if (read.thread?.id === state.thread.id) state.thread = { ...state.thread, ...read.thread };
      } catch (error) {
        errors.push(`会话：${error.message}`);
      }
    }
    try { state.account = await rpc('account/read', { refreshToken: false }); }
    catch (error) { errors.push(`账户：${error.message}`); }
    try { state.rateLimits = await rpc('account/rateLimits/read'); }
    catch (error) { errors.push(`额度：${error.message}`); }
    state.sessionRefreshError = errors.join('；');
  }
  if (root?.isConnected) renderSessionDetail(root);
}

$('#btn-session-status').addEventListener('click', () => openSessionStatus({ refresh: true }));

function openCommandHelp() {
  sheet.open('斜杠命令', (body) => {
    const list = el('div', 'command-list');
    for (const command of SessionControls.getCommandHelp()) {
      const row = el('button', 'command-item');
      row.type = 'button';
      row.innerHTML = `
        <code>${esc(command.command)}${command.acceptsArgs ? ` <i>${esc(command.argHint || '')}</i>` : ''}</code>
        <span><strong>${esc(command.title)}</strong><br>${esc(command.description)}</span>`;
      row.addEventListener('click', () => {
        sheet.close();
        if (command.acceptsArgs) {
          input.value = command.command + ' ';
          autoGrow();
          renderCommandSuggest();
          input.focus();
        } else {
          runLocalCommand({ command: command.command, action: command.action, args: '' });
        }
      });
      list.appendChild(row);
    }
    body.appendChild(list);
    body.appendChild(el('div', 'command-help-note', '与 Codex CLI 中的同名命令一致，由手机端本地处理；其余内容会照常发送给 Codex。输入 / 可随时唤起命令面板。'));
  });
}
$('#btn-command-help').addEventListener('click', () => openCommandHelp());

/* ---------- /compact —— 压缩上下文 ---------- */
async function runCompact() {
  if (!state.thread) { toast('当前没有活动会话'); return; }
  if (mutationsLocked()) { toast('连接正在同步，请稍候'); return; }
  if (state.activeTurnId) { toast('回合进行中，结束后再压缩'); return; }
  try {
    await rpc('thread/compact/start', { threadId: state.thread.id }, 10 * 60 * 1000);
    toast('已开始压缩上下文，完成后会出现「上下文压缩」卡片');
  } catch (e) {
    toast('压缩失败：' + e.message, 4000);
  }
}

/* ---------- /review —— 代码审查（与 codex CLI 同源） ---------- */
async function openReviewPicker(args) {
  if (!state.thread) { toast('先开始一个会话，再发起代码审查'); return; }
  if (args) {
    await startReview({ type: 'custom', instructions: args }, args);
    return;
  }
  sheet.open('代码审查', (body) => {
    const uncommitted = optRow('审查未提交的修改', '检查 git 工作区中所有未提交的改动', false);
    uncommitted.addEventListener('click', () => {
      sheet.close();
      startReview({ type: 'uncommittedChanges' }, '未提交的修改');
    });
    body.appendChild(uncommitted);

    const branch = optRow('对比基线分支…', '审查当前分支相对某个基线分支的差异', false);
    branch.addEventListener('click', () => showReviewForm('branch'));
    body.appendChild(branch);

    const custom = optRow('自定义审查要求…', '告诉审查者应重点检查什么', false);
    custom.addEventListener('click', () => showReviewForm('custom'));
    body.appendChild(custom);
    body.appendChild(el('div', 'share-tip', '审查会作为一个回合在当前会话中运行，结果以审查报告形式回复。'));
  });
}

function showReviewForm(kind) {
  const isBranch = kind === 'branch';
  sheet.open(isBranch ? '对比基线分支' : '自定义审查要求', (body) => {
    const field = el(isBranch ? 'input' : 'textarea', 'appr-input review-field');
    if (isBranch) {
      field.type = 'text';
      field.placeholder = '基线分支名，例如 main';
      field.autocapitalize = 'off';
      field.spellcheck = false;
    } else {
      field.rows = 4;
      field.placeholder = '例如：重点检查登录流程的错误处理和安全性';
    }
    body.appendChild(field);
    const submit = el('button', 'btn-primary', isBranch ? '开始对比审查' : '开始审查');
    submit.style.cssText = 'width:100%;margin-top:12px';
    submit.addEventListener('click', () => {
      const value = field.value.trim();
      if (!value) { toast(isBranch ? '请输入分支名' : '请输入审查要求'); return; }
      sheet.close();
      if (isBranch) startReview({ type: 'baseBranch', branch: value }, `对比分支 ${value}`);
      else startReview({ type: 'custom', instructions: value }, value);
    });
    body.appendChild(submit);
    setTimeout(() => field.focus(), 260);
  });
}

async function startReview(target, label) {
  if (mutationsLocked()) { toast('连接正在同步，请稍候'); return; }
  if (state.activeTurnId) { toast('回合进行中，请稍候'); return; }
  try {
    $('#chat-empty').hidden = true;
    appendChat(el('div', 'turn-status', `⌁ 代码审查 · ${esc(label).slice(0, 80)}`));
    scrollBottom(true);
    setTurnActive('pending');
    await rpc('review/start', {
      threadId: state.thread.id,
      target,
      delivery: 'inline',
    }, 30 * 60 * 1000);
  } catch (e) {
    setTurnActive(null);
    toast('审查启动失败：' + e.message, 4000);
  }
}

/* ---------- /mcp —— MCP 服务器状态 ---------- */
async function openMcpStatus() {
  let panel;
  sheet.open('MCP 服务器', (body) => {
    panel = el('div', 'session-panel-state', '<span class="spin"></span> 正在读取 MCP 状态…');
    body.appendChild(panel);
  });
  try {
    const res = await rpc('mcpServerStatus/list', {
      detail: 'toolsAndAuthOnly',
      threadId: state.thread?.id || undefined,
    });
    if (!panel?.isConnected) return;
    renderMcpList(panel, res.data || []);
  } catch (e) {
    if (!panel?.isConnected) return;
    panel.className = 'session-panel-state error';
    panel.textContent = `MCP 状态获取失败：${e.message}`;
  }
}

function renderMcpList(panel, servers) {
  panel.className = '';
  panel.innerHTML = '';
  if (!servers.length) {
    panel.appendChild(el('div', 'catalog-empty', '还没有配置 MCP 服务器。可在电脑端 ~/.codex/config.toml 中添加。'));
    return;
  }
  const list = el('div', 'catalog-list');
  for (const server of servers) {
    const tools = Object.keys(server.tools || {});
    const auth = {
      unsupported: { text: '无需登录', cls: 'ok' },
      bearerToken: { text: 'Token 已配置', cls: 'ok' },
      oAuth: { text: 'OAuth 已登录', cls: 'ok' },
      notLoggedIn: { text: '未登录', cls: 'warn' },
    }[server.authStatus] || { text: server.authStatus || '未知', cls: '' };
    const item = el('div', 'catalog-item');
    item.innerHTML = `
      <div class="ci-head">
        <span class="ci-name mono">${esc(server.name)}</span>
        <span class="ci-state ${auth.cls}">${esc(auth.text)}</span>
      </div>
      <div class="ci-sub">${tools.length ? `${tools.length} 个工具` : '没有可用工具'}${server.serverInfo?.version ? ` · v${esc(server.serverInfo.version)}` : ''}</div>
      ${tools.length ? `<div class="ci-tags">${tools.slice(0, 8).map((t) => `<span>${esc(t)}</span>`).join('')}${tools.length > 8 ? `<span>+${tools.length - 8}</span>` : ''}</div>` : ''}`;
    list.appendChild(item);
  }
  panel.appendChild(list);
}

/* ---------- /skills —— 可用技能 ---------- */
async function openSkillsSheet() {
  let panel;
  sheet.open('技能 SKILLS', (body) => {
    panel = el('div', 'session-panel-state', '<span class="spin"></span> 正在读取技能列表…');
    body.appendChild(panel);
  });
  try {
    const res = await rpc('skills/list', {});
    if (!panel?.isConnected) return;
    const skills = (res.data || []).flatMap((entry) => entry.skills || []);
    panel.className = '';
    panel.innerHTML = '';
    if (!skills.length) {
      panel.appendChild(el('div', 'catalog-empty', '当前目录没有可用技能。'));
      return;
    }
    const list = el('div', 'catalog-list');
    for (const skill of skills) {
      const item = el('div', 'catalog-item' + (skill.enabled === false ? ' off' : ''));
      item.innerHTML = `
        <div class="ci-head">
          <span class="ci-name mono">${esc(skill.name)}</span>
          <span class="ci-state ${skill.enabled === false ? '' : 'ok'}">${skill.enabled === false ? '已停用' : '可用'}</span>
        </div>
        <div class="ci-sub">${esc(skill.shortDescription || skill.description || '')}</div>`;
      list.appendChild(item);
    }
    panel.appendChild(list);
  } catch (e) {
    if (!panel?.isConnected) return;
    panel.className = 'session-panel-state error';
    panel.textContent = `技能列表获取失败：${e.message}`;
  }
}

/* ---------- /init —— 生成 AGENTS.md ---------- */
const INIT_AGENTS_PROMPT = [
  '请为当前仓库生成一份 AGENTS.md 贡献者指南（如已存在则在保留有效内容的基础上完善），要求：',
  '1. 先浏览仓库结构、构建/测试命令与代码风格约定；',
  '2. 写明：项目结构与模块职责、常用构建/测试/运行命令、代码风格约定、测试要求、提交与 PR 规范；',
  '3. 内容务必与仓库实际情况一致，简洁实用，使用 Markdown 标题组织；',
  '4. 直接创建或更新仓库根目录的 AGENTS.md 文件。',
].join('\n');

async function runInitAgents() {
  if (state.activeTurnId) { toast('回合进行中，请稍候'); return; }
  await dispatchUserMessage(INIT_AGENTS_PROMPT);
}

function openApprovalPicker() {
  const opts = [
    { id: 'untrusted', t: '谨慎审批', s: '除白名单外的所有命令都需要你批准' },
    { id: 'on-request', t: '按需审批', s: '模型自行决定何时请求批准（推荐）' },
    { id: 'never', t: '免审批', s: '从不询问，失败直接返回给模型' },
  ];
  sheet.open('审批策略', (body) => {
    for (const o of opts) {
      const row = optRow(o.t, o.s, state.prefs.approval === o.id);
      row.addEventListener('click', () => { state.prefs.approval = o.id; savePrefs(); renderChips(); sheet.close(); });
      body.appendChild(row);
    }
    body.appendChild(el('div', 'share-tip', '审批策略对下一个回合生效。'));
  });
}
$('#chip-approval').addEventListener('click', () => openApprovalPicker());

$('#chip-sandbox').addEventListener('click', () => {
  const opts = [
    { id: 'read-only', t: '只读', s: '只能读取文件，最安全' },
    { id: 'workspace-write', t: '工作区可写', s: '可修改工作目录内的文件（推荐）' },
    { id: 'danger-full-access', t: '完全访问', s: '⚠ 无沙箱限制，请谨慎使用' },
  ];
  sheet.open('沙箱模式', (body) => {
    for (const o of opts) {
      const row = optRow(o.t, o.s, state.prefs.sandbox === o.id);
      row.addEventListener('click', () => { state.prefs.sandbox = o.id; savePrefs(); renderChips(); sheet.close(); });
      body.appendChild(row);
    }
    body.appendChild(el('div', 'share-tip', '沙箱与审批设置对下一个回合生效。'));
  });
});

/* ---------- 工作目录选择器 ---------- */
function joinPath(base, name) {
  const sep = base.includes('\\') || /^[A-Za-z]:/.test(base) ? '\\' : '/';
  return base.replace(/[\\/]+$/, '') + sep + name;
}
function parentPath(p) {
  const norm = p.replace(/[\\/]+$/, '');
  const m = norm.match(/^(.*[\\/])[^\\/]+$/);
  if (!m) return null;
  let parent = m[1];
  if (/^[A-Za-z]:\\?$/.test(parent.replace(/[\\/]+$/, '') + '\\')) parent = parent.slice(0, 2) + '\\';
  return parent.length >= 2 ? parent : null;
}

$('#chip-cwd').addEventListener('click', () => {
  const start = state.prefs.cwd || state.threadSettings?.cwd || state.serverInfo?.server?.home || 'C:\\';
  openDirBrowser(start);
});

async function openDirBrowser(startPath) {
  let current = startPath;

  sheet.open('选择工作目录', (body) => {
    const bar = el('div', 'dir-bar');
    const pathEl = el('div', 'dir-path mono');
    const pick = el('button', 'btn-primary', '✓ 就用这个目录');
    pick.style.width = '100%';
    const quick = el('div', 'dir-quick');
    const listEl = el('div', 'dir-list');
    const note = el('div', 'share-tip', '对「新建会话」生效；当前会话目录不变。');

    const drives = state.serverInfo?.server?.drives || [];
    const home = state.serverInfo?.server?.home;
    const quicks = [];
    if (home) quicks.push({ label: '⌂ 主目录', path: home });
    for (const d of drives) quicks.push({ label: d.replace(/\\$/, ''), path: d });
    quicks.push({ label: '默认', path: '' });
    for (const q of quicks) {
      const b = el('button', 'chip', q.label);
      b.addEventListener('click', () => {
        if (q.path === '') {
          state.prefs.cwd = '';
          savePrefs(); renderChips(); sheet.close();
          toast('已恢复默认目录');
        } else {
          nav(q.path);
        }
      });
      quick.appendChild(b);
    }

    pick.addEventListener('click', () => {
      state.prefs.cwd = current;
      savePrefs(); renderChips(); sheet.close();
      toast('新会话将在 ' + baseName(current) + ' 中启动');
    });

    async function nav(p) {
      current = p;
      pathEl.textContent = current;
      listEl.innerHTML = '<div class="thread-loading">读取中…</div>';
      try {
        const res = await rpc('fs/readDirectory', { path: current });
        const dirs = (res.entries || []).filter((e) => e.isDirectory)
          .sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh-CN'));
        listEl.innerHTML = '';
        const up = parentPath(current);
        if (up) {
          const row = el('button', 'dir-item up', '<span class="d-ico">↩</span><span>上一级</span>');
          row.addEventListener('click', () => nav(up));
          listEl.appendChild(row);
        }
        if (!dirs.length) listEl.appendChild(el('div', 'thread-loading', '（没有子文件夹）'));
        for (const d of dirs) {
          const row = el('button', 'dir-item');
          row.innerHTML = `<span class="d-ico">▸</span><span class="d-name"></span>`;
          $('.d-name', row).textContent = d.fileName;
          row.addEventListener('click', () => nav(joinPath(current, d.fileName)));
          listEl.appendChild(row);
        }
      } catch (e) {
        listEl.innerHTML = `<div class="thread-loading">无法读取：${esc(e.message)}</div>`;
      }
    }

    bar.appendChild(pathEl);
    body.appendChild(quick);
    body.appendChild(bar);
    body.appendChild(pick);
    body.appendChild(note);
    body.appendChild(listEl);
    nav(current);
  });
}

/* ============================== terminal page ============================== */
const termCreateWaiters = new Map();
function createTerminal(kind) {
  return new Promise((resolve, reject) => {
    if (mutationsLocked()) return reject(new Error('连接正在同步'));
    const reqId = state.reqId++;
    const generation = eventSync.snapshot().generation;
    termCreateWaiters.set(reqId, { resolve, reject, generation });
    wsSend({ type: 'term-create', reqId, kind, cwd: state.prefs.cwd || undefined, cols: 90, rows: 30 });
    setTimeout(() => {
      if (termCreateWaiters.has(reqId)) { termCreateWaiters.delete(reqId); reject(new Error('创建终端超时')); }
    }, 15000);
  });
}

function rejectTermCreateWaitersForGeneration(generation) {
  for (const [reqId, waiter] of termCreateWaiters) {
    if (waiter.generation !== generation) continue;
    termCreateWaiters.delete(reqId);
    waiter.reject(new Error('连接已断开'));
  }
}

function renderTermList() {
  const list = $('#term-list');
  list.innerHTML = '';
  if (!state.term.list.length) {
    list.innerHTML = '<div class="term-empty">没有运行中的终端</div>';
    return;
  }
  for (const t of state.term.list) {
    const item = el('button', 'term-item');
    item.innerHTML = `
      <span class="ti-glyph">${t.kind === 'codex' ? '❯' : '$'}</span>
      <span class="ti-main">
        <span class="ti-title">${esc(t.title)} #${t.id}</span>
        <span class="ti-sub">${esc(t.cwd)}</span>
      </span>
      <span class="ti-live ${t.alive ? '' : 'dead'}">${t.alive ? '● LIVE' : '○ EXITED'}</span>`;
    item.addEventListener('click', () => openTerminal(t));
    list.appendChild(item);
  }
}

$('#btn-new-codex-tui').addEventListener('click', async () => {
  try { openTerminal(await createTerminal('codex')); }
  catch (e) { toast(e.message); }
});
$('#btn-new-shell').addEventListener('click', async () => {
  try { openTerminal(await createTerminal('shell')); }
  catch (e) { toast(e.message); }
});

function openTerminal(t) {
  state.term.current = t.id;
  state.term.baseTitle = `${t.title} #${t.id} · ${baseName(t.cwd)}`;
  $('#term-home').hidden = true;
  $('#term-view').hidden = false;
  $('#term-title').textContent = state.term.baseTitle;

  if (!state.term.xterm) {
    const xt = new Terminal({
      fontFamily: '"Cascadia Code", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: '#1F1E1B', foreground: '#DCD8CC',
        cursor: '#D97757', cursorAccent: '#1F1E1B',
        selectionBackground: 'rgba(217,119,87,0.30)',
        black: '#35342E', red: '#E07B63', green: '#8FAE80', yellow: '#D9A05B',
        blue: '#7E9CC0', magenta: '#B58DA6', cyan: '#7FAE9E', white: '#DCD8CC',
        brightBlack: '#78746B', brightRed: '#ECA08C', brightGreen: '#AECBA0',
        brightYellow: '#E8BC82', brightBlue: '#A3BCD8', brightMagenta: '#CCA9BF',
        brightCyan: '#A0C6B8', brightWhite: '#F0EDE4',
      },
    });
    const fit = new FitAddon.FitAddon();
    xt.loadAddon(fit);
    xt.open($('#xterm-holder'));
    state.term.xterm = xt;
    state.term.fit = fit;
    xt.onData((d) => {
      let data = d;
      if (state.term.ctrlLatch && d.length === 1) {
        const code = d.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
        setCtrlLatch(false);
      }
      if (
        state.term.ws?.readyState === WebSocket.OPEN
        && ptySync.snapshot().status === 'live'
      ) state.term.ws.send(data);
    });
  }

  connectTermWs(t.id, { retry: false });
  setTimeout(fitTerm, 60);
}

function connectTermWs(id, options = {}) {
  clearTimeout(state.term.reconnectTimer);
  if (state.term.ws) { try { state.term.ws.close(); } catch {} }
  const generation = ptySync.begin(id, { retry: !!options.retry });
  renderTermConnectionState();
  const ws = new WebSocket(wsUrl(`/ws/term/${id}`));
  ws.binaryType = 'arraybuffer';
  state.term.ws = ws;
  ws.onmessage = (ev) => {
    if (!ptySync.isCurrentGeneration(generation) || state.term.ws !== ws) return;
    const data = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
    if (data.startsWith('\u0000')) {
      let control;
      try { control = JSON.parse(data.slice(1)); } catch { return; }
      if (control.op === 'sync-begin') {
        const action = ptySync.onSyncBegin(generation, control);
        if (action.accepted && action.reset) state.term.xterm.reset();
        renderTermConnectionState();
      } else if (control.op === 'sync-end') {
        ptySync.onSyncEnd(generation, control);
        renderTermConnectionState();
        fitTerm();
      }
      return;
    }
    const action = ptySync.onData(generation, data);
    if (action.accepted) state.term.xterm.write(action.write);
  };
  ws.onclose = (event) => {
    if (!ptySync.isCurrentGeneration(generation) || state.term.ws !== ws) return;
    state.term.ws = null;
    const action = ptySync.onSocketClose(generation, {
      code: event.code,
      reason: event.reason,
    });
    renderTermConnectionState();
    if (
      action.reconnect
      && state.term.current === String(id)
      && !$('#term-view').hidden
    ) {
      state.term.reconnectTimer = setTimeout(() => connectTermWs(id, { retry: true }), action.delayMs);
    }
  };
  ws.onopen = () => {
    if (!ptySync.isCurrentGeneration(generation) || state.term.ws !== ws) return;
    ptySync.onSocketOpen(generation);
    renderTermConnectionState();
    fitTerm();
  };
  ws.onerror = () => {};
}

function renderTermConnectionState(override) {
  const target = $('#term-connection-status');
  if (!target) return;
  const snapshot = ptySync.snapshot();
  const blocked = {
    back: '已返回',
    kill: '已结束',
    exit: '终端已退出',
    'not-found': '终端不存在',
    closed: '连接已关闭',
  }[snapshot.blockedReason || snapshot.intent];
  target.textContent = override || {
    idle: '未连接',
    connecting: '连接中…',
    syncing: '同步画面中…',
    live: '● 已连接',
    reconnecting: `重连中 · 第 ${snapshot.attempt} 次`,
    blocked: blocked || '已停止重连',
  }[snapshot.status] || snapshot.status;
  target.dataset.state = snapshot.status;
}

function fitTerm() {
  if (!state.term.fit || $('#term-view').hidden) return;
  try {
    state.term.fit.fit();
    const { cols, rows } = state.term.xterm;
    if (state.term.ws?.readyState === WebSocket.OPEN) {
      state.term.ws.send('\u0000' + JSON.stringify({ op: 'resize', cols, rows }));
    }
  } catch {}
}
window.addEventListener('resize', () => setTimeout(fitTerm, 120));

$('#btn-term-back').addEventListener('click', () => {
  closeTerminalView('back');
});

function closeTerminalView(intent) {
  ptySync.stop(intent);
  clearTimeout(state.term.reconnectTimer);
  $('#term-view').hidden = true;
  $('#term-home').hidden = false;
  if (state.term.ws) { try { state.term.ws.close(); } catch {} state.term.ws = null; }
  state.term.current = null;
  renderTermConnectionState();
}

$('#btn-term-kill').addEventListener('click', () => {
  if (!state.term.current) return;
  const id = state.term.current;
  ptySync.stop('kill');
  wsSend({ type: 'term-kill', id });
  closeTerminalView('kill');
});

function setCtrlLatch(on) {
  state.term.ctrlLatch = on;
  $('#key-ctrl').classList.toggle('latched', on);
}
$('#keybar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.ctrl) { setCtrlLatch(!state.term.ctrlLatch); return; }
  const seq = btn.dataset.seq;
  if (
    seq
    && state.term.ws?.readyState === WebSocket.OPEN
    && ptySync.snapshot().status === 'live'
  ) {
    state.term.ws.send(seq);
    state.term.xterm?.focus();
  }
});

/* ============================== status page ============================== */
async function refreshStatusPage() {
  renderStatusCards();
  try {
    const r = await fetch('/api/status', { headers: { 'x-auth-token': store.token } });
    state.serverInfo = await r.json();
    renderStatusCards();
  } catch {}
  try {
    const acc = await rpc('account/read', { refreshToken: false });
    state.account = acc;
  } catch { state.account = null; }
  try {
    state.rateLimits = await rpc('account/rateLimits/read');
  } catch {}
  renderAccountCard();
}

function statRow(k, v, cls = '') {
  return `<div class="stat-row"><span class="k">${esc(k)}</span><span class="v ${cls}">${v}</span></div>`;
}

function renderStatusCards() {
  const link = $('#card-link');
  const si = state.serverInfo;
  link.innerHTML =
    statRow(
      '网络连接',
      { reconnecting: '重连中', syncing: '同步中', synced: '已同步' }[eventSync.snapshot().status] || '已断开',
      eventSync.snapshot().status === 'synced' ? 'ok' : eventSync.snapshot().status === 'syncing' ? 'warn' : 'err',
    ) +
    statRow('Codex 引擎', { ready: '在线', starting: '启动中', stopped: '离线', error: '错误' }[state.bridge] || state.bridge,
      state.bridge === 'ready' ? 'ok' : state.bridge === 'starting' ? 'warn' : 'err') +
    (si?.bridge?.init?.userAgent ? statRow('版本', esc(si.bridge.init.userAgent)) : '') +
    (si?.server ? statRow('主机', esc(`${si.server.host} (${si.server.platform})`)) : '');
  $('#app-version').textContent = si?.server?.version || '0.1';
  renderShareCard();
}

function renderAccountCard() {
  const c = $('#card-account');
  let html = '';
  const a = state.account?.account;
  if (a?.type === 'chatgpt') html += statRow('账户', esc(a.email || 'ChatGPT') + ` · ${esc(a.planType || '')}`);
  else if (a?.type === 'apiKey') html += statRow('账户', 'API Key');
  else if (state.account) html += statRow('账户', '未登录', 'warn');
  html = html || statRow('账户', '加载中…');
  // Context usage & account quota live in the chat page session panel (/status).
  html += statRow('额度与上下文', '对话页输入 /status 查看');
  html += `<div class="acct-actions"><button class="btn-ghost" id="btn-acct-login">登录 / 切换账号</button></div>`;
  c.innerHTML = html;
  $('#btn-acct-login', c).addEventListener('click', openLoginSheet);
}

/* ---------- 手机端登录 / 切换账号 ---------- */
async function apiPost(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': store.token },
    body: JSON.stringify(payload || {}),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function openLoginSheet() {
  sheet.open('登录 / 切换账号', (body) => {
    const acc = optRow('ChatGPT 账号登录', '打开官方授权页登录账号，与电脑上 codex login 相同', false);
    acc.addEventListener('click', async () => {
      acc.style.opacity = '0.5';
      try {
        const res = await rpc('account/login/start', { type: 'chatgpt' }, 30000);
        state.pendingLoginId = res.loginId;
        showChatgptLoginSheet(res);
      } catch (e) {
        toast('启动登录失败：' + e.message, 4000);
        acc.style.opacity = '';
      }
    });
    body.appendChild(acc);

    const api = optRow('使用 API Key', '粘贴 OpenAI API Key 完成登录', false);
    api.addEventListener('click', () => showApiKeySheet());
    body.appendChild(api);

    const out = optRow('退出当前账号', '清除本机 codex 的登录凭据', false);
    out.classList.add('opt-danger');
    out.addEventListener('click', async () => {
      try {
        await rpc('account/logout');
        toast('已退出登录');
        sheet.close();
        state.models = [];
        refreshStatusPage().catch(() => {});
      } catch (e) { toast('退出失败：' + e.message); }
    });
    body.appendChild(out);
  });
}

function showChatgptLoginSheet(res) {
  sheet.open('ChatGPT 账号登录', (body) => {
    body.appendChild(el('div', 'login-step-title', '方式一 · 人在电脑旁（推荐）'));
    body.appendChild(el('div', 'share-tip', '在电脑浏览器打开授权页，登录你的 ChatGPT 账号。完成后本页会自动确认，无需其他操作。'));
    const pc = el('button', 'btn-primary', '在电脑上打开授权页');
    pc.style.width = '100%';
    pc.addEventListener('click', async () => {
      try {
        await apiPost('/api/open-url', { url: res.authUrl });
        toast('已在电脑上打开授权页，请到电脑上完成登录');
      } catch (e) { toast('打开失败：' + e.message, 4000); }
    });
    body.appendChild(pc);

    body.appendChild(el('div', 'login-step-title', '方式二 · 只用手机'));
    body.appendChild(el('div', 'share-tip',
      '第 1 步：点击下方按钮，在手机浏览器里登录并授权。<br>' +
      '第 2 步：授权完成后会跳到一个<b>打不开的 localhost 页面</b>（这是正常的），复制浏览器地址栏里的完整网址。<br>' +
      '第 3 步：回到这里粘贴该网址并提交。'));
    const ph = el('button', 'btn-ghost', '在手机上打开授权页');
    ph.style.width = '100%';
    ph.addEventListener('click', () => window.open(res.authUrl, '_blank', 'noopener'));
    body.appendChild(ph);

    const input = el('input', 'appr-input');
    input.type = 'url';
    input.placeholder = '粘贴 http://localhost:1455/auth/callback?… ';
    input.autocapitalize = 'off';
    input.style.marginTop = '10px';
    body.appendChild(input);
    const submit = el('button', 'btn-ghost', '提交网址，完成登录');
    submit.style.cssText = 'width:100%;margin-top:10px';
    submit.addEventListener('click', async () => {
      const url = input.value.trim();
      if (!url) { toast('请先粘贴回调网址'); return; }
      submit.disabled = true;
      submit.textContent = '正在确认…';
      try {
        const r = await apiPost('/api/login-callback', { url });
        if (r.ok) {
          // 最终结果以 account/login/completed 事件为准（到达后自动关闭本弹层）
          toast('已提交，正在等待登录确认…');
        } else {
          throw new Error(`登录服务返回 ${r.status}，请重新点击上方按钮发起登录后再试`);
        }
      } catch (e) {
        toast(e.message, 5000);
        submit.disabled = false;
        submit.textContent = '提交网址，完成登录';
      }
    });
    body.appendChild(submit);
  });
}

function showApiKeySheet() {
  sheet.open('API Key 登录', (body) => {
    const input = el('input', 'appr-input');
    input.type = 'password';
    input.placeholder = 'sk-…';
    input.autocapitalize = 'off';
    body.appendChild(input);
    const btn = el('button', 'btn-primary', '登录');
    btn.style.cssText = 'width:100%;margin-top:12px';
    btn.addEventListener('click', async () => {
      const key = input.value.trim();
      if (!key) return;
      try {
        await rpc('account/login/start', { type: 'apiKey', apiKey: key });
        toast('API Key 登录成功');
        sheet.close();
        state.models = [];
        refreshStatusPage().catch(() => {});
      } catch (e) { toast('登录失败：' + e.message, 4000); }
    });
    body.appendChild(btn);
  });
}

function renderShareCard() {
  const c = $('#card-share');
  const addrs = state.serverInfo?.server?.addrs || [];
  if (!addrs.length) { c.innerHTML = statRow('局域网', '未检测到地址', 'warn'); return; }
  const url = `http://${addrs[0]}:${state.serverInfo.server.port}/#token=${encodeURIComponent(store.token)}`;
  c.innerHTML = `
    <div class="share-qr"><img src="/api/qr?token=${encodeURIComponent(store.token)}" width="164" height="164" alt="QR"></div>
    <div class="share-tip">让另一台手机扫码即可接入。二维码包含访问令牌，请勿外传。<br>局域网地址：${addrs.map((a) => `<span class="mono">${esc(a)}</span>`).join(' / ')}</div>`;
}

/* ============================== boot ============================== */
marked.setOptions({ mangle: false, headerIds: false });
renderChips();
boot();
