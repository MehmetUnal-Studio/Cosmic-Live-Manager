import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONNECTION_STATES,
  DEVICE_TYPES,
  DeviceRegistry,
  deduplicateManifestEntries,
  displayNameWithoutIdentityToken,
  extractPersistentDeviceId,
  resolveCanonicalIdentity
} from '../server/deviceRegistry.js'
import {
  MAX_RING_LINK_ROLE,
  MAX_RING_RUNTIME_KIND
} from '../shared/maxRingLink.js'
import {
  COSMIC_RING_DEVICE_TYPE,
  COSMIC_RING_LINK_ROLE,
  COSMIC_RING_RUNTIME_KIND,
  isCosmicRingReceiverDevice
} from '../shared/cosmicRingLink.js'

const localAddresses = new Set(['127.0.0.1', '192.168.68.58'])

test('verified loopback and LAN aliases for one local CosmicUnity port upsert to one record', () => {
  let now = 100
  const registry = new DeviceRegistry({ localAddresses, now: () => ++now })
  registry.upsertDiscovery({ name: 'Tablet-1', serviceName: 'Tablet-1', host: '127.0.0.1', port: 5001 })
  registry.upsertDiscovery({ name: 'Tablet-1', serviceName: 'Tablet-1', host: '192.168.68.58', port: 5001 })

  const snapshot = registry.snapshot()
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0].canonicalId, 'cosmicunity:local-port:5001')
  assert.equal(snapshot[0].deviceType, DEVICE_TYPES.COSMIC_UNITY)
  assert.deepEqual(snapshot[0].endpoints.map((item) => item.host), ['127.0.0.1', '192.168.68.58'])
  assert.equal(snapshot[0].activeEndpoint.host, '127.0.0.1')
  assert.equal(snapshot[0].locationLabel, 'Bu Bilgisayar · Port 5001')
})

test('a private address that is not a local interface is never folded into loopback', () => {
  const local = resolveCanonicalIdentity(
    { name: 'Tablet-1', host: '127.0.0.1', port: 5001 },
    { localAddresses }
  )
  const remote = resolveCanonicalIdentity(
    { name: 'Tablet-1', host: '192.168.1.101', port: 5001 },
    { localAddresses }
  )
  assert.notEqual(local.canonicalId, remote.canonicalId)
})

test('local CosmicUnity ports 5001, 5002 and 5003 stay separate', () => {
  const registry = new DeviceRegistry({ localAddresses })
  for (const port of [5001, 5002, 5003]) {
    registry.upsertDiscovery({ name: `Tablet-${port}`, host: '192.168.68.58', port })
  }
  assert.equal(registry.snapshot().length, 3)
  assert.deepEqual(registry.snapshot().map((item) => item.port), [5001, 5002, 5003])
})

test('two Android devices using the same port stay separate by remote endpoint', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertDiscovery({ name: 'Android-A', host: '192.168.68.51', port: 9010 })
  registry.upsertDiscovery({ name: 'Android-B', host: '192.168.68.52', port: 9010 })
  assert.equal(registry.snapshot().length, 2)
  assert.ok(registry.snapshot().every((item) => item.deviceType === DEVICE_TYPES.ANDROID))
})

test('persistent Android identity survives an IP address change', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertDiscovery({
    name: 'Android-A', host: '192.168.68.51', port: 9010,
    txt: { device_id: '7754f567-f2f0-4b10-bdea-4af18ae8f8f2', device_type: 'Android' }
  })
  registry.upsertDiscovery({
    name: 'Android-A', host: '192.168.68.99', port: 9010,
    hostInfo: { DEVICE_ID: '7754f567-f2f0-4b10-bdea-4af18ae8f8f2', DEVICE_TYPE: 'Android' }
  })
  const snapshot = registry.snapshot()
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0].endpoints.length, 2)
  assert.equal(snapshot[0].persistentDeviceId, '7754f567-f2f0-4b10-bdea-4af18ae8f8f2')
})

test('a different Android UUID reusing the same endpoint creates a new entity', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertManifest({
    id: 41,
    name: 'Saved Android A',
    deviceType: 'Android',
    persistentDeviceId: 'android-installation-a',
    host: '192.168.68.51',
    oscQueryPort: 9010,
    enabled: false,
    legacyIds: [9]
  })
  registry.upsertDiscovery({
    name: 'Android B',
    deviceType: 'Android',
    persistentDeviceId: 'android-installation-b',
    host: '192.168.68.51',
    port: 9010
  })

  const snapshot = registry.snapshot()
  assert.equal(snapshot.length, 2)
  const saved = snapshot.find((record) => record.persistentDeviceId === 'android-installation-a')
  const replacement = snapshot.find((record) => record.persistentDeviceId === 'android-installation-b')
  assert.equal(saved.id, 41)
  assert.equal(saved.name, 'Saved Android A')
  assert.equal(saved.enabled, false)
  assert.deepEqual(saved.legacyIds, [9])
  assert.equal(replacement.saved, false)
  assert.notEqual(saved.canonicalId, replacement.canonicalId)
})

