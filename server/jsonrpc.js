'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * Line-delimited JSON-RPC 2.0 client over a child process's stdio.
 * Emits: 'notification' {method,params}, 'request' {id,method,params},
 *        'exit' {code}, 'stderr' (string chunks)
 */
class JsonRpcProcess extends EventEmitter {
  constructor(command, args, options = {}) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, method}
    this.buf = '';
    this.alive = false;
  }

  start() {
    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...this.options,
    });
    this.alive = true;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => this.emit('stderr', chunk));
    this.child.on('exit', (code) => {
      this.alive = false;
      for (const [, p] of this.pending) p.reject(new Error('process exited'));
      this.pending.clear();
      this.emit('exit', { code });
    });
    this.child.on('error', (err) => {
      this.alive = false;
      this.emit('stderr', `[spawn error] ${err.message}\n`);
      this.emit('exit', { code: -1 });
    });
    return this;
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit('stderr', `[non-json stdout] ${line.slice(0, 400)}\n`);
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Response to one of our requests
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) {
          const e = new Error(msg.error.message || 'rpc error');
          e.code = msg.error.code;
          e.data = msg.error.data;
          p.reject(e);
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }
    // Request initiated by the server (needs a response from us)
    if (msg.id !== undefined && msg.method) {
      this.emit('request', { id: msg.id, method: msg.method, params: msg.params });
      return;
    }
    // Notification
    if (msg.method) {
      this.emit('notification', { method: msg.method, params: msg.params });
    }
  }

  _write(obj) {
    if (!this.alive) throw new Error('process not running');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = 120000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`rpc timeout: ${method}`));
          }, timeoutMs)
        : null;
      this.pending.set(id, {
        method,
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      try {
        this._write({ jsonrpc: '2.0', id, method, params: params ?? {} });
      } catch (e) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(e);
      }
    });
  }

  notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  respond(id, result) {
    this._write({ jsonrpc: '2.0', id, result: result ?? {} });
  }

  respondError(id, code, message) {
    this._write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  kill() {
    if (this.child && this.alive) {
      try { this.child.kill(); } catch {}
    }
  }
}

module.exports = { JsonRpcProcess };
