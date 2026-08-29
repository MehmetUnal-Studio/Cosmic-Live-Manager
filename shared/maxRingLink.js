export const MAX_RING_OSCQUERY_PORT = 8005
export const RING_INSTRUMENT_OSCQUERY_PORT = 9011
// The embedded Node-for-Max receiver cannot advertise an ephemeral port when
// `/system/peer/udp_port` is zero. Port 9001 is already owned by the Manager,
// so Max/Ring gets its own stable receive port.
export const MAX_RING_DEFAULT_UDP_PORT = 9005

export const MAX_RING_RUNTIME_KIND = 'MaxForLive'
export const MAX_RING_LINK_ROLE = 'MaxRingReceiver'

function validPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0
}

function endpointPort(value) {
  return validPort(
    value?.port ?? value?.oscQueryPort ?? value?.activeEndpoint?.port
  )
}

function serviceStem(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\._oscjson\._tcp(?:\.local)?\.?$/, '')
    .replace(/[^a-z0-9]+/g, '')
}

function identityCandidates(value) {
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
  return candidates.map(serviceStem).filter(Boolean)
}

function hasIdentity(value, expected) {
  return identityCandidates(value).includes(expected)
}

/**
 * Exact protocol identity only. Local-interface verification is deliberately
 * performed by DeviceRegistry before it assigns MAX_RING_LINK_ROLE.
 */
export function isMaxRingIdentity(value) {
  return endpointPort(value) === MAX_RING_OSCQUERY_PORT &&
    hasIdentity(value, 'maxring')
}

export function isRingInstrumentIdentity(value) {
  return endpointPort(value) === RING_INSTRUMENT_OSCQUERY_PORT &&
    hasIdentity(value, 'ringinstrument')
}

/**
 * A trusted Max/Ring receiver is not inferred from its name alone. The
 * registry assigns this role only after proving that MaxRing:8005 belongs to
 * one of the Manager computer's active interfaces.
 */
export function isMaxRingReceiverDevice(value) {
  return value?.runtimeKind === MAX_RING_RUNTIME_KIND &&
    value?.linkRole === MAX_RING_LINK_ROLE &&
    isMaxRingIdentity(value)
}