test('Android OSCQuery 1.2 service-name token provides a hidden persistent installation id', () => {
  const serviceName = 'Android_Tablet--id-0123456789abcdef0123456789abcdef-SpectraTablet02'
  assert.equal(extractPersistentDeviceId({ serviceName }), '0123456789abcdef0123456789abcdef')
  assert.equal(displayNameWithoutIdentityToken(serviceName), 'Android_Tablet-SpectraTablet02')

  const registry = new DeviceRegistry({ localAddresses })
  const first = registry.upsertDiscovery({ name: serviceName, serviceName, host: '192.168.1.40', port: 9010 })
  const moved = registry.upsertDiscovery({ name: serviceName, serviceName, host: '192.168.1.99', port: 9010 })
  assert.equal(first.canonicalId, moved.canonicalId)
  assert.equal(moved.name, 'Android_Tablet-SpectraTablet02')
  assert.equal(registry.snapshot().length, 1)
})

test('a copied CosmicUnity UUID on two live ports is collision-safe', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertDiscovery({
    name: 'Tablet-1', host: '127.0.0.1', port: 5001,
    txt: { device_id: 'same-state-uuid', device_type: 'CosmicUnity' }
  })
  registry.upsertDiscovery({
    name: 'Tablet-2', host: '127.0.0.1', port: 5002,
    txt: { device_id: 'same-state-uuid', device_type: 'CosmicUnity' }
  })
  assert.equal(registry.snapshot().length, 2)
  assert.ok(registry.snapshot().some((item) => item.identitySource === 'persistent-id-port-collision'))
})

test('manifest and discovery observations become one saved registry record', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertManifest({
    id: 7,
    name: 'Tablet One',
    type: 'oscquery-device',
    host: '127.0.0.1',
    oscQueryPort: 5001,
    enabled: true
  })
  registry.upsertDiscovery({ name: 'Tablet-1', host: '192.168.68.58', port: 5001 })
  const [record] = registry.snapshot()
  assert.equal(registry.snapshot().length, 1)
  assert.equal(record.manifestId, 7)
  assert.equal(record.saved, true)
  assert.equal(record.endpoints.length, 2)
})

test('verified-local MaxRing loopback and LAN aliases become one Ableton receiver record', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertManifest({
    id: 14,
    name: 'Max_Ring',
    serviceName: 'MaxRing',
    deviceType: 'OSCQuery',
    canonicalId: 'oscquery:legacy:192.168.68.58:8005:maxring',
    host: '127.0.0.1',
    oscQueryPort: 8005,
    enabled: true
  })
  registry.upsertDiscovery({
    name: 'MaxRing',
    serviceName: 'MaxRing',
    fqdn: 'MaxRing._oscjson._tcp.local',
    host: '192.168.68.58',
    port: 8005
  })

  const [record] = registry.snapshot()
  assert.equal(registry.snapshot().length, 1)
  assert.equal(record.id, 14)
  assert.equal(record.deviceType, DEVICE_TYPES.OSCQUERY)
  assert.equal(record.canonicalId, 'oscquery:local-maxring:8005')
  assert.deepEqual(record.endpoints.map((item) => item.host), ['127.0.0.1', '192.168.68.58'])
  assert.equal(record.runtimeKind, MAX_RING_RUNTIME_KIND)
  assert.equal(record.linkRole, MAX_RING_LINK_ROLE)
  assert.equal(record.locationLabel, 'Bu Bilgisayar · Port 8005')
})

test('verified-local MaxRing aliases also merge when Bonjour wins the startup race', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertDiscovery({
    name: 'MaxRing',
    serviceName: 'MaxRing',
    fqdn: 'MaxRing._oscjson._tcp.local',
    host: '192.168.68.58',
    port: 8005
  })
  registry.upsertManifest({
    id: 14,
    name: 'Stage Max Ring',
    serviceName: 'MaxRing',
    deviceType: 'OSCQuery',
    host: '127.0.0.1',
    oscQueryPort: 8005,
    enabled: true
  })

  const [record] = registry.snapshot()
  assert.equal(registry.snapshot().length, 1)
  assert.equal(record.id, 14)
  assert.equal(record.name, 'Stage Max Ring')
  assert.equal(record.canonicalId, 'oscquery:local-maxring:8005')
  assert.deepEqual(record.endpoints.map((item) => item.host), ['127.0.0.1', '192.168.68.58'])
})

