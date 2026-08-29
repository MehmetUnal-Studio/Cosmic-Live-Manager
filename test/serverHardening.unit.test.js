// Unit regression tests for the hub-hardening review fixes:
//   F0-4  hub-WS broadcast backpressure thresholds
//   F0-5/F1-3 multi-home legacy (TXT-less) services collapse onto one record
//   F0-6  persistent-id port-collision auto-heal planner
//   F0-8  generic LINK targets resolve through registry-trusted endpoints
//   F0-9  no-goodbye ghosts: silent → probe → dead/Stale → prunable
//   F0-11 removeManifest cleans endpoint/fqdn indexes
//   F0-13 namespace JSON depth/node caps
//   F0-15 reconnect backoff after everConnected
//   F1-4  zero-argument OSC frames map onto T-typed params
//   F1-7  cached HOST_INFO cleared on disconnect

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { DeviceRegistry } from '../server/deviceRegistry.js'
import {
  OscQueryClient,
  MAX_NAMESPACE_DEPTH,
  MAX_NAMESPACE_NODES
} from '../server/oscqueryClient.js'
import { planCollisionHeals } from '../server/collisionHeal.js'
import {
  hubBackpressureAction,
  HUB_WS_SKIP_BUFFERED_BYTES,
  HUB_WS_DROP_BUFFERED_BYTES
} from '../server/hubBackpressure.js'
import { resolveGenericTargetFromRegistry } from '../server/linkRouting.js'

const localAddresses = new Set(['127.0.0.1', '192.168.68.58'])

function noopEvents() {
  return {
    onConnect: () => {},
    onDisconnect: () => {},
    onValue: () => {},
    onLog: () => {}
  }
}

// ─── F0-5 / F1-3 — multi-home legacy collapse ────────────────────────────

test('a multi-homed TXT-less service folds every address into one record via its fqdn', () => {
  let now = 100
  const registry = new DeviceRegistry({ localAddresses, now: () => ++now })
  registry.upsertDiscovery({
    name: 'Ring-Instrument',
    serviceName: 'Ring-Instrument',
    host: '10.0.0.50',
    port: 9011,
    fqdn: 'Ring-Instrument._oscjson._tcp.local'
  })
  registry.upsertDiscovery({
    name: 'Ring-Instrument',
    serviceName: 'Ring-Instrument',
    host: '192.168.1.50',
    port: 9011,
    fqdn: 'Ring-Instrument._oscjson._tcp.local'
  })

  const snapshot = registry.snapshot()
  assert.equal(snapshot.length, 1, 'dual-homed advert must not create sibling cards')
  assert.deepEqual(
    snapshot[0].endpoints.map((endpoint) => endpoint.host).sort(),
    ['10.0.0.50', '192.168.1.50']
  )
})

test('mDNS goodbye downs every endpoint of a multi-homed legacy service and it becomes prunable', () => {
  let now = 100
  const registry = new DeviceRegistry({ localAddresses, now: () => now })
  const fqdn = 'Ring-Instrument._oscjson._tcp.local'
  registry.upsertDiscovery({ name: 'Ring-Instrument', host: '10.0.0.50', port: 9011, fqdn })
  registry.upsertDiscovery({ name: 'Ring-Instrument', host: '192.168.1.50', port: 9011, fqdn })

  registry.markDiscoveryDown({ fqdn, host: '10.0.0.50', port: 9011 })
  const [record] = registry.snapshot()
  assert.equal(record.discoveryState, 'Stale', 'no endpoint may stay Discovered after the goodbye')
  assert.equal(record.endpoints.every((endpoint) => endpoint.available === false), true)

  now += 60_000
  const removed = registry.pruneStale(15_000)
  assert.deepEqual(removed, [record.canonicalId])
  assert.equal(registry.snapshot().length, 0, 'no ghost card may remain')
})

test('a DHCP move of a saved TXT-less device lands on the same record with the fresh endpoint active', () => {
  let now = 1000
  const registry = new DeviceRegistry({ localAddresses, now: () => (now += 10) })
  const fqdn = 'Ring-Instrument._oscjson._tcp.local'
  registry.upsertManifest({
    id: 5,
    name: 'Ring-Instrument',
    host: '10.0.0.50',
    oscQueryPort: 9011,
    enabled: true,
    endpoints: [{ host: '10.0.0.50', port: 9011, source: 'discovery', fqdn, lastSeen: 500 }]
  })
  registry.upsertDiscovery({ name: 'Ring-Instrument', host: '10.0.0.99', port: 9011, fqdn })

  const snapshot = registry.snapshot()
  assert.equal(snapshot.length, 1, 'the new IP must not become a second card')
  assert.equal(snapshot[0].saved, true)
  assert.equal(snapshot[0].activeEndpoint.host, '10.0.0.99', 'freshest endpoint wins')
})

