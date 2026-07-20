'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');

let defaultDataDir;
try {
  ({ defaultDataDir } = require('../server/index'));
} catch {}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('package exposes a global codex-remote command that runs without a checkout', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.equal(pkg.bin?.['codex-remote'], 'bin/codex-remote.js', 'bin entry is missing');
  assert.notEqual(pkg.private, true, 'private:true blocks npm publish / npm install -g');
  for (const required of ['bin/', 'server/', 'web/']) {
    assert.ok(pkg.files?.includes(required), `published package must ship ${required}`);
  }

  const launcher = fs.readFileSync(path.join(root, 'bin', 'codex-remote.js'), 'utf8');
  assert.match(launcher, /^#!\/usr\/bin\/env node/, 'launcher needs a node shebang');
  assert.match(launcher, /require\('\.\.\/server\/index'\)/, 'launcher must reuse the gateway entry point');
});

test('data dir stays in the checkout for development and moves to the profile for global installs', () => {
  assert.equal(typeof defaultDataDir, 'function', 'defaultDataDir is missing');
  const home = tempDir('codex-remote-home-');
  const homedir = () => home;

  const override = tempDir('codex-remote-override-');
  assert.equal(
    defaultDataDir({ env: { CODEX_REMOTE_DATA_DIR: override }, rootDir: tempDir('codex-remote-any-'), homedir }),
    path.resolve(override),
    'explicit CODEX_REMOTE_DATA_DIR must win',
  );

  const checkout = tempDir('codex-remote-checkout-');
  fs.mkdirSync(path.join(checkout, '.git'));
  assert.equal(
    defaultDataDir({ env: {}, rootDir: checkout, homedir }),
    path.join(checkout, '.data'),
    'a git checkout keeps its local .data',
  );

  const legacy = tempDir('codex-remote-legacy-');
  fs.mkdirSync(path.join(legacy, '.data'));
  assert.equal(
    defaultDataDir({ env: {}, rootDir: legacy, homedir }),
    path.join(legacy, '.data'),
    'an existing .data directory keeps being used',
  );

  const globalInstall = tempDir('codex-remote-global-');
  assert.equal(
    defaultDataDir({ env: {}, rootDir: globalInstall, homedir }),
    path.join(home, '.codex-remote'),
    'a bare package directory must persist under the user profile',
  );
});
