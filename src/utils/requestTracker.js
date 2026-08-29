// Pending-request tracker with per-request timeout (fixes F2-2 / F2-13).
//
// Correlates outbound requests (by requestId) with their async results, e.g.
// SET_DEVICE_PARAM -> PARAM_RESULT { requestId, ok, reason } on the hub WS.
// Promises returned by register() NEVER reject — they resolve with
// { ok:false, reason:'timeout' } (configurable) so fire-and-forget callers
// that ignore the promise can't produce unhandled rejections.

export function createRequestTracker({
  timeoutMs = 2000,
  timeoutResult = { ok: false, reason: 'timeout' }
} = {}) {
  // id -> { resolve, timer }
  const pending = new Map()

  function register(id) {
    // A duplicate id replaces the prior entry: settle the old one as timeout
    // immediately rather than leaving it to dangle.
    if (pending.has(id)) settle(id, { ...timeoutResult })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const entry = pending.get(id)
        if (entry && entry.resolve === resolve) {
          pending.delete(id)
          resolve({ ...timeoutResult })
        }
      }, timeoutMs)
      pending.set(id, { resolve, timer })
    })
  }

  // Resolve one pending request. Returns true when a request was waiting.
  function settle(id, result) {
    const entry = pending.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    pending.delete(id)
    entry.resolve(result)
    return true
  }

  // Resolve every pending request with the same result (e.g. WS closed:
  // { ok:false, reason:'disconnected' }).
  function settleAll(result) {
    for (const id of Array.from(pending.keys())) settle(id, { ...result })
  }

  return {
    register,
    settle,
    settleAll,
    get size() { return pending.size }
  }
}
