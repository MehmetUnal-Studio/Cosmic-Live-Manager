import os from 'node:os'

export const DEVICE_TYPES = Object.freeze({
  COSMIC_UNITY: 'CosmicUnity',
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
    return {
      canonicalId: `${normalizeIdentityToken(deviceType)}:uuid:${persistentDeviceId}`,
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
    if (deviceType === DEVICE_TYPES.COSMIC_UNITY) {
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
  const endpoints = Array.from(record.endpoints.values())
    .sort((a, b) => endpointKey(a.host, a.port).localeCompare(endpointKey(b.host, b.port)))
  const activeEndpoint = record.activeEndpoint || preferEndpoint(
    endpoints,
    record.deviceType,
    localAddresses
  )
  const isLocal = record.deviceType === DEVICE_TYPES.COSMIC_UNITY &&
    activeEndpoint && isVerifiedLocalHost(activeEndpoint.host, localAddresses)
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
    locationLabel: isLocal ? `Bu Bilgisayar · Port ${activeEndpoint.port}` : '',
    discoveryState: record.discoveryState,
    connectionState: record.connectionState,
    // Keep the historical lowercase field for API/OSC integrations while the
    // explicit state machine lives in `connectionState`.
    status: legacyStatus(record.connectionState, record.saved),
    saved: record.saved,
    enabled: record.enabled,
    lastSeen: record.lastSeen,
    error: record.error || null,
    paramCount: record.paramCount || 0,
    runtimeGeneration: record.runtimeGeneration || 0,
    legacyIds: Array.from(record.legacyIds || [])
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
    this.records.delete(record.canonicalId)
    record.canonicalId = nextCanonicalId
    this.records.set(nextCanonicalId, record)
    for (const endpoint of record.endpoints.values()) {
      this.endpointIndex.set(endpointKey(endpoint.host, endpoint.port), nextCanonicalId)
    }
    for (const endpoint of record.endpoints.values()) {
      if (endpoint.fqdn) this.fqdnIndex.set(endpoint.fqdn, nextCanonicalId)
    }
    return record
  }

  _findOrCreate(input, source) {
    const now = this.now()
    const identity = resolveCanonicalIdentity(input, { localAddresses: this.localAddresses })
    const endpoint = endpointFrom(input, now, source)
    const byEndpointId = this.endpointIndex.get(endpointKey(endpoint.host, endpoint.port))
    let record = this.records.get(identity.canonicalId) || this.records.get(byEndpointId)

    // A copied VST state can duplicate its UUID. Two simultaneously bound local
    // ports cannot be one instance, so keep them separate and surface the clash.
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
      identity.deviceType === DEVICE_TYPES.COSMIC_UNITY &&
      isVerifiedLocalHost(endpoint.host, this.localAddresses)
    ) {
      record = this.records.get(`cosmicunity:local-port:${endpoint.port}`)
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
        saved: false,
        manifestId: null,
        enabled: true,
        lastSeen: now,
        error: null,
        legacyIds: new Set()
      }
      this.records.set(record.canonicalId, record)
    } else if (identity.persistentDeviceId && !record.persistentDeviceId) {
      record.persistentDeviceId = identity.persistentDeviceId
      record.identitySource = identity.identitySource
      record = this._moveRecord(record, identity.canonicalId)
    }

    record.deviceType = identity.deviceType
    record.lastSeen = now
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
    for (const legacyId of manifest.legacyIds || []) record.legacyIds.add(Number(legacyId))
    for (const alias of manifest.endpoints || []) {
      if (!alias?.host || !alias?.port) continue
      const endpoint = endpointFrom(alias, Number(alias.lastSeen) || this.now(), alias.source || 'manifest')
      record.endpoints.set(endpointKey(endpoint.host, endpoint.port), endpoint)
      this.endpointIndex.set(endpointKey(endpoint.host, endpoint.port), record.canonicalId)
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
    const canonicalId = (fqdn && this.fqdnIndex.get(fqdn)) ||
      this.endpointIndex.get(endpointKey(host, port))
    const record = this.records.get(canonicalId)
    if (!record) return null
    for (const endpoint of record.endpoints.values()) {
      if ((fqdn && endpoint.fqdn === fqdn) || endpointKey(endpoint.host, endpoint.port) === endpointKey(host, port)) {
        endpoint.available = false
      }
    }
    record.discoveryState = Array.from(record.endpoints.values()).some(
      (endpoint) => endpoint.source === 'discovery' && endpoint.available
    ) ? 'Discovered' : 'Stale'
    if (!record.saved && record.connectionState !== CONNECTION_STATES.CONNECTED) {
      record.connectionState = CONNECTION_STATES.UNAVAILABLE
    }
    return publicRecord(record, this.localAddresses)
  }

  pruneStale(maxAgeMs) {
    const cutoff = this.now() - maxAgeMs
    const removed = []
    for (const [canonicalId, record] of this.records) {
      if (record.saved || record.discoveryState !== 'Stale' || record.lastSeen > cutoff) continue
      this.records.delete(canonicalId)
      for (const endpoint of record.endpoints.values()) {
        this.endpointIndex.delete(endpointKey(endpoint.host, endpoint.port))
        if (endpoint.fqdn) this.fqdnIndex.delete(endpoint.fqdn)
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
    // A newly available persistent id outranks a canonical key written by an
    // older Manager version. Otherwise a stale local-port key would keep the
    // UUID-backed instance split after migration.
    const canonicalId = identity.persistentDeviceId
      ? identity.canonicalId
      : (cleanText(manifest.canonicalId) || identity.canonicalId)
    const group = groups.get(canonicalId) || []
    group.push({ ...entry, identity: { ...identity, canonicalId } })
    groups.set(canonicalId, group)
  }

  const kept = []
  const duplicates = []
  for (const [canonicalId, group] of groups) {
    group.sort((a, b) => Number(a.manifest.id) - Number(b.manifest.id))
    const primary = group[0]
    const allEndpoints = group.flatMap((entry) => manifestEndpoints(entry.manifest))
    const endpointMap = new Map(allEndpoints.map((endpoint) => [endpointKey(endpoint.host, endpoint.port), endpoint]))
    const endpoints = Array.from(endpointMap.values())
    const preferred = preferEndpoint(endpoints, primary.identity.deviceType, localAddresses)
    const legacyIds = Array.from(new Set(group.slice(1).map((entry) => Number(entry.manifest.id))))
    const merged = {
      ...primary.manifest,
      canonicalId,
      deviceType: primary.identity.deviceType,
      persistentDeviceId: primary.identity.persistentDeviceId || primary.manifest.persistentDeviceId || null,
      serviceName: primary.manifest.serviceName || primary.manifest.name,
      host: preferred?.host || primary.manifest.host,
      oscQueryPort: preferred?.port || Number(primary.manifest.oscQueryPort),
      endpoints,
      legacyIds: Array.from(new Set([...(primary.manifest.legacyIds || []), ...legacyIds]))
    }
    kept.push({ file: primary.file, manifest: merged, changed: group.length > 1 || !primary.manifest.canonicalId })
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
