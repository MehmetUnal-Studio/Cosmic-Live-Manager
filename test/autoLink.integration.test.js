// Integration tests for the persisted-link auto-announce engine:
//   - a manifest that already carries `link` bootstraps the VST's
//     /system/peer/* parameters with NO dashboard websocket connected
//   - a restarted VST (same OSCQuery port, fresh UDP socket) is re-announced
//   - ANNOUNCE_DEVICE persists `link` into the manifest on disk and
//     CLEAR_DEVICE_LINK removes it again
//   - saveManifest validates the link shape defensively over UPDATE_DEVICE
//
// The machine running this suite may host a REAL hub on port 7400 and real
// mDNS devices: every port here is ephemeral, every manifest dir isolated,
// and every fake device/link name unique to this suite.

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
import WebSocket, { WebSocketServer } from 'ws'
import osc from 'osc'

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

async function waitFor(check, description, timeoutMs = 8000) {
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

function spawnHub({ managerPort, managerOscPort, manifestsDir, extraEnv = {}, onLog }) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      PORT: String(managerPort),
      OSC_LISTEN_PORT: String(managerOscPort),
      ABLETON_FORWARD: '0',
      COSMICNOISE_FORWARD: '0',
      COSMICNOISE_SNAPSHOT_MS: '0',
      HUB_NAME: `AutoLink Integration ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir,
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', onLog)
  child.stderr.on('data', onLog)
  return child
}

async function openHub(managerPort) {
  const messages = []
  const ws = new WebSocket(`ws://${LOOPBACK}:${managerPort}/ws/hub`)
  ws.on('message', (raw) => {
    try { messages.push(JSON.parse(raw.toString())) } catch {}
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  await new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      if (messages.some((message) => message.type === 'INITIAL_STATE')) return resolve()
      if (Date.now() - started > 7000) return reject(new Error('no INITIAL_STATE'))
      setTimeout(poll, 20)
    }
    poll()
  })
  return { ws, messages }
}

/**
 * A fake OSCQuery device shaped like the ones the hub manages: an HTTP
 * namespace + ?HOST_INFO endpoint, a WS channel, and an independent UDP OSC
 * control socket (the port HOST_INFO advertises — like the real VST).
 */
async function startFakeOscDevice({ name, deviceId, deviceType, httpPort = 0 }) {
  const udp = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => {
    udp.once('error', reject)
    udp.bind(0, LOOPBACK, resolve)
  })
  const udpPort = udp.address().port
  const packets = []
  udp.on('message', (buffer) => {
    try { packets.push(osc.readPacket(buffer, { metadata: true, unpackSingleArgs: false })) } catch {}
  })

  const namespace = {
    FULL_PATH: '/',
    CONTENTS: {
      value: { FULL_PATH: '/value', TYPE: 'f', VALUE: [0], ACCESS: 3 }
    }
  }
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.includes('HOST_INFO')) {
      res.end(JSON.stringify({
        NAME: name,
        DEVICE_ID: deviceId,
        DEVICE_TYPE: deviceType,
        OSC_PORT: udpPort,
        OSC_TRANSPORT: 'UDP'
      }))
      return
    }
    res.end(JSON.stringify(namespace))
  })
  const wss = new WebSocketServer({ server })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(httpPort, LOOPBACK, resolve)
  })

  let closed = false
  return {
    name,
    udpPort,
    httpPort: server.address().port,
    packets,
    peerMessages() {
      return packets.filter((packet) =>
        typeof packet.address === 'string' && packet.address.startsWith('/system/peer/')
      )
    },
    async close() {
      if (closed) return
      closed = true
      for (const ws of wss.clients) ws.terminate()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections?.()
      })
      await new Promise((resolve) => {
        try { udp.close(resolve) } catch { resolve() }
      })
    }
  }
}

function peerArgsByAddress(peerMessages) {
  const map = new Map()
  for (const packet of peerMessages) map.set(packet.address, packet.args)
  return map
}

async function deviceConnected(managerPort, manifestId) {
  const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
  if (!response.ok) return false
  const body = await response.json()
  return body.devices?.some((device) =>
    device.manifestId === manifestId && device.connectionState === 'Connected'
  )
}

