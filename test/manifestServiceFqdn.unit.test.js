// The saved manifest's own service identity (`serviceFqdn`).
//
// Incident 2026-09-03, second half: the TouchDesigner machine moved
// 192.168.68.52 → .68 and an operator repaired the cards by hand. Every hand
// repair writes a single `source: 'manual-update'` endpoint with no fqdn, so
// the repair itself destroyed the service identity host-follow heal needs —
// the next DHCP move could only be fixed by hand again. Deriving the fqdn
// from `serviceName` covers the cards whose display name happens to be the
// mDNS instance name; it cannot help a card named by an operator ("TV") whose
// service announces as `Windows_TVNEVA40902`.
//
// A successful connection is the one moment the hub holds mDNS-grade proof of
// which service answers a saved card. Persisting that observation as the
// manifest's `serviceFqdn` gives the card an identity that survives hand
// repairs, hub restarts and addresses the hub never observed — while exact
// fqdn equality (never name similarity) stays the only thing that migrates a
// manifest.

import test from 'node:test'
import assert from 'node:assert/strict'

import { DeviceRegistry, learnedServiceFqdn } from '../server/deviceRegistry.js'
import { planHostFollowHeals } from '../server/hostFollowHeal.js'

const localAddresses = new Set(['127.0.0.1', '192.168.68.58'])
const OLD_HOST = '192.168.68.52'
const NEW_HOST = '192.168.68.68'
const PORT = 9010
// The operator named the card "TV"; the machine announces itself as
// Windows_TVNEVA40902, so nothing about the saved name derives this fqdn.
const OBSERVED_FQDN = 'Windows_TVNEVA40902._oscjson._tcp.local'
const OTHER_FQDN = 'Ring-Instrument._oscjson._tcp.local'

function freshRegistry() {
  let now = 1_000
  return new DeviceRegistry({ localAddresses, now: () => (now += 1_000) })
}

// A card an operator repaired by hand: one manual-update endpoint, no fqdn on
// it, and the service identity the hub learned on an earlier connection.
function handRepairedFixture({
  serviceFqdn = OBSERVED_FQDN,
  manifestEndpoint = {},
  discoveryEndpoint = {}
} = {}) {
  const dev = {
    id: 10,
    name: 'TV',
    serviceName: 'TV',
    serviceFqdn,
    enabled: true,
    status: 'error',
    host: OLD_HOST,
    oscQueryPort: PORT,
    lastMessageAt: 1_000,
    consecutiveConnectFailures: 2
  }
  // An empty value means the manifest holds no service identity at all: the
  // field is simply absent from a card the hub has never connected to.
  if (!serviceFqdn) delete dev.serviceFqdn
  const snapshot = [{
    canonicalId: `oscquery:legacy:${OLD_HOST}:${PORT}:tv`,
    saved: true,
    manifestId: 10,
    endpoints: [
      {
        host: OLD_HOST,
        port: PORT,
        source: 'manual-update',
        available: true,
        lastSeen: 2_000,
        ...manifestEndpoint
      },
      {
        host: NEW_HOST,
        port: PORT,
        source: 'discovery',
        fqdn: OBSERVED_FQDN,
        available: true,
        lastSeen: 6_000,
        ...discoveryEndpoint
      }
    ]
  }]
  return {
    snapshot,
    getManagedDevice: (manifestId) => (manifestId === 10 ? dev : undefined)
  }
}

// ─── host-follow heal falls back to the manifest's service identity ───────

test('a hand-repaired card follows its persisted serviceFqdn on the next move', () => {
  const plans = planHostFollowHeals(handRepairedFixture())
  assert.deepEqual(plans, [{
    manifestId: 10,
    fqdn: OBSERVED_FQDN,
    fromHost: OLD_HOST,
    fromPort: PORT,
    host: NEW_HOST,
    oscQueryPort: PORT
  }])
})

test('the persisted serviceFqdn outranks an fqdn merely derived from the saved name', () => {
  // The derived fqdn is a guess from `serviceName`; a card an operator named
  // "TV" derives `TV._oscjson._tcp.local`, which no service ever announces.
  const plans = planHostFollowHeals(handRepairedFixture({
    manifestEndpoint: { fqdn: 'TV._oscjson._tcp.local', fqdnSource: 'derived' }
  }))
  assert.equal(plans.length, 1)
  assert.equal(plans[0].fqdn, OBSERVED_FQDN)
  assert.equal(plans[0].host, NEW_HOST)
})