test('a remote MaxRing:8005 is never folded into the verified-local receiver', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertDiscovery({
    name: 'MaxRing', serviceName: 'MaxRing',
    host: '127.0.0.1', port: 8005
  })
  registry.upsertDiscovery({
    name: 'MaxRing', serviceName: 'MaxRing',
    host: '192.168.68.63', port: 8005
  })

  const snapshot = registry.snapshot()
  assert.equal(snapshot.length, 2)
  assert.equal(snapshot.filter((record) => record.linkRole === MAX_RING_LINK_ROLE).length, 1)
  assert.equal(snapshot.find((record) => record.host === '192.168.68.63').linkRole, null)
})

test('MaxRing Ableton role requires exact identity, exact port and a verified-local host', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertDiscovery({ name: 'MaxFoo', host: '192.168.68.58', port: 8005 })
  registry.upsertDiscovery({ name: 'MaxRing', host: '192.168.68.58', port: 8006 })
  registry.upsertDiscovery({ name: 'MaxRing', host: '192.168.68.63', port: 8005 })

  assert.equal(registry.snapshot().length, 3)
  assert.ok(registry.snapshot().every((record) => record.runtimeKind === null))
  assert.ok(registry.snapshot().every((record) => record.linkRole === null))
})

test('verified-local Live-Ring is a dedicated CosmicRing Ableton receiver', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertManifest({
    id: 14,
    name: 'Live-Ring',
    serviceName: 'Live-Ring',
    deviceType: 'OSCQuery',
    canonicalId: 'oscquery:uuid:ring-vst-installation',
    persistentDeviceId: 'ring-vst-installation',
    host: '192.168.68.58',
    oscQueryPort: 8000,
    enabled: true
  })
  registry.upsertDiscovery({
    name: 'Live-Ring',
    serviceName: 'Live-Ring',
    fqdn: 'Live-Ring._oscjson._tcp.local',
    host: '192.168.68.58',
    port: 8000,
    hostInfo: {
      DEVICE_ID: 'ring-vst-installation',
      DEVICE_TYPE: 'CosmicRing'
    }
  })

  const [record] = registry.snapshot()
  assert.equal(record.id, 14)
  assert.equal(record.canonicalId, 'cosmicring:uuid:ring-vst-installation')
  assert.equal(record.deviceType, COSMIC_RING_DEVICE_TYPE)
  assert.equal(record.runtimeKind, COSMIC_RING_RUNTIME_KIND)
  assert.equal(record.linkRole, COSMIC_RING_LINK_ROLE)
  assert.equal(record.locationLabel, 'Bu Bilgisayar · Port 8000')
  assert.equal(isCosmicRingReceiverDevice(record), true)
  assert.ok(record.legacyCanonicalIds.includes('oscquery:uuid:ring-vst-installation'))
})

test('remote CosmicRing never receives the trusted local Ableton role', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertDiscovery({
    name: 'Live-Ring',
    serviceName: 'Live-Ring',
    host: '192.168.68.63',
    port: 8000,
    hostInfo: {
      DEVICE_ID: 'remote-ring-vst',
      DEVICE_TYPE: 'CosmicRing'
    }
  })

  const [record] = registry.snapshot()
  assert.equal(record.deviceType, COSMIC_RING_DEVICE_TYPE)
  assert.equal(record.runtimeKind, null)
  assert.equal(record.linkRole, null)
  assert.equal(isCosmicRingReceiverDevice(record), false)
})

test('a remote CosmicRing cannot inherit the trusted local role by copying its UUID', () => {
  const observations = {
    local: {
      name: 'Live-Ring',
      serviceName: 'Live-Ring',
      fqdn: 'Live-Ring._oscjson._tcp.local',
      host: '192.168.68.58',
      port: 8000,
      hostInfo: { DEVICE_ID: 'shared-ring-vst', DEVICE_TYPE: 'CosmicRing' }
    },
    remote: {
      name: 'Live-Ring',
      serviceName: 'Live-Ring',
      fqdn: 'Remote-Live-Ring._oscjson._tcp.local',
      host: '192.168.68.63',
      port: 8000,
      hostInfo: { DEVICE_ID: 'shared-ring-vst', DEVICE_TYPE: 'CosmicRing' }
    }
  }

  for (const order of [['local', 'remote'], ['remote', 'local']]) {
    const registry = new DeviceRegistry({ localAddresses })
    for (const key of order) registry.upsertDiscovery(observations[key])

    const snapshot = registry.snapshot()
    assert.equal(snapshot.length, 2, `order=${order.join('→')}`)
    const trusted = snapshot.find((record) => record.linkRole === COSMIC_RING_LINK_ROLE)
    const untrusted = snapshot.find((record) => record.linkRole === null)
    assert.equal(trusted.host, '192.168.68.58')
    assert.equal(trusted.endpoints.length, 1)
    assert.equal(trusted.activeEndpoint.verifiedLocal, true)
    assert.equal(untrusted.host, '192.168.68.63')
    assert.equal(untrusted.endpoints.length, 1)
    assert.equal(untrusted.activeEndpoint.verifiedLocal, false)
    assert.match(untrusted.canonicalId, /:remote:/)
  }
})

