'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');

function sourceBetween(startNeedle, endNeedle) {
  const start = app.indexOf(startNeedle);
  const end = app.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(start, -1, `${startNeedle} is missing`);
  assert.notEqual(end, -1, `${endNeedle} is missing`);
  return app.slice(start, end);
}

test('browser loads reconnect state machine before the application', () => {
  const reconnect = html.indexOf('<script src="/reconnect.js"></script>');
  const application = html.indexOf('<script src="/app.js"></script>');

  assert.notEqual(reconnect, -1, 'reconnect helper script is missing');
  assert.ok(reconnect < application, 'reconnect helper must load before app.js');
});

test('gateway hello, live events, and replay results carry synchronization metadata', () => {
  assert.match(server, /protocolVersion\s*:/, 'hello must advertise protocolVersion');
  assert.match(server, /streamId\s*:\s*bridge\.streamId/, 'hello must advertise the current streamId');
  assert.match(server, /type:\s*'replay-result'/, 'replay must answer with replay-result');
  assert.match(server, /bridge\.replaySince\(/, 'replay must use sequence-aware event log');
  assert.match(server, /seq:\s*evt\.seq/, 'live event envelope must carry seq');
  assert.match(server, /threadId:\s*evt\.threadId/, 'live event envelope must carry threadId');
  assert.match(server, /streamId:\s*evt\.streamId/, 'live event envelope must carry streamId');
});

test('browser transport rejects pending RPCs when its socket closes', () => {
  assert.match(app, /function rejectPendingRpcForGeneration\(/);
  assert.match(app, /rejectPendingRpcForGeneration\(generation/);
  assert.match(app, /generation,\s*method/, 'pending RPC entries must remember their socket generation');
  const sendStart = app.indexOf('function wsSendForGeneration(');
  const sendEnd = app.indexOf('function applyEventSyncResult(', sendStart);
  const send = app.slice(sendStart, sendEnd);
  assert.match(send, /try\s*\{[\s\S]*ws\.send/, 'socket sends must tolerate a concurrent close');
  assert.match(send, /catch\s*\{[\s\S]*return false/, 'failed sends must report failure to callers');
  const connectStart = app.indexOf('function connectEvents(');
  const connectEnd = app.indexOf('function rpc(', connectStart);
  const connect = app.slice(connectStart, connectEnd);
  const rejectOld = connect.indexOf('rejectPendingRpcForGeneration(previousGeneration');
  const beginNew = connect.indexOf('eventSync.beginSocket()');
  assert.ok(rejectOld >= 0 && rejectOld < beginNew, 'superseded sockets must reject their RPCs immediately');
  const clearReset = connect.indexOf('state.pendingReplayReset = null');
  assert.ok(clearReset >= 0 && clearReset < beginNew, 'superseded sockets must discard deferred replay resets');
});

test('browser rebuilds canonical history before completing a required reset', () => {
  assert.match(app, /ReconnectSync\.create\(/, 'app must use the reconnect state machine');
  assert.match(app, /case 'replay-result'/, 'app must handle replay-result');
  assert.match(app, /rpc\('thread\/read'/, 'reset recovery must read canonical history');
  assert.match(app, /completeReset\(/, 'reset recovery must explicitly finish synchronization');
});

test('canonical completed item content overwrites streamed accumulators', () => {
  const agent = sourceBetween('function renderAgentItem(', 'function onAgentDelta(');
  const agentDelta = sourceBetween('function onAgentDelta(', 'const renderQueue');
  const thought = sourceBetween('function renderThoughtItem(', 'function onThoughtDelta(');
  const thoughtDelta = sourceBetween('function onThoughtDelta(', 'const ICONS');
  const command = sourceBetween('function renderCmdItem(', 'function onCmdOutput(');
  const commandDelta = sourceBetween('function onCmdOutput(', 'function renderDiffInto(');

  assert.doesNotMatch(agent, /\.length\s*>=/, 'agent canonical text must not use a length heuristic');
  assert.match(agent, /entry\.text\s*=\s*item\.text/, 'agent canonical text must overwrite accumulated text');
  assert.match(agent, /entry\.canonical\s*=\s*true/, 'agent completion must mark canonical content');
  assert.match(agentDelta, /entry\.canonical/, 'later replay deltas must not append to canonical agent content');
  assert.doesNotMatch(thought, /\.length\s*>=/, 'reasoning canonical text must not use a length heuristic');
  assert.match(thought, /entry\.text\s*=\s*joined/, 'reasoning canonical text must overwrite accumulated text');
  assert.match(thought, /entry\.canonical\s*=\s*true/, 'reasoning completion must mark canonical content');
  assert.match(thoughtDelta, /entry\.canonical/, 'later replay deltas must not append to canonical reasoning');
  assert.doesNotMatch(command, /agg\.length\s*>/, 'command canonical output must not use a length heuristic');
  assert.match(command, /entry\.outText\s*=\s*agg/, 'command canonical output must overwrite accumulated output');
  assert.match(command, /entry\.canonical\s*=\s*true/, 'command completion must mark canonical output');
  assert.match(commandDelta, /entry\.canonical/, 'later replay deltas must not append to canonical command output');
});

test('queued reasoning renders share one mutable target with canonical completion', () => {
  const thoughtFactory = sourceBetween('function makeThoughtEntry(', 'function renderThoughtItem(');
  const thought = sourceBetween('function renderThoughtItem(', 'function onThoughtDelta(');
  const thoughtDelta = sourceBetween('function onThoughtDelta(', 'const ICONS');

  assert.match(thoughtFactory, /renderTarget/, 'reasoning items need a stable queued render target');
  assert.match(
    thought,
    /entry\.renderTarget\.text\s*=\s*entry\.text/,
    'completion must update the queued target to canonical text',
  );
  assert.match(thoughtDelta, /throttleRender\(entry\.renderTarget\)/);
  assert.doesNotMatch(
    thoughtDelta,
    /renderQueue\.add\(\{/,
    'per-delta snapshot objects can overwrite canonical completion after the timer fires',
  );
});