test('a persisted link auto-announces with no dashboard connected and re-announces after a VST restart', {
  timeout: 90_000
}, async (t) => {
  const vst = await startFakeOscDevice({
    name: 'AutoVst',
    deviceId: 'auto-vst-sim',
    deviceType: 'CosmicUnity'
  })
  const tablet = await startFakeOscDevice({
    name: 'AutoTablet',
    deviceId: 'auto-tablet-sim',
    deviceType: 'OSCQuery'
  })

  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-autolink-auto-'))
  // The VST manifest already remembers its peer: the engine must bootstrap
  // the link with zero operator interaction.
  await writeFile(join(manifestsDir, 'auto_vst_21.json'), JSON.stringify({
    id: 21,
    name: 'AutoVst',
    type: 'oscquery-device',
    deviceType: 'CosmicUnity',
    host: LOOPBACK,
    oscQueryPort: vst.httpPort,
    enabled: true,
    link: { targetFqdn: '', targetName: 'AutoTablet', peerId: '', udpPortOverride: 0 }
  }, null, 2) + '\n')
  await writeFile(join(manifestsDir, 'auto_tablet_22.json'), JSON.stringify({
    id: 22,
    name: 'AutoTablet',
    type: 'oscquery-device',
    deviceType: 'OSCQuery',
    host: LOOPBACK,
    oscQueryPort: tablet.httpPort,
    enabled: true
  }, null, 2) + '\n')

  let logs = ''
  const child = spawnHub({
    managerPort,
    managerOscPort,
    manifestsDir,
    onLog: (chunk) => { logs = `${logs}${chunk.toString()}`.slice(-100_000) }
  })

  let restarted = null
  t.after(async () => {
    await stopChild(child)
    await vst.close()
    await restarted?.close()
    await tablet.close()
    await rm(manifestsDir, { recursive: true, force: true })
  })

  // Deliberately NO /ws/hub client in this phase — the announce must be
  // driven purely by the engine.
  const firstAnnounce = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const messages = vst.peerMessages()
    return messages.length >= 5 ? messages : false
  }, 'auto announce reaches the VST UDP socket with no dashboard connected', 25_000)

  const first = peerArgsByAddress(firstAnnounce)
  assert.deepEqual(
    Array.from(first.keys()).sort(),
    [
      '/system/peer/connect',
      '/system/peer/host',
      '/system/peer/oscquery_port',
      '/system/peer/peer_id',
      '/system/peer/udp_port'
    ],
    'all five peer bootstrap parameters must be written'
  )
  assert.equal(first.get('/system/peer/peer_id')[0].value, 'autotablet',
    'the peer id derives from the resolved target name')
  assert.equal(first.get('/system/peer/host')[0].value, LOOPBACK)
  assert.equal(Number(first.get('/system/peer/oscquery_port')[0].value), tablet.httpPort)
  assert.equal(Number(first.get('/system/peer/udp_port')[0].value), 0)
  assert.equal(first.get('/system/peer/connect')[0].type, 'T')

  // Restart the VST: same OSCQuery HTTP port, but a FRESH UDP control socket
  // (a restarted VST rebinds an ephemeral port and forgot its peers). The
  // hub's reconnect must trigger a fresh announce at the NEW UDP port.
  const oldHttpPort = vst.httpPort
  await vst.close()
  await delay(300)
  restarted = await startFakeOscDevice({
    name: 'AutoVst',
    deviceId: 'auto-vst-sim',
    deviceType: 'CosmicUnity',
    httpPort: oldHttpPort
  })
  assert.equal(restarted.httpPort, oldHttpPort)
  assert.notEqual(restarted.udpPort, vst.udpPort, 'the restarted VST must use a fresh UDP socket')

  const reAnnounce = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const messages = restarted.peerMessages()
    return messages.length >= 5 ? messages : false
  }, 're-announce after the VST restart', 40_000)

  const second = peerArgsByAddress(reAnnounce)
  assert.equal(second.get('/system/peer/peer_id')[0].value, 'autotablet')
  assert.equal(Number(second.get('/system/peer/oscquery_port')[0].value), tablet.httpPort)
  assert.equal(child.exitCode, null, `hub must stay alive\n${logs}`)
})

