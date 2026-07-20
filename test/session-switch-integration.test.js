'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

function functionSource(name, nextName) {
  const start = app.indexOf(`async function ${name}(`);
  const end = app.indexOf(`async function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `${name} is missing`);
  assert.notEqual(end, -1, `${nextName} is missing`);
  return app.slice(start, end);
}

test('browser loads the session transaction helper before the application', () => {
  const helper = html.indexOf('<script src="/session-switch.js"></script>');
  const application = html.indexOf('<script src="/app.js"></script>');

  assert.notEqual(helper, -1, 'session switch helper script is missing');
  assert.ok(helper < application, 'session switch helper must load before app.js');
});

test('new thread keeps the current view until thread creation succeeds', () => {
  const source = functionSource('newThread', 'resumeThread');
  const transaction = source.indexOf('SessionSwitch.runThreadSwitch');
  const commit = source.indexOf('commit(');
  const reset = source.indexOf('resetChat()');

  assert.notEqual(transaction, -1, 'newThread must use the transaction helper');
  assert.ok(commit > transaction, 'newThread must define a commit phase');
  assert.ok(reset > commit, 'newThread must reset the view only inside the commit phase');
});

test('resume keeps the current view until both resume and history loading succeed', () => {
  const source = functionSource('resumeThread', 'interruptTurn');
  const transaction = source.indexOf('SessionSwitch.runThreadSwitch');
  const load = source.indexOf('async load(');
  const resume = source.indexOf("rpc('thread/resume'");
  const read = source.indexOf("rpc('thread/read'");
  const commit = source.indexOf('commit(');
  const reset = source.indexOf('resetChat()');

  assert.notEqual(transaction, -1, 'resumeThread must use the transaction helper');
  assert.ok(load > transaction, 'resumeThread must define a load phase');
  assert.ok(resume > load && read > resume, 'resume and history must finish during the load phase');
  assert.ok(commit > read, 'resumeThread must commit only after history loading');
  assert.ok(reset > commit, 'resumeThread must reset the view only inside the commit phase');
});

test('composer exposes the active session and working directory while switching is locked', () => {
  assert.match(html, /id="execution-context"/, 'composer execution context is missing');
  assert.match(app, /function renderExecutionContext\(\)/, 'execution context renderer is missing');
  assert.match(app, /state\.threadSettings\?\.cwd/, 'execution context must use the active thread cwd');
  assert.match(app, /state\.threadSwitching/, 'thread switching state is missing');
  assert.match(app, /input\.disabled = pending/, 'composer input must be locked while switching');
});
