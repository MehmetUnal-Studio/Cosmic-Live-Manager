// Saved manifests without an observed fqdn (DHCP incident 2026-09-03).
//
// Mac and the TouchDesigner machine rebooted together; DHCP moved the Windows
// box 192.168.68.52 → .68. The hub started fresh and loaded the saved cards
// from manifests whose only endpoint was `source: 'manual-update'` with no
// fqdn. The old address never announced again, so nothing ever attached an
// fqdn to the saved record: the .68 announcement became a separate unsaved
// card and host-follow heal had no service identity to follow. The cards
// looped on "Connection timed out" until an operator edited HOST by hand.
//
// A manifest's `serviceName` is the mDNS service instance name, and the
// _oscjson fqdn is a deterministic function of it. Deriving that fqdn at
// manifest load time gives the saved record its identity even when the hub
// has never observed the old address, while exact fqdn equality (never name
// similarity) remains the only thing that folds or migrates.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DeviceRegistry,
  hostInfoIdentityMismatch,
  derivedServiceFqdn
} from '../server/deviceRegistry.js'
import { planHostFollowHeals } from '../server/hostFollowHeal.js'
import { resolveGenericTargetFromRegistry } from '../server/linkRouting.js'

const localAddresses = new Set(['127.0.0.1', '192.168.68.58'])
const OLD_HOST = '192.168.68.52'
const NEW_HOST = '192.168.68.68'
const TV_SERVICE = 'Windows_TVNEVA40902'
const TV_FQDN = `${TV_SERVICE}._oscjson._tcp.local`
const RING_SERVICE = 'Ring-Instrument'
const RING_FQDN = `${RING_SERVICE}._oscjson._tcp.local`

// The exact manifests loaded on the incident morning: saved from the Device
// Registry, then edited by hand once, never re-announced on the old address.
function tvManifest(overrides = {}) {
  return {
    id: 10,
    name: 'TV',
    type: 'oscquery-device',
    deviceType: 'OSCQuery',
    persistentDeviceId: null,
    serviceName: TV_SERVICE,
    host: OLD_HOST,
    oscQueryPort: 9010,
    enabled: true,
    endpoints: [{ host: OLD_HOST, port: 9010, source: 'manual-update', lastSeen: 500 }],
    legacyIds: [],
    legacyCanonicalIds: [],
    canonicalId: `oscquery:legacy:${OLD_HOST}:9010:windows_tvneva40902`,
    ...overrides
  }
}

function ringManifest() {
  return {
    id: 12,
    name: 'Ring-Instrument',
    type: 'oscquery-device',
    deviceType: 'OSCQuery',
    persistentDeviceId: null,
    serviceName: RING_SERVICE,
    host: OLD_HOST,
    oscQueryPort: 9011,
    enabled: true,
    endpoints: [{ host: OLD_HOST, port: 9011, source: 'manual-update', lastSeen: 500 }],
    legacyIds: [],
    legacyCanonicalIds: [],
    canonicalId: `oscquery:legacy:${OLD_HOST}:9011:ring-instrument`
  }
}

function failingManagedDevice(manifest, failures = 2) {
  return {
    ...manifest,
    status: 'error',
    lastMessageAt: 0,
    consecutiveConnectFailures: failures
  }
}

function freshRegistry() {
  let now = 1_000
  return new DeviceRegistry({ localAddresses, now: () => (now += 1_000) })
}

test('derivedServiceFqdn derives the deterministic _oscjson fqdn from a service name', () => {
  assert.equal(derivedServiceFqdn(TV_SERVICE), TV_FQDN)
  assert.equal(derivedServiceFqdn('  Ring-Instrument  '), RING_FQDN)
  assert.equal(derivedServiceFqdn(''), '')
  assert.equal(derivedServiceFqdn(undefined), '')
})

test('a manifest endpoint without fqdn gets the fqdn derived from serviceName, marked as derived', () => {
  const registry = freshRegistry()
  const record = registry.upsertManifest(tvManifest())
  const endpoint = record.endpoints.find((item) => item.host === OLD_HOST && item.port === 9010)
  assert.ok(endpoint)
  assert.equal(endpoint.fqdn, TV_FQDN)
  assert.equal(endpoint.fqdnSource, 'derived')
})

test('an observed fqdn on a manifest endpoint is never overwritten by the derived one', () => {
  const registry = freshRegistry()
  const record = registry.upsertManifest(tvManifest({
    endpoints: [{ host: OLD_HOST, port: 9010, source: 'discovery', fqdn: 'Other._oscjson._tcp.local', lastSeen: 500 }]
  }))
  const endpoint = record.endpoints.find((item) => item.host === OLD_HOST)
  assert.equal(endpoint.fqdn, 'Other._oscjson._tcp.local')
  assert.equal(endpoint.fqdnSource, undefined)
})

test('a manifest without serviceName derives no fqdn — a display label is not an identity', () => {
  const registry = freshRegistry()
  const record = registry.upsertManifest(tvManifest({ serviceName: undefined, name: 'TV' }))
  for (const endpoint of record.endpoints) {
    assert.equal(endpoint.fqdn, '')
    assert.equal(endpoint.fqdnSource, undefined)
  }
})

test('fresh hub + fqdn-less saved manifest: the same serviceName announced on a new host folds into the saved card', () => {
  const registry = freshRegistry()
  registry.upsertManifest(tvManifest())

  const updated = registry.upsertDiscovery({
    name: TV_SERVICE,
    serviceName: TV_SERVICE,
    host: NEW_HOST,
    port: 9010,
    fqdn: TV_FQDN
  })

  assert.equal(registry.snapshot().length, 1)
  assert.equal(updated.saved, true)
  assert.equal(updated.manifestId, 10)
  assert.deepEqual(
    updated.endpoints.map((endpoint) => endpoint.host).sort(),
    [OLD_HOST, NEW_HOST]
  )
})

