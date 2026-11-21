// Transport completion is independent of whether a response can qualify code.
// `unknown` here is a finish label in a complete response, never an unknown
// remote request. This predicate grants no identity, candidate or delivery.
const terminalFinishLabels = new Set(['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', 'unknown']);
export function hasCompletePlannedModelReceipt(call) {
  return call?.kind === 'model' && call.dispatched === true && call.requestState === 'completed'
    && call.terminationConfirmed === true && call.receiptConfirmed === true
    && /^[a-f0-9]{64}$/u.test(call.receiptHash ?? '') && terminalFinishLabels.has(call.finishReason);
}