test('an fqdn observed on the manifest endpoint itself still wins', () => {
  // Real evidence about the dialed address beats the card-level identity.
  const plans = planHostFollowHeals(handRepairedFixture({
    serviceFqdn: OTHER_FQDN,
    manifestEndpoint: { fqdn: OBSERVED_FQDN, source: 'discovery' }
  }))
  assert.equal(plans.length, 1)
  assert.equal(plans[0].fqdn, OBSERVED_FQDN)
})

// ─── the identity requirement is never relaxed ───────────────────────────

test('a serviceFqdn that does not match the announcement never migrates a card', () => {
  assert.deepEqual(planHostFollowHeals(handRepairedFixture({ serviceFqdn: OTHER_FQDN })), [])
  assert.deepEqual(planHostFollowHeals(handRepairedFixture({
    discoveryEndpoint: { fqdn: OTHER_FQDN }
  })), [])
  // Name similarity is not identity: an instance-name prefix must not match.
  assert.deepEqual(planHostFollowHeals(handRepairedFixture({
    serviceFqdn: 'Windows_TVNEVA._oscjson._tcp.local'
  })), [])
})

test('a card with neither an endpoint fqdn nor a serviceFqdn holds no identity', () => {
  assert.deepEqual(planHostFollowHeals(handRepairedFixture({ serviceFqdn: '' })), [])
  assert.deepEqual(planHostFollowHeals(handRepairedFixture({ serviceFqdn: '   ' })), [])
})

test('the persisted serviceFqdn does not relax the freshness evidence', () => {
  // Announced before the manifest endpoint was last seen → stale.
  assert.deepEqual(planHostFollowHeals(handRepairedFixture({
    discoveryEndpoint: { lastSeen: 1_500 }
  })), [])
  // mDNS goodbye already marked the announcement gone.
  assert.deepEqual(planHostFollowHeals(handRepairedFixture({
    discoveryEndpoint: { available: false }
  })), [])
  // A manifest alias is not a discovery observation.
  assert.deepEqual(planHostFollowHeals(handRepairedFixture({
    discoveryEndpoint: { source: 'manifest' }
  })), [])
})

// ─── what a successful connection may write to the manifest ──────────────

test('a card with no proven identity adopts the fqdn announced where it connected', () => {
  assert.equal(learnedServiceFqdn('', OBSERVED_FQDN), OBSERVED_FQDN)
  assert.equal(learnedServiceFqdn(undefined, OBSERVED_FQDN), OBSERVED_FQDN)
  assert.equal(learnedServiceFqdn('  ', `  ${OBSERVED_FQDN}  `), OBSERVED_FQDN)
})

test('a proven identity is never rewritten by a later announcement', () => {
  // 2026-08-31: DHCP handed a saved card's address to a different device that
  // answered, announced and passed the HOST_INFO name check under its own
  // name. Adopting that fqdn would make the impostor the card's identity.
  assert.equal(learnedServiceFqdn(OBSERVED_FQDN, OTHER_FQDN), '')
  assert.equal(learnedServiceFqdn(OBSERVED_FQDN, OBSERVED_FQDN), '')
})

test('an address that announces nothing teaches the card nothing', () => {
  assert.equal(learnedServiceFqdn('', ''), '')
  assert.equal(learnedServiceFqdn('', undefined), '')
})

// ─── the registry answers who mDNS says lives at an address ──────────────

test('observedFqdnAt reports the fqdn mDNS announced at an exact address', () => {
  const registry = freshRegistry()
  registry.upsertDiscovery({
    name: 'Windows_TVNEVA40902',
    serviceName: 'Windows_TVNEVA40902',
    host: NEW_HOST,
    port: PORT,
    fqdn: OBSERVED_FQDN
  })
  assert.equal(registry.observedFqdnAt(NEW_HOST, PORT), OBSERVED_FQDN)
  assert.equal(registry.observedFqdnAt(NEW_HOST, PORT + 1), '')
  assert.equal(registry.observedFqdnAt('192.168.68.99', PORT), '')
})

test('observedFqdnAt reports nothing for an fqdn the hub only derived', () => {
  const registry = freshRegistry()
  registry.upsertManifest({
    id: 10,
    name: 'TV',
    serviceName: 'Windows_TVNEVA40902',
    deviceType: 'OSCQuery',
    host: OLD_HOST,
    oscQueryPort: PORT,
    enabled: true,
    endpoints: [{ host: OLD_HOST, port: PORT, source: 'manual-update', lastSeen: 500 }]
  })
  // The endpoint carries the derived fqdn (see manifestDerivedFqdn), but the
  // hub never heard anything at this address — that is not an observation.
  assert.equal(registry.observedFqdnAt(OLD_HOST, PORT), '')
})