test('fresh hub + fqdn-less saved manifest: host-follow heal plans the DHCP move', () => {
  const registry = freshRegistry()
  registry.upsertManifest(tvManifest())
  registry.upsertDiscovery({
    name: TV_SERVICE,
    serviceName: TV_SERVICE,
    host: NEW_HOST,
    port: 9010,
    fqdn: TV_FQDN
  })

  const plans = planHostFollowHeals({
    snapshot: registry.snapshot(),
    getManagedDevice: (id) => (id === 10 ? failingManagedDevice(tvManifest()) : undefined)
  })
  assert.deepEqual(plans, [{
    manifestId: 10,
    fqdn: TV_FQDN,
    fromHost: OLD_HOST,
    fromPort: 9010,
    host: NEW_HOST,
    oscQueryPort: 9010
  }])
})

test('two fqdn-less saved cards on the same old host each follow only their own fqdn', () => {
  const registry = freshRegistry()
  registry.upsertManifest(tvManifest())
  registry.upsertManifest(ringManifest())
  registry.upsertDiscovery({ name: TV_SERVICE, serviceName: TV_SERVICE, host: NEW_HOST, port: 9010, fqdn: TV_FQDN })
  registry.upsertDiscovery({ name: RING_SERVICE, serviceName: RING_SERVICE, host: NEW_HOST, port: 9011, fqdn: RING_FQDN })

  assert.equal(registry.snapshot().length, 2)
  const managed = new Map([
    [10, failingManagedDevice(tvManifest())],
    [12, failingManagedDevice(ringManifest())]
  ])
  const plans = planHostFollowHeals({
    snapshot: registry.snapshot(),
    getManagedDevice: (id) => managed.get(id)
  }).sort((a, b) => a.manifestId - b.manifestId)
  assert.deepEqual(plans.map((plan) => [plan.manifestId, plan.fqdn, plan.host, plan.oscQueryPort]), [
    [10, TV_FQDN, NEW_HOST, 9010],
    [12, RING_FQDN, NEW_HOST, 9011]
  ])
})

test('wrong-device guard: a different fqdn on the new host never folds into or migrates the saved card', () => {
  const registry = freshRegistry()
  registry.upsertManifest(tvManifest())

  // A lookalike name is not the same service: "Windows_TVNEVA40902-2".
  const stranger = registry.upsertDiscovery({
    name: `${TV_SERVICE}-2`,
    serviceName: `${TV_SERVICE}-2`,
    host: NEW_HOST,
    port: 9010,
    fqdn: `${TV_SERVICE}-2._oscjson._tcp.local`
  })

  assert.equal(registry.snapshot().length, 2)
  assert.equal(stranger.saved, false)
  assert.equal(stranger.manifestId, null)

  const plans = planHostFollowHeals({
    snapshot: registry.snapshot(),
    getManagedDevice: (id) => (id === 10 ? failingManagedDevice(tvManifest()) : undefined)
  })
  assert.deepEqual(plans, [])
})

test('a derived fqdn is not mDNS-grade evidence for the HOST_INFO name guard', () => {
  const registry = freshRegistry()
  const record = registry.upsertManifest(tvManifest())
  // What the hub dials after applyRegistryIdentity: registry endpoints on the
  // managed device. TouchDesigner may report any NAME; a hand-typed or
  // migrated card must stay lenient exactly as before.
  const dev = { ...tvManifest(), endpoints: record.endpoints }
  assert.equal(hostInfoIdentityMismatch(dev, { NAME: 'TouchDesigner' }), null)
})

test('an observed fqdn on the dialed endpoint still arms the HOST_INFO name guard', () => {
  const registry = freshRegistry()
  const record = registry.upsertManifest(tvManifest({
    endpoints: [{ host: OLD_HOST, port: 9010, source: 'discovery', fqdn: TV_FQDN, lastSeen: 500 }]
  }))
  const dev = { ...tvManifest(), endpoints: record.endpoints }
  const mismatch = hostInfoIdentityMismatch(dev, { NAME: 'SpectraTablet02' })
  assert.ok(mismatch)
  assert.equal(mismatch.basis, 'name')
})

test('a derived fqdn never becomes a LINK target identity — persisted links keep matching by name as before', () => {
  const registry = freshRegistry()
  registry.upsertManifest(tvManifest({ status: 'connected' }))
  const resolved = resolveGenericTargetFromRegistry(registry.snapshot(), {
    address: OLD_HOST,
    port: 9010,
    fqdn: '',
    name: 'TV'
  })
  assert.equal(resolved.record.manifestId, 10)
  assert.equal(resolved.target.address, OLD_HOST)
  assert.equal(resolved.target.fqdn, '')
})

test('a derived fqdn stays marked derived when registry endpoints round-trip through a manifest re-upsert', () => {
  // HOST_INFO and every settings save re-upsert the managed device with the
  // registry's own endpoints (applyRegistryIdentity copies them onto it). The
  // derived marker must survive that trip, or the guard and LINK identity
  // would treat the derived fqdn as an mDNS observation one save later.
  const registry = freshRegistry()
  const first = registry.upsertManifest(tvManifest())
  const second = registry.upsertManifest({ ...tvManifest(), endpoints: first.endpoints })
  const endpoint = second.endpoints.find((item) => item.host === OLD_HOST)
  assert.equal(endpoint.fqdn, TV_FQDN)
  assert.equal(endpoint.fqdnSource, 'derived')
})
