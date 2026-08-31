import os from 'node:os'
import {
  isMaxRingIdentity,
  MAX_RING_LINK_ROLE,
  MAX_RING_RUNTIME_KIND
} from '../shared/maxRingLink.js'
import {
  COSMIC_RING_DEVICE_TYPE,
  COSMIC_RING_LINK_ROLE,
  COSMIC_RING_RUNTIME_KIND,
  isCosmicRingIdentity
} from '../shared/cosmicRingLink.js'

export const DEVICE_TYPES = Object.freeze({
  COSMIC_UNITY: 'CosmicUnity',
  COSMIC_RING: COSMIC_RING_DEVICE_TYPE,
  ANDROID: 'Android',
  OSCQUERY: 'OSCQuery'
})

export const CONNECTION_STATES = Object.freeze({
  DISCOVERED: 'Discovered',
  CONNECTING: 'Connecting',
  CONNECTED: 'Connected',
  UNAVAILABLE: 'Unavailable',
  ERROR: 'Error',
  DISABLED: 'Disabled'
})

export function normalizeConnectionState(value, enabled = true) {
  if (!enabled) return CONNECTION_STATES.DISABLED
  switch (String(value || '').toLowerCase()) {
    case 'connecting': return CONNECTION_STATES.CONNECTING
    case 'connected': return CONNECTION_STATES.CONNECTED
    case 'unavailable':
    case 'lost': return CONNECTION_STATES.UNAVAILABLE
    case 'error':
    case 'connection failed': return CONNECTION_STATES.ERROR
    case 'disabled': return CONNECTION_STATES.DISABLED
    default: return CONNECTION_STATES.DISCOVERED
  }
}

const DEVICE_ID_KEYS = [
  'persistentDeviceId',
  'deviceId', 'device_id', 'device-id', 'DEVICE_ID',
  'instanceUuid', 'instance_uuid', 'INSTANCE_UUID',
  'uuid', 'UUID'
]

function cleanText(value, max = 256) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function normalizeHost(value) {
  const host = cleanText(value).toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return '127.0.0.1'
  }
  if (host.startsWith('::ffff:')) return host.slice(7)
  return host
}

export function normalizeIdentityToken(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128)
}

export function getLocalInterfaceAddresses(networkInterfaces = os.networkInterfaces()) {
  const addresses = new Set(['127.0.0.1', '::1', 'localhost'])
  for (const interfaces of Object.values(networkInterfaces || {})) {
    for (const iface of interfaces || []) {
      if (!iface?.address) continue
      addresses.add(normalizeHost(iface.address))
    }
  }
  return addresses
}

export function isVerifiedLocalHost(host, localAddresses = getLocalInterfaceAddresses()) {
  return localAddresses.has(normalizeHost(host))
}

export function extractPersistentDeviceId(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    for (const key of DEVICE_ID_KEYS) {
      const value = normalizeIdentityToken(source[key])
      if (value) return value
    }
    // OSCQuery-Unity 1.2.2 has no extensible HOST_INFO/TXT identity field.
    // New Android builds therefore carry an installation UUID in the existing
    // service name (`--id-<32 hex>`), which old OSCQuery clients safely ignore.
    for (const candidate of [source.serviceName, source.name, source.NAME]) {
      const match = cleanText(candidate).match(/--id-([a-f0-9]{32})(?=-|$)/i)
      if (match) return normalizeIdentityToken(match[1])
    }
  }
  return ''
}

