// Discovery interface watcher: multicast membership repair + per-interface
// mDNS queries for the Bonjour browser.
//
// Real incident (2026-09-12): the show Mac runs two networks — Wi-Fi en0 for
// the internet (EMU) and USB Ethernet en7 for the stage LAN (Cosmic Stage).
// After the en7 cable was pulled and plugged back in, the hub never saw a
// stage _oscjson._tcp announcement again, REDISCOVER included, while
// `dns-sd -B` on the same machine listed every device via en7. Two
// multicast-dns behaviours add up to that blind spot:
//
//   1. It keys its 224.0.0.251 memberships by IP address. When the kernel
//      drops a membership (a detached/re-attached adapter) and the interface
//      comes back with the same address, the cache says "joined" and
//      IP_ADD_MEMBERSHIP is never issued again — the socket stays deaf on
//      that interface. Rebuilding the bonjour-service Browser (what
//      REDISCOVER did) only swaps a packet listener on the same socket.
//   2. Its outgoing multicast interface is fixed once (en0 / kernel default
//      on macOS), so the hub's PTR queries never reach the stage LAN. Stage
//      devices were only ever seen when some other machine happened to ask.
//
// The hub therefore owns the dgram socket it hands to bonjour-service and this
// watcher keeps the memberships honest from a fresh os.networkInterfaces()
// snapshot (every tick, on REDISCOVER and after connection failures) and asks
// for the service on every interface it is actually a member of. Joining a
// group the socket already belongs to fails with EADDRINUSE — that is the
// "still a member" signal; a successful join means the membership was gone.

import os from 'node:os'

export const MDNS_GROUP = '224.0.0.251'
export const OSCJSON_SERVICE = '_oscjson._tcp.local'

/**
 * External IPv4 interfaces as `{ name, address }`, in the OS's own order.
 * Loopback is excluded on purpose: nothing on the stage announces there and
 * multicast-dns already joins it at startup.
 */
export function listIPv4Interfaces(networkInterfaces = os.networkInterfaces()) {
  const out = []
  for (const [name, list] of Object.entries(networkInterfaces || {})) {
    for (const iface of list || []) {
      if (!iface || iface.internal) continue
      if (iface.family !== 'IPv4' && iface.family !== 4) continue
      out.push({ name, address: iface.address })
    }
  }
  return out
}

function keyOf(iface) {
  return `${iface.name}|${iface.address}`
}

function label(iface) {
  return `${iface.name} ${iface.address}`
}

/**
 * Interfaces that appeared / vanished between two snapshots. A renumbered
 * interface is a removal plus an addition. With no previous snapshot nothing
 * counts as added — startup is not an interface change.
 */
export function diffInterfaces(previous, current) {
  if (!previous) return { added: [], removed: [] }
  const previousKeys = new Set(previous.map(keyOf))
  const currentKeys = new Set(current.map(keyOf))
  return {
    added: current.filter((iface) => !previousKeys.has(keyOf(iface))),
    removed: previous.filter((iface) => !currentKeys.has(keyOf(iface)))
  }
}

/**
 * Where bonjour-service's own sends (browser refresh queries, publish
 * responses) go once a per-interface sweep is over: back to kernel routing,
 * loopback when the machine has no external interface at all.
 */
export function defaultOutboundAddress(interfaces) {
  return interfaces.length > 0 ? '0.0.0.0' : '127.0.0.1'
}

/**
 * @param {{
 *   socket: import('node:dgram').Socket,
 *   mdns: { query: Function },
 *   serviceName?: string,
 *   group?: string,
 *   listInterfaces?: () => Array<{ name: string, address: string }>,
 *   log?: (line: string) => void
 * }} options
 */
export function createInterfaceWatcher({
  socket,
  mdns,
  serviceName = OSCJSON_SERVICE,
  group = MDNS_GROUP,
  listInterfaces = listIPv4Interfaces,
  log = console.log
} = {}) {
  let previous = null
  let current = []
  /** addresses whose group membership this socket holds */
  const members = new Set()
  /** interface keys whose join failure has already been reported */
  const failureReported = new Set()

  function snapshot() {
    try {
      return listInterfaces()
    } catch (err) {
      log(`[discovery] cannot enumerate interfaces: ${err.message}`)
      return current
    }
  }

  function joinOutcome(iface) {
    try {
      socket.addMembership(group, iface.address)
      return 'joined'
    } catch (err) {
      if (err?.code === 'EADDRINUSE') return 'present'
      return err?.code || err?.message || 'error'
    }
  }

  /**
   * Re-read the interface table, repair memberships, report what changed.
   * `reason` is 'startup' | 'poll' | 'rediscover' | 'connect-failure'.
   */
  function sync(reason = 'poll') {
    const next = snapshot()
    const { added, removed } = diffInterfaces(previous, next)
    const addedKeys = new Set(added.map(keyOf))
    const joined = []
    const restored = []
    const failed = []
    const changes = []
    const failures = []

    for (const iface of removed) {
      members.delete(iface.address)
      failureReported.delete(keyOf(iface))
      // The address is usually gone with the interface (EADDRNOTAVAIL); when
      // the kernel still holds the membership this releases it so a later
      // re-add on the same address starts clean.
      try { socket.dropMembership(group, iface.address) } catch {}
      changes.push(`[discovery] interface removed ${label(iface)}`)
    }

    for (const iface of next) {
      const outcome = joinOutcome(iface)
      if (outcome === 'joined' || outcome === 'present') {
        members.add(iface.address)
        failureReported.delete(keyOf(iface))
        if (outcome !== 'joined') continue
        joined.push(iface)
        if (previous === null) continue
        if (addedKeys.has(keyOf(iface))) {
          changes.push(`[discovery] interface added ${label(iface)} — rejoining multicast`)
        } else {
          restored.push(iface)
          changes.push(`[discovery] interface ${label(iface)} lost its multicast membership — rejoining`)
        }
        continue
      }
      members.delete(iface.address)
      failed.push(iface)
      if (!failureReported.has(keyOf(iface))) {
        failureReported.add(keyOf(iface))
        failures.push(`[discovery] interface ${label(iface)}: multicast join failed (${outcome}) — skipped`)
      }
    }

    for (const line of changes) log(line)
    if (previous === null || reason === 'rediscover') {
      log(`[discovery] interfaces: ${next.length > 0 ? next.map(label).join(', ') : 'none'}`)
    }
    for (const line of failures) log(line)

    previous = next
    current = next
    return { interfaces: next, added, removed, restored, joined, failed }
  }

  /**
   * Send one PTR query for the service on every interface the socket is a
   * member of, one at a time (IP_MULTICAST_IF is socket-wide, so the next
   * interface is steered only after the previous datagram left), then hand
   * the outgoing interface back to kernel routing.
   * @returns {Promise<string[]>} addresses that were queried
   */
  async function queryAll() {
    const queried = []
    for (const iface of current) {
      if (!members.has(iface.address)) continue
      try {
        socket.setMulticastInterface(iface.address)
      } catch (err) {
        log(`[discovery] cannot steer multicast to ${label(iface)}: ${err.message}`)
        continue
      }
      await new Promise((resolve) => {
        mdns.query(serviceName, 'PTR', (err) => {
          if (err) log(`[discovery] query on ${label(iface)} failed: ${err.message}`)
          resolve()
        })
      })
      queried.push(iface.address)
    }
    if (queried.length > 0) {
      try { socket.setMulticastInterface(defaultOutboundAddress(current)) } catch {}
    }
    return queried
  }

  return {
    socket,
    mdns,
    sync,
    queryAll,
    interfaces: () => current
  }
}
