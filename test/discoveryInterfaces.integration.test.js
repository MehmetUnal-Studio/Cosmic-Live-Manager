// Integration regression test for discovery interface tracking.
//
// Real incident (2026-09-12): after the stage LAN's USB Ethernet cable was
// re-plugged, the hub was blind to every _oscjson._tcp service on that
// interface and REDISCOVER did not help — it only swapped the Bonjour
// browser's packet listener and queried on the Wi-Fi interface. The hub now
// keeps its multicast memberships honest from a fresh interface snapshot and
// asks for services on every interface; REDISCOVER runs that path too.
//
// A physical interface add/remove cannot be played from a test, so this
// exercises the observable half against a real hub process: the interface
// list is logged from the live interface table at startup and again on
// REDISCOVER, and rebuilding the browser re-observes a live service without
// creating a second registry record for it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import net from 'node:net'
import os from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { Bonjour } from 'bonjour-service'

import { listIPv4Interfaces } from '../server/discoveryInterfaces.js'

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const LOOPBACK = '127.0.0.1'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function freeTcpPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK, resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function freeUdpPort() {
  const socket = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, LOOPBACK, resolve)
  })
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

async function waitFor(check, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(25)
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`)
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGINT')
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(3000).then(() => false)
  ])
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

test('REDISCOVER refreshes the interface list and rebuilding the browser never duplicates a discovered service', {
  timeout: 40_000
}, async (t) => {
  const interfaces = listIPv4Interfaces()
  if (interfaces.length === 0) {
    t.skip('needs an external IPv4 interface for a non-loopback mDNS announce')
    return
  }

  const serviceName = `IfaceWatch-${process.pid}-${Date.now() % 1_000_000}`
  const fqdn = `${serviceName}._oscjson._tcp.local`
  const servicePort = await freeTcpPort()
  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-iface-watch-'))

  let logs = ''
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      PORT: String(managerPort),
      OSC_LISTEN_PORT: String(managerOscPort),
      ABLETON_FORWARD: '0',
      COSMICNOISE_FORWARD: '0',
      COSMICNOISE_SNAPSHOT_MS: '0',
      HUB_NAME: `Iface Watch Integration ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir,
      DISCOVERY_INTERFACE_WATCH_MS: '250'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-200_000)
  }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)

  const bonjour = new Bonjour()
  let observer
  t.after(async () => {
    observer?.close()
    await new Promise((resolve) => bonjour.unpublishAll(resolve))
    bonjour.destroy()
    await stopChild(child)
    await rm(manifestsDir, { recursive: true, force: true })
  })

  const getDevices = async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) throw new Error(`devices HTTP ${response.status}`)
    const body = await response.json()
    return body.devices
  }
  const recordsFor = (devices) => devices.filter((device) =>
    device.activeEndpoint?.fqdn === fqdn ||
    (device.endpoints || []).some((endpoint) => endpoint.fqdn === fqdn)
  )

  await waitFor(getDevices, 'hub serving /_devices')

  // (b) the interface list the hub joined comes from the live interface table
  await waitFor(() => /\[discovery\] interfaces: /.test(logs), 'startup interface list in the log')
  const startupLine = logs.match(/\[discovery\] interfaces: (.*)/)[1]
  for (const iface of interfaces) {
    assert.ok(
      startupLine.includes(`${iface.name} ${iface.address}`),
      `startup interface list must include ${iface.name} ${iface.address}: ${startupLine}`
    )
  }

  bonjour.publish({ name: serviceName, type: 'oscjson', protocol: 'tcp', port: servicePort })
  await waitFor(async () => recordsFor(await getDevices()).length === 1, 'the service discovered once')
  const before = await getDevices()
  const upsBefore = countOccurrences(logs, `[discovery] up    ${serviceName}`)
  assert.ok(upsBefore >= 1, 'the browser must have reported the service up')
  const interfaceLinesBefore = countOccurrences(logs, '[discovery] interfaces: ')

  observer = new WebSocket(`ws://${LOOPBACK}:${managerPort}/ws/hub`)
  await new Promise((resolve, reject) => {
    observer.once('open', resolve)
    observer.once('error', reject)
  })
  observer.send(JSON.stringify({ type: 'REDISCOVER' }))

  await waitFor(() => /\[discovery\] rediscover requested/.test(logs), 'rediscover acknowledged')
  await waitFor(
    () => countOccurrences(logs, '[discovery] interfaces: ') > interfaceLinesBefore,
    'rediscover re-reading the interface table'
  )
  // The rebuilt browser sees the service again (the hub asked for it on every interface)…
  await waitFor(
    () => countOccurrences(logs, `[discovery] up    ${serviceName}`) > upsBefore,
    'the rebuilt browser re-observing the service',
    20_000
  )
  // …and a re-observation is never a second card: same single record, same
  // identity, and no fqdn anywhere in the registry is represented twice.
  await delay(500)
  const after = await getDevices()
  const afterRecords = recordsFor(after)
  assert.equal(afterRecords.length, 1, 'exactly one registry record for the service after rediscover')
  assert.equal(afterRecords[0].canonicalId, recordsFor(before)[0].canonicalId, 'the re-observed service keeps its identity')
  const fqdnOwners = new Map()
  for (const device of after) {
    for (const endpoint of device.endpoints || []) {
      if (!endpoint.fqdn) continue
      const owners = fqdnOwners.get(endpoint.fqdn) || new Set()
      owners.add(device.canonicalId)
      fqdnOwners.set(endpoint.fqdn, owners)
    }
  }
  for (const [ownedFqdn, owners] of fqdnOwners) {
    assert.equal(owners.size, 1, `${ownedFqdn} must belong to exactly one record, got ${[...owners].join(', ')}`)
  }
})

