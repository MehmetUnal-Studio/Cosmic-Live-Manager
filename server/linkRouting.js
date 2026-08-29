import { DEVICE_TYPES } from './deviceRegistry.js'
import {
  isMaxRingIdentity,
  isMaxRingReceiverDevice,
  isRingInstrumentIdentity,
  MAX_RING_DEFAULT_UDP_PORT
} from '../shared/maxRingLink.js'
import {
  isCosmicRingIdentity,
  isCosmicRingReceiverDevice
} from '../shared/cosmicRingLink.js'

const ABLETON_MAX_TYPE = 'AbletonMax'

function validPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0
}

function validOscPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0
}

export async function resolveOscUdpPort(target, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 2000
} = {}) {
  const cached = validOscPort(target?.oscPort)
  if (cached) return cached

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let resolutionError = null
  try {
    const response = await fetchImpl(
      `http://${target.address}:${target.port}/?HOST_INFO`,
      { signal: controller.signal }
    )
    if (!response.ok) throw new Error(`HOST_INFO returned HTTP ${response.status}`)
    const info = await response.json()
    const advertised = validOscPort(info?.OSC_PORT)
    if (advertised) return advertised
    throw new Error('HOST_INFO did not advertise OSC_PORT')
  } catch (error) {
    resolutionError = error
  } finally {
    clearTimeout(timeout)
  }

  const detail = resolutionError?.message ? `: ${resolutionError.message}` : ''
  throw new Error(`CosmicUnity OSC UDP port is unavailable${detail}`)
}

function endpointFromManagedDevice(device) {
  const address = String(device?.host || device?.activeEndpoint?.host || '').trim()
  const port = validPort(device?.oscQueryPort ?? device?.port ?? device?.activeEndpoint?.port)
  if (!address || !port) throw new Error('Managed device has no valid endpoint')
  return {
    address,
    port,
    name: String(device?.name || address),
    oscPort: validPort(device?.oscPort)
  }
}

function endpointFromDiscovery(service) {
  const address = String(service?.address || service?.host || '').trim()
  const port = validPort(service?.port ?? service?.oscQueryPort)
  if (!address || !port) throw new Error('Selected target has no valid endpoint')
  return {
    address,
    port,
    name: String(service?.name || address),
    oscPort: validPort(service?.oscPort)
  }
}

function normalized(value) {
  return String(value || '').trim().toLowerCase()
}

function sanitizedPeerId(value) {
  return normalized(value).replace(/[^a-z0-9_-]+/g, '_')
}

function isAbletonRingReceiverDevice(value) {
  return isMaxRingReceiverDevice(value) || isCosmicRingReceiverDevice(value)
}

function defaultRingReceiverUdpPort(value) {
  return isMaxRingReceiverDevice(value) ? MAX_RING_DEFAULT_UDP_PORT : 0
}

function inferredType(value) {
  if (isMaxRingIdentity(value) || isCosmicRingIdentity(value)) return ABLETON_MAX_TYPE
  const declared = normalized(
    value?.deviceType || value?.type || value?.txt?.device_type || value?.txt?.deviceType ||
    value?.txt?.DEVICE_TYPE
  )
  if (declared === 'android') return DEVICE_TYPES.ANDROID
  if (declared === 'cosmicunity' || declared === 'cosmic unity') return DEVICE_TYPES.COSMIC_UNITY
  if (
    declared === 'manager' ||
    declared === 'cosmiclivemanager' ||
    declared === 'cosmic live manager'
  ) return 'Manager'
  if (declared === 'oscquery' || declared === 'oscquery-device') return DEVICE_TYPES.OSCQUERY
  if (normalized(value?.name || value?.serviceName) === 'cosmic live manager') return 'Manager'
  if (/android/i.test(value?.name || value?.serviceName || '')) return DEVICE_TYPES.ANDROID
  return DEVICE_TYPES.OSCQUERY
}