test('ANNOUNCE_DEVICE persists the link on disk and CLEAR_DEVICE_LINK removes it', {
  timeout: 60_000
}, async (t) => {
  const vst = await startFakeOscDevice({
    name: 'LinkVst',
    deviceId: 'link-vst-sim',
    deviceType: 'CosmicUnity'
  })
  const tablet = await startFakeOscDevice({
    name: 'LinkTablet',
    deviceId: 'link-tablet-sim',
    deviceType: 'OSCQuery'
  })

  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-autolink-persist-'))
  const vstManifestPath = join(manifestsDir, 'link_vst_31.json')
  // The source VST starts WITHOUT a saved link.
  await writeFile(vstManifestPath, JSON.stringify({
    id: 31,
    name: 'LinkVst',
    type: 'oscquery-device',
    deviceType: 'CosmicUnity',
    host: LOOPBACK,
    oscQueryPort: vst.httpPort,
    enabled: true
  }, null, 2) + '\n')
  await writeFile(join(manifestsDir, 'link_tablet_32.json'), JSON.stringify({
    id: 32,
    name: 'LinkTablet',
    type: 'oscquery-device',
    deviceType: 'OSCQuery',
    host: LOOPBACK,
    oscQueryPort: tablet.httpPort,
    enabled: true
  }, null, 2) + '\n')

  let logs = ''
  const child = spawnHub({
    managerPort,
    managerOscPort,
    manifestsDir,
    onLog: (chunk) => { logs = `${logs}${chunk.toString()}`.slice(-100_000) }
  })

  let hub
  t.after(async () => {
    try { hub?.ws.terminate() } catch {}
    await stopChild(child)
    await vst.close()
    await tablet.close()
    await rm(manifestsDir, { recursive: true, force: true })
  })

  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    return (await deviceConnected(managerPort, 31)) && (await deviceConnected(managerPort, 32))
  }, 'both fake devices connected', 20_000)

  hub = await openHub(managerPort)

  hub.ws.send(JSON.stringify({
    type: 'ANNOUNCE_DEVICE',
    deviceId: 31,
    target: { address: LOOPBACK, port: tablet.httpPort, fqdn: '', name: 'LinkTablet' },
    peerId: 'Custom-Peer'
  }))
  const announceResult = await waitFor(() => hub.messages.find((message) =>
    message.type === 'ANNOUNCE_RESULT' && message.deviceId === 31
  ), 'ANNOUNCE_RESULT', 15_000)
  assert.equal(announceResult.ok, true, `announce failed: ${announceResult.error}`)

  // The five bootstrap messages must reach the VST's UDP socket.
  const announced = await waitFor(() =>
    vst.peerMessages().length >= 5 ? vst.peerMessages() : false
  , 'announce reaches the VST', 10_000)
  assert.equal(
    peerArgsByAddress(announced).get('/system/peer/peer_id')[0].value,
    'custom-peer'
  )

  // The link must now be persisted in the manifest file on disk.
  const savedManifest = await waitFor(async () => {
    const parsed = JSON.parse(await readFile(vstManifestPath, 'utf-8'))
    return parsed.link ? parsed : false
  }, 'link persisted to the manifest on disk')
  assert.deepEqual(savedManifest.link, {
    targetFqdn: '',
    targetName: 'LinkTablet',
    peerId: 'custom-peer',
    udpPortOverride: 0
  })

  // Clearing an unknown device must fail without side effects.
  hub.ws.send(JSON.stringify({ type: 'CLEAR_DEVICE_LINK', deviceId: 999 }))
  const unknownClear = await waitFor(() => hub.messages.find((message) =>
    message.type === 'CLEAR_LINK_RESULT' && message.deviceId === 999
  ), 'CLEAR_LINK_RESULT for unknown device')
  assert.equal(unknownClear.ok, false)
  assert.equal(typeof unknownClear.error, 'string')

  hub.ws.send(JSON.stringify({ type: 'CLEAR_DEVICE_LINK', deviceId: 31 }))
  const clearResult = await waitFor(() => hub.messages.find((message) =>
    message.type === 'CLEAR_LINK_RESULT' && message.deviceId === 31
  ), 'CLEAR_LINK_RESULT')
  assert.equal(clearResult.ok, true, `clear failed: ${clearResult.error}`)

  await waitFor(async () => {
    const parsed = JSON.parse(await readFile(vstManifestPath, 'utf-8'))
    return !('link' in parsed)
  }, 'link removed from the manifest on disk')
  assert.equal(child.exitCode, null, `hub must stay alive\n${logs}`)
})

