'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let AuthStore;
let AuthStoreCorruptError;
let PairingService;
let AuditLog;
let policy;
try {
  ({ AuthStore, AuthStoreCorruptError } = require('../server/auth-store'));
  ({ PairingService } = require('../server/pairing'));
  ({ AuditLog } = require('../server/audit-log'));
  policy = require('../server/policy');
} catch {}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-auth-'));
}

test('auth store persists only secret digests and authenticates opaque sessions', () => {
  assert.equal(typeof AuthStore, 'function', 'AuthStore is missing');
  const dir = tempDir();
  const filePath = path.join(dir, 'auth.json');
  const store = new AuthStore({ filePath, clock: () => 1_000 });
  const device = store.createDevice({
    name: 'Phone',
    platform: 'ios',
    scope: 'full-control',
    owner: true,
  });
  const issued = store.issueSession(device.id, { ttlMs: 60_000 });

  const disk = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(disk, new RegExp(issued.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(disk, /"secretHash":/);

  const principal = store.authenticateSession(issued.token);
  assert.equal(principal.deviceId, device.id);
  assert.equal(principal.scope, 'full-control');
  assert.equal(principal.owner, true);

  const reloaded = new AuthStore({ filePath, clock: () => 1_000 });
  assert.equal(reloaded.authenticateSession(issued.token).deviceId, device.id);
});

test('expired and revoked device sessions fail closed', () => {
  let now = 10_000;
  const store = new AuthStore({
    filePath: path.join(tempDir(), 'auth.json'),
    clock: () => now,
  });
  const device = store.createDevice({ name: 'Tablet', scope: 'read-only' });
  const issued = store.issueSession(device.id, { ttlMs: 100 });

  now = 10_101;
  assert.equal(store.authenticateSession(issued.token), null);

  now = 20_000;
  const active = store.issueSession(device.id, { ttlMs: 1_000 });
  const invitation = store.createInvite({
    createdByDeviceId: device.id,
    scope: 'chat-only',
  });
  store.revokeDevice(device.id, { revokedAt: now });
  assert.equal(store.authenticateSession(active.token), null);
  assert.throws(() => store.consumeInvite(invitation.code), /revoked|invalid/i);
});

test('corrupt auth storage is preserved and never reset silently', () => {
  assert.equal(typeof AuthStoreCorruptError, 'function', 'AuthStoreCorruptError is missing');
  const dir = tempDir();
  const filePath = path.join(dir, 'auth.json');
  fs.writeFileSync(filePath, '{broken');

  assert.throws(
    () => new AuthStore({ filePath, clock: () => 42 }),
    AuthStoreCorruptError,
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
  assert.ok(
    fs.readdirSync(dir).some((name) => name.startsWith('auth.json.corrupt-')),
    'a diagnostic copy of corrupt storage must be preserved',
  );
});

test('legacy token migrates exactly once and invite codes are one-time and expiring', () => {
  assert.equal(typeof PairingService, 'function', 'PairingService is missing');
  let now = 100_000;
  let consumed = 0;
  const store = new AuthStore({
    filePath: path.join(tempDir(), 'auth.json'),
    clock: () => now,
  });
  const service = new PairingService({
    store,
    legacyToken: 'legacy-owner-secret',
    clock: () => now,
    onLegacyConsumed: () => { consumed += 1; },
  });

  const ownerPair = service.pair({
    code: 'legacy-owner-secret',
    deviceName: 'Owner phone',
    platform: 'ios',
  });
  assert.equal(ownerPair.device.owner, true);
  assert.equal(ownerPair.device.scope, 'full-control');
  assert.equal(consumed, 1);
  assert.throws(
    () => service.pair({ code: 'legacy-owner-secret', deviceName: 'Attacker' }),
    /invalid|used|migrated/i,
  );

  const owner = store.authenticateSession(ownerPair.sessionToken);
  const invitation = service.createInvite(owner, {
    scope: 'read-only',
    ttlMs: 5 * 60_000,
  });
  const guestPair = service.pair({
    code: invitation.code,
    deviceName: 'Guest tablet',
    platform: 'android',
  });
  assert.equal(guestPair.device.scope, 'read-only');
  assert.throws(
    () => service.pair({ code: invitation.code, deviceName: 'Replay' }),
    /invalid|used|expired/i,
  );

  const expiring = service.createInvite(owner, { scope: 'chat-only', ttlMs: 50 });
  now += 51;
  assert.throws(
    () => service.pair({ code: expiring.code, deviceName: 'Late' }),
    /expired|invalid/i,
  );
});

test('device enrollment is atomic when persistent storage fails', () => {
  const realFs = fs;
  const dir = tempDir();
  let failRename = true;
  const failingFs = {
    ...realFs,
    renameSync(source, destination) {
      if (failRename) {
        failRename = false;
        throw new Error('simulated disk failure');
      }
      return realFs.renameSync(source, destination);
    },
  };
  const store = new AuthStore({
    filePath: path.join(dir, 'auth.json'),
    fs: failingFs,
  });

  assert.throws(
    () => store.enrollDevice({
      device: { name: 'Owner', scope: 'full-control', owner: true },
      markBootstrapMigrated: true,
    }),
    /simulated disk failure/,
  );
  assert.equal(store.hasOwner(), false);
  assert.equal(store.isBootstrapMigrated(), false);
});

test('a local recovery invitation restores owner access after all owner sessions end', () => {
  const store = new AuthStore({
    filePath: path.join(tempDir(), 'auth.json'),
    clock: () => 7_000,
  });
  const owner = store.createDevice({
    name: 'Old owner',
    scope: 'full-control',
    owner: true,
  });
  const oldSession = store.issueSession(owner.id);
  store.revokeSession(oldSession.sessionId);
  assert.equal(store.hasActiveOwnerSession(), false);

  const recovery = store.createRecoveryInvite({ ttlMs: 5 * 60_000 });
  const service = new PairingService({ store, clock: () => 7_000 });
  const restored = service.pair({ code: recovery.code, deviceName: 'Recovered owner' });
  assert.equal(restored.device.owner, true);
  assert.equal(store.hasActiveOwnerSession(), true);
});

test('critical audit failure cannot consume an invite or create a device', () => {
  const store = new AuthStore({
    filePath: path.join(tempDir(), 'auth.json'),
    clock: () => 8_000,
  });
  const owner = store.createDevice({
    name: 'Owner',
    scope: 'full-control',
    owner: true,
  });
  store.issueSession(owner.id);
  const invitation = store.createInvite({
    createdByDeviceId: owner.id,
    scope: 'read-only',
  });
  const blocked = new PairingService({
    store,
    clock: () => 8_000,
    audit: {
      record() { throw new Error('audit unavailable'); },
    },
  });

  assert.throws(
    () => blocked.pair({ code: invitation.code, deviceName: 'Blocked guest' }),
    /audit unavailable/,
  );
  assert.equal(store.listDevices().length, 1);

  const allowed = new PairingService({ store, clock: () => 8_000 });
  const paired = allowed.pair({ code: invitation.code, deviceName: 'Guest' });
  assert.equal(paired.device.scope, 'read-only');
});

test('websocket tickets are one-time and bound to device, channel, and terminal', () => {
  const store = new AuthStore({
    filePath: path.join(tempDir(), 'auth.json'),
    clock: () => 5_000,
  });
  const device = store.createDevice({ name: 'Owner', scope: 'full-control', owner: true });
  const session = store.issueSession(device.id, { ttlMs: 60_000 });
  const principal = store.authenticateSession(session.token);
  const service = new PairingService({ store, clock: () => 5_000 });
  const ticket = service.issueWsTicket(principal, {
    channel: 'terminal',
    termId: '7',
    ttlMs: 30_000,
  });

  assert.equal(service.consumeWsTicket(ticket.token, {
    channel: 'terminal',
    termId: '7',
  }).deviceId, device.id);
  assert.equal(service.consumeWsTicket(ticket.token, {
    channel: 'terminal',
    termId: '7',
  }), null);

  const wrongChannel = service.issueWsTicket(principal, { channel: 'events' });
  assert.equal(service.consumeWsTicket(wrongChannel.token, {
    channel: 'terminal',
    termId: '7',
  }), null);

  const loggedOut = service.issueWsTicket(principal, { channel: 'events' });
  store.revokeSession(principal.sessionId);
  assert.equal(service.consumeWsTicket(loggedOut.token, { channel: 'events' }), null);
});

test('capability policy enforces presets and rewrites chat-only sandbox server-side', () => {
  assert.equal(typeof policy?.principalCapabilities, 'function', 'policy module is missing');
  const chat = policy.createPrincipal({ deviceId: 'chat', scope: 'chat-only' });
  const reader = policy.createPrincipal({ deviceId: 'reader', scope: 'read-only' });
  const full = policy.createPrincipal({ deviceId: 'full', scope: 'full-control' });
  const owner = policy.createPrincipal({
    deviceId: 'owner',
    scope: 'full-control',
    owner: true,
  });

  assert.equal(policy.can(chat, 'rpc', 'turn/start'), true);
  assert.equal(policy.can(chat, 'rpc', 'fs/readDirectory'), false);
  assert.equal(policy.can(chat, 'approval.submit'), false);
  assert.equal(policy.can(chat, 'terminal.read'), false);

  const forced = policy.enforceRpcParams(chat, 'turn/start', {
    threadId: 't1',
    approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'dangerFullAccess' },
  });
  assert.deepEqual(forced.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(forced.approvalPolicy, 'never');

  assert.equal(policy.can(reader, 'terminal.read'), true);
  assert.equal(policy.can(reader, 'terminal.write'), false);
  assert.equal(policy.can(full, 'terminal.write'), true);
  assert.equal(policy.can(full, 'approval.submit'), true);
  assert.equal(policy.can(full, 'devices.manage'), false);
  assert.equal(policy.can(owner, 'devices.manage'), true);
  assert.equal(policy.can(owner, 'account.manage'), true);
  assert.equal(policy.can(owner, 'unknown.action'), false);
});

test('audit log rotates, redacts sensitive fields, and fails closed for critical writes', () => {
  assert.equal(typeof AuditLog, 'function', 'AuditLog is missing');
  const dir = tempDir();
  const filePath = path.join(dir, 'audit.jsonl');
  const log = new AuditLog({ filePath, maxBytes: 220, maxFiles: 2, clock: () => 9_000 });

  log.record({
    actorDeviceId: 'owner',
    action: 'device.revoke',
    resource: 'device:guest',
    result: 'accepted',
    correlationId: 'c1',
    token: 'must-not-leak',
    apiKey: 'sk-secret',
    command: 'rm -rf secret',
  }, { critical: true });
  log.record({
    actorDeviceId: 'owner',
    action: 'device.invite',
    resource: 'scope:read-only',
    result: 'accepted',
    correlationId: 'c2',
  });

  const joined = fs.readdirSync(dir)
    .filter((name) => name.startsWith('audit.jsonl'))
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(joined, /must-not-leak|sk-secret|rm -rf/);
  assert.match(joined, /device\.revoke/);
  assert.ok(fs.readdirSync(dir).filter((name) => name.startsWith('audit.jsonl')).length <= 2);

  const failing = new AuditLog({
    filePath: path.join(dir, 'blocked', 'audit.jsonl'),
    fs: {
      ...fs,
      mkdirSync() {},
      appendFileSync() { throw new Error('disk full'); },
    },
  });
  assert.throws(
    () => failing.record({ action: 'device.revoke' }, { critical: true }),
    /disk full/,
  );
  assert.equal(
    failing.record({ action: 'status.read' }, { critical: false }),
    false,
  );
});
