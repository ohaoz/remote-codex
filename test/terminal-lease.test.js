'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let TerminalLeaseManager;
try {
  ({ TerminalLeaseManager } = require('../server/terminal-lease'));
} catch {}

test('only one terminal writer exists and stale connections cannot write', () => {
  assert.equal(typeof TerminalLeaseManager, 'function', 'TerminalLeaseManager is missing');
  let now = 1_000;
  const leases = new TerminalLeaseManager({
    clock: () => now,
    leaseTtlMs: 30_000,
    reconnectGraceMs: 5_000,
  });

  const first = leases.acquire({
    terminalId: '7',
    deviceId: 'device-a',
    connectionId: 'conn-a',
  });
  assert.equal(first.granted, true);

  const denied = leases.acquire({
    terminalId: '7',
    deviceId: 'device-b',
    connectionId: 'conn-b',
  });
  assert.equal(denied.granted, false);
  assert.equal(denied.writerDeviceId, 'device-a');

  assert.equal(leases.validate({
    terminalId: '7',
    leaseId: first.leaseId,
    deviceId: 'device-a',
    connectionId: 'conn-a',
  }), true);

  leases.disconnect('conn-a');
  now += 1_000;
  const resumed = leases.acquire({
    terminalId: '7',
    deviceId: 'device-a',
    connectionId: 'conn-a2',
    leaseId: first.leaseId,
  });
  assert.equal(resumed.granted, true);
  assert.equal(resumed.leaseId, first.leaseId);
  assert.equal(leases.validate({
    terminalId: '7',
    leaseId: first.leaseId,
    deviceId: 'device-a',
    connectionId: 'conn-a',
  }), false);
});

test('expired leases release automatically and owner force takeover rotates the lease', () => {
  let now = 2_000;
  const leases = new TerminalLeaseManager({
    clock: () => now,
    leaseTtlMs: 100,
    reconnectGraceMs: 50,
  });
  const first = leases.acquire({
    terminalId: '3',
    deviceId: 'device-a',
    connectionId: 'conn-a',
  });

  assert.equal(leases.acquire({
    terminalId: '3',
    deviceId: 'device-b',
    connectionId: 'conn-b',
    force: true,
    canForce: false,
  }).granted, false);

  const forced = leases.acquire({
    terminalId: '3',
    deviceId: 'owner',
    connectionId: 'conn-owner',
    force: true,
    canForce: true,
  });
  assert.equal(forced.granted, true);
  assert.equal(forced.takeover, true);
  assert.notEqual(forced.leaseId, first.leaseId);

  now += 101;
  const afterExpiry = leases.acquire({
    terminalId: '3',
    deviceId: 'device-b',
    connectionId: 'conn-b',
  });
  assert.equal(afterExpiry.granted, true);
});

test('kill may validate the same device lease across its event connection', () => {
  const leases = new TerminalLeaseManager({ clock: () => 5_000 });
  const lease = leases.acquire({
    terminalId: '9',
    deviceId: 'device-a',
    connectionId: 'terminal-connection',
  });
  assert.equal(leases.validate({
    terminalId: '9',
    leaseId: lease.leaseId,
    deviceId: 'device-a',
    allowDeviceOnly: true,
  }), true);
  assert.equal(leases.validate({
    terminalId: '9',
    leaseId: lease.leaseId,
    deviceId: 'device-b',
    allowDeviceOnly: true,
  }), false);
});
