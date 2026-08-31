import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import osc from 'osc'
import WebSocket, { WebSocketServer } from 'ws'

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

async function bindUdp(socket) {
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, LOOPBACK, resolve)
  })
  return socket.address().port
}

async function waitFor(check, description, timeoutMs = 7000) {
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

async function createOscQueryPeer({ name, deviceType, oscPort, listenPort = 0 }) {
  const namespace = { FULL_PATH: '/', CONTENTS: {} }
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.includes('HOST_INFO')) {
      res.end(JSON.stringify({
        NAME: name,
        DEVICE_TYPE: deviceType,
        DEVICE_ID: `${name.toLowerCase()}-uuid`,
        OSC_PORT: oscPort,
        OSC_TRANSPORT: 'UDP'
      }))
      return
    }
    res.end(JSON.stringify(namespace))
  })
  const wss = new WebSocketServer({ server })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(listenPort, LOOPBACK, resolve)
  })
  return { server, wss, port: server.address().port }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGINT')
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(2500).then(() => false)
  ])
  if (!exited) child.kill('SIGKILL')
}

test('Cosmic-card LINK writes Android coordinates and udp_port zero to the VST', {
  timeout: 20_000
}, async (t) => {
  const vstOscReceiver = dgram.createSocket('udp4')
  const androidOscReceiver = dgram.createSocket('udp4')
  const managerOscProbe = dgram.createSocket('udp4')
  const vstOscPort = await bindUdp(vstOscReceiver)
  const androidOscPort = await bindUdp(androidOscReceiver)
  const managerOscPort = await bindUdp(managerOscProbe)
  await new Promise((resolve) => managerOscProbe.close(resolve))

  const packets = []
  vstOscReceiver.on('message', (packet) => {
    packets.push(osc.readPacket(packet, { metadata: true, unpackSingleArgs: false }))
  })

  const vst = await createOscQueryPeer({
    name: 'Cosmic_Test_1',
    deviceType: 'CosmicUnity',
    oscPort: vstOscPort
  })
  const android = await createOscQueryPeer({
    name: 'Android_Test_1',
    deviceType: 'Android',
    oscPort: androidOscPort
  })
  const managerPort = await freeTcpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-link-test-'))
  const cosmicManifestPath = join(manifestsDir, 'cosmic.json')
  await writeFile(cosmicManifestPath, JSON.stringify({
    id: 11,
    name: 'Cosmic_Test_1',
    deviceType: 'CosmicUnity',
    persistentDeviceId: 'cosmic_test_1-uuid',
    host: LOOPBACK,
    oscQueryPort: vst.port,
    enabled: true,
    routing: { peerId: 'operator-tablet', udpPortOverride: 0 },
    operatorConfig: { color: 'magenta', channel: 1 }
  }))
  await writeFile(join(manifestsDir, 'android.json'), JSON.stringify({
    id: 22,
    name: 'Android_Test_1',
    deviceType: 'Android',
    persistentDeviceId: 'android_test_1-uuid',
    host: LOOPBACK,
    oscQueryPort: android.port,
    enabled: true
  }))

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
      HUB_NAME: `Link Routing Integration ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir,
      KEEP_MANIFESTS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-30_000)
  }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)

  let hub
  t.after(async () => {
    try { hub?.terminate() } catch {}
    await stopChild(child)
    for (const peer of [vst, android]) {
      for (const ws of peer.wss.clients) ws.terminate()
      await new Promise((resolve) => peer.wss.close(resolve))
      if (peer.server.listening) await new Promise((resolve) => peer.server.close(resolve))
    }
    for (const socket of [vstOscReceiver, androidOscReceiver]) {
      try { socket.close() } catch {}
    }
    await rm(manifestsDir, { recursive: true, force: true })
  })

  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) return false
    const body = await response.json()
    return body.devices?.filter((device) => device.connectionState === 'Connected').length === 2
  }, 'both fake OSCQuery peers to connect')

  hub = new WebSocket(`ws://${LOOPBACK}:${managerPort}/ws/hub`)
  const messages = []
  hub.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch {}
  })
  await new Promise((resolve, reject) => {
    hub.once('open', resolve)
    hub.once('error', reject)
  })
  hub.send(JSON.stringify({
    type: 'ANNOUNCE_DEVICE',
    deviceId: 11,
    target: {
      name: 'Android_Test_1',
      address: LOOPBACK,
      port: android.port
    },
    peerId: 'android_test_1',
    udpPortOverride: 0
  }))

  const result = await waitFor(
    () => messages.find((message) => message.type === 'ANNOUNCE_RESULT'),
    'ANNOUNCE_RESULT'
  )
  assert.equal(result.ok, true, logs)
  await waitFor(() => packets.length === 5, 'five peer bootstrap packets')

  const byAddress = new Map(packets.map((packet) => [packet.address, packet]))
  assert.equal(byAddress.get('/system/peer/host').args[0].value, LOOPBACK)
  assert.equal(byAddress.get('/system/peer/oscquery_port').args[0].value, android.port)
  assert.equal(byAddress.get('/system/peer/udp_port').args[0].value, 0)
  assert.equal(byAddress.get('/system/peer/peer_id').args[0].value, 'android_test_1')
  assert.equal(byAddress.get('/system/peer/connect').args[0].value, true)
  assert.equal(packets.every((packet) => packet.address.startsWith('/system/peer/')), true)

  // The same wire protocol also accepts a generic OSCQuery instrument. The
  // UI exposes these under "Other OSCQuery Devices" to every Cosmic card.
  const priorResultCount = messages.filter((message) => message.type === 'ANNOUNCE_RESULT').length
  hub.send(JSON.stringify({
    type: 'ANNOUNCE_DEVICE',
    deviceId: 11,
    target: {
      name: 'Ring-Instrument',
      address: LOOPBACK,
      port: android.port,
      deviceType: 'OSCQuery'
    },
    peerId: 'ring-instrument',
    udpPortOverride: 0
  }))
  const otherResult = await waitFor(
    () => {
      const results = messages.filter((message) => message.type === 'ANNOUNCE_RESULT')
      return results.length > priorResultCount ? results.at(-1) : null
    },
    'Other OSCQuery ANNOUNCE_RESULT'
  )
  assert.equal(otherResult.ok, true, logs)
  await waitFor(() => packets.length === 10, 'five generic OSCQuery peer bootstrap packets')
  const otherPackets = packets.slice(5)
  const otherByAddress = new Map(otherPackets.map((packet) => [packet.address, packet]))
  assert.equal(otherByAddress.get('/system/peer/host').args[0].value, LOOPBACK)
  assert.equal(otherByAddress.get('/system/peer/oscquery_port').args[0].value, android.port)
  assert.equal(otherByAddress.get('/system/peer/peer_id').args[0].value, 'ring-instrument')

  // A normal identity/settings save after migration must retain extension
  // fields that are not part of the Manager's runtime whitelist.
  hub.send(JSON.stringify({
    type: 'UPDATE_DEVICE',
    deviceId: 11,
    updates: { name: 'Cosmic_Test_1_Renamed' }
  }))
  const updateResult = await waitFor(
    () => messages.find((message) => message.type === 'UPDATE_DEVICE_RESULT'),
    'UPDATE_DEVICE_RESULT'
  )
  assert.equal(updateResult.ok, true, logs)
  const persisted = JSON.parse(await readFile(cosmicManifestPath, 'utf8'))
  assert.deepEqual(persisted.routing, { peerId: 'operator-tablet', udpPortOverride: 0 })
  assert.deepEqual(persisted.operatorConfig, { color: 'magenta', channel: 1 })
})

