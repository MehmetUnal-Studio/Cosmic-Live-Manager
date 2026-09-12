// Discovery interface watcher (multicast membership repair + per-interface
// mDNS queries).
//
// Real incident (2026-09-12): the show Mac runs two networks — Wi-Fi en0 for
// the internet and USB Ethernet en7 for the stage LAN. After the en7 cable
// was pulled and plugged back in, the hub saw no _oscjson._tcp announcement
// from the stage network again, even after REDISCOVER, while `dns-sd -B` on
// the same machine listed every device via en7. Two library behaviours
// combine into that blind spot: multicast-dns keys its 224.0.0.251
// memberships by IP address and never rejoins an interface whose membership
// the kernel dropped (same address ⇒ cache hit ⇒ no IP_ADD_MEMBERSHIP), and
// on macOS it pins the outgoing multicast interface to en0, so the hub's PTR
// queries never reach the stage LAN at all — discovery there depended on
// other machines asking. The watcher owns the shared mDNS socket, repairs
// memberships from a fresh os.networkInterfaces() snapshot and asks for
// services on every interface it is actually a member of.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MDNS_GROUP,
  OSCJSON_SERVICE,
  createInterfaceWatcher,
  defaultOutboundAddress,
  diffInterfaces,
  listIPv4Interfaces
} from '../server/discoveryInterfaces.js'

const EN0 = { name: 'en0', address: '192.168.68.75' }
const EN7 = { name: 'en7', address: '192.168.0.229' }
const UTUN = { name: 'utun4', address: '100.106.168.8' }

function errorWithCode(code) {
  const error = new Error(code)
  error.code = code
  return error
}

// Mirrors the kernel contract the watcher relies on: joining a group the
// socket is already a member of fails with EADDRINUSE, dropping a membership
// that does not exist fails with EADDRNOTAVAIL.
function fakeSocket({ joined = new Set(), joinFailures = {} } = {}) {
  const calls = []
  return {
    calls,
    joined,
    addMembership(group, address) {
      calls.push(['add', group, address])
      if (joinFailures[address]) throw errorWithCode(joinFailures[address])
      if (joined.has(address)) throw errorWithCode('EADDRINUSE')
      joined.add(address)
    },
    dropMembership(group, address) {
      calls.push(['drop', group, address])
      if (!joined.has(address)) throw errorWithCode('EADDRNOTAVAIL')
      joined.delete(address)
    },
    setMulticastInterface(address) {
      calls.push(['if', address])
    }
  }
}

function fakeMdns() {
  const queries = []
  return {
    queries,
    query(name, type, callback) {
      queries.push([name, type])
      setImmediate(() => callback(null))
    }
  }
}

function watcherFixture({ interfaces = [EN0, EN7], socket = fakeSocket(), mdns = fakeMdns() } = {}) {
  const logs = []
  const current = { list: interfaces }
  const watcher = createInterfaceWatcher({
    socket,
    mdns,
    listInterfaces: () => current.list,
    log: (line) => logs.push(line)
  })
  return { watcher, socket, mdns, logs, current }
}

test('listIPv4Interfaces keeps external IPv4 addresses only, in interface order', () => {
  const list = listIPv4Interfaces({
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: EN0.address, family: 'IPv4', internal: false }
    ],
    en7: [{ address: EN7.address, family: 4, internal: false }],
    awdl0: [{ address: 'fe80::2', family: 'IPv6', internal: false }]
  })
  assert.deepEqual(list, [EN0, EN7])
})

test('listIPv4Interfaces tolerates an empty or undefined interface table', () => {
  assert.deepEqual(listIPv4Interfaces({}), [])
  assert.deepEqual(listIPv4Interfaces(null), [])
  assert.deepEqual(listIPv4Interfaces({ en0: undefined }), [])
})

test('diffInterfaces reports an interface that appeared', () => {
  const diff = diffInterfaces([EN0], [EN0, EN7])
  assert.deepEqual(diff.added, [EN7])
  assert.deepEqual(diff.removed, [])
})

test('diffInterfaces reports an interface that vanished', () => {
  const diff = diffInterfaces([EN0, EN7], [EN0])
  assert.deepEqual(diff.added, [])
  assert.deepEqual(diff.removed, [EN7])
})