export function findRegistryDeviceForTarget(records, target) {
  const targetFqdn = normalized(target?.fqdn)
  const endpoint = endpointFromDiscovery(target)
  const availableRecords = Array.isArray(records) ? records : []
  const candidatesFor = (record) =>
    [record?.activeEndpoint, ...(record?.endpoints || [])].filter(Boolean)

  // Identity beats topology globally, not just within each record. Otherwise
  // an earlier stale record without an FQDN can win via host:port before the
  // later record carrying the exact Bonjour identity is inspected.
  if (targetFqdn) {
    const exact = availableRecords.find((record) =>
      candidatesFor(record).some((candidate) => normalized(candidate?.fqdn) === targetFqdn)
    )
    if (exact) return exact
  }

  return availableRecords.find((record) =>
    candidatesFor(record).some((candidate) => {
      // When the target has an FQDN, only a genuinely legacy endpoint without
      // one is eligible for topology fallback. A different FQDN is a different
      // service even if DHCP has reused the address.
      if (targetFqdn && normalized(candidate?.fqdn)) return false
      return normalized(candidate?.host) === normalized(endpoint.address) &&
        validPort(candidate?.port) === endpoint.port
    })
  ) || null
}

function trustedEndpointForTarget(record, submittedTarget) {
  const candidates = [record?.activeEndpoint, ...(record?.endpoints || [])]
    .filter((endpoint) => endpoint?.host && validPort(endpoint?.port))
  const targetFqdn = normalized(submittedTarget?.fqdn)

  if (targetFqdn) {
    const exact = candidates.find(
      (endpoint) => normalized(endpoint?.fqdn) === targetFqdn
    )
    if (exact) return exact
  }

  const submittedHost = normalized(submittedTarget?.address || submittedTarget?.host)
  const submittedPort = validPort(submittedTarget?.port ?? submittedTarget?.oscQueryPort)
  return candidates.find((endpoint) =>
    normalized(endpoint.host) === submittedHost &&
    validPort(endpoint.port) === submittedPort
  ) || null
}

/**
 * Resolve the Max/Ring peer from server-owned discovery/registry state. A
 * browser payload may identify a target by FQDN, but it never gets to choose
 * the host written into Ableton. This also makes a stale browser address safe
 * when Bonjour has already observed the same service at its new endpoint.
 */
export function resolveMaxRingTargetFromRegistry(records, submittedTarget) {
  const record = findRegistryDeviceForTarget(records, submittedTarget)
  if (!record) {
    throw new Error('Max/Ring LINK target must be present in the Device Registry')
  }
  if (
    record.discoveryState !== 'Discovered' &&
    record.connectionState !== 'Connected'
  ) {
    throw new Error('Ring-Instrument is unavailable')
  }

  const endpoint = trustedEndpointForTarget(record, submittedTarget)
  if (!endpoint) {
    throw new Error('Max/Ring LINK target endpoint is not trusted')
  }
  const trustedTarget = {
    address: endpoint.host,
    port: validPort(endpoint.port),
    fqdn: endpoint.fqdn || submittedTarget?.fqdn || '',
    name: record.serviceName || record.name || endpoint.serviceName || submittedTarget?.name,
    serviceName: record.serviceName || endpoint.serviceName || record.name,
    deviceType: record.deviceType,
    runtimeKind: record.runtimeKind,
    linkRole: record.linkRole
  }
  if (!isRingInstrumentIdentity(trustedTarget)) {
    throw new Error('Max/Ring LINK target must be Ring-Instrument on port 9011')
  }
  return { record, target: trustedTarget }
}

export function resolveRingInstrumentTargetFromRegistry(records, submittedTarget) {
  return resolveMaxRingTargetFromRegistry(records, submittedTarget)
}

/**
 * Resolve the reverse UI direction (Ring-Instrument card -> Max_Ring) using
 * the same server-owned trust boundary. The browser may select by FQDN, but
 * only a verified-local MaxRing:8005 registry record can become the receiver
 * and its registered endpoint always replaces the submitted host/port.
 */
