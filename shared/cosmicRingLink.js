export const COSMIC_RING_DEVICE_TYPE = 'CosmicRing'
export const COSMIC_RING_RUNTIME_KIND = 'VST3'
export const COSMIC_RING_LINK_ROLE = 'CosmicRingReceiver'

function normalized(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function declaredTypes(value) {
  return [
    value?.deviceType,
    value?.type,
    value?.txt?.device_type,
    value?.txt?.deviceType,
    value?.txt?.DEVICE_TYPE,
    value?.hostInfo?.DEVICE_TYPE,
    value?.hostInfo?.deviceType
  ].map(normalized).filter(Boolean)
}

function identityNames(value) {
  const candidates = [
    value?.name,
    value?.displayName,
    value?.serviceName,
    value?.fqdn,
    value?.activeEndpoint?.serviceName,
    value?.activeEndpoint?.fqdn
  ]
  for (const endpoint of value?.endpoints || []) {
    candidates.push(endpoint?.serviceName, endpoint?.fqdn)
  }
  return candidates.map(normalized).filter(Boolean)
}

/**
 * Protocol identity for the Cosmic Ring VST3. Its OSCQuery HTTP port is
 * operator-configurable and can fall back across 16 ports, so unlike the
 * legacy MaxRing bridge identity must not depend on one hard-coded port.
 */
export function isCosmicRingIdentity(value) {
  return declaredTypes(value).includes('cosmicring') ||
    identityNames(value).includes('livering')
}

/**
 * The registry assigns this role only to a CosmicRing service proven to be
 * hosted by one of the Manager computer's active network interfaces.
 */
export function isCosmicRingReceiverDevice(value) {
  return value?.deviceType === COSMIC_RING_DEVICE_TYPE &&
    value?.runtimeKind === COSMIC_RING_RUNTIME_KIND &&
    value?.linkRole === COSMIC_RING_LINK_ROLE &&
    isCosmicRingIdentity(value)
}