// Name comparison for identity verification collapses every separator:
// manifest labels, mDNS instance names and HOST_INFO NAMEs write the same
// device as "HealthyDevice", "Healthy Device" or "healthy-device". The
// discriminator that matters — Tablet01 vs Tablet02 — survives collapsing.
function collapseNameForComparison(value) {
  return cleanText(displayNameWithoutIdentityToken(value))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function fqdnInstanceLabel(fqdn) {
  return cleanText(fqdn).replace(/\._[a-z0-9-]+\._(tcp|udp)\.local\.?$/i, '')
}

/**
 * Compare a managed device's known identity with the identity a freshly
 * fetched HOST_INFO declares. DHCP can hand a saved device's address to a
 * different physical device; HOST_INFO is the first moment the far end says
 * who it actually is.
 *
 * DEVICE_ID is authoritative when both sides declare one — a renamed device
 * with the same installation id still verifies. Without ids on both sides the
 * name fallback needs mDNS-grade evidence on the record side: only when the
 * dialed endpoint carries an observed fqdn does the record hold a service
 * identity worth enforcing (manifest migration synthesizes `serviceName` from
 * the display label, so a hand-typed card must stay lenient). HOST_INFO NAME
 * is then accepted against any of the fqdn instance label, the serviceName
 * and the display name. A side that declares no identity can never mismatch.
 *
 * @returns {null | { basis: 'device-id' | 'name', expected: string, found: string }}
 */
export function hostInfoIdentityMismatch(expected, hostInfo) {
  if (!expected || typeof expected !== 'object') return null
  if (!hostInfo || typeof hostInfo !== 'object') return null

  const expectedId = extractPersistentDeviceId(expected)
  const foundId = extractPersistentDeviceId(hostInfo)
  if (expectedId && foundId) {
    return expectedId === foundId
      ? null
      : { basis: 'device-id', expected: expectedId, found: foundId }
  }

  const endpoints = Array.from(expected.endpoints?.values?.() || expected.endpoints || [])
  const dialedKey = endpointKey(expected.host, expected.oscQueryPort ?? expected.port)
  const dialed = endpoints.find(
    (endpoint) => endpoint && endpointKey(endpoint.host, endpoint.port) === dialedKey
  )
  const fqdnLabel = fqdnInstanceLabel(dialed?.fqdn)
  if (!fqdnLabel) return null

  const foundName = collapseNameForComparison(hostInfo.NAME)
  if (!foundName) return null
  const acceptedNames = new Set([
    collapseNameForComparison(fqdnLabel),
    collapseNameForComparison(expected.serviceName),
    collapseNameForComparison(expected.name)
  ])
  acceptedNames.delete('')
  if (acceptedNames.has(foundName)) return null
  return {
    basis: 'name',
    expected: cleanText(expected.serviceName) || fqdnLabel,
    found: cleanText(hostInfo.NAME)
  }
}

export function displayNameWithoutIdentityToken(value) {
  return cleanText(value)
    .replace(/--id-[a-f0-9]{32}(?=-|$)/ig, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeExplicitType(value) {
  const token = normalizeIdentityToken(value)
  if (!token) return ''
  if (token.includes('cosmicunity') || token.includes('cosmic-unity')) {
    return DEVICE_TYPES.COSMIC_UNITY
  }
  if (token.includes('cosmicring') || token.includes('cosmic-ring')) {
    return DEVICE_TYPES.COSMIC_RING
  }
  if (token.includes('android')) return DEVICE_TYPES.ANDROID
  return ''
}

export function inferDeviceType(input, localAddresses = getLocalInterfaceAddresses()) {
  const explicit = normalizeExplicitType(
    input.deviceType || input.type || input.txt?.device_type || input.txt?.deviceType ||
    input.hostInfo?.DEVICE_TYPE || input.hostInfo?.deviceType
  )
  if (explicit) return explicit

  const name = cleanText(
    input.serviceName || input.hostInfo?.NAME || input.name || input.displayName
  )
  if (/android/i.test(name)) return DEVICE_TYPES.ANDROID

  const port = Number(input.port ?? input.oscQueryPort)
  const local = isVerifiedLocalHost(input.host, localAddresses)
  if (local && /^live[\s_-]*ring$/i.test(name)) return DEVICE_TYPES.COSMIC_RING
  if (/cosmic[\s_-]*unity/i.test(name)) return DEVICE_TYPES.COSMIC_UNITY
  if (local && port >= 5001 && port <= 5016 && !/android/i.test(name)) {
    return DEVICE_TYPES.COSMIC_UNITY
  }
  if (local && /^(max[-_ ]*)?tablet[-_ ]*\d+/i.test(name)) {
    return DEVICE_TYPES.COSMIC_UNITY
  }
  return DEVICE_TYPES.OSCQUERY
}

function legacyRemoteIdentity(input) {
  return normalizeIdentityToken(
    input.serviceName || input.hostInfo?.NAME || input.name || input.displayName || 'oscquery'
  ) || 'oscquery'
}

function isVerifiedLocalMaxRing(input, localAddresses) {
  const host = normalizeHost(input.host ?? input.activeEndpoint?.host)
  return isVerifiedLocalHost(host, localAddresses) && isMaxRingIdentity(input)
}

function localMaxRingCanonicalId(port) {
  return `oscquery:local-maxring:${Number(port)}`
}

function isVerifiedLocalCosmicRing(input, localAddresses) {
  const host = normalizeHost(input.host ?? input.activeEndpoint?.host)
  return isVerifiedLocalHost(host, localAddresses) &&
    inferDeviceType(input, localAddresses) === DEVICE_TYPES.COSMIC_RING &&
    isCosmicRingIdentity(input)
}

function localCosmicRingCanonicalId(port) {
  return `cosmicring:local-port:${Number(port)}`
}

function remoteCosmicRingCanonicalId(baseCanonicalId, endpoint) {
  const endpointIdentity = normalizeIdentityToken(
    endpoint?.fqdn || `${normalizeHost(endpoint?.host)}-${Number(endpoint?.port)}`
  ) || 'unknown-endpoint'
  return `${baseCanonicalId}:remote:${endpointIdentity}`
}

function hasVerifiedLocalCosmicRingEndpoint(record, localAddresses) {
  if (!record || record.deviceType !== DEVICE_TYPES.COSMIC_RING) return false
  const endpoints = Array.from(record.endpoints?.values?.() || record.endpoints || [])
  return endpoints.some((endpoint) => isVerifiedLocalCosmicRing({
    ...record,
    host: endpoint.host,
    port: endpoint.port,
    activeEndpoint: endpoint,
    endpoints
  }, localAddresses))
}

export function resolveCanonicalIdentity(input, options = {}) {
  const localAddresses = options.localAddresses || getLocalInterfaceAddresses()
  const host = normalizeHost(input.host)
  const port = Number(input.port ?? input.oscQueryPort)
  const deviceType = inferDeviceType(input, localAddresses)
  const persistentDeviceId = extractPersistentDeviceId(
    input,
    input.txt,
    input.hostInfo
  )

  if (persistentDeviceId) {
    const baseCanonicalId = `${normalizeIdentityToken(deviceType)}:uuid:${persistentDeviceId}`
    // CosmicRing receiver authority is local-machine scoped. A remote service
    // never shares the local VST's base UUID identity, even when it copies the
    // same DEVICE_ID. Prefer FQDN for DHCP continuity; fall back to endpoint
    // coordinates for legacy announcements without a service identity.
    if (
      deviceType === DEVICE_TYPES.COSMIC_RING &&
      !isVerifiedLocalHost(host, localAddresses)
    ) {
      return {
        canonicalId: remoteCosmicRingCanonicalId(baseCanonicalId, {
          host,
          port,
          fqdn: input.fqdn
        }),
        deviceType,
        persistentDeviceId,
        identitySource: 'persistent-id-remote-endpoint'
      }
    }
    return {
      canonicalId: baseCanonicalId,
      deviceType,
      persistentDeviceId,
      identitySource: 'persistent-id'
    }
  }

  if (deviceType === DEVICE_TYPES.COSMIC_UNITY && isVerifiedLocalHost(host, localAddresses)) {
    return {
      canonicalId: `cosmicunity:local-port:${port}`,
      deviceType,
      persistentDeviceId: '',
      identitySource: 'verified-local-port'
    }
  }

  // Max/Ring is a single Node-for-Max receiver bound on this computer. Bonjour
  // can announce that listener through loopback and every active LAN interface,
  // so exact MaxRing:8005 local aliases share one registry identity. Name/port
  // matching alone is deliberately insufficient for remote OSCQuery devices.
  if (isVerifiedLocalMaxRing({ ...input, host, port }, localAddresses)) {
    return {
      canonicalId: localMaxRingCanonicalId(port),
      deviceType,
      persistentDeviceId: '',
      identitySource: 'verified-local-maxring'
    }
  }

  if (isVerifiedLocalCosmicRing({ ...input, host, port }, localAddresses)) {
    return {
      canonicalId: localCosmicRingCanonicalId(port),
      deviceType,
      persistentDeviceId: '',
      identitySource: 'verified-local-cosmicring'
    }
  }

  return {
    canonicalId: `${normalizeIdentityToken(deviceType)}:legacy:${host}:${port}:${legacyRemoteIdentity(input)}`,
    deviceType,
    persistentDeviceId: '',
    identitySource: 'legacy-remote-endpoint'
  }
}

function endpointKey(host, port) {
  return `${normalizeHost(host)}:${Number(port)}`
}

function endpointFrom(input, now, source) {
  return {
    host: normalizeHost(input.host),
    port: Number(input.port ?? input.oscQueryPort),
    source,
    serviceName: cleanText(input.serviceName || input.name),
    fqdn: cleanText(input.fqdn),
    lastSeen: now,
    available: true
  }
}

function preferEndpoint(endpoints, deviceType, localAddresses) {
  if (!endpoints.length) return null
  const sorted = endpoints.slice().sort((a, b) => {
    if (
      deviceType === DEVICE_TYPES.COSMIC_UNITY ||
      deviceType === DEVICE_TYPES.COSMIC_RING
    ) {
      const aLoopback = normalizeHost(a.host) === '127.0.0.1'
      const bLoopback = normalizeHost(b.host) === '127.0.0.1'
      if (aLoopback !== bLoopback) return aLoopback ? -1 : 1
      const aLocal = isVerifiedLocalHost(a.host, localAddresses)
      const bLocal = isVerifiedLocalHost(b.host, localAddresses)
      if (aLocal !== bLocal) return aLocal ? -1 : 1
    }
    if (a.available !== b.available) return a.available ? -1 : 1
    return Number(b.lastSeen || 0) - Number(a.lastSeen || 0)
  })
  return sorted[0]
}

function legacyStatus(connectionState, saved) {
  switch (connectionState) {
    case CONNECTION_STATES.CONNECTED: return 'connected'
    case CONNECTION_STATES.CONNECTING: return 'connecting'
    case CONNECTION_STATES.UNAVAILABLE: return 'lost'
    case CONNECTION_STATES.ERROR: return 'error'
    case CONNECTION_STATES.DISABLED: return 'disabled'
    default: return saved ? 'configured' : 'discovered'
  }
}

function publicRecord(record, localAddresses) {
  const rawEndpoints = Array.from(record.endpoints.values())
    .sort((a, b) => endpointKey(a.host, a.port).localeCompare(endpointKey(b.host, b.port)))
  const rawActiveEndpoint = record.activeEndpoint || preferEndpoint(
    rawEndpoints,
    record.deviceType,
    localAddresses
  )
  // Local receiver authority belongs to an endpoint, not merely to a UUID.
  // Carry that server-owned proof into the public registry snapshot so a
  // browser-submitted FQDN can never select a remote alias from a trusted
  // local record.
  const endpoints = rawEndpoints.map((endpoint) => ({
    ...endpoint,
    verifiedLocal: isVerifiedLocalHost(endpoint.host, localAddresses)
  }))
  const activeEndpoint = rawActiveEndpoint
    ? endpoints.find((endpoint) =>
        endpointKey(endpoint.host, endpoint.port) ===
        endpointKey(rawActiveEndpoint.host, rawActiveEndpoint.port)
      ) || {
        ...rawActiveEndpoint,
        verifiedLocal: isVerifiedLocalHost(rawActiveEndpoint.host, localAddresses)
      }
    : null
  const isLocal = record.deviceType === DEVICE_TYPES.COSMIC_UNITY &&
    activeEndpoint?.verifiedLocal === true
  // Max/Ring is an OSCQuery service hosted by Node-for-Max, not a
  // CosmicUnity VST. Keep its canonical device type untouched and assign an
  // orthogonal role only after its exact service/port is proven local.
  const isLocalMaxRing = Boolean(
    activeEndpoint &&
    activeEndpoint.verifiedLocal === true &&
    isMaxRingIdentity({
      ...record,
      port: activeEndpoint.port,
      activeEndpoint,
      endpoints
    })
  )
  const isLocalCosmicRing = Boolean(
    record.deviceType === DEVICE_TYPES.COSMIC_RING &&
    activeEndpoint &&
    activeEndpoint.verifiedLocal === true &&
    isCosmicRingIdentity({
      ...record,
      deviceType: record.deviceType,
      activeEndpoint,
      endpoints
    })
  )
  return {
    canonicalId: record.canonicalId,
    id: record.manifestId ?? null,
    manifestId: record.manifestId ?? null,
    deviceType: record.deviceType,
    type: record.deviceType,
    name: record.name,
    displayName: record.name,
    serviceName: record.serviceName,
    persistentDeviceId: record.persistentDeviceId || null,
    identitySource: record.identitySource,
    endpoints,
    activeEndpoint,
    host: activeEndpoint?.host || '',
    port: activeEndpoint?.port || 0,
    oscQueryPort: activeEndpoint?.port || 0,
    isLocal,
    runtimeKind: isLocalMaxRing
      ? MAX_RING_RUNTIME_KIND
      : isLocalCosmicRing
        ? COSMIC_RING_RUNTIME_KIND
        : null,
    linkRole: isLocalMaxRing
      ? MAX_RING_LINK_ROLE
      : isLocalCosmicRing
        ? COSMIC_RING_LINK_ROLE
        : null,
    locationLabel: (isLocal || isLocalMaxRing || isLocalCosmicRing)
      ? `Bu Bilgisayar · Port ${activeEndpoint.port}`
      : '',
    discoveryState: record.discoveryState,
    connectionState: record.connectionState,
    reachability: record.reachability || 'ok',
    // Keep the historical lowercase field for API/OSC integrations while the
    // explicit state machine lives in `connectionState`.
    status: legacyStatus(record.connectionState, record.saved),
    saved: record.saved,
    enabled: record.enabled,
    lastSeen: record.lastSeen,
    error: record.error || null,
    paramCount: record.paramCount || 0,
    runtimeGeneration: record.runtimeGeneration || 0,
    legacyIds: Array.from(record.legacyIds || []),
    legacyCanonicalIds: Array.from(record.legacyCanonicalIds || [])
  }
}

export class DeviceRegistry {
  constructor({ localAddresses = getLocalInterfaceAddresses(), now = () => Date.now() } = {}) {
    this.localAddresses = localAddresses
    this.now = now
    this.records = new Map()
    this.endpointIndex = new Map()
    this.fqdnIndex = new Map()
  }

  setLocalAddresses(addresses) {
    this.localAddresses = addresses
  }

  _moveRecord(record, nextCanonicalId) {
    if (record.canonicalId === nextCanonicalId) return record
    const previousCanonicalId = record.canonicalId
    this.records.delete(record.canonicalId)
    record.canonicalId = nextCanonicalId
    if (previousCanonicalId) record.legacyCanonicalIds.add(previousCanonicalId)
    this.records.set(nextCanonicalId, record)
    for (const endpoint of record.endpoints.values()) {
      this.endpointIndex.set(endpointKey(endpoint.host, endpoint.port), nextCanonicalId)
    }
    for (const endpoint of record.endpoints.values()) {
      if (endpoint.fqdn) this.fqdnIndex.set(endpoint.fqdn, nextCanonicalId)
    }
    return record
  }

  _localCosmicRecordForPort(port) {
    return Array.from(this.records.values()).find((candidate) =>
      candidate.deviceType === DEVICE_TYPES.COSMIC_UNITY &&
      Array.from(candidate.endpoints.values()).some((endpoint) =>
        Number(endpoint.port) === Number(port) &&
        isVerifiedLocalHost(endpoint.host, this.localAddresses)
      )
    )
  }

  _localMaxRingRecordForPort(port) {
    return Array.from(this.records.values()).find((candidate) =>
      Array.from(candidate.endpoints.values()).some((endpoint) =>
        Number(endpoint.port) === Number(port) &&
        isVerifiedLocalMaxRing({
          ...candidate,
          host: endpoint.host,
          port: endpoint.port,
          activeEndpoint: endpoint,
          endpoints: Array.from(candidate.endpoints.values())
        }, this.localAddresses)
      )
    )
  }

  _localCosmicRingRecordForPort(port) {
    return Array.from(this.records.values()).find((candidate) =>
      candidate.deviceType === DEVICE_TYPES.COSMIC_RING &&
      Array.from(candidate.endpoints.values()).some((endpoint) =>
        Number(endpoint.port) === Number(port) &&
        isVerifiedLocalCosmicRing({
          ...candidate,
          host: endpoint.host,
          port: endpoint.port,
          activeEndpoint: endpoint,
          endpoints: Array.from(candidate.endpoints.values())
        }, this.localAddresses)
      )
    )
  }

  _mergeRecords(primary, duplicate) {
    if (!primary || !duplicate || primary === duplicate) return primary || duplicate

    // Prefer the durable routing entity. Startup migration normally prevents
    // two saved records from reaching this path, but the rule remains stable
    // under discovery/manifest races.
    if (!primary.saved && duplicate.saved) [primary, duplicate] = [duplicate, primary]

    for (const endpoint of duplicate.endpoints.values()) {
      const key = endpointKey(endpoint.host, endpoint.port)
      const previous = primary.endpoints.get(key)
      if (!previous || Number(endpoint.lastSeen || 0) >= Number(previous.lastSeen || 0)) {
        primary.endpoints.set(key, endpoint)
      }
    }
    for (const legacyId of duplicate.legacyIds || []) primary.legacyIds.add(legacyId)
    for (const alias of duplicate.legacyCanonicalIds || []) primary.legacyCanonicalIds.add(alias)
    if (duplicate.canonicalId !== primary.canonicalId) {
      primary.legacyCanonicalIds.add(duplicate.canonicalId)
    }
    primary.lastSeen = Math.max(Number(primary.lastSeen || 0), Number(duplicate.lastSeen || 0))
    primary.discoveryState =
      primary.discoveryState === 'Discovered' || duplicate.discoveryState === 'Discovered'
        ? 'Discovered'
        : primary.discoveryState

    this.records.delete(duplicate.canonicalId)
    for (const endpoint of primary.endpoints.values()) {
      this.endpointIndex.set(endpointKey(endpoint.host, endpoint.port), primary.canonicalId)
      if (endpoint.fqdn) this.fqdnIndex.set(endpoint.fqdn, primary.canonicalId)
    }
    primary.activeEndpoint = preferEndpoint(
      Array.from(primary.endpoints.values()),
      primary.deviceType,
      this.localAddresses
    )
    return primary
  }

  _findOrCreate(input, source) {
    const now = this.now()
    const identity = resolveCanonicalIdentity(input, { localAddresses: this.localAddresses })
    const endpoint = endpointFrom(input, now, source)
    const byEndpointId = this.endpointIndex.get(endpointKey(endpoint.host, endpoint.port))
    const isVerifiedLocalCosmicObservation =
      identity.deviceType === DEVICE_TYPES.COSMIC_UNITY &&
      isVerifiedLocalHost(endpoint.host, this.localAddresses)
    const isVerifiedLocalMaxRingObservation = isVerifiedLocalMaxRing({
      ...input,
      host: endpoint.host,
      port: endpoint.port,
      activeEndpoint: endpoint
    }, this.localAddresses)
    const isVerifiedLocalCosmicRingObservation = isVerifiedLocalCosmicRing({
      ...input,
      deviceType: identity.deviceType,
      host: endpoint.host,
      port: endpoint.port,
      activeEndpoint: endpoint
    }, this.localAddresses)
    let identityRecord = this.records.get(identity.canonicalId)
    const endpointRecord = this.records.get(byEndpointId)
    let record = identityRecord || endpointRecord

    // TXT-less (legacy) services embed the host in their canonical identity,
    // so a multi-homed machine (Wi-Fi + Ethernet) would otherwise fragment
    // into one card per address. The Bonjour FQDN is the strongest identity
    // such a service has: fold every address alias of the same fqdn into one
    // record, collapsing duplicates onto the freshest observation.
    if (!identity.persistentDeviceId && endpoint.fqdn) {
      const byFqdnId = this.fqdnIndex.get(endpoint.fqdn)
      const fqdnRecord = byFqdnId ? this.records.get(byFqdnId) : null
      if (fqdnRecord && fqdnRecord !== record) {
        // DHCP can hand this address to a different device than the one the
        // endpointIndex last saw there. When the claimant's endpoint carries a
        // different fqdn than the announcement, that claim is a stale lease —
        // the announced fqdn's owner wins, and the two records must never be
        // merged into one card.
        const claimed = record?.endpoints.get(endpointKey(endpoint.host, endpoint.port))
        if (record && claimed?.fqdn && claimed.fqdn !== endpoint.fqdn) {
          record = fqdnRecord
        } else if (!fqdnRecord.persistentDeviceId) {
          if (!record) record = fqdnRecord
          else record = this._mergeRecords(record, fqdnRecord)
        } else if (!record) {
          // A saved record can know its DEVICE_ID from HOST_INFO while the
          // device's own mDNS announcement stays identity-less (OSCQuery-Unity
          // 1.2.2 has no TXT identity field). The same fqdn on a fresh host is
          // still the same service — fold the endpoint in so host-follow heal
          // sees the move.
          record = fqdnRecord
        }
      }
    }

    // A persistent UUID authenticates continuity, not locality. If a remote
    // CosmicRing advertises the same UUID as this computer's Live-Ring, keep
    // it in a separate untrusted entity. This handles both discovery orders:
    // remote-first is moved aside when the local VST appears; local-first
    // makes the later remote observation use a scoped collision identity.
    if (identity.deviceType === DEVICE_TYPES.COSMIC_RING && identity.persistentDeviceId) {
      const identityIsTrustedLocal = hasVerifiedLocalCosmicRingEndpoint(
        identityRecord,
        this.localAddresses
      )
      if (isVerifiedLocalCosmicRingObservation && identityRecord && !identityIsTrustedLocal) {
        const remoteEndpoint = identityRecord.activeEndpoint ||
          Array.from(identityRecord.endpoints.values())[0]
        this._moveRecord(
          identityRecord,
          remoteCosmicRingCanonicalId(identity.canonicalId, remoteEndpoint)
        )
        identityRecord = null
        record = endpointRecord && hasVerifiedLocalCosmicRingEndpoint(
          endpointRecord,
          this.localAddresses
        ) ? endpointRecord : null
      } else if (!isVerifiedLocalCosmicRingObservation && identityIsTrustedLocal) {
        identity.canonicalId = remoteCosmicRingCanonicalId(identity.canonicalId, endpoint)
        identity.identitySource = 'persistent-id-remote-collision'
        record = endpointRecord && !hasVerifiedLocalCosmicRingEndpoint(
          endpointRecord,
          this.localAddresses
        ) ? endpointRecord : this.records.get(identity.canonicalId)
      }
    }
    // A host:port can be reused after DHCP churn, an app reinstall, or a
    // device replacement. Once both observations carry different persistent
    // IDs, endpoint equality is not identity proof. The sole exception is a
    // verified-local CosmicUnity listener: Ableton can restore/restart the one
    // VST bound to that local port with a new UUID, and the port owner remains
    // the same physical instance/card.
    if (
      record &&
      identity.persistentDeviceId &&
      record.persistentDeviceId &&
      identity.persistentDeviceId !== record.persistentDeviceId &&
      !isVerifiedLocalCosmicObservation &&
      !isVerifiedLocalMaxRingObservation &&
      !isVerifiedLocalCosmicRingObservation
    ) {
      record = this.records.get(identity.canonicalId)
    }

    // A copied CosmicUnity state can duplicate its UUID. Two simultaneously
    // bound local ports cannot be one instance, so keep them separate and
    // surface the clash. CosmicRing is intentionally excluded: Live-Ring has
    // one receiver identity and its configurable listener may legitimately
    // move to a fallback port.
    if (
      record && identity.persistentDeviceId &&
      identity.deviceType === DEVICE_TYPES.COSMIC_UNITY &&
      Array.from(record.endpoints.values()).some((item) => Number(item.port) !== endpoint.port)
    ) {
      const collisionId = `${identity.canonicalId}:port:${endpoint.port}`
      record = this.records.get(collisionId)
      identity.canonicalId = collisionId
      identity.identitySource = 'persistent-id-port-collision'
    }

    // Upgrade a legacy local-port entity when a newer VST advertisement first
    // reveals its UUID through another verified interface alias. Without this,
    // `127.0.0.1:5001` (manifest) and `192.168.x.x:5001` (mDNS + UUID) would
    // briefly become two cards even though both endpoints bind the same local
    // listener.
    if (
      !record && identity.persistentDeviceId &&
      isVerifiedLocalCosmicObservation
    ) {
      record = this.records.get(`cosmicunity:local-port:${endpoint.port}`) ||
        this._localCosmicRecordForPort(endpoint.port)
    }


    // Preserve a saved loopback Max/Ring entity when a newer build eventually
    // gains a persistent identity on its LAN advertisement.
    if (
      !record && identity.persistentDeviceId &&
      isVerifiedLocalMaxRingObservation
    ) {
      record = this.records.get(localMaxRingCanonicalId(endpoint.port)) ||
        this._localMaxRingRecordForPort(endpoint.port)
    }


    if (
      !record && identity.persistentDeviceId &&
      isVerifiedLocalCosmicRingObservation
    ) {
      record = this.records.get(localCosmicRingCanonicalId(endpoint.port)) ||
        this._localCosmicRingRecordForPort(endpoint.port)
    }

    // A restarted/restored VST can legitimately report a new persistent UUID.
    // On this computer, a single bound TCP port still identifies the physical
    // instance more strongly than that stale UUID. Merge only after proving the
    // endpoint belongs to a real local interface; never apply this to Android
    // or remote CosmicUnity devices.
    if (
      isVerifiedLocalCosmicObservation
    ) {
      const localPortRecord = this._localCosmicRecordForPort(endpoint.port)
      if (!record) record = localPortRecord
      else if (localPortRecord && localPortRecord !== record) {
        record = this._mergeRecords(localPortRecord, record)
      }
    }


    if (isVerifiedLocalMaxRingObservation) {
      const localMaxRingRecord = this._localMaxRingRecordForPort(endpoint.port)
      if (!record) record = localMaxRingRecord
      else if (localMaxRingRecord && localMaxRingRecord !== record) {
        record = this._mergeRecords(localMaxRingRecord, record)
      }
    }


    if (isVerifiedLocalCosmicRingObservation) {
      const localCosmicRingRecord = this._localCosmicRingRecordForPort(endpoint.port)
      if (!record) record = localCosmicRingRecord
      else if (localCosmicRingRecord && localCosmicRingRecord !== record) {
        record = this._mergeRecords(localCosmicRingRecord, record)
      }
    }

    if (!record) {
      record = {
        canonicalId: identity.canonicalId,
        deviceType: identity.deviceType,
        persistentDeviceId: identity.persistentDeviceId,
        identitySource: identity.identitySource,
        name: displayNameWithoutIdentityToken(
          input.displayName || input.name || input.serviceName
        ) || 'OSCQuery Device',
        serviceName: cleanText(input.serviceName || input.hostInfo?.NAME || input.name),
        endpoints: new Map(),
        activeEndpoint: null,
        discoveryState: 'Absent',
        connectionState: CONNECTION_STATES.DISCOVERED,
        reachability: 'ok',
        saved: false,
        manifestId: null,
        enabled: true,
        lastSeen: now,
        error: null,
        legacyIds: new Set(),
        legacyCanonicalIds: new Set()
      }
      this.records.set(record.canonicalId, record)
    } else if (
      identity.persistentDeviceId &&
      (
        identity.persistentDeviceId !== record.persistentDeviceId ||
        (isVerifiedLocalCosmicRingObservation && identity.canonicalId !== record.canonicalId)
      ) &&
      (
        !record.persistentDeviceId ||
        isVerifiedLocalCosmicObservation ||
        isVerifiedLocalMaxRingObservation ||
        isVerifiedLocalCosmicRingObservation
      )
    ) {
      const existingAtIdentity = this.records.get(identity.canonicalId)
      if (existingAtIdentity && existingAtIdentity !== record) {
        record = this._mergeRecords(record, existingAtIdentity)
      }
      record.persistentDeviceId = identity.persistentDeviceId
      record.identitySource = identity.identitySource
      record = this._moveRecord(record, identity.canonicalId)
    }

    record.deviceType = identity.deviceType
    record.lastSeen = now
    record.reachability = 'ok'
    record.endpoints.set(endpointKey(endpoint.host, endpoint.port), endpoint)
    this.endpointIndex.set(endpointKey(endpoint.host, endpoint.port), record.canonicalId)
    if (endpoint.fqdn) this.fqdnIndex.set(endpoint.fqdn, record.canonicalId)
    record.activeEndpoint = preferEndpoint(
      Array.from(record.endpoints.values()),
      record.deviceType,
      this.localAddresses
    )
    return record
  }

  upsertDiscovery(input) {
    const record = this._findOrCreate(input, 'discovery')
    record.discoveryState = 'Discovered'
    if (!record.saved && record.connectionState !== CONNECTION_STATES.CONNECTED) {
      record.connectionState = CONNECTION_STATES.DISCOVERED
    }
    if (!record.serviceName) record.serviceName = cleanText(input.serviceName || input.name)
    return publicRecord(record, this.localAddresses)
  }

  upsertManifest(manifest) {
    const input = {
      ...manifest,
      host: manifest.host,
      port: manifest.oscQueryPort,
      deviceType: manifest.deviceType || manifest.type,
      serviceName: manifest.serviceName || manifest.name
    }
    const record = this._findOrCreate(input, 'manifest')
    record.saved = true
    record.manifestId = Number(manifest.id)
    record.name = displayNameWithoutIdentityToken(manifest.name) || record.name
    record.serviceName = cleanText(manifest.serviceName) || record.serviceName
    record.enabled = manifest.enabled !== false
    record.connectionState = normalizeConnectionState(
      manifest.connectionState || manifest.status,
      record.enabled
    )
    record.error = manifest.error || null
    record.paramCount = Number(manifest.paramCount || 0)
    record.runtimeGeneration = Number(manifest.runtimeGeneration || 0)
    const manifestCanonicalId = cleanText(manifest.canonicalId)
    if (manifestCanonicalId && manifestCanonicalId !== record.canonicalId) {
      record.legacyCanonicalIds.add(manifestCanonicalId)
    }
    for (const legacyId of manifest.legacyIds || []) record.legacyIds.add(Number(legacyId))
    for (const alias of manifest.legacyCanonicalIds || []) {
      const canonicalAlias = cleanText(alias)
      if (canonicalAlias && canonicalAlias !== record.canonicalId) {
        record.legacyCanonicalIds.add(canonicalAlias)
      }
    }
    for (const alias of manifest.endpoints || []) {
      if (!alias?.host || !alias?.port) continue
      const endpoint = endpointFrom(alias, Number(alias.lastSeen) || this.now(), alias.source || 'manifest')
      record.endpoints.set(endpointKey(endpoint.host, endpoint.port), endpoint)
      this.endpointIndex.set(endpointKey(endpoint.host, endpoint.port), record.canonicalId)
      if (endpoint.fqdn) this.fqdnIndex.set(endpoint.fqdn, record.canonicalId)
    }
    record.activeEndpoint = preferEndpoint(
      Array.from(record.endpoints.values()),
      record.deviceType,
      this.localAddresses
    )
    return publicRecord(record, this.localAddresses)
  }

  updateConnection(canonicalId, updates) {
    const record = this.records.get(canonicalId)
    if (!record) return null
    if (updates.connectionState) {
      record.connectionState = normalizeConnectionState(updates.connectionState, updates.enabled ?? record.enabled)
    }
    if (updates.error !== undefined) record.error = updates.error
    if (updates.paramCount !== undefined) record.paramCount = updates.paramCount
    if (updates.enabled !== undefined) record.enabled = updates.enabled
    if (updates.runtimeGeneration !== undefined) record.runtimeGeneration = updates.runtimeGeneration
    if (updates.lastSeen !== undefined) record.lastSeen = updates.lastSeen
    if (updates.activeEndpoint?.host && updates.activeEndpoint?.port) {
      const key = endpointKey(updates.activeEndpoint.host, updates.activeEndpoint.port)
      record.activeEndpoint = record.endpoints.get(key) || endpointFrom(
        updates.activeEndpoint,
        this.now(),
        'connection'
      )
      record.endpoints.set(key, record.activeEndpoint)
      this.endpointIndex.set(key, record.canonicalId)
    }
    return publicRecord(record, this.localAddresses)
  }

  markDiscoveryDown({ fqdn, host, port }) {
    // One mDNS goodbye covers every record that carries the fqdn. The
    // fqdnIndex alone is last-writer-wins, so consult all records: a
    // multi-homed legacy service observed before the fqdn folding fix may
    // still exist as sibling records sharing the same fqdn.
    const affected = new Set()
    if (fqdn) {
      const indexed = this.records.get(this.fqdnIndex.get(fqdn))
      if (indexed) affected.add(indexed)
      for (const record of this.records.values()) {
        for (const endpoint of record.endpoints.values()) {
          if (endpoint.fqdn === fqdn) {
            affected.add(record)
            break
          }
        }
      }
    }
    const endpointRecord = this.records.get(this.endpointIndex.get(endpointKey(host, port)))
    if (endpointRecord) affected.add(endpointRecord)
    if (affected.size === 0) return null

    let result = null
    for (const record of affected) {
      for (const endpoint of record.endpoints.values()) {
        if ((fqdn && endpoint.fqdn === fqdn) || endpointKey(endpoint.host, endpoint.port) === endpointKey(host, port)) {
          endpoint.available = false
        }
      }
      record.discoveryState = Array.from(record.endpoints.values()).some(
        (endpoint) => endpoint.source === 'discovery' && endpoint.available
      ) ? 'Discovered' : 'Stale'
      if (record.discoveryState === 'Stale') record.reachability = 'dead'
      if (!record.saved && record.connectionState !== CONNECTION_STATES.CONNECTED) {
        record.connectionState = CONNECTION_STATES.UNAVAILABLE
      }
      result = publicRecord(record, this.localAddresses)
    }
    return result
  }

  /**
   * Records that look alive ("Discovered") but have not been observed for
   * `maxSilentMs`. Devices that hard-power-off never send an mDNS goodbye, so
   * without an active probe these ghosts would stay `Discovered` forever.
   * Marks each candidate `reachability: 'silent'` and returns its snapshot so
   * the caller can run a reachability probe and report back via
   * `markProbeResult`.
   */
  reachabilityProbeCandidates(maxSilentMs) {
    const cutoff = this.now() - maxSilentMs
    const out = []
    for (const record of this.records.values()) {
      if (record.saved) continue
      if (record.discoveryState !== 'Discovered') continue
      if (Number(record.lastSeen || 0) > cutoff) continue
      if (record.reachability !== 'dead') record.reachability = 'silent'
      out.push(publicRecord(record, this.localAddresses))
    }
    return out
  }

  markProbeResult(canonicalId, ok) {
    const record = this.records.get(canonicalId)
    if (!record) return null
    if (ok) {
      record.reachability = 'ok'
      record.lastSeen = this.now()
    } else {
      record.reachability = 'dead'
      record.discoveryState = 'Stale'
      for (const endpoint of record.endpoints.values()) endpoint.available = false
      if (!record.saved && record.connectionState !== CONNECTION_STATES.CONNECTED) {
        record.connectionState = CONNECTION_STATES.UNAVAILABLE
      }
    }
    return publicRecord(record, this.localAddresses)
  }

  pruneStale(maxAgeMs) {
    const cutoff = this.now() - maxAgeMs
    const removed = []
    for (const [canonicalId, record] of this.records) {
      if (record.saved || record.discoveryState !== 'Stale' || record.lastSeen > cutoff) continue
      this.records.delete(canonicalId)
      // Only drop index entries this record still owns — an endpoint/fqdn key
      // may have been re-pointed at a newer live record since (same guard as
      // removeManifest below).
      for (const endpoint of record.endpoints.values()) {
        const key = endpointKey(endpoint.host, endpoint.port)
        if (this.endpointIndex.get(key) === canonicalId) this.endpointIndex.delete(key)
        if (endpoint.fqdn && this.fqdnIndex.get(endpoint.fqdn) === canonicalId) {
          this.fqdnIndex.delete(endpoint.fqdn)
        }
      }
      removed.push(canonicalId)
    }
    return removed
  }

  removeManifest(manifestId) {
    for (const record of this.records.values()) {
      if (record.manifestId !== Number(manifestId)) continue
      record.saved = false
      record.manifestId = null
      record.connectionState = record.discoveryState === 'Discovered'
        ? CONNECTION_STATES.DISCOVERED
        : CONNECTION_STATES.UNAVAILABLE
      if (record.discoveryState !== 'Discovered') {
        this.records.delete(record.canonicalId)
        // Clean the lookup indexes like pruneStale does, so a later service
        // reusing the same endpoint/fqdn key cannot resolve to a ghost id.
        for (const endpoint of record.endpoints.values()) {
          const key = endpointKey(endpoint.host, endpoint.port)
          if (this.endpointIndex.get(key) === record.canonicalId) {
            this.endpointIndex.delete(key)
          }
          if (endpoint.fqdn && this.fqdnIndex.get(endpoint.fqdn) === record.canonicalId) {
            this.fqdnIndex.delete(endpoint.fqdn)
          }
        }
      }
      return true
    }
    return false
  }

  get(canonicalId) {
    const record = this.records.get(canonicalId)
    return record ? publicRecord(record, this.localAddresses) : null
  }

  findByManifestId(manifestId) {
    for (const record of this.records.values()) {
      if (record.manifestId === Number(manifestId)) return publicRecord(record, this.localAddresses)
    }
    return null
  }

  snapshot() {
    return Array.from(this.records.values())
      .map((record) => publicRecord(record, this.localAddresses))
      .sort((a, b) => {
        if (a.saved !== b.saved) return a.saved ? -1 : 1
        if (a.deviceType !== b.deviceType) return a.deviceType.localeCompare(b.deviceType)
        if (a.port !== b.port) return a.port - b.port
        return a.canonicalId.localeCompare(b.canonicalId)
      })
  }
}

function manifestEndpoints(manifest) {
  const endpoints = []
  if (manifest.host && manifest.oscQueryPort) {
    endpoints.push({ host: normalizeHost(manifest.host), port: Number(manifest.oscQueryPort), source: 'manifest' })
  }
  for (const endpoint of manifest.endpoints || []) {
    if (!endpoint?.host || !endpoint?.port) continue
    endpoints.push({ ...endpoint, host: normalizeHost(endpoint.host), port: Number(endpoint.port) })
  }
  const unique = new Map(endpoints.map((endpoint) => [endpointKey(endpoint.host, endpoint.port), endpoint]))
  return Array.from(unique.values())
}

export function deduplicateManifestEntries(entries, options = {}) {
  const localAddresses = options.localAddresses || getLocalInterfaceAddresses()
  const groups = new Map()

  for (const entry of entries) {
    const manifest = entry.manifest
    const identity = resolveCanonicalIdentity({
      ...manifest,
      port: manifest.oscQueryPort,
      deviceType: manifest.deviceType || manifest.type,
      serviceName: manifest.serviceName || manifest.name
    }, { localAddresses })
    const endpoints = manifestEndpoints(manifest)
    const isVerifiedLocalCosmic =
      identity.deviceType === DEVICE_TYPES.COSMIC_UNITY &&
      endpoints.some((endpoint) =>
        Number(endpoint.port) === Number(manifest.oscQueryPort) &&
        isVerifiedLocalHost(endpoint.host, localAddresses)
      )
    const isVerifiedLocalMaxRingManifest = endpoints.some((endpoint) =>
      isVerifiedLocalMaxRing({
        ...manifest,
        host: endpoint.host,
        port: endpoint.port,
        activeEndpoint: endpoint,
        endpoints
      }, localAddresses)
    )
    const isVerifiedLocalCosmicRingManifest = endpoints.some((endpoint) =>
      isVerifiedLocalCosmicRing({
        ...manifest,
        deviceType: identity.deviceType,
        host: endpoint.host,
        port: endpoint.port,
        activeEndpoint: endpoint,
        endpoints
      }, localAddresses)
    )

    // A local listener can only have one physical owner per port. Grouping by
    // the verified local port lets a current HOST_INFO UUID replace a stale
    // persisted UUID without merging 5001/5002/5003 or any remote device.
    const groupKey = isVerifiedLocalCosmic
      ? `cosmicunity:local-port:${Number(manifest.oscQueryPort)}`
      : isVerifiedLocalMaxRingManifest
        ? localMaxRingCanonicalId(manifest.oscQueryPort)
        : isVerifiedLocalCosmicRingManifest
          ? identity.persistentDeviceId
            ? `cosmicring:verified-local-uuid:${identity.persistentDeviceId}`
            : localCosmicRingCanonicalId(manifest.oscQueryPort)
          : identity.canonicalId
    const observedAt = Math.max(
      Number(manifest.lastSeen || 0),
      ...endpoints.map((endpoint) => Number(endpoint.lastSeen || 0))
    )
    const group = groups.get(groupKey) || []
    group.push({ ...entry, identity, endpoints, observedAt, groupKey })
    groups.set(groupKey, group)
  }

  const kept = []
  const duplicates = []
  for (const [groupKey, group] of groups) {
    group.sort((a, b) => Number(a.manifest.id) - Number(b.manifest.id))
    const primary = group[0]
    const identitySource = group.slice().sort((a, b) =>
      Number(b.observedAt || 0) - Number(a.observedAt || 0) ||
      Number(b.manifest.id) - Number(a.manifest.id)
    ).find((entry) => entry.identity.persistentDeviceId) || primary
    const persistentDeviceId = identitySource.identity.persistentDeviceId || ''
    const canonicalId = persistentDeviceId
      ? identitySource.identity.identitySource === 'persistent-id-remote-endpoint'
        ? identitySource.identity.canonicalId
        : `${normalizeIdentityToken(primary.identity.deviceType)}:uuid:${persistentDeviceId}`
      : groupKey

    const endpointMap = new Map()
    for (const entry of group) {
      for (const endpoint of entry.endpoints) {
        const key = endpointKey(endpoint.host, endpoint.port)
        const previous = endpointMap.get(key)
        if (!previous || Number(endpoint.lastSeen || 0) >= Number(previous.lastSeen || 0)) {
          endpointMap.set(key, endpoint)
        }
      }
    }
    const endpoints = Array.from(endpointMap.values())
    const preferred = preferEndpoint(endpoints, primary.identity.deviceType, localAddresses)
    const legacyIds = Array.from(new Set([
      ...group.flatMap((entry) => entry.manifest.legacyIds || []).map(Number),
      ...group.slice(1).map((entry) => Number(entry.manifest.id))
    ])).filter(Number.isFinite).sort((a, b) => a - b)
    const legacyCanonicalIds = Array.from(new Set([
      ...group.flatMap((entry) => entry.manifest.legacyCanonicalIds || []),
      ...group.flatMap((entry) => [entry.manifest.canonicalId, entry.identity.canonicalId])
    ].map((value) => cleanText(value)).filter((value) => value && value !== canonicalId)))
    const merged = {
      ...primary.manifest,
      canonicalId,
      deviceType: primary.identity.deviceType,
      persistentDeviceId: persistentDeviceId || null,
      serviceName: primary.manifest.serviceName || primary.manifest.name,
      host: preferred?.host || primary.manifest.host,
      oscQueryPort: preferred?.port || Number(primary.manifest.oscQueryPort),
      endpoints,
      legacyIds,
      legacyCanonicalIds
    }
    const changed =
      group.length > 1 ||
      !primary.manifest.canonicalId ||
      primary.manifest.canonicalId !== canonicalId ||
      cleanText(primary.manifest.deviceType) !== merged.deviceType ||
      cleanText(primary.manifest.serviceName) !== cleanText(merged.serviceName) ||
      normalizeHost(primary.manifest.host) !== normalizeHost(merged.host) ||
      Number(primary.manifest.oscQueryPort) !== Number(merged.oscQueryPort) ||
      cleanText(primary.manifest.persistentDeviceId) !== persistentDeviceId ||
      JSON.stringify(primary.manifest.legacyIds || []) !== JSON.stringify(legacyIds) ||
      JSON.stringify(primary.manifest.legacyCanonicalIds || []) !== JSON.stringify(legacyCanonicalIds) ||
      JSON.stringify(manifestEndpoints(primary.manifest)) !== JSON.stringify(endpoints)
    kept.push({
      file: primary.file,
      manifest: merged,
      identity: { ...identitySource.identity, canonicalId },
      changed
    })
    for (const duplicate of group.slice(1)) {
      duplicates.push({
        file: duplicate.file,
        manifest: duplicate.manifest,
        canonicalId,
        keptFile: primary.file,
        keptId: primary.manifest.id
      })
    }
  }

  return { kept, duplicates }
}
