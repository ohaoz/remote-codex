'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let createProductionSecurity;
try {
  ({ createProductionSecurity } = require('../server/index'));
} catch {}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-startup-auth-'));
}

test('production security creates bootstrap once and never recreates it after owner migration', () => {
  assert.equal(typeof createProductionSecurity, 'function', 'production device auth setup is missing');
  const dataDir = tempDir();
  const tokenFile = path.join(dataDir, 'token');
  const pairFile = path.join(dataDir, 'pair.png');
  fs.writeFileSync(pairFile, 'legacy qr');

  const first = createProductionSecurity({
    dataDir,
    env: {},
    clock: () => 1_000,
  });
  assert.ok(first.bootstrapToken);
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), first.bootstrapToken);

  const paired = first.deviceAuth.pair({
    code: first.bootstrapToken,
    deviceName: 'Owner phone',
  });
  assert.equal(paired.device.owner, true);
  assert.equal(fs.existsSync(tokenFile), false);
  assert.equal(fs.existsSync(pairFile), false);

  const second = createProductionSecurity({
    dataDir,
    env: {},
    clock: () => 2_000,
  });
  assert.equal(second.bootstrapToken, '');
  assert.equal(fs.existsSync(tokenFile), false);
  assert.equal(second.deviceAuth.authenticateSession(paired.sessionToken).deviceId, paired.device.id);

  second.authStore.revokeSession(paired.sessionToken.split('.')[0]);
  const recovery = createProductionSecurity({
    dataDir,
    env: {},
    clock: () => 3_000,
  });
  assert.match(recovery.bootstrapToken, /^inv_/);
  const restored = recovery.deviceAuth.pair({
    code: recovery.bootstrapToken,
    deviceName: 'Recovered owner',
  });
  assert.equal(restored.device.owner, true);
});

test('production security refuses corrupt auth state instead of minting a new bootstrap', () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, 'auth.json'), '{corrupt');

  assert.throws(
    () => createProductionSecurity({ dataDir, env: {} }),
    /auth store is corrupt/i,
  );
  assert.equal(fs.existsSync(path.join(dataDir, 'token')), false);
});