// ─── a hand-typed HOST no longer costs the card its identity ─────────────

test('a manual-update endpoint adopts the identity mDNS announces at that address', () => {
  const registry = freshRegistry()
  registry.upsertDiscovery({
    name: 'Windows_TVNEVA40902',
    serviceName: 'Windows_TVNEVA40902',
    host: NEW_HOST,
    port: PORT,
    fqdn: OBSERVED_FQDN
  })
  const endpoint = registry.manualUpdateEndpoint({
    host: NEW_HOST,
    port: PORT,
    serviceFqdn: OBSERVED_FQDN
  })
  assert.equal(endpoint.host, NEW_HOST)
  assert.equal(endpoint.port, PORT)
  assert.equal(endpoint.source, 'manual-update')
  assert.equal(endpoint.fqdn, OBSERVED_FQDN)
  assert.ok(Number(endpoint.lastSeen) > 0)
})

test('a card with no identity yet adopts the announcement at the typed address', () => {
  const registry = freshRegistry()
  registry.upsertDiscovery({
    name: 'Windows_TVNEVA40902',
    serviceName: 'Windows_TVNEVA40902',
    host: NEW_HOST,
    port: PORT,
    fqdn: OBSERVED_FQDN
  })
  const endpoint = registry.manualUpdateEndpoint({ host: NEW_HOST, port: PORT })
  assert.equal(endpoint.fqdn, OBSERVED_FQDN)
})

test('a manual-update endpoint never adopts an identity that contradicts the card', () => {
  const registry = freshRegistry()
  registry.upsertDiscovery({
    name: 'Ring-Instrument',
    serviceName: 'Ring-Instrument',
    host: NEW_HOST,
    port: PORT,
    fqdn: OTHER_FQDN
  })
  const endpoint = registry.manualUpdateEndpoint({
    host: NEW_HOST,
    port: PORT,
    serviceFqdn: OBSERVED_FQDN
  })
  assert.equal(endpoint.fqdn, undefined)
  assert.equal(endpoint.source, 'manual-update')
})

test('a manual-update endpoint at an unannounced address stays fqdn-less', () => {
  const registry = freshRegistry()
  const endpoint = registry.manualUpdateEndpoint({
    host: NEW_HOST,
    port: PORT,
    serviceFqdn: OBSERVED_FQDN
  })
  assert.equal(endpoint.fqdn, undefined)
})

// ─── the manifest's identity reaches the registry record ─────────────────

test('an fqdn-less manifest endpoint adopts the persisted serviceFqdn over the derived one', () => {
  const registry = freshRegistry()
  const record = registry.upsertManifest({
    id: 10,
    name: 'TV',
    serviceName: 'TV',
    serviceFqdn: OBSERVED_FQDN,
    deviceType: 'OSCQuery',
    host: OLD_HOST,
    oscQueryPort: PORT,
    enabled: true,
    endpoints: [{ host: OLD_HOST, port: PORT, source: 'manual-update', lastSeen: 500 }]
  })
  const endpoint = record.endpoints.find((item) => item.host === OLD_HOST && item.port === PORT)
  assert.equal(endpoint.fqdn, OBSERVED_FQDN)
  // The address itself was never observed, so the identity guards must keep
  // treating this fqdn as second-hand evidence.
  assert.equal(endpoint.fqdnSource, 'derived')
})

test('the persisted serviceFqdn folds a fresh announcement into the saved card', () => {
  const registry = freshRegistry()
  registry.upsertManifest({
    id: 10,
    name: 'TV',
    serviceName: 'TV',
    serviceFqdn: OBSERVED_FQDN,
    deviceType: 'OSCQuery',
    host: OLD_HOST,
    oscQueryPort: PORT,
    enabled: true,
    endpoints: [{ host: OLD_HOST, port: PORT, source: 'manual-update', lastSeen: 500 }]
  })
  registry.upsertDiscovery({
    name: 'Windows_TVNEVA40902',
    serviceName: 'Windows_TVNEVA40902',
    host: NEW_HOST,
    port: PORT,
    fqdn: OBSERVED_FQDN
  })
  const saved = registry.snapshot().filter((record) => record.saved === true)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].manifestId, 10)
  assert.ok(
    saved[0].endpoints.some((endpoint) => endpoint.host === NEW_HOST && endpoint.port === PORT),
    'the new address must fold into the saved card, not become a second row'
  )
})
