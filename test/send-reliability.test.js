'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let SendReliability;
try {
  SendReliability = require('../web/send-reliability');
} catch {}

test('turn start errors are retryable only for explicit server rejection', () => {
  assert.equal(
    typeof SendReliability?.classifyTurnStartError,
    'function',
    'turn start error classifier is missing',
  );

  for (const error of [
    Object.assign(new Error('连接已断开'), { rpcResponse: false }),
    Object.assign(new Error('请求超时: turn/start'), { rpcResponse: false }),
    Object.assign(new Error('process exited'), { rpcResponse: true }),
    Object.assign(new Error('socket hang up'), { rpcResponse: true, code: 'ECONNRESET' }),
    Object.assign(new Error('internal app-server error'), { rpcResponse: true, code: -32000 }),
  ]) {
    assert.equal(
      SendReliability.classifyTurnStartError(error),
      'unknown',
      `${error.message} may have been delivered`,
    );
  }

  assert.equal(
    SendReliability.classifyTurnStartError(Object.assign(new Error('invalid params'), {
      rpcResponse: true,
      code: -32602,
    })),
    'rejected',
  );
  assert.equal(
    SendReliability.classifyTurnStartError(Object.assign(new Error('turn rejected'), {
      rpcResponse: true,
      data: { delivery: 'rejected' },
    })),
    'rejected',
  );
});

test('client message ids include the page instance nonce', () => {
  assert.equal(
    typeof SendReliability?.createClientUserMessageId,
    'function',
    'client message id helper is missing',
  );
  const first = SendReliability.createClientUserMessageId({
    instanceNonce: 'instance-a',
    generation: 1,
    sequence: 1,
  });
  const second = SendReliability.createClientUserMessageId({
    instanceNonce: 'instance-b',
    generation: 1,
    sequence: 1,
  });

  assert.notEqual(first, second);
  assert.match(first, /instance-a/);
  assert.match(second, /instance-b/);
});

test('instance nonce uses randomUUID with a cryptographic random fallback', () => {
  assert.equal(
    typeof SendReliability?.createInstanceNonce,
    'function',
    'instance nonce helper is missing',
  );
  assert.equal(
    SendReliability.createInstanceNonce({ randomUUID: () => 'page-uuid' }),
    'page-uuid',
  );

  let fallbackCalled = false;
  const fallback = SendReliability.createInstanceNonce({
    getRandomValues(bytes) {
      fallbackCalled = true;
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
      return bytes;
    },
  });
  assert.equal(fallbackCalled, true);
  assert.match(fallback, /^[0-9a-f]{32}$/);
  assert.throws(() => SendReliability.createInstanceNonce({}), /cryptographic/i);
});
