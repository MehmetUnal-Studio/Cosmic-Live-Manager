import {
  isMaxRingIdentity,
  isMaxRingReceiverDevice,
  isRingInstrumentIdentity
} from '../../shared/maxRingLink.js'
import {
  isCosmicRingIdentity,
  isCosmicRingReceiverDevice
} from '../../shared/cosmicRingLink.js'

function normalized(value) {
  return String(value || '').trim().toLowerCase()
}

const TARGET_TYPES = Object.freeze({
  ABLETON_MAX: 'AbletonMax',
  ANDROID: 'Android',
  COSMIC_UNITY: 'CosmicUnity',
  MANAGER: 'Manager',
  OSCQUERY: 'OSCQuery'
})

function portOf(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

export function isCosmicUnityDevice(device) {
  if (device?.deviceType === 'CosmicUnity') return true
  const port = portOf(device?.port ?? device?.oscQueryPort)
  return device?.isLocal === true && port >= 5001 && port <= 5016
}

export function isCosmicUnityOrAbletonDevice(device) {
  return isCosmicUnityDevice(device) || isAbletonRingReceiverDevice(device)
}

// Cosmic Leap VST (Ableton-side gesture→MIDI instance; TXT device_type
// "CosmicLeap", default service name "MaxLeap"). Used for dashboard
// grouping only — it deliberately takes no part in the LINK topology rules.
export function isCosmicLeapDevice(device) {
  const declared = normalized(device?.deviceType)
  if (declared === 'cosmicleap') return true
  if (declared === 'android') return false
  return /leap/i.test(device?.name || '') || /leap/i.test(device?.serviceName || '')
}

export function isAbletonRingReceiverDevice(device) {
  return isMaxRingReceiverDevice(device) || isCosmicRingReceiverDevice(device)
}

export {
  isCosmicRingIdentity,
  isCosmicRingReceiverDevice,
  isMaxRingIdentity,
  isMaxRingReceiverDevice,
  isRingInstrumentIdentity
}

export function isAndroidDevice(device) {
  if (isCosmicUnityDevice(device)) return false
  return device?.deviceType === 'Android' || /android/i.test(device?.name || '')
}

function serviceAddresses(service) {
  return new Set(
    [service?.address, service?.host, ...(service?.addresses || [])]
      .map(normalized)
      .filter(Boolean)
  )
}

function deviceEndpoints(device) {
  const endpoints = [...(device?.endpoints || [])]
  if (device?.activeEndpoint) endpoints.push(device.activeEndpoint)
  if (device?.host && (device?.port || device?.oscQueryPort)) {
    endpoints.push({
      host: device.host,
      port: device.port || device.oscQueryPort
    })
  }
  return endpoints
}

export function serviceMatchesDevice(service, device) {
  if (!service || !device) return false

  const serviceFqdn = normalized(service.fqdn)
  const servicePort = portOf(service.port)
  const addresses = serviceAddresses(service)
  const endpoints = deviceEndpoints(device)

  // Within one record, prefer a stable Bonjour identity before considering
  // legacy endpoint aliases. This prevents an endpoint without an FQDN from
  // winning merely because it appears earlier in the array.
  if (
    serviceFqdn &&
    endpoints.some((endpoint) => normalized(endpoint?.fqdn) === serviceFqdn)
  ) {
    return true
  }

  return endpoints.some((endpoint) => {
    const endpointFqdn = normalized(endpoint?.fqdn)
    // When both sides have a service identity, a different FQDN means a
    // different Bonjour observation even if a stale record reused host:port.
    // Fall back to endpoint matching only when one side genuinely lacks FQDN.
    if (serviceFqdn && endpointFqdn) return serviceFqdn === endpointFqdn

    const endpointPort = portOf(endpoint?.port)
    const endpointHost = normalized(endpoint?.host)
    return servicePort != null &&
      endpointPort === servicePort &&
      endpointHost &&
      addresses.has(endpointHost)
  })
}

export function findRegistryDeviceForService(service, registryDevices) {
  if (!service) return null
  const devices = Array.isArray(registryDevices) ? registryDevices : []
  const serviceFqdn = normalized(service.fqdn)

  // Identity matching must be global, not dependent on registry ordering. A
  // stale record can legitimately retain a host:port alias without an FQDN;
  // an exact FQDN on another record is stronger evidence and must win first.
  if (serviceFqdn) {
    const exact = devices.find((device) =>
      deviceEndpoints(device).some(
        (endpoint) => normalized(endpoint?.fqdn) === serviceFqdn
      )
    )
    if (exact) return exact
  }

  return devices.find((device) => serviceMatchesDevice(service, device)) || null
}

export function serializeLinkTarget(target) {
  if (!target || typeof target !== 'object') return {}

  // Keep the discovery identity intact across the UI -> WebSocket boundary.
  // The backend needs FQDN/TXT/deviceType to resolve same-host aliases without
  // falling back to display-name heuristics.
  const serialized = { ...target }
  if (target.txt && typeof target.txt === 'object') serialized.txt = { ...target.txt }
  if (Array.isArray(target.addresses)) serialized.addresses = [...target.addresses]
  return serialized
}

function declaredServiceType(service) {
  const txt = service?.txt || {}
  const declaredType = normalized(
    service?.deviceType || txt.device_type || txt.deviceType || txt.DEVICE_TYPE
  )

  if (declaredType === 'android') return TARGET_TYPES.ANDROID
  if (declaredType === 'cosmicunity' || declaredType === 'cosmic unity') {
    return TARGET_TYPES.COSMIC_UNITY
  }
  if (declaredType === 'cosmicring' || declaredType === 'cosmic ring') {
    return TARGET_TYPES.ABLETON_MAX
  }
  if (
    declaredType === 'manager' ||
    declaredType === 'cosmiclivemanager' ||
    declaredType === 'cosmic live manager'
  ) {
    return TARGET_TYPES.MANAGER
  }
  if (declaredType === 'oscquery' || declaredType === 'oscquery-device') {
    return TARGET_TYPES.OSCQUERY
  }
  return null
}

function classifyService(service, registryDevices) {
  const registryDevice = findRegistryDeviceForService(service, registryDevices)

  // Registry identity is authoritative. It survives service renames and IP
  // changes, unlike a Bonjour display name.
  if (registryDevice) {
    // MaxRing is an Ableton/Max receiver role, not a generic external
    // instrument. Exact identity keeps it out of every CosmicUnity target
    // list even while the trusted local role is still converging.
    if (
      isMaxRingIdentity(registryDevice) ||
      isCosmicRingIdentity(registryDevice)
    ) {
      return { type: TARGET_TYPES.ABLETON_MAX, definitive: true }
    }
    if (isCosmicUnityDevice(registryDevice)) {
      return { type: TARGET_TYPES.COSMIC_UNITY, definitive: true }
    }
    if (isAndroidDevice(registryDevice)) {
      return { type: TARGET_TYPES.ANDROID, definitive: true }
    }
    return { type: TARGET_TYPES.OSCQUERY, definitive: true }
  }

  if (isMaxRingIdentity(service) || isCosmicRingIdentity(service)) {
    return { type: TARGET_TYPES.ABLETON_MAX, definitive: true }
  }

  const declaredType = declaredServiceType(service)
  if (declaredType) return { type: declaredType, definitive: true }

  // The Manager publishes itself without a device_type TXT field. Its own
  // well-known service name is enough to hide it, but not strong enough to
  // destructively clear storage if a remote service happens to reuse the name.
  if (normalized(service?.name) === 'cosmic live manager') {
    return { type: TARGET_TYPES.MANAGER, definitive: false }
  }

  // Backward compatibility for Android APKs that predate device_type/UUID.
  // This is sufficient for display filtering, but deliberately non-definitive
  // so a persisted target is not destructively cleared on a name heuristic.
  if (/android/i.test(service?.name || '')) {
    return { type: TARGET_TYPES.ANDROID, definitive: false }
  }

  return { type: TARGET_TYPES.OSCQUERY, definitive: false }
}

function isAllowedTargetType(sourceDevice, targetType) {
  if (isCosmicUnityDevice(sourceDevice)) {
    return targetType === TARGET_TYPES.ANDROID || targetType === TARGET_TYPES.OSCQUERY
  }
  return targetType === TARGET_TYPES.COSMIC_UNITY
}

function isAllowedTarget(sourceDevice, service, targetType, registryDevices) {
  if (isAbletonRingReceiverDevice(sourceDevice)) {
    return isRingInstrumentIdentity(service)
  }

  // Exact Ring receiver identities fail closed until the registry has proven
  // their endpoint belongs to this computer and assigned a trusted role.
  // Otherwise the UI would offer normal CosmicUnity targets that the backend
  // correctly rejects for a remote or spoofed Live-Ring/MaxRing source.
  if (isMaxRingIdentity(sourceDevice) || isCosmicRingIdentity(sourceDevice)) {
    return false
  }

  // Ring-Instrument remains a normal external OSCQuery peer for regular
  // CosmicUnity instances, but it is also the one device allowed to address
  // the trusted local Max/Ring receiver. Never grant that receiver capability
  // from a raw Bonjour name alone: the registry must have assigned the local
  // MaxForLive role first.
  if (
    isRingInstrumentIdentity(sourceDevice) &&
    targetType === TARGET_TYPES.ABLETON_MAX
  ) {
    return isAbletonRingReceiverDevice(
      findRegistryDeviceForService(service, registryDevices)
    )
  }
  return isAllowedTargetType(sourceDevice, targetType)
}

function registryDeviceAsLinkService(device) {
  const state = String(device?.connectionState || '').toLowerCase()
  const discovery = String(device?.discoveryState || '').toLowerCase()
  if (state !== 'connected' && discovery !== 'discovered') return null

  const endpoint = device?.activeEndpoint || (device?.endpoints || []).find(
    (candidate) => candidate?.available !== false
  )
  const fqdn = String(endpoint?.fqdn || '').trim()
  const address = String(endpoint?.host || '').trim()
  const port = portOf(endpoint?.port)
  // DeviceCard persists FQDN as the selected key. Without a real Bonjour
  // identity we keep the candidate out rather than inventing an unstable key.
  if (!fqdn || !address || !port) return null

  return {
    fqdn,
    name: device.name || device.serviceName || endpoint.serviceName || address,
    address,
    addresses: [address],
    port,
    deviceType: device.deviceType,
    runtimeKind: device.runtimeKind,
    linkRole: device.linkRole,
    registryBacked: true
  }
}

function registryEndpointForService(service, device) {
  const endpoints = deviceEndpoints(device)
  const fqdn = normalized(service?.fqdn)
  const addresses = serviceAddresses(service)
  const port = portOf(service?.port)
  if (fqdn) {
    const exact = endpoints.filter((endpoint) => normalized(endpoint?.fqdn) === fqdn)
    return exact.find((endpoint) => addresses.has(normalized(endpoint?.host))) ||
      exact.sort((a, b) => Number(b?.lastSeen || 0) - Number(a?.lastSeen || 0))[0] ||
      null
  }
  return endpoints.find((endpoint) =>
    portOf(endpoint?.port) === port && addresses.has(normalized(endpoint?.host))
  ) || null
}

function candidateScore(service, registryDevice) {
  const endpoint = registryDevice
    ? registryEndpointForService(service, registryDevice)
    : null
  const hasNonLoopback = Array.from(serviceAddresses(service)).some((host) =>
    !['127.0.0.1', '::1', 'localhost'].includes(host)
  )
  return [
    endpoint?.available === false ? 0 : 1,
    hasNonLoopback ? 1 : 0,
    Number(endpoint?.lastSeen || service?.lastSeen || 0)
  ]
}

function preferCandidate(next, current, registryDevice) {
  const nextScore = candidateScore(next, registryDevice)
  const currentScore = candidateScore(current, registryDevice)
  for (let index = 0; index < nextScore.length; index += 1) {
    if (nextScore[index] !== currentScore[index]) {
      return nextScore[index] > currentScore[index]
    }
  }
  return false
}

function candidateAliasFqdns(service, registryDevice) {
  return new Set([
    service?.fqdn,
    ...(service?.aliasFqdns || []),
    ...deviceEndpoints(registryDevice).map((endpoint) => endpoint?.fqdn)
  ].map(normalized).filter(Boolean))
}

function linkServiceCandidates(services, registryDevices) {
  const candidates = new Map()
  for (const service of Array.isArray(services) ? services : []) {
    const registryDevice = findRegistryDeviceForService(service, registryDevices)
    const candidate = isAbletonRingReceiverDevice(registryDevice)
      ? {
          // Raw Bonjour wins the FQDN dedup race, so carry the trusted registry
          // role and operator-facing manifest name onto that live candidate.
          ...service,
          name: registryDevice.name || service.name,
          deviceType: registryDevice.deviceType,
          runtimeKind: registryDevice.runtimeKind,
          linkRole: registryDevice.linkRole
        }
      : service
    const fqdn = normalized(service?.fqdn)
    const endpointIdentity = `${normalized(service?.address || service?.host)}:${portOf(service?.port) || 0}:${normalized(service?.name)}`
    const key = registryDevice?.canonicalId
      ? `registry:${registryDevice.canonicalId}`
      : fqdn
        ? `fqdn:${fqdn}`
        : `endpoint:${endpointIdentity}`
    const current = candidates.get(key)
    const aliasFqdns = candidateAliasFqdns(candidate, registryDevice)
    if (current) {
      for (const alias of current.aliasFqdns) aliasFqdns.add(alias)
    }
    if (!current || preferCandidate(candidate, current.candidate, registryDevice)) {
      candidates.set(key, { candidate, registryDevice, aliasFqdns })
    } else {
      current.aliasFqdns = aliasFqdns
    }
  }

  // A single canonical registry entity may retain several historical Bonjour
  // FQDN aliases. Keep one option for that physical device, preferring an
  // available non-loopback announcement and then the freshest observation.
  for (const device of Array.isArray(registryDevices) ? registryDevices : []) {
    const key = device?.canonicalId ? `registry:${device.canonicalId}` : ''
    if (key && candidates.has(key)) continue
    const candidate = registryDeviceAsLinkService(device)
    if (!candidate) continue
    const fallbackKey = key || `fqdn:${normalized(candidate.fqdn)}`
    if (!candidates.has(fallbackKey)) {
      candidates.set(fallbackKey, {
        candidate,
        registryDevice: device,
        aliasFqdns: candidateAliasFqdns(candidate, device)
      })
    }
  }
  return Array.from(candidates.values(), ({ candidate, aliasFqdns }) => {
    const preferredFqdn = normalized(candidate?.fqdn)
    const historicalAliases = Array.from(
      aliasFqdns || candidateAliasFqdns(candidate, null)
    ).filter((alias) => alias !== preferredFqdn)
    if (historicalAliases.length === 0) return candidate
    return {
      ...candidate,
      // Preserve historical Bonjour identities folded into this canonical
      // device. DeviceCard uses them to migrate sticky LINK selections when
      // the preferred endpoint changes from loopback to LAN (or vice versa).
      aliasFqdns: historicalAliases
    }
  })
}

export function findLinkTargetByFqdn(services, fqdn) {
  const selected = normalized(fqdn)
  if (!selected) return null
  return (Array.isArray(services) ? services : []).find((service) =>
    normalized(service?.fqdn) === selected ||
    (service?.aliasFqdns || []).some((alias) => normalized(alias) === selected)
  ) || null
}

export function filterLinkTargetServices(sourceDevice, services, registryDevices) {
  // A live OSCQuery/WebSocket connection is stronger availability evidence
  // than a transiently empty mDNS browse immediately after Manager restart.
  // Merge connected/discovered registry entities by their real FQDN so LINK
  // targets do not flicker while Bonjour reconverges.
  const availableServices = linkServiceCandidates(services, registryDevices)
  return availableServices.filter((service) => {
    if (serviceMatchesDevice(service, sourceDevice)) return false
    return isAllowedTarget(
      sourceDevice,
      service,
      classifyService(service, registryDevices).type,
      registryDevices
    )
  })
}

// Returns only targets whose current raw discovery record proves that a
// previously persisted selection violates the source/target topology. Unknown
// or offline targets are intentionally omitted so reconnecting devices retain
// their sticky LINK selection while discovery and registry streams converge.
export function knownDisallowedLinkTargetFqdns(sourceDevice, services, registryDevices) {
  const out = []
  for (const service of Array.isArray(services) ? services : []) {
    if (!service?.fqdn) continue
    if (serviceMatchesDevice(service, sourceDevice)) {
      out.push(service.fqdn)
      continue
    }

    const classification = classifyService(service, registryDevices)
    if (
      isAbletonRingReceiverDevice(sourceDevice) &&
      !isRingInstrumentIdentity(service)
    ) {
      out.push(service.fqdn)
      continue
    }
    if (
      classification.definitive &&
      !isAllowedTarget(sourceDevice, service, classification.type, registryDevices)
    ) {
      out.push(service.fqdn)
    }
  }
  return out
}