test('Live-Ring is migrated to a trusted Ableton receiver and only bootstraps Ring-Instrument', {
  timeout: 20_000
}, async (t) => {
  const liveRingOscReceiver = dgram.createSocket('udp4')
  const ringOscReceiver = dgram.createSocket('udp4')
  const managerOscProbe = dgram.createSocket('udp4')
  const liveRingOscPort = await bindUdp(liveRingOscReceiver)
  const ringOscPort = await bindUdp(ringOscReceiver)
  const managerOscPort = await bindUdp(managerOscProbe)
  await new Promise((resolve) => managerOscProbe.close(resolve))

  const packets = []
  liveRingOscReceiver.on('message', (packet) => {
    packets.push(osc.readPacket(packet, { metadata: true, unpackSingleArgs: false }))
  })

  const liveRing = await createOscQueryPeer({
    name: 'Live-Ring',
    deviceType: 'CosmicRing',
    oscPort: liveRingOscPort
  })
  const ringInstrument = await createOscQueryPeer({
    name: 'Ring-Instrument',
    deviceType: 'OSCQuery',
    oscPort: ringOscPort,
    listenPort: 9011
  })
  const managerPort = await freeTcpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-live-ring-test-'))
  const liveRingManifestPath = join(manifestsDir, 'live-ring.json')
  await writeFile(liveRingManifestPath, JSON.stringify({
    id: 14,
    name: 'Live-Ring',
    serviceName: 'Live_Ring',
    deviceType: 'OSCQuery',
    canonicalId: 'oscquery:uuid:live-ring-uuid',
    persistentDeviceId: 'live-ring-uuid',
    host: LOOPBACK,
    oscQueryPort: liveRing.port,
    enabled: true,
    routing: { peerId: 'ring-instrument', udpPortOverride: 0 },
    operatorConfig: { channel: 'ring' }
  }))
  await writeFile(join(manifestsDir, 'ring-instrument.json'), JSON.stringify({
    id: 12,
    name: 'Ring-Instrument',
    serviceName: 'Ring-Instrument',
    deviceType: 'OSCQuery',
    persistentDeviceId: 'ring-instrument-uuid',
    host: LOOPBACK,
    oscQueryPort: 9011,
    enabled: true
  }))

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
      HUB_NAME: `Live Ring Integration ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir,
      KEEP_MANIFESTS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-30_000)
  }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)

  let hub
  t.after(async () => {
    try { hub?.terminate() } catch {}
    await stopChild(child)
    for (const peer of [liveRing, ringInstrument]) {
      for (const ws of peer.wss.clients) ws.terminate()
      await new Promise((resolve) => peer.wss.close(resolve))
      if (peer.server.listening) await new Promise((resolve) => peer.server.close(resolve))
    }
    for (const socket of [liveRingOscReceiver, ringOscReceiver]) {
      try { socket.close() } catch {}
    }
    await rm(manifestsDir, { recursive: true, force: true })
  })

  const registryDevices = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) return false
    const body = await response.json()
    const receiver = body.devices?.find((device) => device.id === 14)
    const peer = body.devices?.find((device) => device.id === 12)
    return receiver?.connectionState === 'Connected' &&
      receiver?.deviceType === 'CosmicRing' &&
      receiver?.runtimeKind === 'VST3' &&
      receiver?.linkRole === 'CosmicRingReceiver' &&
      peer?.connectionState === 'Connected'
      ? body.devices
      : false
  }, 'Live-Ring and Ring-Instrument registry roles')
  assert.equal(registryDevices.filter((device) => device.id === 14).length, 1)

  hub = new WebSocket(`ws://${LOOPBACK}:${managerPort}/ws/hub`)
  const messages = []
  hub.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch {}
  })
  await new Promise((resolve, reject) => {
    hub.once('open', resolve)
    hub.once('error', reject)
  })
  hub.send(JSON.stringify({
    type: 'ANNOUNCE_DEVICE',
    deviceId: 14,
    target: {
      name: 'Ring-Instrument',
      address: LOOPBACK,
      port: 9011
    },
    peerId: 'ring-instrument',
    udpPortOverride: 0
  }))

  const result = await waitFor(
    () => messages.find((message) => message.type === 'ANNOUNCE_RESULT'),
    'Live-Ring ANNOUNCE_RESULT'
  )
  assert.equal(result.ok, true, logs)
  assert.equal(result.summary, 'Ring-Instrument → Live-Ring')
  await waitFor(() => packets.length === 5, 'five Live-Ring peer bootstrap packets')

  const byAddress = new Map(packets.map((packet) => [packet.address, packet]))
  assert.equal(byAddress.get('/system/peer/host').args[0].value, LOOPBACK)
  assert.equal(byAddress.get('/system/peer/oscquery_port').args[0].value, 9011)
  assert.equal(byAddress.get('/system/peer/udp_port').args[0].value, 0)
  assert.equal(byAddress.get('/system/peer/peer_id').args[0].value, 'ring-instrument')
  assert.equal(byAddress.get('/system/peer/connect').args[0].value, true)

  const migrated = JSON.parse(await readFile(liveRingManifestPath, 'utf8'))
  assert.equal(migrated.deviceType, 'CosmicRing')
  assert.equal(migrated.canonicalId, 'cosmicring:uuid:live-ring-uuid')
  assert.ok(migrated.legacyCanonicalIds.includes('oscquery:uuid:live-ring-uuid'))
  assert.deepEqual(migrated.routing, { peerId: 'ring-instrument', udpPortOverride: 0 })
  assert.deepEqual(migrated.operatorConfig, { channel: 'ring' })
})

