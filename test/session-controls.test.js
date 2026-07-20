'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let SessionControls;
try {
  SessionControls = require('../web/session-controls');
} catch {}

test('recognizes the locally implemented slash commands, mirroring codex CLI', () => {
  assert.equal(typeof SessionControls?.parseSlashCommand, 'function', 'session controls module is missing');
  assert.deepEqual(SessionControls.parseSlashCommand('  /status  '), {
    command: '/status',
    action: 'status',
    args: '',
  });
  assert.deepEqual(SessionControls.parseSlashCommand('/model'), {
    command: '/model',
    action: 'model',
    args: '',
  });
  for (const [command, action] of [
    ['/approvals', 'approvals'],
    ['/new', 'new'],
    ['/resume', 'resume'],
    ['/compact', 'compact'],
    ['/diff', 'diff'],
    ['/mcp', 'mcp'],
    ['/skills', 'skills'],
    ['/init', 'init'],
  ]) {
    assert.deepEqual(SessionControls.parseSlashCommand(command), { command, action, args: '' });
  }
  // /review forwards free text as its argument.
  assert.deepEqual(SessionControls.parseSlashCommand('/review 重点检查登录流程'), {
    command: '/review',
    action: 'review',
    args: '重点检查登录流程',
  });
  // Commands without argument support reject trailing text.
  assert.equal(SessionControls.parseSlashCommand('/status now'), null);
  assert.equal(SessionControls.parseSlashCommand('/MODEL'), null);
  assert.equal(SessionControls.parseSlashCommand('/nonexistent'), null);
});

test('slash-likeness separates command drafts from paths and prose', () => {
  assert.equal(typeof SessionControls?.isSlashLike, 'function', 'slash-likeness helper is missing');
  assert.equal(SessionControls.isSlashLike('/mod'), true);
  assert.equal(SessionControls.isSlashLike('/'), true);
  assert.equal(SessionControls.isSlashLike('/unknown thing'), true);
  assert.equal(SessionControls.isSlashLike('/usr/bin/env node'), false);
  assert.equal(SessionControls.isSlashLike('hello /model'), false);
});

test('prefix matching powers the composer command palette', () => {
  assert.equal(typeof SessionControls?.matchCommands, 'function', 'command matching helper is missing');
  assert.deepEqual(
    SessionControls.matchCommands('/re').map((entry) => entry.command),
    ['/review', '/resume'],
  );
  assert.ok(SessionControls.matchCommands('/').length >= 10, 'a bare slash must list every command');
  assert.deepEqual(SessionControls.matchCommands('plain text'), []);
  assert.deepEqual(SessionControls.matchCommands('/nonexistent'), []);
  // Once arguments are being typed only arg-accepting commands stay matched.
  assert.deepEqual(
    SessionControls.matchCommands('/review focus on auth').map((entry) => entry.command),
    ['/review'],
  );
  assert.deepEqual(SessionControls.matchCommands('/status extra'), []);
});

test('derives model and effort choices only from the live model catalog', () => {
  assert.equal(typeof SessionControls?.getVisibleModels, 'function', 'model catalog helper is missing');
  const models = [
    {
      id: 'hidden',
      model: 'hidden',
      hidden: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
    },
    {
      id: 'gpt-a',
      model: 'gpt-a',
      displayName: 'GPT A',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast' },
        { reasoningEffort: 'medium', description: 'Balanced' },
      ],
    },
  ];

  assert.deepEqual(SessionControls.getVisibleModels(models).map((model) => model.model), ['gpt-a']);
  assert.deepEqual(SessionControls.getEffortOptions(models, 'gpt-a'), [
    { id: 'low', description: 'Fast', isDefault: false },
    { id: 'medium', description: 'Balanced', isDefault: true },
  ]);
  assert.equal(SessionControls.reconcileEffort(models, 'gpt-a', 'low'), 'low');
  assert.equal(SessionControls.reconcileEffort(models, 'gpt-a', 'ultra'), '');
  assert.deepEqual(SessionControls.getEffortOptions(models, 'unknown'), []);
});

test('distinguishes active model settings from pending next-turn overrides', () => {
  assert.equal(typeof SessionControls?.resolveModelSelection, 'function', 'model selection helper is missing');
  const models = [{
    id: 'gpt-b',
    model: 'gpt-b',
    displayName: 'GPT B',
    isDefault: true,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'Deep' },
    ],
  }];

  assert.deepEqual(SessionControls.resolveModelSelection({
    models,
    prefs: { model: 'gpt-b', effort: 'high' },
    threadSettings: { model: 'gpt-a', effort: 'low' },
  }), {
    activeModel: 'gpt-a',
    activeEffort: 'low',
    selectedModel: 'gpt-b',
    selectedEffort: 'high',
    displayName: 'GPT B',
    pending: true,
  });
});