test('remote-first saved CosmicRing keeps an endpoint-scoped canonical ID after local manifest load', () => {
  const registry = new DeviceRegistry({ localAddresses })
  const remote = registry.upsertManifest({
    id: 13,
    name: 'Live-Ring',
    serviceName: 'Live-Ring',
    fqdn: 'Remote-Live-Ring._oscjson._tcp.local',
    deviceType: 'CosmicRing',
    persistentDeviceId: 'shared-ring-vst',
    host: '192.168.68.63',
    oscQueryPort: 8000,
    enabled: true
  })
  const local = registry.upsertManifest({
    id: 14,
    name: 'Live-Ring',
    serviceName: 'Live-Ring',
    fqdn: 'Live-Ring._oscjson._tcp.local',
    deviceType: 'CosmicRing',
    persistentDeviceId: 'shared-ring-vst',
    host: '192.168.68.58',
    oscQueryPort: 8000,
    enabled: true
  })

  assert.match(remote.canonicalId, /:remote:/)
  assert.equal(local.canonicalId, 'cosmicring:uuid:shared-ring-vst')
  registry.updateConnection(remote.canonicalId, {
    connectionState: 'Connected',
    activeEndpoint: { host: '192.168.68.63', port: 8000 }
  })

  const localAfterRemoteConnect = registry.findByManifestId(14)
  const remoteAfterConnect = registry.findByManifestId(13)
  assert.equal(localAfterRemoteConnect.host, '192.168.68.58')
  assert.equal(localAfterRemoteConnect.linkRole, COSMIC_RING_LINK_ROLE)
  assert.equal(remoteAfterConnect.host, '192.168.68.63')
  assert.equal(remoteAfterConnect.linkRole, null)
})

test('Live-Ring persistent identity survives a verified-local fallback port change', () => {
  let now = 100
  const registry = new DeviceRegistry({ localAddresses, now: () => ++now })
  registry.upsertManifest({
    id: 14,
    name: 'Live-Ring',
    serviceName: 'Live-Ring',
    deviceType: 'CosmicRing',
    persistentDeviceId: 'ring-vst-installation',
    host: '192.168.68.58',
    oscQueryPort: 8000,
    enabled: true
  })
  registry.upsertDiscovery({
    name: 'Live-Ring',
    serviceName: 'Live-Ring',
    fqdn: 'Live-Ring._oscjson._tcp.local',
    host: '192.168.68.58',
    port: 8001,
    hostInfo: {
      DEVICE_ID: 'ring-vst-installation',
      DEVICE_TYPE: 'CosmicRing'
    }
  })

  const [record] = registry.snapshot()
  assert.equal(registry.snapshot().length, 1)
  assert.equal(record.id, 14)
  assert.equal(record.canonicalId, 'cosmicring:uuid:ring-vst-installation')
  assert.equal(record.activeEndpoint.port, 8001)
  assert.deepEqual(record.endpoints.map((endpoint) => endpoint.port), [8000, 8001])
  assert.equal(record.linkRole, COSMIC_RING_LINK_ROLE)
})

test('a restored local CosmicRing keeps one manifest entity when its UUID changes', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertManifest({
    id: 14,
    name: 'Live-Ring',
    deviceType: 'CosmicRing',
    persistentDeviceId: 'old-ring-vst',
    host: '192.168.68.58',
    oscQueryPort: 8000,
    enabled: false
  })
  registry.upsertDiscovery({
    name: 'Live-Ring',
    host: '192.168.68.58',
    port: 8000,
    hostInfo: {
      DEVICE_ID: 'new-ring-vst',
      DEVICE_TYPE: 'CosmicRing'
    }
  })

  const [record] = registry.snapshot()
  assert.equal(registry.snapshot().length, 1)
  assert.equal(record.id, 14)
  assert.equal(record.enabled, false)
  assert.equal(record.canonicalId, 'cosmicring:uuid:new-ring-vst')
  assert.equal(record.persistentDeviceId, 'new-ring-vst')
})

