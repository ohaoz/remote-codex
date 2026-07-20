'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let DeviceSession;
try {
  DeviceSession = require('../web/device-session');
} catch {}

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    async json() { return body; },
  };
}

test('device session pairs with credentials and never persists a long-lived token', async () => {
  assert.equal(typeof DeviceSession?.create, 'function', 'device session client is missing');
  const calls = [];
  const client = DeviceSession.create({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, {
        ok: true,
        device: { id: 'dev-1', scope: 'full-control', owner: true },
      });
    },
    location: { protocol: 'http:', host: 'localhost:7860' },
  });

  const paired = await client.pair('one-time-code', {
    deviceName: 'Phone',
    platform: 'ios',
  });
  assert.equal(paired.device.id, 'dev-1');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    token: 'one-time-code',
    deviceName: 'Phone',
    platform: 'ios',
  });
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal('token' in client.snapshot(), false);
});

test('websocket URL uses a short-lived channel-bound ticket', async () => {
  const calls = [];
  const client = DeviceSession.create({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response(200, { ticket: 'short ticket', expiresAt: 42 });
    },
    location: { protocol: 'https:', host: 'remote.example' },
  });

  const events = await client.websocketUrl('/ws/events', { channel: 'events' });
  const terminal = await client.websocketUrl('/ws/term/7', {
    channel: 'terminal',
    termId: '7',
  });
  assert.equal(events, 'wss://remote.example/ws/events?ticket=short%20ticket');
  assert.equal(terminal, 'wss://remote.example/ws/term/7?ticket=short%20ticket');
  assert.deepEqual(calls.map((entry) => entry.body), [
    { channel: 'events', termId: null },
    { channel: 'terminal', termId: '7' },
  ]);
});

test('revoked and expired sessions are permanent reconnect failures', () => {
  assert.equal(DeviceSession.shouldReconnect(1006), true);
  assert.equal(DeviceSession.shouldReconnect(1012), true);
  assert.equal(DeviceSession.shouldReconnect(4401), false);
  assert.equal(DeviceSession.shouldReconnect(4403), false);
});

test('device management methods preserve cookie authentication', async () => {
  const calls = [];
  const client = DeviceSession.create({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/devices') return response(200, { devices: [] });
      if (url === '/api/invites') return response(201, { code: 'invite' });
      return response(200, { ok: true });
    },
    location: { protocol: 'http:', host: 'localhost' },
  });

  await client.listDevices();
  await client.createInvite('read-only');
  await client.revokeDevice('dev-2');
  await client.logout();
  assert.ok(calls.every((entry) => entry.options.credentials === 'same-origin'));
});