// A cable-only re-plug leaves the interface table untouched (same name, same
// address, membership kept by the kernel — verified on the show Mac on
// 2026-09-12), so an interface diff cannot see it, and devices on the far
// side do not re-announce because nothing changed for them. The hub must
// therefore keep asking on its own: a periodic sweep rebuilds the browser
// and queries every interface, so known services are re-observed without
// an operator pressing Rediscover.
test('the periodic interface sweep re-observes a known service without REDISCOVER and keeps one record', {
  timeout: 40_000
}, async (t) => {
  const interfaces = listIPv4Interfaces()
  if (interfaces.length === 0) {
    t.skip('needs an external IPv4 interface for a non-loopback mDNS announce')
    return
  }

  const serviceName = `IfaceSweep-${process.pid}-${Date.now() % 1_000_000}`
  const fqdn = `${serviceName}._oscjson._tcp.local`
  const servicePort = await freeTcpPort()
  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-iface-sweep-'))

  let logs = ''
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      PORT: String(managerPort),
      OSC_LISTEN_PORT: String(managerOscPort),
      ABLETON_FORWARD: '0',
      COSMICNOISE_FORWARD: '0',
      COSMICNOISE_SNAPSHOT_MS: '0',
      HUB_NAME: `Iface Sweep Integration ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir,
      DISCOVERY_QUERY_INTERVAL_MS: '1000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-200_000)
  }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)

  const bonjour = new Bonjour()
  t.after(async () => {
    await new Promise((resolve) => bonjour.unpublishAll(resolve))
    bonjour.destroy()
    await stopChild(child)
    await rm(manifestsDir, { recursive: true, force: true })
  })

  const getDevices = async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) throw new Error(`devices HTTP ${response.status}`)
    const body = await response.json()
    return body.devices
  }
  const recordsFor = (devices) => devices.filter((device) =>
    device.activeEndpoint?.fqdn === fqdn ||
    (device.endpoints || []).some((endpoint) => endpoint.fqdn === fqdn)
  )

  await waitFor(getDevices, 'hub serving /_devices')
  bonjour.publish({ name: serviceName, type: 'oscjson', protocol: 'tcp', port: servicePort })
  const first = await waitFor(async () => recordsFor(await getDevices())[0], 'the service discovered once')
  const firstSeen = Number(first.activeEndpoint.lastSeen)
  assert.equal(countOccurrences(logs, `[discovery] up    ${serviceName}`), 1)

  // No REDISCOVER, no interface change: the sweeps alone must bring it back,
  // visible as the endpoint observation moving forward (twice, to prove it
  // is periodic and not the tail of the first announcement).
  const reseen = await waitFor(async () => {
    const record = recordsFor(await getDevices())[0]
    return record && Number(record.activeEndpoint.lastSeen) >= firstSeen + 2000 ? record : null
  }, 'sweep re-observations advancing the endpoint lastSeen', 12_000)
  assert.equal(reseen.canonicalId, first.canonicalId)
  assert.doesNotMatch(logs, /\[discovery\] rediscover requested/)

  const devices = await getDevices()
  assert.equal(recordsFor(devices).length, 1, 'periodic re-observation must not create a second record')
  // An unchanged service re-observed by a sweep is not news: no repeated up line.
  assert.equal(
    countOccurrences(logs, `[discovery] up    ${serviceName}`), 1,
    'a re-observation with the same address and port must not be logged as up again'
  )
})

// A connection failure is the hub's earliest hint that something moved, so
// the first failures of a card trigger a sweep (host-follow heal needs a
// fresh observation right then). A card that stays dead — a headset left at
// home — must not turn every retry into another multicast sweep.
test('a card\'s first connection failures trigger a sweep, its later retries do not', {
  timeout: 60_000
}, async (t) => {
  const interfaces = listIPv4Interfaces()
  if (interfaces.length === 0) {
    t.skip('needs an external IPv4 interface for a non-loopback mDNS announce')
    return
  }

  const serviceName = `IfaceFail-${process.pid}-${Date.now() % 1_000_000}`
  const fqdn = `${serviceName}._oscjson._tcp.local`
  const servicePort = await freeTcpPort()
  const deadPort = await freeTcpPort()
  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-iface-fail-'))
  await writeFile(join(manifestsDir, 'dead-card.json'), `${JSON.stringify({
    id: 61,
    name: 'DeadCard',
    type: 'oscquery-device',
    deviceType: 'OSCQuery',
    serviceName: 'DeadCard',
    host: LOOPBACK,
    oscQueryPort: deadPort,
    enabled: false,
    description: 'Nothing listens here',
    endpoints: []
  }, null, 2)}\n`)

  let logs = ''
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      PORT: String(managerPort),
      OSC_LISTEN_PORT: String(managerOscPort),
      ABLETON_FORWARD: '0',
      COSMICNOISE_FORWARD: '0',
      COSMICNOISE_SNAPSHOT_MS: '0',
      HUB_NAME: `Iface Fail Integration ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir,
      DISCOVERY_QUERY_INTERVAL_MS: '0',
      DISCOVERY_FAILURE_SYNC_MIN_MS: '0',
      DISCOVERY_FAILURE_SWEEP_MIN_MS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-200_000)
  }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)

  const bonjour = new Bonjour()
  let socket
  t.after(async () => {
    socket?.close()
    await new Promise((resolve) => bonjour.unpublishAll(resolve))
    bonjour.destroy()
    await stopChild(child)
    await rm(manifestsDir, { recursive: true, force: true })
  })

  const getDevices = async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) throw new Error(`devices HTTP ${response.status}`)
    const body = await response.json()
    return body.devices
  }
  const probeRecord = (devices) => devices.find((device) =>
    device.activeEndpoint?.fqdn === fqdn ||
    (device.endpoints || []).some((endpoint) => endpoint.fqdn === fqdn)
  )
  // The public record carries no failure counter; the hub logs every attempt.
  const cardFailures = async () => (logs.match(/\[client\] (failed|timeout) DeadCard:/g) || []).length
  const probeSeen = async () => Number(probeRecord(await getDevices())?.activeEndpoint?.lastSeen) || 0

  await waitFor(getDevices, 'hub serving /_devices')
  bonjour.publish({ name: serviceName, type: 'oscjson', protocol: 'tcp', port: servicePort })
  const firstSeen = await waitFor(probeSeen, 'the probe service discovered once')

  socket = new WebSocket(`ws://${LOOPBACK}:${managerPort}/ws/hub`)
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const enabled = new Promise((resolve) => {
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString())
        if (message.type === 'UPDATE_DEVICE_RESULT' && message.deviceId === 61) resolve(message)
      } catch {}
    })
  })
  socket.send(JSON.stringify({ type: 'UPDATE_DEVICE', deviceId: 61, updates: { enabled: true } }))
  assert.equal((await enabled).ok, true)
  socket.send(JSON.stringify({ type: 'RECONNECT_DEVICE', deviceId: 61 }))

  // The first failures ask the network again: the probe is re-observed.
  await waitFor(async () => (await cardFailures()) >= 1, 'the card failing once')
  await waitFor(async () => (await probeSeen()) > firstSeen, 'a sweep after the first failure re-observing the probe', 10_000)

  // Later retries of the same dead card do not.
  await waitFor(async () => (await cardFailures()) >= 3, 'the card failing three times', 20_000)
  const seenAtThirdFailure = await probeSeen()
  await waitFor(async () => (await cardFailures()) >= 5, 'the card failing five times', 20_000)
  assert.equal(await probeSeen(), seenAtThirdFailure, 'retries of a dead card must not keep sweeping the network')
  assert.doesNotMatch(logs, /\[discovery\] rediscover requested/)
})