test('a UUID first seen on LAN upgrades an existing loopback VST manifest instead of duplicating it', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertManifest({
    id: 9,
    name: 'Cosmic Unity 1',
    type: 'oscquery-device',
    host: '127.0.0.1',
    oscQueryPort: 5001,
    enabled: true
  })
  registry.upsertDiscovery({
    name: 'Cosmic Unity 1',
    host: '192.168.68.58',
    port: 5001,
    txt: { device_id: 'vst-instance-uuid', device_type: 'CosmicUnity' }
  })

  const [record] = registry.snapshot()
  assert.equal(registry.snapshot().length, 1)
  assert.equal(record.id, 9)
  assert.equal(record.canonicalId, 'cosmicunity:uuid:vst-instance-uuid')
  assert.deepEqual(record.endpoints.map((item) => item.host), ['127.0.0.1', '192.168.68.58'])
})

test('a verified-local VST discovery replaces a stale manifest UUID on the same port without losing the saved entity', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertManifest({
    id: 7,
    name: 'Stage Tablet Three',
    type: 'oscquery-device',
    deviceType: 'CosmicUnity',
    persistentDeviceId: 'stale-vst-instance-uuid',
    host: '127.0.0.1',
    oscQueryPort: 5003,
    enabled: false,
    paramCount: 10,
    legacyIds: [3]
  })

  registry.upsertDiscovery({
    name: 'LiveTablet-3',
    serviceName: 'LiveTablet-3',
    host: '192.168.68.58',
    port: 5003,
    hostInfo: {
      DEVICE_ID: 'current-vst-instance-uuid',
      DEVICE_TYPE: 'CosmicUnity'
    }
  })

  const [record] = registry.snapshot()
  assert.equal(registry.snapshot().length, 1)
  assert.equal(record.id, 7)
  assert.equal(record.name, 'Stage Tablet Three')
  assert.equal(record.enabled, false)
  assert.equal(record.paramCount, 10)
  assert.equal(record.persistentDeviceId, 'current-vst-instance-uuid')
  assert.equal(record.canonicalId, 'cosmicunity:uuid:current-vst-instance-uuid')
  assert.deepEqual(record.legacyIds, [3])
  assert.deepEqual(record.endpoints.map((item) => item.host), ['127.0.0.1', '192.168.68.58'])
})

test('stale unsaved discovery records expire, saved records do not', () => {
  let now = 1_000
  const registry = new DeviceRegistry({ localAddresses, now: () => now })
  registry.upsertDiscovery({ fqdn: 'Android-A._oscjson._tcp.local', name: 'Android-A', host: '192.168.68.51', port: 9010 })
  registry.upsertManifest({ id: 4, name: 'Android-B', host: '192.168.68.52', oscQueryPort: 9010, enabled: true })
  registry.markDiscoveryDown({ fqdn: 'Android-A._oscjson._tcp.local', host: '192.168.68.51', port: 9010 })
  now += 20_000
  assert.equal(registry.pruneStale(15_000).length, 1)
  assert.equal(registry.snapshot().length, 1)
  assert.equal(registry.snapshot()[0].manifestId, 4)
})

test('connection state updates stay on the same entity', () => {
  const registry = new DeviceRegistry({ localAddresses })
  const record = registry.upsertManifest({ id: 1, name: 'Tablet-1', host: '127.0.0.1', oscQueryPort: 5001, enabled: true })
  registry.updateConnection(record.canonicalId, { connectionState: CONNECTION_STATES.CONNECTING })
  registry.updateConnection(record.canonicalId, { connectionState: CONNECTION_STATES.UNAVAILABLE, error: 'Timed out after 3000 ms' })
  assert.equal(registry.snapshot().length, 1)
  assert.equal(registry.snapshot()[0].connectionState, CONNECTION_STATES.UNAVAILABLE)
})

test('manifest migration deduplicates only verified local aliases and preserves routing id', () => {
  const entries = [
    { file: 'loopback.json', manifest: { id: 1, name: 'Tablet One', host: '127.0.0.1', oscQueryPort: 5001, enabled: true } },
    { file: 'wifi.json', manifest: { id: 8, name: 'Tablet One Copy', host: '192.168.68.58', oscQueryPort: 5001, enabled: true } },
    { file: 'remote.json', manifest: { id: 9, name: 'Tablet One', host: '192.168.1.101', oscQueryPort: 5001, enabled: true } },
    { file: 'port2.json', manifest: { id: 10, name: 'Tablet Two', host: '127.0.0.1', oscQueryPort: 5002, enabled: true } }
  ]
  const result = deduplicateManifestEntries(entries, { localAddresses })
  assert.equal(result.kept.length, 3)
  assert.equal(result.duplicates.length, 1)
  const merged = result.kept.find((entry) => entry.manifest.id === 1).manifest
  assert.equal(merged.host, '127.0.0.1')
  assert.deepEqual(merged.legacyIds, [8])
  assert.equal(merged.endpoints.length, 2)
})