test('resolves next-turn model and reasoning effort from explicit preferences then catalog defaults', () => {
  assert.equal(
    typeof SessionControls?.resolveTurnModelOverrides,
    'function',
    'turn model override helper is missing',
  );
  const models = [
    {
      model: 'gpt-a',
      isDefault: true,
      defaultReasoningEffort: 'medium',
    },
    {
      model: 'gpt-b',
      defaultReasoningEffort: 'low',
    },
  ];

  assert.deepEqual(SessionControls.resolveTurnModelOverrides({
    models,
    prefs: { model: 'gpt-b', effort: '' },
    threadSettings: { model: 'gpt-a', effort: 'high' },
  }), {
    model: 'gpt-b',
    effort: 'low',
  });
  assert.deepEqual(SessionControls.resolveTurnModelOverrides({
    models,
    prefs: { model: 'gpt-b', effort: 'high' },
    threadSettings: { model: 'gpt-a', effort: 'medium' },
  }), {
    model: 'gpt-b',
    effort: 'high',
  });
});

test('explicit local-default sentinel overrides the active thread with catalog defaults', () => {
  assert.equal(
    typeof SessionControls?.LOCAL_MODEL_DEFAULT,
    'string',
    'local-default model sentinel is missing',
  );
  const models = [
    { model: 'gpt-current', defaultReasoningEffort: 'high' },
    { model: 'gpt-default', isDefault: true, defaultReasoningEffort: 'medium' },
  ];

  assert.deepEqual(SessionControls.resolveTurnModelOverrides({
    models,
    prefs: { model: SessionControls.LOCAL_MODEL_DEFAULT, effort: '' },
    threadSettings: { model: 'gpt-current', effort: 'high' },
  }), {
    model: 'gpt-default',
    effort: 'medium',
  });
});

test('local-default sentinel remains pending when only the default effort differs', () => {
  const selection = SessionControls.resolveModelSelection({
    models: [{ model: 'gpt-default', isDefault: true, defaultReasoningEffort: 'medium' }],
    prefs: { model: SessionControls.LOCAL_MODEL_DEFAULT, effort: '' },
    threadSettings: { model: 'gpt-default', effort: 'high' },
  });

  assert.equal(selection.selectedModel, 'gpt-default');
  assert.equal(selection.selectedEffort, 'medium');
  assert.equal(selection.pending, true);
});

test('explicit default effort sentinel restores the catalog default from active high', () => {
  assert.equal(
    typeof SessionControls?.LOCAL_EFFORT_DEFAULT,
    'string',
    'default effort sentinel is missing',
  );
  assert.deepEqual(SessionControls.resolveTurnModelOverrides({
    models: [{
      model: 'gpt-current',
      isDefault: true,
      defaultReasoningEffort: 'medium',
    }],
    prefs: { model: '', effort: SessionControls.LOCAL_EFFORT_DEFAULT },
    threadSettings: { model: 'gpt-current', effort: 'high' },
  }), {
    model: 'gpt-current',
    effort: 'medium',
  });
});

test('builds session detail with context remaining and explicitly account-scoped quota', () => {
  assert.equal(typeof SessionControls?.createSessionSnapshot, 'function', 'session snapshot helper is missing');
  const snapshot = SessionControls.createSessionSnapshot({
    thread: {
      id: '0190-thread-id',
      name: '修复登录',
      cwd: 'G:\\repo',
    },
    threadSettings: {
      cwd: 'G:\\repo',
      model: 'gpt-5',
      effort: 'high',
      approvalPolicy: 'on-request',
      sandbox: { type: 'workspaceWrite' },
    },
    prefs: {},
    tokenUsage: {
      total: { totalTokens: 32000 },
      last: { totalTokens: 24000 },
      modelContextWindow: 64000,
    },
    account: {
      account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' },
    },
    rateLimits: {
      rateLimits: {
        primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1234 },
        secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: 5678 },
      },
    },
  });

  assert.deepEqual(snapshot.session, {
    name: '修复登录',
    id: '0190-thread-id',
    cwd: 'G:\\repo',
    model: 'gpt-5',
    effort: 'high',
    approval: 'on-request',
    sandbox: 'workspace-write',
    totalTokens: 32000,
    context: {
      usedTokens: 24000,
      windowTokens: 64000,
      remainingTokens: 40000,
      usedPercent: 38,
      remainingPercent: 62,
    },
  });
  assert.equal(snapshot.account.label, '账户额度');
  assert.equal(snapshot.account.identity, 'dev@example.com · pro');
  assert.deepEqual(snapshot.account.windows.map(({ label, usedPercent }) => ({ label, usedPercent })), [
    { label: '5 小时窗口', usedPercent: 35 },
    { label: '每周窗口', usedPercent: 70 },
  ]);
});

test('command help exposes the codex CLI-style command set this client implements', () => {
  assert.equal(typeof SessionControls?.getCommandHelp, 'function', 'command help helper is missing');
  assert.deepEqual(SessionControls.getCommandHelp().map((entry) => entry.command), [
    '/status', '/model', '/approvals', '/review', '/new', '/resume',
    '/compact', '/diff', '/mcp', '/skills', '/init',
  ]);
  for (const entry of SessionControls.getCommandHelp()) {
    assert.ok(entry.title, `${entry.command} needs a title`);
    assert.ok(entry.description, `${entry.command} needs a description`);
    assert.equal(typeof entry.acceptsArgs, 'boolean', `${entry.command} needs acceptsArgs`);
  }
});
