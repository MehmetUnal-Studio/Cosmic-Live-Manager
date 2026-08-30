// Unit tests for the auto-link engine (server/autoLink.js), driven entirely
// with fakes and fake timers:
//   - a resolved link announces once; an unchanged signature stays quiet
//   - endpoint / override changes and a VST reconnect (nonce) re-announce
//   - recordApplied suppresses the duplicate announce after a WS ANNOUNCE
//   - a failed announce walks the bounded retry ladder, then waits for a poke
//   - unresolvable/offline targets park as pending with no retry spam
//   - ineligible sources are skipped and their pending retries cancelled
//   - poke debounces to one evaluation; close leaves no timer running

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computeLinkSignature,
  createAutoLinkEngine,
  resolveLinkTargetRecord,
  sanitizePeerId
} from '../server/autoLink.js'

// Flush the attemptAnnounce promise chain (then/catch/finally microtasks).
function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

function makeFixture({ retryDelaysMs } = {}) {
  const announces = []
  const statuses = []
  const logs = []
  const timers = []
  const dev = {
    id: 1,
    name: 'CosmicVst',
    enabled: true,
    connectionState: 'Connected',
    oscPort: 41234,
    link: { targetFqdn: '', targetName: 'Tablet', peerId: '', udpPortOverride: 0 }
  }
  const record = {
    name: 'Tablet',
    serviceName: 'Tablet',
    discoveryState: 'Discovered',
    activeEndpoint: { host: '10.0.0.20', port: 9010, fqdn: 'tablet._oscjson._tcp.local' },
    endpoints: [{ host: '10.0.0.20', port: 9010, fqdn: 'tablet._oscjson._tcp.local' }]
  }
  const world = { snapshot: [record], devices: new Map([[1, dev]]) }
  let announceImpl = () => Promise.resolve({
    announcement: { peerName: 'tablet', receiverName: 'CosmicVst' }
  })
  const engine = createAutoLinkEngine({
    resolveAndAnnounce: (args) => {
      announces.push(args)
      return announceImpl(args)
    },
    getDevicesWithLinks: () =>
      Array.from(world.devices.values()).filter((item) => item.link),
    getRegistrySnapshot: () => world.snapshot,
    getManagedDevice: (id) => world.devices.get(Number(id)) || null,
    onStatus: (deviceId, status) => {
      statuses.push({ deviceId, ...status })
      // Mirror index.js: the runtime status lands on the device object, which
      // is what emitStatus deduplicates against.
      const target = world.devices.get(Number(deviceId))
      if (target) target.autoLink = status
    },
    log: (line) => logs.push(line),
    setTimeoutFn: (fn, delayMs) => {
      const timer = { fn, delayMs, cleared: false, fired: false }
      timers.push(timer)
      return timer
    },
    clearTimeoutFn: (timer) => {
      if (timer) timer.cleared = true
    },
    ...(retryDelaysMs ? { retryDelaysMs } : {})
  })
  const pendingTimers = () => timers.filter((timer) => !timer.cleared && !timer.fired)
  const fire = (timer) => {
    timer.fired = true
    timer.fn()
  }
  return {
    engine,
    dev,
    record,
    world,
    announces,
    statuses,
    logs,
    timers,
    pendingTimers,
    fire,
    setAnnounce: (fn) => { announceImpl = fn }
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────

test('computeLinkSignature covers every re-announce trigger component', () => {
  const base = {
    nonce: 2,
    targetAddress: '10.0.0.5',
    targetPort: 9010,
    targetOscPort: 4000,
    peerId: 'tab',
    udpPortOverride: 0
  }
  assert.equal(computeLinkSignature(base), '2|10.0.0.5:9010:4000|tab|0')
  assert.equal(
    computeLinkSignature({ ...base, targetOscPort: '' }),
    '2|10.0.0.5:9010:|tab|0'
  )
  const variants = [
    { ...base, nonce: 3 },
    { ...base, targetAddress: '10.0.0.6' },
    { ...base, targetPort: 9011 },
    { ...base, targetOscPort: 4001 },
    { ...base, peerId: 'other' },
    { ...base, udpPortOverride: 9005 }
  ]
  for (const variant of variants) {
    assert.notEqual(computeLinkSignature(variant), computeLinkSignature(base))
  }
})

test('sanitizePeerId lowercases and collapses runs of illegal characters', () => {
  assert.equal(sanitizePeerId('My Tablet #2'), 'my_tablet_2')
  assert.equal(sanitizePeerId('  UPPER-case_ok  '), 'upper-case_ok')
  assert.equal(sanitizePeerId(''), '')
  assert.equal(sanitizePeerId(undefined), '')
})

test('resolveLinkTargetRecord prefers the Bonjour fqdn and only then matches by name', () => {
  const byName = {
    name: 'Tablet',
    serviceName: 'Tablet',
    endpoints: [{ fqdn: 'other._oscjson._tcp.local' }]
  }
  const byFqdn = {
    name: 'Other',
    activeEndpoint: { fqdn: 'Tablet._oscjson._tcp.local' },
    endpoints: []
  }
  const records = [byName, byFqdn]

  assert.equal(
    resolveLinkTargetRecord(records, {
      targetFqdn: 'tablet._oscjson._tcp.local',
      targetName: 'Tablet'
    }),
    byFqdn,
    'an exact fqdn match beats an earlier name match'
  )
  assert.equal(
    resolveLinkTargetRecord(records, {
      targetFqdn: 'missing._oscjson._tcp.local',
      targetName: 'tablet'
    }),
    byName,
    'an unmatched fqdn falls back to the name'
  )
  assert.equal(resolveLinkTargetRecord(records, { targetName: 'nobody' }), null)
  assert.equal(resolveLinkTargetRecord(records, {}), null)
  assert.equal(resolveLinkTargetRecord(null, { targetName: 'tablet' }), null)
})

// ─── Engine state machine ─────────────────────────────────────────────────

test('a resolved link announces once and an unchanged signature stays quiet', async () => {
  const fx = makeFixture()

  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 1)
  const call = fx.announces[0]
  assert.equal(call.dev, fx.dev)
  assert.equal(call.target.address, '10.0.0.20')
  assert.equal(call.target.port, 9010)
  assert.equal(call.peerId, '', 'empty link.peerId passes through — resolveLinkAnnouncement owns the direction-aware name fallback')
  assert.equal(call.udpPortOverride, 0)
  assert.equal(fx.statuses.length, 1)
  assert.equal(fx.statuses[0].state, 'ok')
  assert.equal(fx.statuses[0].summary, 'tablet → CosmicVst')
  assert.equal(typeof fx.statuses[0].at, 'number')

  fx.engine.evaluateNow()
  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 1, 'an unchanged signature must not re-announce')
  assert.equal(fx.statuses.length, 1, 'the deduped ok status must not be re-emitted')
})