// ─── F0-9 — no-goodbye prune ──────────────────────────────────────────────

test('a Discovered record silent past the TTL is probed and a dead probe makes it Stale and prunable', () => {
  let now = 10_000
  const registry = new DeviceRegistry({ localAddresses, now: () => now })
  registry.upsertDiscovery({ name: 'Ghost', host: '192.168.1.77', port: 9012, fqdn: 'ghost.local' })
  const [fresh] = registry.snapshot()
  assert.equal(fresh.reachability, 'ok')

  // Within the TTL: not a probe candidate.
  now += 30_000
  assert.deepEqual(registry.reachabilityProbeCandidates(60_000), [])

  // Past the TTL: candidate, marked silent.
  now += 40_000
  const candidates = registry.reachabilityProbeCandidates(60_000)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].reachability, 'silent')
  assert.equal(candidates[0].discoveryState, 'Discovered')

  // Failed probe → dead + Stale → prunable.
  const dead = registry.markProbeResult(candidates[0].canonicalId, false)
  assert.equal(dead.reachability, 'dead')
  assert.equal(dead.discoveryState, 'Stale')
  const removed = registry.pruneStale(15_000)
  assert.deepEqual(removed, [dead.canonicalId])
})

test('a successful reachability probe refreshes the record instead of pruning it', () => {
  let now = 10_000
  const registry = new DeviceRegistry({ localAddresses, now: () => now })
  registry.upsertDiscovery({ name: 'Alive', host: '192.168.1.78', port: 9012 })
  now += 70_000
  const [candidate] = registry.reachabilityProbeCandidates(60_000)
  const refreshed = registry.markProbeResult(candidate.canonicalId, true)
  assert.equal(refreshed.reachability, 'ok')
  assert.equal(refreshed.discoveryState, 'Discovered')
  assert.deepEqual(registry.reachabilityProbeCandidates(60_000), [],
    'a refreshed record must leave the probe set')
  assert.deepEqual(registry.pruneStale(15_000), [])
})

test('saved records are never reachability-probe candidates', () => {
  let now = 10_000
  const registry = new DeviceRegistry({ localAddresses, now: () => now })
  registry.upsertManifest({ id: 9, name: 'Saved', host: '192.168.1.80', oscQueryPort: 9013, enabled: true })
  registry.upsertDiscovery({ name: 'Saved', host: '192.168.1.80', port: 9013 })
  now += 120_000
  assert.deepEqual(registry.reachabilityProbeCandidates(60_000), [])
})

// ─── F0-11 — removeManifest index cleanup ────────────────────────────────

test('removeManifest cleans endpointIndex and fqdnIndex like pruneStale does', () => {
  const registry = new DeviceRegistry({ localAddresses })
  registry.upsertManifest({
    id: 3,
    name: 'Doomed',
    host: '192.168.1.90',
    oscQueryPort: 9014,
    enabled: true,
    endpoints: [{ host: '192.168.1.90', port: 9014, source: 'discovery', fqdn: 'doomed.local' }]
  })
  // discoveryState is Absent (no live discovery), so removal deletes the record.
  assert.equal(registry.removeManifest(3), true)
  assert.equal(registry.records.size, 0)
  assert.equal(registry.endpointIndex.size, 0, 'endpointIndex must not leak ghost keys')
  assert.equal(registry.fqdnIndex.size, 0, 'fqdnIndex must not leak ghost keys')
})

// ─── F0-6 — collision auto-heal planner ──────────────────────────────────

function collisionFixture({ failures, status = 'unavailable', collisionState = 'Discovered' }) {
  const snapshot = [
    {
      canonicalId: 'cosmicunity:uuid:aaaa',
      identitySource: 'persistent-id',
      saved: true,
      manifestId: 11,
      activeEndpoint: { host: '127.0.0.1', port: 5001 },
      endpoints: [{ host: '127.0.0.1', port: 5001 }]
    },
    {
      canonicalId: 'cosmicunity:uuid:aaaa:port:5002',
      identitySource: 'persistent-id-port-collision',
      saved: false,
      discoveryState: collisionState,
      activeEndpoint: { host: '127.0.0.1', port: 5002 },
      endpoints: [{ host: '127.0.0.1', port: 5002 }]
    }
  ]
  const dev = {
    id: 11,
    enabled: true,
    status,
    host: '127.0.0.1',
    oscQueryPort: 5001,
    consecutiveConnectFailures: failures
  }
  return { snapshot, getManagedDevice: (id) => (id === 11 ? dev : undefined) }
}