test('manifest migration deduplicates only verified-local MaxRing aliases', () => {
  const entries = [
    {
      file: 'maxring-loopback.json',
      manifest: {
        id: 13,
        name: 'Max_Ring',
        serviceName: 'MaxRing',
        deviceType: 'OSCQuery',
        canonicalId: 'oscquery:legacy:127.0.0.1:8005:maxring',
        host: '127.0.0.1',
        oscQueryPort: 8005,
        enabled: false,
        description: 'Operator configured Max/Ring receiver',
        routing: { peerId: 'ring-instrument', udpPortOverride: 9005 }
      }
    },
    {
      file: 'maxring-lan.json',
      manifest: {
        id: 14,
        name: 'MaxRing Copy',
        serviceName: 'MaxRing',
        deviceType: 'OSCQuery',
        canonicalId: 'oscquery:legacy:192.168.68.58:8005:maxring',
        host: '192.168.68.58',
        oscQueryPort: 8005,
        enabled: true
      }
    },
    {
      file: 'maxring-remote.json',
      manifest: {
        id: 15,
        name: 'Remote MaxRing',
        serviceName: 'MaxRing',
        deviceType: 'OSCQuery',
        host: '192.168.68.63',
        oscQueryPort: 8005,
        enabled: true
      }
    }
  ]

  const result = deduplicateManifestEntries(entries, { localAddresses })
  assert.equal(result.kept.length, 2)
  assert.equal(result.duplicates.length, 1)
  const local = result.kept.find((entry) => entry.manifest.id === 13).manifest
  assert.equal(local.canonicalId, 'oscquery:local-maxring:8005')
  assert.equal(local.enabled, false)
  assert.equal(local.description, 'Operator configured Max/Ring receiver')
  assert.deepEqual(local.routing, { peerId: 'ring-instrument', udpPortOverride: 9005 })
  assert.deepEqual(local.legacyIds, [14])
  assert.deepEqual(
    new Set(local.legacyCanonicalIds),
    new Set([
      'oscquery:legacy:127.0.0.1:8005:maxring',
      'oscquery:legacy:192.168.68.58:8005:maxring'
    ])
  )
  assert.deepEqual(
    local.endpoints.map((endpoint) => `${endpoint.host}:${endpoint.port}`),
    ['127.0.0.1:8005', '192.168.68.58:8005']
  )
  assert.ok(result.kept.some((entry) => entry.manifest.id === 15))
})

test('manifest migration upgrades the old Live-Ring OSCQuery identity without losing settings', () => {
  const result = deduplicateManifestEntries([{
    file: 'live_ring_14.json',
    manifest: {
      id: 14,
      name: 'Live-Ring',
      serviceName: 'Live-Ring',
      type: 'oscquery-device',
      deviceType: 'OSCQuery',
      persistentDeviceId: 'ring-vst-installation',
      canonicalId: 'oscquery:uuid:ring-vst-installation',
      host: '192.168.68.58',
      oscQueryPort: 8000,
      enabled: false,
      description: 'Operator configured Ring receiver'
    }
  }], { localAddresses })

  assert.equal(result.kept.length, 1)
  assert.equal(result.duplicates.length, 0)
  const manifest = result.kept[0].manifest
  assert.equal(result.kept[0].changed, true)
  assert.equal(manifest.id, 14)
  assert.equal(manifest.deviceType, COSMIC_RING_DEVICE_TYPE)
  assert.equal(manifest.canonicalId, 'cosmicring:uuid:ring-vst-installation')
  assert.equal(manifest.enabled, false)
  assert.equal(manifest.description, 'Operator configured Ring receiver')
  assert.deepEqual(manifest.legacyCanonicalIds, ['oscquery:uuid:ring-vst-installation'])
})

test('manifest migration persists a corrected CosmicRing type even when canonical identity is already current', () => {
  const result = deduplicateManifestEntries([{
    file: 'live_ring_14.json',
    manifest: {
      id: 14,
      name: 'Live-Ring',
      serviceName: 'Live-Ring',
      deviceType: 'OSCQuery',
      persistentDeviceId: 'ring-vst-installation',
      canonicalId: 'cosmicring:uuid:ring-vst-installation',
      host: '192.168.68.58',
      oscQueryPort: 8000,
      endpoints: [{
        host: '192.168.68.58',
        port: 8000,
        source: 'manifest'
      }],
      legacyIds: [],
      legacyCanonicalIds: []
    }
  }], { localAddresses })

  assert.equal(result.kept[0].changed, true)
  assert.equal(result.kept[0].manifest.deviceType, COSMIC_RING_DEVICE_TYPE)
})

