'use strict';

(function exposeSessionControls(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SessionControls = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  /**
   * Slash commands implemented by this client, mirroring the Codex CLI
   * command palette. Commands with `acceptsArgs` take free text after the
   * command name (e.g. `/review 重点检查登录流程`).
   */
  const COMMANDS = Object.freeze([
    Object.freeze({
      command: '/status',
      action: 'status',
      title: '会话状态',
      description: '刷新并查看会话设置、上下文剩余与账户额度',
      acceptsArgs: false,
    }),
    Object.freeze({
      command: '/model',
      action: 'model',
      title: '模型与推理',
      description: '刷新模型目录并切换模型与推理强度',
      acceptsArgs: false,
    }),
    Object.freeze({
      command: '/approvals',
      action: 'approvals',
      title: '审批策略',
      description: '选择 Codex 何时需要请求你的批准',
      acceptsArgs: false,
    }),
    Object.freeze({
      command: '/review',
      action: 'review',
      title: '代码审查',
      description: '审查未提交修改、分支差异或自定义目标',
      acceptsArgs: true,
      argHint: '[审查要求]',
    }),
    Object.freeze({
      command: '/new',
      action: 'new',
      title: '新建会话',
      description: '开始一个全新的会话',
      acceptsArgs: false,
    }),
    Object.freeze({
      command: '/resume',
      action: 'resume',
      title: '恢复会话',
      description: '打开历史会话列表并恢复',
      acceptsArgs: false,
    }),
    Object.freeze({
      command: '/compact',
      action: 'compact',
      title: '压缩上下文',
      description: '摘要化会话历史，释放上下文窗口空间',
      acceptsArgs: false,
    }),
    Object.freeze({
      command: '/diff',
      action: 'diff',
      title: '本回合变更',
      description: '查看本回合产生的文件差异',
      acceptsArgs: false,
    }),
    Object.freeze({
      command: '/mcp',
      action: 'mcp',
      title: 'MCP 服务器',
      description: '查看已配置的 MCP 服务器与工具状态',
      acceptsArgs: false,
    }),
    Object.freeze({
      command: '/skills',
      action: 'skills',
      title: '技能列表',
      description: '查看当前会话可用的技能',
      acceptsArgs: false,
    }),
    Object.freeze({
      command: '/init',
      action: 'init',
      title: '初始化 AGENTS.md',
      description: '让 Codex 为当前仓库生成贡献者指南',
      acceptsArgs: false,
    }),
  ]);

  function normalized(value) {
    return String(value ?? '').trim();
  }

  function firstToken(value) {
    const input = normalized(value);
    return input ? input.split(/\s+/)[0] : '';
  }

  /**
   * A message is "slash-like" when its first token looks like a command name:
   * one leading slash followed by letters. Paths such as `/usr/bin` contain a
   * second slash and fall through to Codex as a normal message.
   */
  function isSlashLike(value) {
    const head = firstToken(value);
    return head === '/' || /^\/[A-Za-z][\w-]*$/.test(head);
  }

  function parseSlashCommand(value) {
    const input = normalized(value);
    if (!input.startsWith('/')) return null;
    const head = firstToken(input);
    const args = input.slice(head.length).trim();
    const match = COMMANDS.find((entry) => entry.command === head);
    if (!match) return null;
    if (args && !match.acceptsArgs) return null;
    return { command: match.command, action: match.action, args };
  }

  /** Prefix matching for the composer autocomplete strip. */
  function matchCommands(value) {
    const input = String(value ?? '').trimStart();
    if (!input.startsWith('/')) return [];
    const head = firstToken(input);
    if (!/^\/[\w-]*$/.test(head)) return [];
    const hasArgs = normalized(input).length > head.length;
    if (hasArgs) {
      const exact = COMMANDS.find((entry) => entry.command === head && entry.acceptsArgs);
      return exact ? [{ ...exact }] : [];
    }
    return COMMANDS.filter((entry) => entry.command.startsWith(head)).map((entry) => ({ ...entry }));
  }

  function getCommandHelp() {
    return COMMANDS.map((entry) => ({ ...entry }));
  }

  function modelId(model) {
    return model && (model.model || model.id) || '';
  }

  function getVisibleModels(models) {
    return (Array.isArray(models) ? models : []).filter((model) => model && !model.hidden && modelId(model));
  }

  function findModel(models, id) {
    const visible = getVisibleModels(models);
    return visible.find((model) => modelId(model) === id)
      || (!id ? visible.find((model) => model.isDefault) : null)
      || null;
  }

  function getEffortOptions(models, id) {
    const model = findModel(models, id);
    if (!model) return [];
    return (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
      .filter((option) => option && option.reasoningEffort)
      .map((option) => ({
        id: option.reasoningEffort,
        description: option.description || '',
        isDefault: option.reasoningEffort === model.defaultReasoningEffort,
      }));
  }

  function reconcileEffort(models, model, effort) {
    if (!effort) return '';
    return getEffortOptions(models, model).some((option) => option.id === effort) ? effort : '';
  }

  function resolveModelSelection({ models, prefs, threadSettings } = {}) {
    const preferences = prefs || {};
    const active = threadSettings || {};
    const catalogDefault = findModel(models, '');
    const activeModel = active.model || '';
    const selectedModel = preferences.model || activeModel || modelId(catalogDefault);
    const selectedCatalogModel = findModel(models, selectedModel);
    const activeEffort = active.effort || '';
    const selectedEffort = preferences.effort
      || (selectedModel === activeModel ? activeEffort : '')
      || selectedCatalogModel?.defaultReasoningEffort
      || '';
    const pending = Boolean(
      (preferences.model && preferences.model !== activeModel)
      || (preferences.effort && preferences.effort !== activeEffort),
    );

    return {
      activeModel,
      activeEffort,
      selectedModel,
      selectedEffort,
      displayName: selectedCatalogModel?.displayName || selectedModel || '默认模型',
      pending,
    };
  }

  function clampPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(100, Math.round(numeric)));
  }

  function contextSnapshot(tokenUsage) {
    const totalTokens = Number(tokenUsage?.total?.totalTokens) || 0;
    const usedTokens = Math.max(0, Number(tokenUsage?.last?.totalTokens) || 0);
    const windowTokens = Math.max(0, Number(tokenUsage?.modelContextWindow) || 0);
    if (!windowTokens) return { totalTokens, context: null };
    const boundedUsed = Math.min(usedTokens, windowTokens);
    const usedPercent = clampPercent((boundedUsed / windowTokens) * 100);
    return {
      totalTokens,
      context: {
        usedTokens: boundedUsed,
        windowTokens,
        remainingTokens: Math.max(0, windowTokens - boundedUsed),
        usedPercent,
        remainingPercent: 100 - usedPercent,
      },
    };
  }

  function approvalName(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && value.granular) return 'granular';
    return '';
  }

  function sandboxName(value) {
    if (typeof value === 'string') return value;
    const names = {
      readOnly: 'read-only',
      workspaceWrite: 'workspace-write',
      dangerFullAccess: 'danger-full-access',
      externalSandbox: 'external-sandbox',
    };
    return names[value?.type] || value?.type || '';
  }

  function accountIdentity(accountResponse) {
    const account = accountResponse?.account;
    if (account?.type === 'chatgpt') {
      return [account.email || 'ChatGPT', account.planType].filter(Boolean).join(' · ');
    }
    if (account?.type === 'apiKey') return 'API Key';
    if (account?.type === 'amazonBedrock') return 'Amazon Bedrock';
    return accountResponse ? '未登录' : '加载中…';
  }

  function windowLabel(window, fallback) {
    const minutes = Number(window?.windowDurationMins);
    if (minutes === 300) return '5 小时窗口';
    if (minutes === 10080) return '每周窗口';
    if (minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440} 天窗口`;
    if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
    return fallback;
  }

  function quotaWindows(rateLimitsResponse) {
    const limits = rateLimitsResponse?.rateLimits || rateLimitsResponse || {};
    const windows = [];
    if (limits.primary) {
      windows.push({
        label: windowLabel(limits.primary, '主要窗口'),
        usedPercent: clampPercent(limits.primary.usedPercent),
        resetsAt: limits.primary.resetsAt || null,
      });
    }
    if (limits.secondary) {
      windows.push({
        label: windowLabel(limits.secondary, '次要窗口'),
        usedPercent: clampPercent(limits.secondary.usedPercent),
        resetsAt: limits.secondary.resetsAt || null,
      });
    }
    return windows;
  }

  function createSessionSnapshot({
    thread,
    threadSettings,
    prefs,
    tokenUsage,
    account,
    rateLimits,
  } = {}) {
    const settings = threadSettings || {};
    const preferences = prefs || {};
    const tokens = contextSnapshot(tokenUsage);
    return {
      session: {
        name: thread?.name || thread?.preview || (thread ? '未命名会话' : '尚未开始'),
        id: thread?.id || '',
        cwd: settings.cwd || thread?.cwd || preferences.cwd || '默认目录',
        model: settings.model || preferences.model || '默认模型',
        effort: settings.effort || preferences.effort || '默认',
        approval: approvalName(settings.approvalPolicy) || preferences.approval || '默认',
        sandbox: sandboxName(settings.sandbox || settings.sandboxPolicy) || preferences.sandbox || '默认',
        totalTokens: tokens.totalTokens,
        context: tokens.context,
      },
      account: {
        label: '账户额度',
        identity: accountIdentity(account),
        windows: quotaWindows(rateLimits),
      },
    };
  }

  return {
    parseSlashCommand,
    matchCommands,
    isSlashLike,
    getCommandHelp,
    getVisibleModels,
    getEffortOptions,
    reconcileEffort,
    resolveModelSelection,
    createSessionSnapshot,
  };
});