test('collision auto-heal migrates the saved card once the old endpoint is confirmed dead', () => {
  const plans = planCollisionHeals(collisionFixture({ failures: 3 }))
  assert.deepEqual(plans, [{
    manifestId: 11,
    collisionCanonicalId: 'cosmicunity:uuid:aaaa:port:5002',
    host: '127.0.0.1',
    oscQueryPort: 5002
  }])
})

test('collision auto-heal keeps the explicit collision while the old endpoint still answers', () => {
  assert.deepEqual(
    planCollisionHeals(collisionFixture({ failures: 0, status: 'connected' })),
    [],
    'both alive → real UUID copy → no migration'
  )
  assert.deepEqual(
    planCollisionHeals(collisionFixture({ failures: 2 })),
    [],
    'fewer than N failed probes is not proof of death'
  )
  assert.deepEqual(
    planCollisionHeals(collisionFixture({ failures: 5, status: 'connected' })),
    [],
    'a device that reconnected must never be migrated away'
  )
})

test('collision auto-heal ignores collisions whose endpoint is no longer discovered', () => {
  assert.deepEqual(
    planCollisionHeals(collisionFixture({ failures: 5, collisionState: 'Stale' })),
    []
  )
})

// ─── F0-8 — generic LINK target trust boundary ───────────────────────────

test('generic LINK targets resolve to the registry endpoint, never the browser-submitted address', () => {
  const records = [{
    canonicalId: 'android:uuid:tablet1',
    deviceType: 'Android',
    name: 'Tablet-1',
    serviceName: 'Tablet-1',
    saved: true,
    discoveryState: 'Discovered',
    connectionState: 'Connected',
    activeEndpoint: { host: '192.168.1.30', port: 9010, fqdn: 'tablet1.local' },
    endpoints: [{ host: '192.168.1.30', port: 9010, fqdn: 'tablet1.local' }]
  }]
  // Browser still holds yesterday's DHCP address but identifies by fqdn.
  const resolved = resolveGenericTargetFromRegistry(records, {
    name: 'Tablet-1',
    fqdn: 'tablet1.local',
    address: '192.168.1.99',
    port: 9010,
    deviceType: 'CosmicUnity' // spoofed type must not survive either
  })
  assert.equal(resolved.target.address, '192.168.1.30')
  assert.equal(resolved.target.port, 9010)
  assert.equal(resolved.target.deviceType, 'Android')
})

test('generic LINK targets absent from the registry are rejected', () => {
  assert.throws(
    () => resolveGenericTargetFromRegistry([], {
      name: 'Anything',
      address: '192.168.1.40',
      port: 9010,
      deviceType: 'Android'
    }),
    /must be present in the Device Registry/
  )
})

test('generic LINK targets that are neither discovered nor connected are rejected', () => {
  const records = [{
    canonicalId: 'android:uuid:tablet2',
    deviceType: 'Android',
    name: 'Tablet-2',
    saved: true,
    discoveryState: 'Stale',
    connectionState: 'Unavailable',
    activeEndpoint: { host: '192.168.1.31', port: 9010 },
    endpoints: [{ host: '192.168.1.31', port: 9010 }]
  }]
  assert.throws(
    () => resolveGenericTargetFromRegistry(records, { address: '192.168.1.31', port: 9010 }),
    /unavailable/
  )
})

// ─── F0-4 — hub-WS backpressure thresholds ───────────────────────────────

test('hub broadcast backpressure: send under 1MB, skip over 1MB, drop over 8MB', () => {
  assert.equal(hubBackpressureAction(0), 'send')
  assert.equal(hubBackpressureAction(HUB_WS_SKIP_BUFFERED_BYTES), 'send')
  assert.equal(hubBackpressureAction(HUB_WS_SKIP_BUFFERED_BYTES + 1), 'skip')
  assert.equal(hubBackpressureAction(HUB_WS_DROP_BUFFERED_BYTES), 'skip')
  assert.equal(hubBackpressureAction(HUB_WS_DROP_BUFFERED_BYTES + 1), 'drop')
  assert.equal(hubBackpressureAction(undefined), 'send')
})

// ─── F1-4 — zero-argument OSC frames ─────────────────────────────────────

