'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('browser loads session controls assets before the application', () => {
  const html = read('web/index.html');
  const application = html.indexOf('<script src="/app.js"></script>');
  const helper = html.indexOf('<script src="/session-controls.js"></script>');

  assert.match(html, /<link rel="stylesheet" href="\/session-controls\.css">/);
  assert.notEqual(helper, -1, 'session controls helper script is missing');
  assert.ok(helper < application, 'session controls helper must load before app.js');
});

test('composer exposes one accessible model and effort switcher', () => {
  const html = read('web/index.html');

  assert.match(html, /id="session-controls"/);
  assert.match(html, /id="btn-session-status"[^>]+aria-label=/);
  assert.match(html, /id="btn-model-switch"[^>]+aria-label=/);
  assert.match(html, /id="model-current"/);
  assert.match(html, /id="effort-current"/);
  assert.match(html, /id="btn-command-help"[^>]+aria-label=/);
  assert.match(html, /id="context-ring"/, 'session status button must host the context gauge');
  assert.doesNotMatch(html, /id="chip-model"/, 'legacy model control must not remain');
  assert.doesNotMatch(html, /id="chip-effort"/, 'legacy effort control must not remain');
});

test('composer hosts the slash command palette', () => {
  const html = read('web/index.html');
  const app = read('web/app.js');

  assert.match(html, /id="command-suggest"/);
  assert.match(app, /function renderCommandSuggest\(\)/);
  assert.match(app, /SessionControls\.matchCommands\(input\.value\)/);
  assert.match(app, /function acceptCommandSuggestion\(/);
});

test('global status page no longer duplicates session or quota details', () => {
  const html = read('web/index.html');
  const app = read('web/app.js');

  assert.doesNotMatch(html, /id="card-session"/);
  assert.doesNotMatch(html, /ACCOUNT · 账户与额度/);
  assert.match(html, /ACCOUNT · 账户/);
  const accountCard = app.slice(
    app.indexOf('function renderAccountCard('),
    app.indexOf('/* ---------- 手机端登录'),
  );
  assert.doesNotMatch(accountCard, /m-bar/, 'quota meters must not render on the status page');
});

test('model picker force-refreshes model/list and renders catalog effort options', () => {
  const app = read('web/app.js');

  assert.match(app, /async function loadModels\(force = false\)/);
  assert.match(app, /if \(!force && state\.models\.length\)/);
  assert.match(app, /rpc\('model\/list'/);
  assert.match(app, /async function openModelPicker\(\)/);
  assert.match(app, /loadModels\(true\)/);
  assert.match(app, /SessionControls\.getEffortOptions/);
  assert.match(app, /SessionControls\.reconcileEffort/);
});

test('exact local slash commands are handled before sending to Codex', () => {
  const app = read('web/app.js');
  const sendStart = app.indexOf('async function sendMessage()');
  const sendEnd = app.indexOf('async function interruptTurn()', sendStart);
  const source = app.slice(sendStart, sendEnd);

  assert.notEqual(sendStart, -1, 'sendMessage is missing');
  assert.match(source, /SessionControls\.parseSlashCommand\(text\)/);
  assert.match(source, /runLocalCommand\(/);
  assert.match(source, /SessionControls\.isSlashLike\(text\)/, 'unknown slash drafts must not reach Codex');
  assert.ok(
    source.indexOf('SessionControls.parseSlashCommand(text)') < source.indexOf("rpc('turn/start'"),
    'local commands must be intercepted before turn/start',
  );
  assert.match(app, /case 'status':[\s\S]*openSessionStatus/);
  assert.match(app, /case 'model':[\s\S]*openModelPicker/);
});

test('codex CLI session commands are wired to app-server RPCs', () => {
  const app = read('web/app.js');

  assert.match(app, /case 'approvals':[\s\S]*openApprovalPicker/);
  assert.match(app, /case 'review':[\s\S]*openReviewPicker/);
  assert.match(app, /case 'compact':[\s\S]*runCompact/);
  assert.match(app, /case 'diff':[\s\S]*openDiffSheet/);
  assert.match(app, /case 'mcp':[\s\S]*openMcpStatus/);
  assert.match(app, /case 'skills':[\s\S]*openSkillsSheet/);
  assert.match(app, /case 'init':[\s\S]*runInitAgents/);
  assert.match(app, /case 'new':[\s\S]*newThread/);
  assert.match(app, /case 'resume':[\s\S]*drawer\.open/);
  assert.match(app, /rpc\('thread\/compact\/start'/);
  assert.match(app, /rpc\('review\/start'/);
  assert.match(app, /rpc\('mcpServerStatus\/list'/);
  assert.match(app, /rpc\('skills\/list'/);
  assert.match(app, /type: 'uncommittedChanges'/);
  assert.match(app, /type: 'baseBranch'/);
  assert.match(app, /type: 'custom'/);
});

test('session detail refreshes canonical thread and account-scoped quota', () => {
  const app = read('web/app.js');

  assert.match(app, /async function openSessionStatus\(/);
  assert.match(app, /rpc\('thread\/read'/);
  assert.match(app, /rpc\('account\/read'/);
  assert.match(app, /rpc\('account\/rateLimits\/read'/);
  assert.match(app, /SessionControls\.createSessionSnapshot/);
  assert.match(app, /账户额度/);
  assert.match(app, /剩余上下文/);
  assert.match(app, /function renderContextRing\(\)/, 'live context gauge renderer is missing');
  assert.doesNotMatch(app, /function renderSessionCard\(/, 'legacy session renderer must be removed');
});

test('gateway allowlists every RPC the session commands rely on', () => {
  const server = read('server/codex.js');
  for (const method of [
    'thread/compact/start', 'review/start', 'mcpServerStatus/list',
    'skills/list', 'model/list', 'account/rateLimits/read',
  ]) {
    assert.ok(server.includes(`'${method}'`), `${method} must stay allowlisted`);
  }
});
