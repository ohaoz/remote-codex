'use strict';
const os = require('os');
const { EventEmitter } = require('events');
const pty = require('@lydell/node-pty');
const { findCodexExe } = require('./codex');

const SCROLLBACK_LIMIT = 400000; // chars kept per terminal for replay

function encodeTerminalControl(message) {
  return `\u0000${JSON.stringify(message)}`;
}

/**
 * Human-readable name of the shell a `kind: 'shell'` terminal will run.
 * The web UI uses it so the "open shell" button never promises PowerShell
 * on a machine that will actually start bash/zsh.
 */
function defaultShellLabel(platform = process.platform, env = process.env) {
  if (platform === 'win32') return 'PowerShell';
  const shell = String(env.SHELL || '/bin/bash');
  const base = shell.split('/').pop();
  return base || 'shell';
}

function terminalSyncFrames(snapshot) {
  const frames = [
    encodeTerminalControl({
      op: 'sync-begin',
      terminalId: snapshot.terminalId,
      generation: snapshot.generation,
      firstAvailableOffset: snapshot.firstAvailableOffset,
      lastOffset: snapshot.lastOffset,
      alive: snapshot.alive,
    }),
  ];
  if (snapshot.buffer) frames.push(snapshot.buffer);
  frames.push(encodeTerminalControl({
    op: 'sync-end',
    terminalId: snapshot.terminalId,
    generation: snapshot.generation,
    lastOffset: snapshot.lastOffset,
  }));
  return frames;
}

/**
 * PTY sessions. Each session runs either the interactive Codex TUI or a plain
 * system shell. Output is buffered so a phone that reconnects can replay it.
 */
class TerminalManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessions = new Map(); // id -> session
    this.nextId = 1;
    this.nextGeneration = 1;
    this.spawn = options.spawn || ((file, args, spawnOptions) => pty.spawn(file, args, spawnOptions));
    this.scrollbackLimit = Math.max(1, options.scrollbackLimit || SCROLLBACK_LIMIT);
    this.now = options.now || Date.now;
    this.disposed = false;
  }

  _shellSpec(kind, opts) {
    if (kind === 'codex') {
      const exe = findCodexExe();
      const args = [];
      if (opts.resumeId) args.push('resume', opts.resumeId);
      if (exe) return { file: exe, args, label: 'Codex TUI' };
      // Fall back to the npm shim through the default shell
      if (process.platform === 'win32') {
        return { file: 'cmd.exe', args: ['/d', '/s', '/c', 'codex', ...args], label: 'Codex TUI' };
      }
      return { file: '/bin/sh', args: ['-lc', ['codex', ...args].join(' ')], label: 'Codex TUI' };
    }
    const label = defaultShellLabel();
    if (process.platform === 'win32') {
      return { file: 'powershell.exe', args: ['-NoLogo'], label };
    }
    return { file: process.env.SHELL || '/bin/bash', args: ['-l'], label };
  }

  create(kind = 'codex', opts = {}) {
    if (this.disposed) throw new Error('terminal manager is disposed');
    const id = String(this.nextId++);
    const spec = this._shellSpec(kind, opts);
    const cwd = opts.cwd && typeof opts.cwd === 'string' ? opts.cwd : os.homedir();
    const proc = this.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: opts.cols || 90,
      rows: opts.rows || 30,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' },
      useConpty: true,
    });
    const session = {
      id,
      kind,
      cwd,
      title: spec.label || (kind === 'codex' ? 'Codex TUI' : 'Shell'),
      proc,
      buffer: '',
      generation: this.nextGeneration++,
      firstAvailableOffset: 0,
      lastOffset: 0,
      alive: true,
      createdAt: this.now(),
      cols: opts.cols || 90,
      rows: opts.rows || 30,
    };
    proc.onData((data) => {
      session.lastOffset += data.length;
      session.buffer += data;
      if (session.buffer.length > this.scrollbackLimit) {
        session.buffer = session.buffer.slice(session.buffer.length - this.scrollbackLimit);
      }
      session.firstAvailableOffset = session.lastOffset - session.buffer.length;
      this.emit('data', id, data);
    });
    proc.onExit(({ exitCode }) => {
      session.alive = false;
      this.emit('exit', id, exitCode);
    });
    this.sessions.set(id, session);
    this.emit('created', this.describe(session));
    return session;
  }

  describe(s) {
    return {
      id: s.id,
      kind: s.kind,
      title: s.title,
      cwd: s.cwd,
      alive: s.alive,
      createdAt: s.createdAt,
      cols: s.cols,
      rows: s.rows,
      generation: s.generation,
      firstAvailableOffset: s.firstAvailableOffset,
      lastOffset: s.lastOffset,
    };
  }

  list() {
    return [...this.sessions.values()].map((s) => this.describe(s));
  }

  get(id) {
    return this.sessions.get(String(id));
  }

  snapshot(id) {
    const s = this.get(id);
    if (!s) return null;
    return {
      terminalId: s.id,
      generation: s.generation,
      firstAvailableOffset: s.firstAvailableOffset,
      lastOffset: s.lastOffset,
      buffer: s.buffer,
      alive: s.alive,
      cols: s.cols,
      rows: s.rows,
    };
  }

  write(id, data) {
    const s = this.get(id);
    if (s && s.alive) s.proc.write(data);
  }

  resize(id, cols, rows) {
    const s = this.get(id);
    if (s && s.alive && cols > 0 && rows > 0) {
      s.cols = cols; s.rows = rows;
      try { s.proc.resize(cols, rows); } catch {}
    }
  }

  kill(id) {
    const s = this.get(id);
    if (!s) return false;
    if (s.alive) { try { s.proc.kill(); } catch {} }
    this.sessions.delete(String(id));
    this.emit('closed', String(id));
    return true;
  }

  stop() {
    this.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.sessions.keys()]) this.kill(id);
    this.removeAllListeners();
  }
}

module.exports = {
  TerminalManager,
  defaultShellLabel,
  encodeTerminalControl,
  terminalSyncFrames,
};
