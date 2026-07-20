'use strict';

(function exposeDeviceSession(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeviceSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const PERMANENT_CLOSE_CODES = new Set([4401, 4403]);

  function shouldReconnect(closeCode) {
    return !PERMANENT_CLOSE_CODES.has(Number(closeCode));
  }

  function create(options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
    const location = options.location || globalThis.location;
    const state = {
      device: null,
      sessionExpiresAt: null,
    };

    async function api(route, {
      method = 'GET',
      body,
    } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetchImpl(route, {
        method,
        credentials: 'same-origin',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload = {};
      try { payload = await response.json(); } catch {}
      if (!response.ok) {
        const error = new Error(payload.error || `request failed (${response.status})`);
        error.status = response.status;
        error.retryAfter = response.headers?.get?.('retry-after') || null;
        throw error;
      }
      return payload;
    }

    async function pair(code, metadata = {}) {
      const result = await api('/api/pair', {
        method: 'POST',
        body: {
          token: code,
          deviceName: metadata.deviceName,
          platform: metadata.platform,
        },
      });
      state.device = result.device || null;
      state.sessionExpiresAt = result.sessionExpiresAt || null;
      return result;
    }

    async function loadSession() {
      const result = await api('/api/session');
      state.device = result.device || null;
      return result;
    }

    async function websocketUrl(path, { channel, termId = null }) {
      const issued = await api('/api/ws-ticket', {
        method: 'POST',
        body: { channel, termId },
      });
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      return `${protocol}://${location.host}${path}?ticket=${encodeURIComponent(issued.ticket)}`;
    }

    return {
      pair,
      loadSession,
      websocketUrl,
      listDevices: () => api('/api/devices'),
      createInvite: (scope) => api('/api/invites', {
        method: 'POST',
        body: { scope },
      }),
      revokeDevice: (deviceId) => api(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, {
        method: 'POST',
        body: {},
      }),
      renameDevice: (deviceId, name) => api(`/api/devices/${encodeURIComponent(deviceId)}/rename`, {
        method: 'POST',
        body: { name },
      }),
      logout: async () => {
        const result = await api('/api/logout', { method: 'POST', body: {} });
        state.device = null;
        state.sessionExpiresAt = null;
        return result;
      },
      snapshot: () => ({
        device: state.device ? { ...state.device } : null,
        sessionExpiresAt: state.sessionExpiresAt,
      }),
    };
  }

  return {
    PERMANENT_CLOSE_CODES,
    create,
    shouldReconnect,
  };
});
