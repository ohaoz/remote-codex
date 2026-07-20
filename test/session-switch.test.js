'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let runThreadSwitch;
try {
  ({ runThreadSwitch } = require('../web/session-switch'));
} catch {}

test('failed switch leaves the current session untouched and unlocks input', async () => {
  const events = [];
  let committed = false;

  assert.equal(typeof runThreadSwitch, 'function', 'thread switch transaction helper is missing');

  await assert.rejects(
    runThreadSwitch({
      setPending(pending) {
        events.push(`pending:${pending}`);
      },
      async load() {
        events.push('load');
        throw new Error('resume failed');
      },
      commit() {
        committed = true;
      },
    }),
    /resume failed/,
  );

  assert.equal(committed, false);
  assert.deepEqual(events, ['pending:true', 'load', 'pending:false']);
});

test('successful switch commits only after loading has finished', async () => {
  const events = [];
  let finishLoading;
  let committed = false;
  const loaded = new Promise((resolve) => { finishLoading = resolve; });

  assert.equal(typeof runThreadSwitch, 'function', 'thread switch transaction helper is missing');

  const switching = runThreadSwitch({
    setPending(pending) {
      events.push(`pending:${pending}`);
    },
    async load() {
      events.push('load');
      return loaded;
    },
    commit(result) {
      committed = true;
      events.push(`commit:${result.thread.id}`);
    },
  });

  await Promise.resolve();
  assert.equal(committed, false);
  assert.deepEqual(events, ['pending:true', 'load']);

  finishLoading({ thread: { id: 'new-thread' } });
  await switching;

  assert.equal(committed, true);
  assert.deepEqual(events, ['pending:true', 'load', 'commit:new-thread', 'pending:false']);
});
