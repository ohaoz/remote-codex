'use strict';

const PRESET_CAPABILITIES = Object.freeze({
  'chat-only': Object.freeze([
    'status.read',
    'events.read',
    'chat.read',
    'chat.send',
    'models.read',
  ]),
  'read-only': Object.freeze([
    'status.read',
    'events.read',
    'chat.read',
    'chat.send',
    'models.read',
    'account.read',
    'fs.read',
    'terminal.read',
  ]),
  'full-control': Object.freeze([
    'status.read',
    'events.read',
    'chat.read',
    'chat.send',
    'models.read',
    'account.read',
    'fs.read',
    'thread.manage',
    'review.run',
    'approval.read',
    'approval.submit',
    'terminal.read',
    'terminal.create',
    'terminal.write',
    'terminal.resize',
    'terminal.kill',
  ]),
});

const OWNER_CAPABILITIES = Object.freeze([
  'devices.manage',
  'account.manage',
  'dangerous.grant',
]);

const CHAT_READ_METHODS = new Set([
  'thread/list',
  'thread/read',
  'thread/turns/list',
  'thread/items/list',
  'thread/backgroundTerminals/list',
  'getConversationSummary',
]);

const CHAT_SEND_METHODS = new Set([
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
]);

const MODEL_METHODS = new Set([
  'model/list',
  'collaborationMode/list',
  'permissionProfile/list',
  'config/read',
  'skills/list',
  'mcpServerStatus/list',
  'experimentalFeature/list',
]);

const ACCOUNT_READ_METHODS = new Set([
  'account/read',
  'account/rateLimits/read',
  'account/usage/read',
  'getAuthStatus',
]);

const ACCOUNT_MANAGE_METHODS = new Set([
  'account/login/start',
  'account/login/cancel',
  'account/logout',
]);

const FS_READ_METHODS = new Set([
  'fs/readDirectory',
  'fuzzyFileSearch',
  'gitDiffToRemote',
]);

const THREAD_MANAGE_METHODS = new Set([
  'thread/fork',
  'thread/archive',
  'thread/unarchive',
  'thread/delete',
  'thread/name/set',
  'thread/compact/start',
  'thread/rollback',
  'thread/backgroundTerminals/terminate',
  'thread/backgroundTerminals/clean',
]);

function principalCapabilities(principal) {
  const base = PRESET_CAPABILITIES[principal?.scope] || [];
  const capabilities = new Set(base);
  if (principal?.owner) OWNER_CAPABILITIES.forEach((entry) => capabilities.add(entry));
  return capabilities;
}

function createPrincipal(device) {
  const principal = {
    sessionId: device.sessionId || null,
    deviceId: device.deviceId || device.id,
    name: device.name || '',
    platform: device.platform || 'unknown',
    scope: device.scope || 'chat-only',
    owner: Boolean(device.owner),
    expiresAt: device.expiresAt || null,
  };
  principal.capabilities = [...principalCapabilities(principal)];
  return principal;
}

function rpcCapability(method) {
  if (CHAT_READ_METHODS.has(method)) return 'chat.read';
  if (CHAT_SEND_METHODS.has(method)) return 'chat.send';
  if (MODEL_METHODS.has(method)) return 'models.read';
  if (ACCOUNT_READ_METHODS.has(method)) return 'account.read';
  if (ACCOUNT_MANAGE_METHODS.has(method)) return 'account.manage';
  if (FS_READ_METHODS.has(method)) return 'fs.read';
  if (THREAD_MANAGE_METHODS.has(method)) return 'thread.manage';
  if (method === 'review/start') return 'review.run';
  return null;
}

function can(principal, action, resource) {
  const capabilities = principalCapabilities(principal);
  if (action === 'rpc') {
    const capability = rpcCapability(resource);
    return Boolean(capability) && capabilities.has(capability);
  }
  return capabilities.has(action);
}

function enforceRpcParams(principal, method, params = {}) {
  const safe = { ...(params || {}) };
  if (!['chat-only', 'read-only'].includes(principal?.scope)) return safe;

  if (method === 'thread/start' || method === 'thread/resume') {
    safe.approvalPolicy = 'never';
    safe.sandbox = 'read-only';
  }
  if (method === 'turn/start') {
    safe.approvalPolicy = 'never';
    safe.sandboxPolicy = { type: 'readOnly', networkAccess: false };
  }
  return safe;
}

module.exports = {
  ACCOUNT_MANAGE_METHODS,
  ACCOUNT_READ_METHODS,
  CHAT_READ_METHODS,
  CHAT_SEND_METHODS,
  FS_READ_METHODS,
  MODEL_METHODS,
  OWNER_CAPABILITIES,
  PRESET_CAPABILITIES,
  THREAD_MANAGE_METHODS,
  can,
  createPrincipal,
  enforceRpcParams,
  principalCapabilities,
  rpcCapability,
};
