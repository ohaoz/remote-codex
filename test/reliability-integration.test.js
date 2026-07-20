'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('browser loads all reliability helpers before the application', () => {
  const html = read('web/index.html');
  const application = html.indexOf('<script src="/app.js"></script>');
  for (const helper of ['reconnect.js', 'approval-state.js', 'pty-reconnect.js']) {
    const index = html.indexOf(`<script src="/${helper}"></script>`);
    assert.notEqual(index, -1, `${helper} is not loaded`);
    assert.ok(index < application, `${helper} must load before app.js`);
  }
});

test('event transport guards callbacks and pending RPC by socket generation', () => {
  const app = read('web/app.js');
  assert.match(app, /const eventSync = ReconnectSync\.create\(\)/);
  assert.match(app, /const generation = eventSync\.beginSocket\(\)/);
  assert.match(app, /eventSync\.isCurrentGeneration\(generation\)/);
  assert.match(app, /rejectPendingRpcForGeneration\(generation/);
  assert.match(app, /generation,\s*method/);
  assert.match(app, /case 'replay-result'/);
  assert.match(app, /rpc\('thread\/read'/);
  assert.match(app, /completeReset\(generation/);
  assert.match(app, /pendingReplayReset/, 'app-server restart reset must wait for canonical read readiness');
  assert.match(
    app,
    /case 'bridge-status':[\s\S]*msg\.state === 'ready'[\s\S]*finishCanonicalReset/,
    'a ready app-server must resume a deferred canonical rebuild',
  );
});

test('event synchronization locks mutations and exposes all three link states', () => {
  const app = read('web/app.js');
  assert.match(app, /function mutationsLocked\(\)/);
  assert.match(app, /eventSync\.snapshot\(\)\.status/);
  assert.match(app, /state\.bridge\s*!==\s*'ready'/);
  assert.match(app, /重连中/);
  assert.match(app, /同步中/);
  assert.match(app, /已同步/);
  assert.match(app, /input\.disabled\s*=\s*locked/);
  assert.match(app, /btn\.disabled\s*=\s*locked/);
  assert.match(app, /modelSwitchButton\.disabled\s*=\s*locked/);
});

test('approval UI sends stable submissions and handles ack before removal', () => {
  const app = read('web/app.js');
  const approvalState = read('web/approval-state.js');
  assert.match(app, /ApprovalState\.create\(/);
  assert.match(app, /submissionId/);
  assert.match(app, /case 'approval-ack'/);
  assert.match(app, /approvalFlow\.ack\(/);
  assert.match(app, /approvalFlow\.retry\(/);
  const retryStart = app.indexOf('function retryApproval(');
  const retryEnd = app.indexOf('function renderApprovalState(', retryStart);
  assert.match(
    app.slice(retryStart, retryEnd),
    /if\s*\(!wsSend\([\s\S]*approvalFlow\.connectionLost\(\)/,
    'retry must become retryable again when its socket send loses the race',
  );
  assert.match(approvalState, /已由其他客户端处理/);
  assert.match(app, /entry\.context\?\.files/);
});

test('a reused approval rpc id rebuilds the card for the new request lifecycle', () => {
  const app = read('web/app.js');
  const addStart = app.indexOf('function addApproval(');
  const addEnd = app.indexOf('function removeApproval(', addStart);
  const source = app.slice(addStart, addEnd);

  assert.notEqual(addStart, -1, 'addApproval is missing');
  assert.match(source, /const previousFlow = approvalFlow\.get\(/);
  assert.match(source, /const flow = approvalFlow\.add\(/);
  assert.match(source, /flow !== previousFlow/, 'request lifecycle reuse must be detected');
  assert.match(source, /existingCard\?\.remove\(\)/, 'the stale card and handlers must be replaced');
});

test('gateway uses structured approval protocol and terminal sync frames', () => {
  const server = read('server/index.js');
  const app = read('web/app.js');
  assert.match(server, /submitApproval\(/);
  assert.match(server, /submissionId/);
  assert.match(server, /type:\s*'bridge-status'[\s\S]*approvals:\s*bridge\.listPendingApprovals\(\)/);
  assert.match(app, /case 'bridge-status':[\s\S]*reconcileGatewayApprovals\(/);
  assert.match(server, /terminalSyncFrames\(/);
  assert.match(server, /sync-begin/);
  assert.match(server, /sync-end/);
});

test('terminal UI has a generation-safe reconnect loop and explicit status', () => {
  const html = read('web/index.html');
  const app = read('web/app.js');
  assert.match(html, /id="term-connection-status"/);
  assert.match(app, /PtyReconnect\.create\(/);
  assert.match(app, /onSyncBegin\(/);
  assert.match(app, /state\.term\.xterm\.reset\(\)/);
  assert.match(app, /onSyncEnd\(/);
  assert.match(app, /setTimeout\([\s\S]*?connectTermWs\(id,\s*\{\s*retry:\s*true\s*\}\)/);
});
