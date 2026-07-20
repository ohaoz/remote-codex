'use strict';

(function exposeSendReliability(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SendReliability = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const EXPLICIT_REJECTION_CODES = new Set([-32600, -32601, -32602]);
  const TRANSPORT_CODES = new Set([
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
  ]);
  const TRANSPORT_MESSAGE = /(?:连接|断开|超时|替换|socket|network|process exited|not running|not ready|app-server 未就绪|hang up|timed? ?out)/i;

  function classifyTurnStartError(error) {
    const code = error?.code;
    const message = String(error?.message || error || '');
    if (
      TRANSPORT_CODES.has(String(code || '').toUpperCase())
      || TRANSPORT_MESSAGE.test(message)
    ) return 'unknown';

    if (error?.rpcResponse === true) {
      const delivery = error?.data?.delivery || error?.data?.deliveryStatus;
      if (
        delivery === 'rejected'
        || delivery === 'not-delivered'
        || error?.data?.retrySafe === true
        || EXPLICIT_REJECTION_CODES.has(Number(code))
      ) return 'rejected';
    }
    return 'unknown';
  }

  function createInstanceNonce(cryptoLike) {
    const source = cryptoLike
      || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (typeof source?.randomUUID === 'function') return source.randomUUID();
    if (typeof source?.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      source.getRandomValues(bytes);
      return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    }
    throw new Error('cryptographic random source is required');
  }

  function createClientUserMessageId({ instanceNonce, generation, sequence } = {}) {
    if (!instanceNonce) throw new Error('instanceNonce is required');
    return `codex-remote-${instanceNonce}-${generation}-${sequence}`;
  }

  return {
    classifyTurnStartError,
    createClientUserMessageId,
    createInstanceNonce,
  };
});
