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
