// Coalescing batcher for high-rate PATH_CHANGED streams (fix F2-1).
//
// A Ring-Instrument or CosmicUnity instance can stream 100-300 msg/s. The
// old useHub applied every message straight onto the reactive Map (cloning
// the outer Map + the device's inner Map per message), which cascaded into
// full re-render/stringify/sort cycles across every card. This batcher
// buffers (deviceId, relPath) -> latest value and flushes at most once per
// animation frame (16 ms fallback), so the reactive graph pays once per
// frame instead of once per message.
//
// Pure logic — the scheduler is injectable so it can be unit-tested with
// node --test and driven by requestAnimationFrame in the browser.
//
// Flush payload shape: Map<deviceId, Map<relPath, { value, paramType }>>
// Only the LAST value per (deviceId, relPath) within a window survives —
// exact-timing consumers (recording) must be fed pre-coalesce by the caller.

function defaultSchedule(cb) {
  if (typeof requestAnimationFrame === 'function') {
    return { kind: 'raf', id: requestAnimationFrame(cb) }
  }
  return { kind: 'timeout', id: setTimeout(cb, 16) }
}

function defaultCancel(handle) {
  if (!handle) return
  if (handle.kind === 'raf' && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle.id)
  } else {
    clearTimeout(handle.id)
  }
}

export function createParamBatcher({ onFlush, schedule, cancel } = {}) {
  const scheduleFn = schedule || defaultSchedule
  const cancelFn = cancel || defaultCancel

  // deviceId -> Map<relPath, { value, paramType }>
  let buffer = new Map()
  let scheduled = null

  function push(deviceId, relPath, value, paramType) {
    let inner = buffer.get(deviceId)
    if (!inner) {
      inner = new Map()
      buffer.set(deviceId, inner)
    }
    inner.set(relPath, { value, paramType })
    if (scheduled == null) {
      scheduled = scheduleFn(() => flushNow())
    }
  }

  // Flush synchronously. Used by the scheduler callback and by callers that
  // need ordering guarantees (e.g. before replacing a device namespace).
  // Returns the flushed batch (or null when nothing was pending).
  function flushNow() {
    if (scheduled != null) {
      cancelFn(scheduled)
      scheduled = null
    }
    if (buffer.size === 0) return null
    const batch = buffer
    buffer = new Map()
    if (onFlush) onFlush(batch)
    return batch
  }

  // Drop everything buffered for one device (e.g. device removed mid-window).
  function dropDevice(deviceId) {
    buffer.delete(deviceId)
  }

  // Drop the entire pending buffer without flushing (e.g. INITIAL_STATE reset).
  function clear() {
    if (scheduled != null) {
      cancelFn(scheduled)
      scheduled = null
    }
    buffer = new Map()
  }

  function pendingCount() {
    let n = 0
    for (const inner of buffer.values()) n += inner.size
    return n
  }

  return {
    push,
    flushNow,
    dropDevice,
    clear,
    pendingCount,
    get isScheduled() { return scheduled != null }
  }
}
