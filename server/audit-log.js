'use strict';

const fs = require('node:fs');
const path = require('node:path');

function boundedText(value, max = 240) {
  return value == null ? null : String(value).slice(0, max);
}

class AuditLog {
  constructor(options = {}) {
    if (!options.filePath) throw new TypeError('filePath is required');
    this.filePath = options.filePath;
    this.fs = options.fs || fs;
    this.clock = options.clock || Date.now;
    this.maxBytes = Math.max(128, options.maxBytes || 2 * 1024 * 1024);
    this.maxFiles = Math.max(1, options.maxFiles || 5);
  }

  _now() {
    return Number(typeof this.clock === 'function' ? this.clock() : this.clock.now());
  }

  _entry(event) {
    return {
      at: this._now(),
      actorDeviceId: boundedText(event.actorDeviceId, 100),
      connectionId: boundedText(event.connectionId, 100),
      action: boundedText(event.action, 120),
      resource: boundedText(event.resource, 240),
      result: boundedText(event.result, 80),
      correlationId: boundedText(event.correlationId, 120),
      risk: boundedText(event.risk, 40),
      reason: boundedText(event.reason, 240),
    };
  }

  _size() {
    try {
      return this.fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  _rotate() {
    if (this.maxFiles <= 1) {
      try { this.fs.unlinkSync(this.filePath); } catch {}
      return;
    }
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      const destination = `${this.filePath}.${index}`;
      try {
        if (this.fs.existsSync(destination)) this.fs.unlinkSync(destination);
        if (this.fs.existsSync(source)) this.fs.renameSync(source, destination);
      } catch {}
    }
  }

  record(event, { critical = false } = {}) {
    try {
      const entry = this._entry(event || {});
      const line = `${JSON.stringify(entry)}\n`;
      this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (this._size() + Buffer.byteLength(line) > this.maxBytes) this._rotate();
      this.fs.appendFileSync(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch (error) {
      if (critical) throw error;
      return false;
    }
  }
}

module.exports = {
  AuditLog,
  boundedText,
};