test('Max/Ring handler rejects a spoofed Ring name and port that are absent from registry state', {
  timeout: 15_000
}, async (t) => {
  const managerPort = await freeTcpPort()
  const managerOscProbe = dgram.createSocket('udp4')
  const managerOscPort = await bindUdp(managerOscProbe)
  await new Promise((resolve) => managerOscProbe.close(resolve))
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-maxring-guard-'))
  await writeFile(join(manifestsDir, 'maxring.json'), JSON.stringify({
    id: 14,
    name: 'Max_Ring',
    serviceName: 'MaxRing',
    deviceType: 'OSCQuery',
    host: LOOPBACK,
    oscQueryPort: 8005,
    enabled: false
  }))

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
      HUB_NAME: `MaxRing Guard ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir,
      KEEP_MANIFESTS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-30_000)
  }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)

  let hub
  t.after(async () => {
    try { hub?.terminate() } catch {}
    await stopChild(child)
    await rm(manifestsDir, { recursive: true, force: true })
  })

  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) return false
    const body = await response.json()
    return body.devices?.some((device) =>
      device.id === 14 && device.linkRole === 'MaxRingReceiver'
    )
  }, 'verified-local Max/Ring registry role')

  hub = new WebSocket(`ws://${LOOPBACK}:${managerPort}/ws/hub`)
  const messages = []
  hub.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch {}
  })
  await new Promise((resolve, reject) => {
    hub.once('open', resolve)
    hub.once('error', reject)
  })

  hub.send(JSON.stringify({
    type: 'ANNOUNCE_DEVICE',
    deviceId: 14,
    target: {
      name: 'Ring-Instrument',
      address: '203.0.113.77',
      port: 9011
    },
    peerId: 'ring-instrument',
    udpPortOverride: 9005
  }))

  const result = await waitFor(
    () => messages.find((message) => message.type === 'ANNOUNCE_RESULT'),
    'guarded Max/Ring ANNOUNCE_RESULT'
  )
  assert.equal(result.ok, false, logs)
  assert.match(result.error, /must be present in the Device Registry/)
})