export function resolveMaxRingReceiverFromRegistry(records, submittedTarget) {
  const record = findRegistryDeviceForTarget(records, submittedTarget)
  if (!record) {
    throw new Error('Ring-Instrument LINK target must be present in the Device Registry')
  }
  if (
    record.discoveryState !== 'Discovered' &&
    record.connectionState !== 'Connected'
  ) {
    throw new Error('Max/Ring receiver is unavailable')
  }

  const endpoint = trustedEndpointForTarget(record, submittedTarget)
  if (!endpoint) {
    throw new Error('Ring-Instrument LINK target endpoint is not trusted')
  }
  if (endpoint.verifiedLocal !== true) {
    throw new Error('Ring-Instrument LINK target must resolve to a verified local endpoint')
  }
  const trustedTarget = {
    address: endpoint.host,
    port: validPort(endpoint.port),
    fqdn: endpoint.fqdn || submittedTarget?.fqdn || '',
    name: record.name || record.serviceName || endpoint.serviceName || submittedTarget?.name,
    serviceName: record.serviceName || endpoint.serviceName || record.name,
    deviceType: record.deviceType,
    runtimeKind: record.runtimeKind,
    linkRole: record.linkRole
  }
  if (!isMaxRingReceiverDevice(trustedTarget)) {
    throw new Error('Ring-Instrument LINK target must be the verified local MaxRing on port 8005')
  }
  return { record, target: trustedTarget }
}

/**
 * Resolve either trusted Ableton Ring receiver. MaxRing and CosmicRing share
 * the same Ring-Instrument peer, but retain different UDP defaults.
 */
export function resolveRingReceiverFromRegistry(records, submittedTarget) {
  const record = findRegistryDeviceForTarget(records, submittedTarget)
  if (!record) {
    throw new Error('Ring-Instrument LINK target must be present in the Device Registry')
  }
  if (
    record.discoveryState !== 'Discovered' &&
    record.connectionState !== 'Connected'
  ) {
    throw new Error('Ableton Ring receiver is unavailable')
  }

  const endpoint = trustedEndpointForTarget(record, submittedTarget)
  if (!endpoint) {
    throw new Error('Ring-Instrument LINK target endpoint is not trusted')
  }
  if (endpoint.verifiedLocal !== true) {
    throw new Error('Ring-Instrument LINK target must resolve to a verified local endpoint')
  }
  const trustedTarget = {
    address: endpoint.host,
    port: validPort(endpoint.port),
    fqdn: endpoint.fqdn || submittedTarget?.fqdn || '',
    name: record.name || record.serviceName || endpoint.serviceName || submittedTarget?.name,
    serviceName: record.serviceName || endpoint.serviceName || record.name,
    deviceType: record.deviceType,
    runtimeKind: record.runtimeKind,
    linkRole: record.linkRole
  }
  if (!isAbletonRingReceiverDevice(trustedTarget)) {
    throw new Error('Ring-Instrument LINK target must be a verified local Ableton Ring receiver')
  }
  return { record, target: trustedTarget }
}

/**
 * Resolve Ring-Instrument's current peer coordinates from its server-owned
 * registry entity. A manifest can retain yesterday's IP after DHCP changes;
 * the active endpoint observed by discovery/connection must win before those
 * coordinates are written into Max.
 */
export function resolveRingInstrumentSourceFromRegistry(record) {
  if (!record) throw new Error('Ring-Instrument is absent from the Device Registry')
  if (
    record.discoveryState !== 'Discovered' &&
    record.connectionState !== 'Connected'
  ) {
    throw new Error('Ring-Instrument is unavailable')
  }

  const endpoint = [record.activeEndpoint, ...(record.endpoints || [])]
    .find((candidate) => candidate?.host && validPort(candidate?.port))
  if (!endpoint) throw new Error('Ring-Instrument has no trusted active endpoint')

  const trustedSource = {
    name: record.name || record.serviceName || endpoint.serviceName || 'Ring-Instrument',
    serviceName: record.serviceName || endpoint.serviceName || record.name,
    host: endpoint.host,
    oscQueryPort: validPort(endpoint.port),
    deviceType: record.deviceType
  }
  if (!isRingInstrumentIdentity(trustedSource)) {
    throw new Error('Max/Ring LINK peer must be Ring-Instrument on port 9011')
  }
  return trustedSource
}