test('manifest migration folds one Live-Ring UUID across fallback ports without losing settings', () => {
  const result = deduplicateManifestEntries([{
    file: 'live_ring_old.json',
    manifest: {
      id: 14,
      name: 'Live-Ring',
      serviceName: 'Live-Ring',
      deviceType: 'CosmicRing',
      persistentDeviceId: 'ring-vst-installation',
      canonicalId: 'cosmicring:uuid:ring-vst-installation',
      host: '192.168.68.58',
      oscQueryPort: 8000,
      enabled: false,
      routing: { peerId: 'ring-instrument', udpPortOverride: 0 },
      endpoints: [{
        host: '192.168.68.58', port: 8000, source: 'manifest', lastSeen: 100
      }]
    }
  }, {
    file: 'live_ring_fallback.json',
    manifest: {
      id: 15,
      name: 'Live-Ring',
      serviceName: 'Live-Ring',
      deviceType: 'CosmicRing',
      persistentDeviceId: 'ring-vst-installation',
      canonicalId: 'cosmicring:uuid:ring-vst-installation',
      host: '192.168.68.58',
      oscQueryPort: 8001,
      enabled: true,
      endpoints: [{
        host: '192.168.68.58', port: 8001, source: 'discovery', lastSeen: 200
      }]
    }
  }], { localAddresses })

  assert.equal(result.kept.length, 1)
  assert.equal(result.duplicates.length, 1)
  const manifest = result.kept[0].manifest
  assert.equal(manifest.id, 14)
  assert.equal(manifest.enabled, false)
  assert.deepEqual(manifest.routing, { peerId: 'ring-instrument', udpPortOverride: 0 })
  assert.equal(manifest.oscQueryPort, 8001)
  assert.deepEqual(manifest.endpoints.map((endpoint) => endpoint.port), [8000, 8001])
  assert.equal(manifest.canonicalId, 'cosmicring:uuid:ring-vst-installation')
})

test('manifest migration keeps remote-first CosmicRing UUID scoped away from the local receiver', () => {
  const result = deduplicateManifestEntries([{
    file: 'remote_ring.json',
    manifest: {
      id: 13,
      name: 'Live-Ring',
      serviceName: 'Live-Ring',
      fqdn: 'Remote-Live-Ring._oscjson._tcp.local',
      deviceType: 'CosmicRing',
      persistentDeviceId: 'shared-ring-vst',
      canonicalId: 'cosmicring:uuid:shared-ring-vst',
      host: '192.168.68.63',
      oscQueryPort: 8000,
      endpoints: [{
        host: '192.168.68.63',
        port: 8000,
        fqdn: 'Remote-Live-Ring._oscjson._tcp.local',
        source: 'manifest'
      }]
    }
  }, {
    file: 'local_ring.json',
    manifest: {
      id: 14,
      name: 'Live-Ring',
      serviceName: 'Live-Ring',
      fqdn: 'Live-Ring._oscjson._tcp.local',
      deviceType: 'CosmicRing',
      persistentDeviceId: 'shared-ring-vst',
      canonicalId: 'cosmicring:uuid:shared-ring-vst',
      host: '192.168.68.58',
      oscQueryPort: 8000,
      endpoints: [{
        host: '192.168.68.58',
        port: 8000,
        fqdn: 'Live-Ring._oscjson._tcp.local',
        source: 'manifest'
      }]
    }
  }], { localAddresses })

  assert.equal(result.kept.length, 2)
  assert.equal(result.duplicates.length, 0)
  const remote = result.kept.find((entry) => entry.manifest.id === 13).manifest
  const local = result.kept.find((entry) => entry.manifest.id === 14).manifest
  assert.match(remote.canonicalId, /:remote:/)
  assert.equal(local.canonicalId, 'cosmicring:uuid:shared-ring-vst')
})

