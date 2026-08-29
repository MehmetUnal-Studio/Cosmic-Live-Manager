// Auto-heal for `persistent-id-port-collision` registry cards.
//
// A CosmicUnity VST that rebinds to a fallback OSCQuery port after a restart
// (5001 taken → 5002) legitimately reuses its persistent UUID on a new port.
// The registry conservatively surfaces this as a collision card because a
// *copied* VST state can produce the same signature with both ports alive.
//
// The tie-breaker is liveness: when the saved card's old endpoint is
// confirmed dead (its managed OSCQuery client failed N consecutive connect
// attempts) while the collision endpoint is being discovered, the saved
// manifest should migrate to the new endpoint and the collision card should
// disappear. When both endpoints are alive the explicit collision stays —
// that is a real UUID copy.

export const COLLISION_HEAL_MIN_FAILURES = 3

const COLLISION_IDENTITY_SOURCE = 'persistent-id-port-collision'

/**
 * Compute the set of manifest migrations that would heal dead-port
 * collisions. Pure decision logic: probing evidence comes from the managed
 * device's `consecutiveConnectFailures` counter (incremented on every failed
 * connect attempt, reset on success).
 *
 * @param {{
 *   snapshot: Array<any>,
 *   getManagedDevice: (manifestId: number) => any,
 *   minFailures?: number
 * }} args
 * @returns {Array<{manifestId: number, collisionCanonicalId: string, host: string, oscQueryPort: number}>}
 */
export function planCollisionHeals({
  snapshot,
  getManagedDevice,
  minFailures = COLLISION_HEAL_MIN_FAILURES
}) {
  const records = Array.isArray(snapshot) ? snapshot : []
  const plans = []
  for (const collision of records) {
    if (collision?.identitySource !== COLLISION_IDENTITY_SOURCE) continue
    if (collision.saved) continue
    // Only migrate onto an endpoint the network currently vouches for.
    if (collision.discoveryState !== 'Discovered') continue
    const canonicalId = String(collision.canonicalId || '')
    const marker = canonicalId.lastIndexOf(':port:')
    if (marker < 0) continue
    const baseCanonicalId = canonicalId.slice(0, marker)

    const saved = records.find((record) =>
      record?.canonicalId === baseCanonicalId &&
      record.saved === true &&
      record.manifestId != null
    )
    if (!saved) continue

    const dev = getManagedDevice(saved.manifestId)
    if (!dev || dev.enabled === false) continue
    // Keep the explicit collision while the old endpoint still answers.
    if (dev.status === 'connected') continue
    if (!(Number(dev.consecutiveConnectFailures) >= minFailures)) continue

    const endpoint = collision.activeEndpoint ||
      (collision.endpoints || []).find((item) => item?.host && item?.port)
    if (!endpoint?.host || !Number(endpoint.port)) continue
    if (
      String(endpoint.host) === String(dev.host) &&
      Number(endpoint.port) === Number(dev.oscQueryPort)
    ) continue

    plans.push({
      manifestId: saved.manifestId,
      collisionCanonicalId: canonicalId,
      host: String(endpoint.host),
      oscQueryPort: Number(endpoint.port)
    })
  }
  return plans
}