test('endpoint and udpPortOverride changes re-announce with the new coordinates', async () => {
  const fx = makeFixture()
  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 1)

  fx.record.activeEndpoint = { host: '10.0.0.21', port: 9010, fqdn: '' }
  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 2, 'a moved target endpoint must re-announce')
  assert.equal(fx.announces[1].target.address, '10.0.0.21')

  fx.dev.link.udpPortOverride = 9005
  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 3, 'a changed override must re-announce')
  assert.equal(fx.announces[2].udpPortOverride, 9005)
})

test('noteDeviceConnected invalidates the applied signature so a restarted VST is re-announced', async () => {
  const fx = makeFixture()
  fx.engine.evaluateNow()
  await settle()
  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 1)

  const timersBefore = fx.timers.length
  fx.engine.noteDeviceConnected(1)
  assert.equal(fx.timers.length, timersBefore + 1, 'a reconnect must schedule the debounced pass')
  assert.equal(fx.timers[fx.timers.length - 1].delayMs, 1000)

  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 2, 'the same coordinates must be re-applied to a restarted VST')
})

test('recordApplied suppresses the duplicate engine announce after a WS ANNOUNCE', async () => {
  const fx = makeFixture()
  // Mirror the WS path exactly: it persists link.peerId and records the SAME
  // value (no name fallback on either side), so signatures stay byte-equal.
  fx.dev.link.peerId = 'tablet'
  fx.engine.recordApplied(1, {
    targetAddress: '10.0.0.20',
    targetPort: 9010,
    targetOscPort: '',
    peerId: 'tablet',
    udpPortOverride: 0,
    summary: 'tablet → CosmicVst'
  })
  assert.equal(fx.statuses.length, 1)
  assert.equal(fx.statuses[0].state, 'ok')

  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 0, 'the WS path already applied these exact coordinates')

  // The recorded signature is still nonce-scoped: a reconnect re-announces.
  fx.engine.noteDeviceConnected(1)
  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 1)
})

test('a failed announce walks the bounded retry ladder and then waits for the next poke', async () => {
  const fx = makeFixture()
  fx.setAnnounce(() => Promise.reject(new Error('udp exploded')))

  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 1)
  assert.equal(fx.statuses.at(-1).state, 'failed')
  assert.equal(fx.statuses.at(-1).error, 'udp exploded')

  // Bounded ladder: 2s → 5s → 15s, one timer at a time.
  for (const expectedDelay of [2000, 5000, 15000]) {
    const pending = fx.pendingTimers()
    assert.equal(pending.length, 1, 'exactly one retry timer may be pending')
    assert.equal(pending[0].delayMs, expectedDelay)
    fx.fire(pending[0])
    await settle()
  }
  assert.equal(fx.announces.length, 4)
  assert.equal(fx.pendingTimers().length, 0, 'exhausted retries must not leave a timer')
  assert.equal(
    fx.logs.some((line) => line.includes('retries exhausted')),
    true
  )

  // Repeated identical failures must not spam the status channel.
  assert.equal(fx.statuses.filter((status) => status.state === 'failed').length, 1)

  // A fresh poke restarts the ladder from the first rung.
  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 5)
  const restarted = fx.pendingTimers()
  assert.equal(restarted.length, 1)
  assert.equal(restarted[0].delayMs, 2000)

  // Recovery on a retry: success stores the signature and clears the ladder.
  fx.setAnnounce(() => Promise.resolve({
    announcement: { peerName: 'tablet', receiverName: 'CosmicVst' }
  }))
  fx.fire(restarted[0])
  await settle()
  assert.equal(fx.announces.length, 6)
  assert.equal(fx.statuses.at(-1).state, 'ok')
  assert.equal(fx.pendingTimers().length, 0)

  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 6, 'the recovered signature must be remembered')
})

