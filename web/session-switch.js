'use strict';

(function exposeSessionSwitch(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SessionSwitch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  async function runThreadSwitch({ setPending, load, commit }) {
    setPending(true);
    try {
      const result = await load();
      commit(result);
      return result;
    } finally {
      setPending(false);
    }
  }

  return { runThreadSwitch };
});