test('manifest migration merges stale and current UUIDs for one verified-local VST port and preserves the lower-id settings', () => {
  const entries = [
    {
      file: 'tablet3-old.json',
      manifest: {
        id: 7,
        name: 'Stage Tablet Three',
        type: 'oscquery-device',
        deviceType: 'CosmicUnity',
        canonicalId: 'cosmicunity:uuid:stale-vst-instance-uuid',
        persistentDeviceId: 'stale-vst-instance-uuid',
        serviceName: 'tablet2',
        host: '127.0.0.1',
        oscQueryPort: 5003,
        enabled: false,
        description: 'Operator configured',
        routing: { peerId: 'stage-tablet-3', udpPortOverride: 0 },
        endpoints: [
          { host: '127.0.0.1', port: 5003, source: 'manifest', lastSeen: 100 }
        ],
        legacyIds: [3]
      }
    },
    {
      file: 'tablet3-current.json',
      manifest: {
        id: 8,
        name: 'LiveTablet-3',
        type: 'oscquery-device',
        deviceType: 'CosmicUnity',
        canonicalId: 'cosmicunity:uuid:current-vst-instance-uuid',
        persistentDeviceId: 'current-vst-instance-uuid',
        serviceName: 'LiveTablet-3',
        host: '192.168.68.58',
        oscQueryPort: 5003,
        enabled: true,
        endpoints: [
          { host: '192.168.68.58', port: 5003, source: 'discovery', lastSeen: 200 }
        ],
        legacyIds: [6]
      }
    }
  ]

  const result = deduplicateManifestEntries(entries, { localAddresses })
  assert.equal(result.kept.length, 1)
  assert.equal(result.duplicates.length, 1)

  const [{ file, manifest }] = result.kept
  assert.equal(file, 'tablet3-old.json')
  assert.equal(manifest.id, 7)
  assert.equal(manifest.name, 'Stage Tablet Three')
  assert.equal(manifest.enabled, false)
  assert.equal(manifest.description, 'Operator configured')
  assert.deepEqual(manifest.routing, { peerId: 'stage-tablet-3', udpPortOverride: 0 })
  assert.equal(manifest.persistentDeviceId, 'current-vst-instance-uuid')
  assert.equal(manifest.canonicalId, 'cosmicunity:uuid:current-vst-instance-uuid')
  assert.deepEqual(manifest.legacyIds, [3, 6, 8])
  assert.deepEqual(
    manifest.endpoints.map((endpoint) => `${endpoint.host}:${endpoint.port}`),
    ['127.0.0.1:5003', '192.168.68.58:5003']
  )
  assert.deepEqual(result.duplicates.map((entry) => entry.manifest.id), [8])
})

test('manifest migration keeps different verified-local VST ports separate even when both carry UUIDs', () => {
  const entries = [
    {
      file: 'tablet2.json',
      manifest: {
        id: 5,
        name: 'LiveTablet-2',
        deviceType: 'CosmicUnity',
        persistentDeviceId: 'vst-port-5002-uuid',
        host: '127.0.0.1',
        oscQueryPort: 5002
      }
    },
    {
      file: 'tablet3.json',
      manifest: {
        id: 7,
        name: 'LiveTablet-3',
        deviceType: 'CosmicUnity',
        persistentDeviceId: 'vst-port-5003-uuid',
        host: '192.168.68.58',
        oscQueryPort: 5003
      }
    }
  ]

  const result = deduplicateManifestEntries(entries, { localAddresses })
  assert.equal(result.kept.length, 2)
  assert.equal(result.duplicates.length, 0)
  assert.deepEqual(result.kept.map((entry) => entry.manifest.oscQueryPort).sort(), [5002, 5003])
})

test('manifest migration keeps copied VST UUIDs separate by verified local port', () => {
  const entries = [5001, 5002].map((port, index) => ({
    file: `tablet-${port}.json`,
    manifest: {
      id: index + 1,
      name: `LiveTablet-${index + 1}`,
      deviceType: 'CosmicUnity',
      persistentDeviceId: 'copied-ableton-state-uuid',
      host: '127.0.0.1',
      oscQueryPort: port
    }
  }))

  const result = deduplicateManifestEntries(entries, { localAddresses })
  assert.equal(result.kept.length, 2)
  assert.equal(result.duplicates.length, 0)
  assert.deepEqual(result.kept.map((entry) => entry.manifest.oscQueryPort).sort(), [5001, 5002])
})

test('manifest migration never folds remote CosmicUnity or Android devices together merely because their ports match', () => {
  const entries = [
    {
      file: 'remote-vst-a.json',
      manifest: {
        id: 20,
        name: 'Remote VST A',
        deviceType: 'CosmicUnity',
        persistentDeviceId: 'remote-vst-a-uuid',
        host: '192.168.68.81',
        oscQueryPort: 5003
      }
    },
    {
      file: 'remote-vst-b.json',
      manifest: {
        id: 21,
        name: 'Remote VST B',
        deviceType: 'CosmicUnity',
        persistentDeviceId: 'remote-vst-b-uuid',
        host: '192.168.68.82',
        oscQueryPort: 5003
      }
    },
    {
      file: 'android-a.json',
      manifest: {
        id: 30,
        name: 'Android Tablet A',
        deviceType: 'Android',
        persistentDeviceId: 'android-a-uuid',
        host: '192.168.68.51',
        oscQueryPort: 9010
      }
    },
    {
      file: 'android-b.json',
      manifest: {
        id: 31,
        name: 'Android Tablet B',
        deviceType: 'Android',
        persistentDeviceId: 'android-b-uuid',
        host: '192.168.68.52',
        oscQueryPort: 9010
      }
    }
  ]

  const result = deduplicateManifestEntries(entries, { localAddresses })
  assert.equal(result.kept.length, 4)
  assert.equal(result.duplicates.length, 0)
  assert.deepEqual(result.kept.map((entry) => entry.manifest.id).sort((a, b) => a - b), [20, 21, 30, 31])
})
