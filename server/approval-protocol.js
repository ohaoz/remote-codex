'use strict';

function normalizeAck(result, message) {
  const status = result?.status || 'failed';
  const ack = {
    type: 'approval-ack',
    status,
    retryable: !!result?.retryable,
    rpcId: String(message?.rpcId ?? ''),
    submissionId: String(message?.submissionId ?? ''),
    resolvedBySubmissionId: result?.resolvedBySubmissionId || null,
  };
  if (result?.error) ack.error = result.error;
  return ack;
}

function submitApproval({
  bridge,
  message,
  sendAck,
  publishResolution,
}) {
  const rpcId = message?.rpcId;
  const submissionId = message?.submissionId;
  let result;

  if (
    rpcId === undefined
    || rpcId === null
    || typeof submissionId !== 'string'
    || !submissionId.trim()
  ) {
    result = {
      status: 'failed',
      retryable: false,
      error: 'rpcId and submissionId are required',
      resolvedBySubmissionId: null,
    };
  } else {
    result = bridge.resolveApproval(String(rpcId), message.result, submissionId);
  }

  const ack = normalizeAck(result, message);
  sendAck(ack);
  if (ack.status === 'accepted') {
    publishResolution({
      type: 'approval-resolved',
      rpcId: ack.rpcId,
      submissionId: ack.submissionId,
      resolvedBySubmissionId: ack.resolvedBySubmissionId || ack.submissionId,
    });
  }
  return ack;
}

module.exports = { normalizeAck, submitApproval };
