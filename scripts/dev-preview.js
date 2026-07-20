#!/usr/bin/env node
'use strict';

/**
 * Boots the gateway against a fake Codex bridge + fake terminals so the web
 * UI can be inspected visually without a real codex app-server.
 *
 *   node scripts/dev-preview.js          → http://127.0.0.1:7899/#token=preview-code
 */

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGateway } = require('../server/gateway');
const { AuthStore } = require('../server/auth-store');
const { AuditLog } = require('../server/audit-log');
const { PairingService } = require('../server/pairing');
const policy = require('../server/policy');

class FakeBridge extends EventEmitter {
  constructor() {
    super();
    this.state = 'ready';
    this.streamId = 'preview-stream';
    this.threads = new Map();
    this.nextThread = 1;
  }

  info() { return { state: this.state, init: { userAgent: 'codex-preview/0.0' } }; }
  listPendingApprovals() { return []; }
  isAllowed() { return true; }
  cachedEvents() { return []; }
  publishApprovalResolution() {}
  replaySince(threadId) {
    return {
      threadId,
      streamId: this.streamId,
      events: [],
      resetRequired: false,
      firstAvailableSeq: 1,
      lastSeq: 0,
      toSeq: 0,
      activeTurnId: null,
    };
  }

  async call(method, params = {}) {
    switch (method) {
      case 'thread/start': {
        const id = `preview-thread-${this.nextThread++}`;
        this.threads.set(id, { id, turns: [] });
        return {
          thread: { id },
          model: 'gpt-5.3-codex',
          reasoningEffort: 'medium',
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          cwd: 'G:\\codex remote',
        };
      }
      case 'thread/resume':
        return {
          thread: { id: params.threadId },
          model: 'gpt-5.3-codex',
          reasoningEffort: 'medium',
          cwd: 'G:\\codex remote',
        };
      case 'thread/read':
        return { thread: this.threads.get(params.threadId) || { id: params.threadId, turns: [] } };
      case 'thread/list':
        return { data: [] };
      case 'model/list':
        return {
          data: [
            {
              model: 'gpt-5.3-codex',
              displayName: 'GPT-5.3 Codex',
              description: '预览用模型',
              isDefault: true,
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: '低' },
                { reasoningEffort: 'medium', description: '中' },
                { reasoningEffort: 'high', description: '高' },
              ],
            },
          ],
        };
      case 'account/read':
        return { account: { type: 'chatgpt', email: 'preview@example.com', planType: 'pro' } };
      case 'account/rateLimits/read':
        return {
          rateLimits: {
            limitId: 'codex',
            planType: 'pro',
            primary: { usedPercent: 32, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
          },
        };
      default:
        return { ok: true };
    }
  }
}

class FakeTerminals extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.next = 1;
  }
  list() { return [...this.sessions.values()].map((s) => this.describe(s)); }
  describe(s) {
    return {
      id: s.id, kind: s.kind, title: s.title, cwd: s.cwd, alive: s.alive,
      createdAt: s.createdAt, cols: 90, rows: 30, generation: 1,
      firstAvailableOffset: 0, lastOffset: s.buffer.length,
    };
  }
  create(kind) {
    const id = String(this.next++);
    const session = {
      id, kind, title: kind === 'codex' ? 'Codex TUI' : 'PowerShell',
      cwd: 'G:\\codex remote', alive: true, createdAt: Date.now(),
      buffer: `\u001b[38;5;173mcodex://remote preview\u001b[0m\r\n$ 这是一个假终端，仅供 UI 预览\r\n$ `,
    };
    this.sessions.set(id, session);
    this.emit('created', this.describe(session));
    return session;
  }
  get(id) { return this.sessions.get(String(id)) || null; }
  snapshot(id) {
    const s = this.get(id);
    if (!s) return null;
    return {
      terminalId: s.id, generation: 1, firstAvailableOffset: 0,
      lastOffset: s.buffer.length, buffer: s.buffer, alive: s.alive, cols: 90, rows: 30,
    };
  }
  write() {}
  resize() {}
  kill(id) { this.sessions.delete(String(id)); this.emit('closed', String(id)); return true; }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-preview-'));
  const store = new AuthStore({ filePath: path.join(dir, 'auth.json') });
  const audit = new AuditLog({ filePath: path.join(dir, 'audit.jsonl') });
  const pairing = new PairingService({ store, legacyToken: 'preview-code', audit });
  const gateway = createGateway({
    bridge: new FakeBridge(),
    terminals: new FakeTerminals(),
    deviceAuth: pairing,
    policy,
  });
  await gateway.listen({ host: '127.0.0.1', port: 7899 });
  console.log('preview: http://127.0.0.1:7899/#token=preview-code');
  console.log('login page only: http://127.0.0.1:7899/');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