test('saveManifest validates persisted link shapes defensively over UPDATE_DEVICE', {
  timeout: 30_000
}, async (t) => {
  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-autolink-shape-'))
  const manifestPath = join(manifestsDir, 'link_shape_41.json')
  // Disabled device: no connections needed to exercise saveManifest.
  await writeFile(manifestPath, JSON.stringify({
    id: 41,
    name: 'LinkShape',
    type: 'oscquery-device',
    host: '10.9.9.41',
    oscQueryPort: 5050,
    enabled: false
  }, null, 2) + '\n')

  let logs = ''
  const child = spawnHub({
    managerPort,
    managerOscPort,
    manifestsDir,
    onLog: (chunk) => { logs = `${logs}${chunk.toString()}`.slice(-100_000) }
  })

  let hub
  t.after(async () => {
    try { hub?.ws.terminate() } catch {}
    await stopChild(child)
    await rm(manifestsDir, { recursive: true, force: true })
  })

  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) return false
    const body = await response.json()
    return body.devices?.some((device) => device.manifestId === 41)
  }, 'device loaded')

  hub = await openHub(managerPort)
  const updateResults = () => hub.messages.filter((message) =>
    message.type === 'UPDATE_DEVICE_RESULT' && message.deviceId === 41
  )

  // A full valid shape persists exactly as validated.
  hub.ws.send(JSON.stringify({
    type: 'UPDATE_DEVICE',
    deviceId: 41,
    updates: {
      link: {
        targetFqdn: 'sim-tablet._oscjson._tcp.local',
        targetName: 'SimTablet',
        peerId: 'sim_tablet',
        udpPortOverride: 9005
      }
    }
  }))
  await waitFor(() => updateResults().some((result) => result.ok === true), 'valid link saved')
  const fullShape = await waitFor(async () => {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf-8'))
    return parsed.link ? parsed : false
  }, 'valid link persisted on disk')
  assert.deepEqual(fullShape.link, {
    targetFqdn: 'sim-tablet._oscjson._tcp.local',
    targetName: 'SimTablet',
    peerId: 'sim_tablet',
    udpPortOverride: 9005
  })

  // Omitted optional fields are normalized to the documented defaults.
  hub.ws.send(JSON.stringify({
    type: 'UPDATE_DEVICE',
    deviceId: 41,
    updates: { link: { targetName: 'OnlyName' } }
  }))
  // Wait for the WS result too, not only the disk write: saveManifest hits
  // the disk before its UPDATE_DEVICE_RESULT is delivered, and okCountBefore
  // below must be captured only after this second ok has landed.
  await waitFor(() => updateResults().filter((result) => result.ok === true).length >= 2,
    'defaults-normalized link acknowledged over WS')
  const normalized = await waitFor(async () => {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf-8'))
    return parsed.link?.targetName === 'OnlyName' ? parsed : false
  }, 'defaults-normalized link persisted on disk')
  assert.deepEqual(normalized.link, {
    targetFqdn: '',
    targetName: 'OnlyName',
    peerId: '',
    udpPortOverride: 0
  })

  // Every malformed shape must be rejected with {ok:false} — and none of
  // them may crash the hub or touch the manifest on disk.
  const badLinks = [
    'i-am-a-string',
    [1, 2, 3],
    { targetFqdn: 'x'.repeat(129), targetName: 'T' },
    { targetName: 'x'.repeat(129) },
    { targetFqdn: '', targetName: '' },
    { targetName: 123 },
    { targetFqdn: { nested: true }, targetName: 'T' },
    { targetName: 'T', peerId: 'x'.repeat(129) },
    { targetName: 'T', peerId: 42 },
    { targetName: 'T', udpPortOverride: 'nope' },
    { targetName: 'T', udpPortOverride: 65536 },
    { targetName: 'T', udpPortOverride: -1 },
    { targetName: 'T', udpPortOverride: 1.5 }
  ]
  const okCountBefore = updateResults().filter((result) => result.ok === true).length
  for (const link of badLinks) {
    hub.ws.send(JSON.stringify({ type: 'UPDATE_DEVICE', deviceId: 41, updates: { link } }))
  }
  const failures = await waitFor(() => {
    const failed = updateResults().filter((result) => result.ok === false)
    return failed.length >= badLinks.length ? failed : false
  }, 'every malformed link rejected with ok:false')
  assert.equal(failures.every((result) => typeof result.error === 'string'), true)
  assert.equal(
    updateResults().filter((result) => result.ok === true).length,
    okCountBefore,
    'no malformed link may report ok'
  )

  // The disk manifest still carries the last VALID link, untouched.
  const afterBarrage = JSON.parse(await readFile(manifestPath, 'utf-8'))
  assert.deepEqual(afterBarrage.link, {
    targetFqdn: '',
    targetName: 'OnlyName',
    peerId: '',
    udpPortOverride: 0
  })

  // The hub survived the barrage and still accepts valid updates.
  assert.equal(child.exitCode, null, `hub process died during the barrage\n${logs}`)
  hub.ws.send(JSON.stringify({ type: 'UPDATE_DEVICE', deviceId: 41, updates: { link: null } }))
  await waitFor(async () => {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf-8'))
    return !('link' in parsed)
  }, 'link:null removes the persisted field')
})
