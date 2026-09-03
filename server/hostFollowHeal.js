// Auto-heal for saved devices whose address moved under a stable mDNS fqdn.
//
// A DHCP lease change moves a device (TouchDesigner machine, tablet, …) to a
// new address while its Bonjour service fqdn stays identical. Discovery folds
// the fresh endpoint into the saved registry record immediately, but the
// managed connection loop keeps dialing the manifest's dead host:port, so the
// card stays Error/Unavailable until an operator edits the HOST by hand.
//
// The tie-breaker mirrors collisionHeal.js: once the manifest endpoint has
// failed repeatedly, follow the fqdn — and only the fqdn, never a name
// lookalike — to the freshest discovered endpoint on another host. The fqdn
// comes from the dialed endpoint when mDNS was observed there, otherwise from
// the manifest's own `serviceFqdn`, so a card an operator repaired by hand
// (which leaves an identity-less `manual-update` endpoint) still has an
// identity to follow on the next move. Freshness is required on both axes
// (newer than the manifest endpoint's own observation and newer than the
// device's last successful contact) so a stale announcement can never bounce
// a healthy manifest around.

import { normalizeHost } from './deviceRegistry.js'

export const HOST_FOLLOW_MIN_FAILURES = 2

function cleanFqdn(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Compute the manifest migrations that would heal fqdn-stable host moves.
 * Pure decision logic: probing evidence comes from the managed device's
 * `consecutiveConnectFailures` counter, discovery evidence from the registry
 * snapshot's per-endpoint fqdn/source/lastSeen fields.
 *
 * @param {{
 *   snapshot: Array<any>,
 *   getManagedDevice: (manifestId: number) => any,
 *   minFailures?: number
 * }} args
 * @returns {Array<{
 *   manifestId: number, fqdn: string,
 *   fromHost: string, fromPort: number,
 *   host: string, oscQueryPort: number
 * }>}
 */
export function planHostFollowHeals({
  snapshot,
  getManagedDevice,
  minFailures = HOST_FOLLOW_MIN_FAILURES
}) {
  const records = Array.isArray(snapshot) ? snapshot : []
  const plans = []
  for (const record of records) {
    if (record?.saved !== true || record.manifestId == null) continue

    const dev = getManagedDevice(record.manifestId)
    if (!dev || dev.enabled === false) continue
    if (dev.status === 'connected') continue
    if (!(Number(dev.consecutiveConnectFailures) >= minFailures)) continue

    const devHost = normalizeHost(dev.host)
    const devPort = Number(dev.oscQueryPort)
    const endpoints = Array.isArray(record.endpoints) ? record.endpoints : []
    const manifestEndpoint = endpoints.find((endpoint) =>
      normalizeHost(endpoint?.host) === devHost && Number(endpoint?.port) === devPort
    )
    // Service identity, strongest evidence first: an fqdn mDNS was observed
    // announcing at the dialed address, then the identity the manifest
    // persisted from an earlier successful connection (`serviceFqdn`), then
    // whatever was merely derived from the saved serviceName. Without any of
    // them there is nothing to follow — name similarity is deliberately not
    // enough.
    const endpointFqdn = cleanFqdn(manifestEndpoint?.fqdn)
    const observedOnEndpoint = manifestEndpoint?.fqdnSource === 'derived' ? '' : endpointFqdn
    const fqdn = observedOnEndpoint || cleanFqdn(dev.serviceFqdn) || endpointFqdn
    if (!fqdn) continue

    const candidate = endpoints
      .filter((endpoint) =>
        endpoint?.fqdn === fqdn &&
        endpoint.source === 'discovery' &&
        endpoint.available === true &&
        normalizeHost(endpoint.host) !== devHost &&
        Number(endpoint.port) > 0 &&
        Number(endpoint.lastSeen) > Number(manifestEndpoint?.lastSeen || 0) &&
        Number(endpoint.lastSeen) >= Number(dev.lastMessageAt || 0)
      )
      .sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0))[0]
    if (!candidate) continue

    plans.push({
      manifestId: record.manifestId,
      fqdn,
      fromHost: String(dev.host),
      fromPort: devPort,
      host: String(candidate.host),
      oscQueryPort: Number(candidate.port)
    })
  }
  return plans
}
