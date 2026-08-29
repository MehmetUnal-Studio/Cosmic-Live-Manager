// Backpressure policy for /ws/hub dashboard sockets.
//
// A sleeping tablet keeps its WS in readyState OPEN while consuming nothing,
// so the hub's PATH_CHANGED stream (hundreds of messages per second under
// motion input) accumulates in that socket's send buffer for the whole show.
// Skip non-essential broadcasts once the buffer is clearly behind, and drop
// the connection entirely once it is hopeless — the client will reconnect
// and resync from INITIAL_STATE.

export const HUB_WS_SKIP_BUFFERED_BYTES = 1 * 1024 * 1024 // 1 MB
export const HUB_WS_DROP_BUFFERED_BYTES = 8 * 1024 * 1024 // 8 MB

/**
 * @param {number} bufferedAmount current ws.bufferedAmount in bytes
 * @returns {'send'|'skip'|'drop'}
 */
export function hubBackpressureAction(bufferedAmount) {
  const buffered = Number(bufferedAmount) || 0
  if (buffered > HUB_WS_DROP_BUFFERED_BYTES) return 'drop'
  if (buffered > HUB_WS_SKIP_BUFFERED_BYTES) return 'skip'
  return 'send'
}