test('an unresolvable or offline target parks as pending without announces or retries', async () => {
  const fx = makeFixture()

  fx.world.snapshot = []
  fx.engine.evaluateNow()
  fx.engine.evaluateNow()
  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 0)
  assert.equal(fx.pendingTimers().length, 0, 'an absent target must not schedule retries')
  assert.equal(fx.statuses.length, 1, 'one pending status, no spam')
  assert.equal(fx.statuses[0].state, 'pending')
  assert.equal(fx.statuses[0].summary, 'Waiting for Tablet')

  // A record that is neither Discovered nor Connected is equally offline.
  fx.world.snapshot = [{ ...fx.record, discoveryState: 'Stale', connectionState: 'Unavailable' }]
  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 0)
  assert.equal(fx.statuses.length, 1, 'still the same deduped pending status')

  // The next poke after the target comes online applies the link.
  fx.world.snapshot = [fx.record]
  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 1)
  assert.equal(fx.statuses.at(-1).state, 'ok')
})

test('an ineligible source is skipped and its pending retry is cancelled', async () => {
  const fx = makeFixture()
  fx.setAnnounce(() => Promise.reject(new Error('boom')))
  fx.engine.evaluateNow()
  await settle()
  const retry = fx.pendingTimers()[0]
  assert.ok(retry, 'the failure must have scheduled a retry')

  fx.dev.connectionState = 'Unavailable'
  fx.engine.evaluateNow()
  await settle()
  assert.equal(retry.cleared, true, 'a disconnected source must not keep a retry pending')
  assert.equal(fx.announces.length, 1)

  // Announce-unready variants are skipped the same way.
  fx.dev.connectionState = 'Connected'
  fx.dev.oscPort = null
  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 1)

  fx.dev.oscPort = 41234
  fx.dev.enabled = false
  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.announces.length, 1)
})

test('poke debounces to a single evaluation pass and close leaves no timer running', async () => {
  const fx = makeFixture()

  fx.engine.poke('a')
  fx.engine.poke('b')
  fx.engine.poke('c')
  const debounces = fx.pendingTimers()
  assert.equal(debounces.length, 1, 'coalesced pokes must share one debounce timer')
  assert.equal(debounces[0].delayMs, 1000)

  fx.fire(debounces[0])
  await settle()
  assert.equal(fx.announces.length, 1, 'the debounced pass must evaluate')

  // Leave a retry and a fresh debounce pending, then close.
  fx.setAnnounce(() => Promise.reject(new Error('boom')))
  fx.record.activeEndpoint = { host: '10.0.0.22', port: 9010, fqdn: '' }
  fx.engine.evaluateNow()
  await settle()
  fx.engine.poke('after-failure')
  assert.ok(fx.pendingTimers().length >= 1)

  fx.engine.close()
  assert.equal(fx.pendingTimers().length, 0, 'close must clear every pending timer')

  fx.engine.poke('post-close')
  fx.engine.noteDeviceConnected(1)
  fx.engine.evaluateNow()
  await settle()
  assert.equal(fx.pendingTimers().length, 0, 'a closed engine must not schedule again')
  assert.equal(fx.announces.length, 2, 'a closed engine must not evaluate again')
})

test('a target restart invalidates the applied signature of sources linked to it', async () => {
  const fx = makeFixture()
  // The link target is itself a managed device (external-card shape): the
  // peer bootstrap was written INTO it, so its restart wipes that state
  // even though host/ports — the signature components — stay identical.
  fx.record.manifestId = 2
  fx.world.devices.set(2, {
    id: 2,
    name: 'Tablet',
    enabled: true,
    connectionState: 'Connected',
    oscPort: 42000
  })

  fx.engine.evaluateNow('manifests-loaded')
  await settle()
  assert.equal(fx.announces.length, 1, 'initial pass announces the saved link')

  fx.engine.evaluateNow('poke')
  await settle()
  assert.equal(fx.announces.length, 1, 'unchanged signature stays quiet')

  fx.engine.noteDeviceConnected(2)
  fx.engine.evaluateNow('device-connected')
  await settle()
  assert.equal(fx.announces.length, 2, 'target restart must re-announce the source link')

  // An unrelated device reconnecting must NOT invalidate the pairing.
  fx.engine.noteDeviceConnected(99)
  fx.engine.evaluateNow('device-connected')
  await settle()
  assert.equal(fx.announces.length, 2, 'unrelated reconnects leave the applied signature intact')
})