test('a zero-argument OSC frame becomes a T bang for a bool-typed param and is dropped otherwise', () => {
  const seen = []
  const events = {
    ...noopEvents(),
    onValue: (path, value, metadata) => seen.push({ path, value, metadata })
  }
  const client = new OscQueryClient('127.0.0.1', 1, events)
  client.nodeTypes = new Map([
    ['/toggle', 'T'],
    ['/toggleOff', 'F'],
    ['/level', 'f']
  ])

  client._processOscPacket({ address: '/toggle', args: [] })
  client._processOscPacket({ address: '/toggleOff', args: [] })
  client._processOscPacket({ address: '/level', args: [] })
  client._processOscPacket({ address: '/unknown', args: [] })

  assert.deepEqual(seen.map((entry) => entry.path), ['/toggle', '/toggleOff'])
  for (const entry of seen) {
    assert.equal(entry.value, true, 'EMPTY-frame bool means TRUE (bang), never []')
    assert.equal(entry.metadata.oscQueryType, 'T')
    assert.deepEqual(entry.metadata.wireArgs, [{ type: 'T' }])
  }
})

// ─── F0-15 — reconnect backoff ───────────────────────────────────────────

test('post-everConnected reconnect delay backs off 500ms → 5s cap with bounded jitter', () => {
  const client = new OscQueryClient('127.0.0.1', 1, noopEvents(), {
    reconnectDelayMs: 3000,
    disconnectReconnectDelayMs: 500,
    reconnectBackoffMaxMs: 5000,
    random: () => 0
  })

  assert.equal(client._nextReconnectDelay(), 3000, 'never-connected keeps the slow initial retry')

  client.everConnected = true
  const progression = [1, 2, 3, 4, 5, 6, 20].map((n) => client._reconnectDelayForFailureCount(n))
  assert.deepEqual(progression, [500, 1000, 2000, 4000, 5000, 5000, 5000])

  const jittery = new OscQueryClient('127.0.0.1', 1, noopEvents(), {
    disconnectReconnectDelayMs: 500,
    reconnectBackoffMaxMs: 5000,
    random: () => 1
  })
  jittery.everConnected = true
  assert.equal(jittery._reconnectDelayForFailureCount(1), 600, '20% jitter on top of the base')
  assert.equal(jittery._reconnectDelayForFailureCount(9), 5000, 'jitter never exceeds the cap')
})

// ─── F1-7 — HOST_INFO cache lifetime ─────────────────────────────────────

test('disconnect clears the cached HOST_INFO so a restarted device cannot inherit a stale OSC port', () => {
  const client = new OscQueryClient('127.0.0.1', 1, noopEvents())
  client.hostInfo = { NAME: 'X', OSC_PORT: 40001 }
  client.disconnect()
  assert.equal(client.hostInfo, null)
})

// ─── F0-13 — namespace caps ──────────────────────────────────────────────

test('namespace tree walking enforces depth and node-count caps', () => {
  const client = new OscQueryClient('127.0.0.1', 1, noopEvents())

  let deep = { FULL_PATH: '/x', TYPE: 'f' }
  for (let i = 0; i <= MAX_NAMESPACE_DEPTH + 1; i++) {
    deep = { CONTENTS: { child: deep } }
  }
  assert.throws(() => client._collectNodes(deep, []), /max depth/)

  const wide = { CONTENTS: {} }
  for (let i = 0; i <= MAX_NAMESPACE_NODES; i++) {
    wide.CONTENTS[`p${i}`] = { FULL_PATH: `/p${i}`, TYPE: 'f' }
  }
  assert.throws(() => client._collectNodes(wide, []), /max node count/)

  const sane = {
    CONTENTS: {
      a: { FULL_PATH: '/a', TYPE: 'f' },
      group: { CONTENTS: { b: { FULL_PATH: '/group/b', TYPE: 'i' } } }
    }
  }
  const out = []
  client._collectNodes(sane, out)
  assert.deepEqual(out.map((node) => node.FULL_PATH), ['/a', '/group/b'])
})

test('a namespace JSON over the byte cap fails the connect attempt instead of being buffered', async (t) => {
  // ~3 MB of JSON — over the 2 MB cap.
  const huge = JSON.stringify({
    FULL_PATH: '/',
    CONTENTS: { pad: { FULL_PATH: '/pad', TYPE: 's', VALUE: ['x'.repeat(3 * 1024 * 1024)] } }
  })
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.includes('HOST_INFO')) {
      res.end(JSON.stringify({ NAME: 'Huge', OSC_PORT: 19001, OSC_TRANSPORT: 'UDP' }))
      return
    }
    res.end(huge)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const failures = []
  const client = new OscQueryClient('127.0.0.1', server.address().port, {
    ...noopEvents(),
    onAttemptFailed: (reason) => failures.push(reason)
  }, { attemptTimeoutMs: 5000 })

  t.after(async () => {
    client.disconnect()
    await new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections?.()
    })
  })

  await client.connect()
  const deadline = Date.now() + 5000
  while (failures.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(failures.length > 0, true, 'attempt must fail')
  assert.match(failures[0], /too large/)
})
