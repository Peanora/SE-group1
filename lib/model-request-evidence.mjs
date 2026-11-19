// Native adapters alone record transport facts. Model JSON and error fields
// cannot manufacture this identity, nor mutate a settled request's evidence.
const requests = new WeakMap(), pending = new WeakMap();
const snapshot = state => Object.freeze({ dispatched: state.dispatched === true, responseComplete: state.responseComplete === true });

export function runModelRequestWithEvidence(callback, { trackPromise = false, trackResult = false } = {}) {
  const state = { dispatched: false, responseComplete: false };
  const handle = trackPromise ? Object.freeze({ kind: 'native_model_transport' }) : undefined;
  if (handle) pending.set(handle, state);
  let promise, terminal;
  promise = (async () => {
    try {
      const result = await callback(state, handle);
      if (trackResult && result !== null && (typeof result === 'object' || typeof result === 'function')) requests.set(result, snapshot(state));
      return result;
    } catch (error) {
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) requests.set(error, snapshot(state));
      throw error;
    } finally {
      terminal = snapshot(state);
      if (handle) { pending.delete(handle); requests.set(handle, terminal); }
      if (trackPromise && promise) { pending.delete(promise); requests.set(promise, terminal); }
    }
  })();
  if (trackPromise) { if (terminal) requests.set(promise, terminal); else pending.set(promise, state); }
  return promise;
}

export function getModelRequestEvidence(error) {
  if (error === null || !['object', 'function'].includes(typeof error)) return null;
  const live = pending.get(error);
  return requests.get(error) ?? (live ? snapshot(live) : null);
}
