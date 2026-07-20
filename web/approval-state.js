'use strict';

(function exposeApprovalState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ApprovalState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function defaultSubmissionId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  class ApprovalFlow {
    constructor(options = {}) {
      this.entries = new Map();
      this.createSubmissionId = options.createSubmissionId || defaultSubmissionId;
    }

    add(approval) {
      if (!approval || approval.rpcId === undefined || approval.rpcId === null) return null;
      const rpcId = String(approval.rpcId);
      const current = this.entries.get(rpcId);
      const reusedRpcId = current
        && approval.receivedAt !== undefined
        && current.approval.receivedAt !== undefined
        && approval.receivedAt !== current.approval.receivedAt;
      if (current && !reusedRpcId) {
        current.approval = { ...current.approval, ...approval, rpcId };
        return current;
      }
      if (reusedRpcId) {
        clearTimeout(current.removeTimer);
        this.entries.delete(rpcId);
      }
      const entry = {
        rpcId,
        approval: { ...approval, rpcId },
        status: 'idle',
        disabled: false,
        retryable: false,
        message: '',
        error: null,
        result: null,
        submissionId: null,
        handledElsewhere: false,
        resolutionPendingAck: false,
        pendingResolution: null,
      };
      this.entries.set(rpcId, entry);
      return entry;
    }

    get(rpcId) {
      return this.entries.get(String(rpcId)) || null;
    }

    values() {
      return [...this.entries.values()];
    }

    remove(rpcId) {
      return this.entries.delete(String(rpcId));
    }

    begin(rpcId, result) {
      const entry = this.get(rpcId);
      if (!entry) throw new Error(`unknown approval: ${rpcId}`);
      if (entry.status === 'submitting') {
        return this._submission(entry);
      }
      if (entry.status === 'confirmed') {
        throw new Error('approval already resolved');
      }
      if (entry.status === 'failed' && entry.retryable && entry.submissionId) {
        return this.retry(rpcId);
      }

      entry.submissionId = String(this.createSubmissionId());
      entry.result = result;
      this._setSubmitting(entry);
      return this._submission(entry);
    }

    retry(rpcId) {
      const entry = this.get(rpcId);
      if (!entry) throw new Error(`unknown approval: ${rpcId}`);
      if (entry.status !== 'failed' || !entry.retryable || !entry.submissionId) {
        throw new Error('approval is not retryable');
      }
      this._setSubmitting(entry);
      return this._submission(entry);
    }

    ack(message) {
      const entry = this.get(message?.rpcId);
      if (!entry || !entry.submissionId || message?.submissionId !== entry.submissionId) {
        return { accepted: false, entry };
      }

      const status = message.status;
      if (status === 'accepted' || status === 'already-resolved') {
        const resolver = message.resolvedBySubmissionId
          || entry.pendingResolution?.resolvedBySubmissionId
          || entry.pendingResolution?.submissionId
          || null;
        entry.status = 'confirmed';
        entry.disabled = true;
        entry.retryable = false;
        entry.error = null;
        entry.handledElsewhere = resolver
          ? resolver !== entry.submissionId
          : status === 'already-resolved';
        entry.message = entry.handledElsewhere ? '已由其他客户端处理' : '已确认';
        entry.resolutionPendingAck = false;
        entry.pendingResolution = null;
      } else {
        entry.status = 'failed';
        entry.disabled = !message.retryable;
        entry.retryable = !!message.retryable;
        entry.error = message.error || (status === 'not-found' ? '审批请求已不存在' : '审批提交失败');
        entry.message = entry.retryable ? '提交失败，可重试' : entry.error;
        entry.resolutionPendingAck = false;
        entry.pendingResolution = null;
      }
      return { accepted: true, entry };
    }

    resolved(message) {
      const entry = this.get(message?.rpcId);
      if (!entry) return { accepted: false, entry: null };
      const resolver = message.resolvedBySubmissionId || message.submissionId || null;

      if (entry.status === 'submitting') {
        entry.resolutionPendingAck = true;
        entry.pendingResolution = { ...message, resolvedBySubmissionId: resolver };
        return { accepted: true, entry, pendingAck: true };
      }

      entry.status = 'confirmed';
      entry.disabled = true;
      entry.retryable = false;
      entry.error = null;
      entry.handledElsewhere = !entry.submissionId || !resolver || resolver !== entry.submissionId;
      entry.message = entry.handledElsewhere ? '已由其他客户端处理' : '已确认';
      entry.resolutionPendingAck = false;
      entry.pendingResolution = null;
      return { accepted: true, entry, pendingAck: false };
    }

    connectionLost() {
      for (const entry of this.entries.values()) {
        if (entry.status !== 'submitting') continue;
        entry.status = 'failed';
        entry.disabled = false;
        entry.retryable = true;
        entry.error = '连接中断，服务端可能尚未收到确认';
        entry.message = '连接中断，可用同一提交重试';
        entry.resolutionPendingAck = false;
        entry.pendingResolution = null;
      }
    }

    reconcile(pendingRpcIds) {
      const pending = new Set([...pendingRpcIds].map(String));
      for (const entry of this.entries.values()) {
        if (pending.has(entry.rpcId) || entry.status === 'confirmed') continue;
        entry.status = 'confirmed';
        entry.disabled = true;
        entry.retryable = false;
        entry.handledElsewhere = true;
        entry.message = '已由其他客户端处理';
        entry.resolutionPendingAck = false;
        entry.pendingResolution = null;
      }
    }

    _setSubmitting(entry) {
      entry.status = 'submitting';
      entry.disabled = true;
      entry.retryable = false;
      entry.message = '正在提交…';
      entry.error = null;
      entry.handledElsewhere = false;
      entry.resolutionPendingAck = false;
      entry.pendingResolution = null;
    }

    _submission(entry) {
      return {
        rpcId: entry.rpcId,
        submissionId: entry.submissionId,
        result: entry.result,
      };
    }
  }

  function create(options) {
    return new ApprovalFlow(options);
  }

  return { create, ApprovalFlow };
});