test('diffInterfaces treats a renumbered interface as removed + added', () => {
  const moved = { name: 'en7', address: '192.168.0.230' }
  const diff = diffInterfaces([EN0, EN7], [EN0, moved])
  assert.deepEqual(diff.added, [moved])
  assert.deepEqual(diff.removed, [EN7])
})

test('diffInterfaces with no previous snapshot reports nothing as added', () => {
  const diff = diffInterfaces(null, [EN0, EN7])
  assert.deepEqual(diff.added, [])
  assert.deepEqual(diff.removed, [])
})

test('defaultOutboundAddress hands routing back to the kernel, loopback when no external interface exists', () => {
  assert.equal(defaultOutboundAddress([EN7, EN0]), '0.0.0.0')
  assert.equal(defaultOutboundAddress([EN0]), '0.0.0.0')
  assert.equal(defaultOutboundAddress([]), '127.0.0.1')
})

test('startup sync joins the multicast group on every interface and logs the list once', () => {
  const { watcher, socket, logs } = watcherFixture()
  const result = watcher.sync('startup')

  assert.deepEqual(result.interfaces, [EN0, EN7])
  assert.deepEqual(socket.calls, [
    ['add', MDNS_GROUP, EN0.address],
    ['add', MDNS_GROUP, EN7.address]
  ])
  assert.deepEqual(result.joined, [EN0, EN7])
  assert.deepEqual(result.added, [])
  assert.deepEqual(result.restored, [])
  assert.deepEqual(logs, ['[discovery] interfaces: en0 192.168.68.75, en7 192.168.0.229'])
})

test('a sync with nothing changed is silent and joins nothing', () => {
  const { watcher, socket, logs } = watcherFixture({
    socket: fakeSocket({ joined: new Set([EN0.address, EN7.address]) })
  })
  watcher.sync('startup')
  logs.length = 0
  socket.calls.length = 0

  const result = watcher.sync('poll')

  assert.deepEqual(result.added, [])
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.restored, [])
  assert.deepEqual(result.joined, [])
  assert.deepEqual(logs, [])
  // The membership is re-asserted every tick (EADDRINUSE = still a member).
  assert.deepEqual(socket.calls, [
    ['add', MDNS_GROUP, EN0.address],
    ['add', MDNS_GROUP, EN7.address]
  ])
})

test('an interface that appears later is joined and announced in the log', () => {
  const { watcher, socket, logs, current } = watcherFixture({ interfaces: [EN0] })
  watcher.sync('startup')
  logs.length = 0
  socket.calls.length = 0

  current.list = [EN0, EN7]
  const result = watcher.sync('poll')

  assert.deepEqual(result.added, [EN7])
  assert.deepEqual(result.joined, [EN7])
  assert.deepEqual(result.restored, [])
  assert.ok(socket.calls.some(([op, group, address]) =>
    op === 'add' && group === MDNS_GROUP && address === EN7.address
  ))
  assert.deepEqual(logs, ['[discovery] interface added en7 192.168.0.229 — rejoining multicast'])
})

test('a membership the kernel dropped silently is restored even though the interface list did not change', () => {
  const socket = fakeSocket()
  const { watcher, logs } = watcherFixture({ socket })
  watcher.sync('startup')
  logs.length = 0

  // Same name, same address — only the kernel-side membership is gone
  // (what a USB adapter detach/re-attach does to the socket).
  socket.joined.delete(EN7.address)
  const result = watcher.sync('poll')

  assert.deepEqual(result.added, [])
  assert.deepEqual(result.restored, [EN7])
  assert.deepEqual(result.joined, [EN7])
  assert.ok(socket.joined.has(EN7.address))
  assert.deepEqual(logs, ['[discovery] interface en7 192.168.0.229 lost its multicast membership — rejoining'])
})

test('an interface that vanished is dropped from the membership set and logged', () => {
  const socket = fakeSocket()
  const { watcher, logs, current } = watcherFixture({ socket })
  watcher.sync('startup')
  logs.length = 0
  socket.calls.length = 0

  current.list = [EN0]
  const result = watcher.sync('poll')

  assert.deepEqual(result.removed, [EN7])
  assert.deepEqual(result.joined, [])
  assert.ok(socket.calls.some(([op, , address]) => op === 'drop' && address === EN7.address))
  assert.deepEqual(logs, ['[discovery] interface removed en7 192.168.0.229'])
  assert.deepEqual(watcher.interfaces(), [EN0])
})