/**
 * Resolve the UI's symmetric "device ↔ target" selection into the asymmetric
 * CosmicUnity bootstrap protocol.
 *
 * `/system/peer/*` must always be written TO the CosmicUnity instance. The
 * values written there must always describe the external OSCQuery instrument
 * that the VST should dial. This keeps both the current Cosmic-card UI and
 * external-device card callers compatible without reversing the wire protocol.
 *
 * `udpPort=0` is intentional: CosmicUnity treats this field as a local receive
 * port, not the tablet's OSC port. Zero lets each VST bind a unique ephemeral
 * port and register that actual bound port with the tablet.
 */
export function resolveLinkAnnouncement({
  sourceDevice,
  selectedTarget,
  peerId,
  udpPortOverride = 0
}) {
  const sourceType = inferredType(sourceDevice)
  const targetType = inferredType(selectedTarget)
  const override = validPort(udpPortOverride)

  if (isAbletonRingReceiverDevice(sourceDevice)) {
    if (!isRingInstrumentIdentity(selectedTarget)) {
      throw new Error('Max/Ring LINK target must be Ring-Instrument on port 9011')
    }
    const receiver = endpointFromManagedDevice(sourceDevice)
    const peer = endpointFromDiscovery(selectedTarget)
    return {
      target: receiver,
      peerId: sanitizedPeerId(peerId || peer.name),
      receiverName: receiver.name,
      peerName: peer.name,
      host: peer.address,
      oscQueryPort: peer.port,
      udpPort: override || defaultRingReceiverUdpPort(sourceDevice)
    }
  }

  if (
    isRingInstrumentIdentity(sourceDevice) &&
    (isMaxRingIdentity(selectedTarget) || isCosmicRingIdentity(selectedTarget))
  ) {
    if (!isAbletonRingReceiverDevice(selectedTarget)) {
      throw new Error('Ring-Instrument LINK target must be a verified local Ableton Ring receiver')
    }
    const receiver = endpointFromDiscovery(selectedTarget)
    const peer = endpointFromManagedDevice(sourceDevice)
    return {
      target: receiver,
      peerId: sanitizedPeerId(peerId || peer.name),
      receiverName: receiver.name,
      peerName: peer.name,
      host: peer.address,
      oscQueryPort: peer.port,
      udpPort: override || defaultRingReceiverUdpPort(selectedTarget)
    }
  }

  if (sourceType === DEVICE_TYPES.COSMIC_UNITY) {
    if (![DEVICE_TYPES.ANDROID, DEVICE_TYPES.OSCQUERY].includes(targetType)) {
      throw new Error('CosmicUnity LINK target must be an Android or OSCQuery device')
    }
    const receiver = endpointFromManagedDevice(sourceDevice)
    const peer = endpointFromDiscovery(selectedTarget)
    return {
      target: receiver,
      peerId: sanitizedPeerId(peerId || peer.name),
      receiverName: receiver.name,
      peerName: peer.name,
      host: peer.address,
      oscQueryPort: peer.port,
      udpPort: override
    }
  }

  if ([DEVICE_TYPES.ANDROID, DEVICE_TYPES.OSCQUERY].includes(sourceType)) {
    if (targetType !== DEVICE_TYPES.COSMIC_UNITY) {
      throw new Error('External OSCQuery LINK target must be a CosmicUnity device')
    }
    const receiver = endpointFromDiscovery(selectedTarget)
    const peer = endpointFromManagedDevice(sourceDevice)
    return {
      target: receiver,
      peerId: sanitizedPeerId(peerId || peer.name),
      receiverName: receiver.name,
      peerName: peer.name,
      host: peer.address,
      oscQueryPort: peer.port,
      udpPort: override
    }
  }

  if (sourceType === ABLETON_MAX_TYPE) {
    throw new Error('Max/Ring LINK receiver is not verified on this computer')
  }

  throw new Error('LINK requires one CosmicUnity device and one external OSCQuery device')
}