test('dropping a membership the kernel already purged is not an error', () => {
  const socket = fakeSocket()
  const { watcher, current } = watcherFixture({ socket })
  watcher.sync('startup')
  socket.joined.delete(EN7.address)

  current.list = [EN0]
  assert.doesNotThrow(() => watcher.sync('poll'))
})

test('a join failure other than EADDRINUSE is logged once and the interface is skipped', () => {
  const socket = fakeSocket({ joinFailures: { [UTUN.address]: 'EADDRNOTAVAIL' } })
  const { watcher, logs } = watcherFixture({ socket, interfaces: [EN0, UTUN] })
  const first = watcher.sync('startup')

  assert.deepEqual(first.joined, [EN0])
  assert.deepEqual(first.failed, [UTUN])
  assert.deepEqual(logs, [
    '[discovery] interfaces: en0 192.168.68.75, utun4 100.106.168.8',
    '[discovery] interface utun4 100.106.168.8: multicast join failed (EADDRNOTAVAIL) — skipped'
  ])

  logs.length = 0
  const second = watcher.sync('poll')
  assert.deepEqual(second.failed, [UTUN])
  assert.deepEqual(logs, [], 'a persistent join failure must not spam the log every tick')
})

test('rediscover logs the fresh interface list even when nothing changed', () => {
  const { watcher, logs, current } = watcherFixture({ interfaces: [EN0] })
  watcher.sync('startup')
  logs.length = 0

  current.list = [EN0, EN7]
  const result = watcher.sync('rediscover')

  assert.deepEqual(result.added, [EN7])
  assert.deepEqual(logs, [
    '[discovery] interface added en7 192.168.0.229 — rejoining multicast',
    '[discovery] interfaces: en0 192.168.68.75, en7 192.168.0.229'
  ])
})

test('queryAll asks for the service on every joined interface and restores the default outbound interface', async () => {
  const { watcher, socket, mdns } = watcherFixture()
  watcher.sync('startup')
  socket.calls.length = 0

  const queried = await watcher.queryAll()

  assert.deepEqual(queried, [EN0.address, EN7.address])
  assert.deepEqual(mdns.queries, [
    [OSCJSON_SERVICE, 'PTR'],
    [OSCJSON_SERVICE, 'PTR']
  ])
  assert.deepEqual(socket.calls, [
    ['if', EN0.address],
    ['if', EN7.address],
    ['if', '0.0.0.0'] // back to kernel routing for bonjour-service's own sends
  ])
})

test('queryAll waits for each query to be sent before steering the next interface', async () => {
  const { watcher, socket } = watcherFixture()
  watcher.sync('startup')
  socket.calls.length = 0
  const order = []
  watcher.mdns.query = (name, type, callback) => {
    order.push(`query@${socket.calls.at(-1)[1]}`)
    setImmediate(() => {
      order.push('sent')
      callback(null)
    })
  }

  await watcher.queryAll()

  assert.deepEqual(order, [`query@${EN0.address}`, 'sent', `query@${EN7.address}`, 'sent'])
})

test('queryAll skips interfaces whose membership failed and ones the socket cannot steer to', async () => {
  const socket = fakeSocket({ joinFailures: { [UTUN.address]: 'EADDRNOTAVAIL' } })
  socket.setMulticastInterface = (address) => {
    socket.calls.push(['if', address])
    if (address === EN7.address) throw errorWithCode('EADDRNOTAVAIL')
  }
  const { watcher, mdns } = watcherFixture({ socket, interfaces: [EN0, EN7, UTUN] })
  watcher.sync('startup')

  const queried = await watcher.queryAll()

  assert.deepEqual(queried, [EN0.address])
  assert.equal(mdns.queries.length, 1)
})

test('queryAll on a machine without an external interface sends nothing and does not throw', async () => {
  const { watcher, mdns } = watcherFixture({ interfaces: [] })
  watcher.sync('startup')

  const queried = await watcher.queryAll()

  assert.deepEqual(queried, [])
  assert.deepEqual(mdns.queries, [])
  assert.deepEqual(watcher.socket.calls.filter(([op]) => op === 'if'), [], 'nothing to steer, nothing to restore')
})
