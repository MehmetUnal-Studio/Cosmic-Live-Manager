// F0-3/F1-2 regression: the hub must ping every managed OSCQuery WS and
// terminate + reconnect a half-open socket after missed pongs. A device that
// answers pings normally (the ws library and our VSTs auto-pong) must stay
// connected on a single socket.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

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

async function waitFor(check, description, timeoutMs = 10_000) {
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

async function createDevice({ name, deviceId, autoPong }) {
  const namespace = {
    FULL_PATH: '/',
    CONTENTS: {
      value: { FULL_PATH: '/value', TYPE: 'f', VALUE: [0.5], ACCESS: 3 }
    }
  }
  let connectionCount = 0
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.includes('HOST_INFO')) {
      res.end(JSON.stringify({
        NAME: name,
        DEVICE_ID: deviceId,
        DEVICE_TYPE: 'OSCQuery',
        OSC_PORT: 19001,
        OSC_TRANSPORT: 'UDP'
      }))
      return
    }
    res.end(JSON.stringify(namespace))
  })
  // autoPong:false simulates a half-open peer: the TCP socket stays OPEN but
  // nothing ever answers the hub's pings (battery pull / Wi-Fi drop).
  const wss = new WebSocketServer({ server, autoPong })
  wss.on('connection', () => { connectionCount++ })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK, resolve)
  })
  return {
    port: server.address().port,
    get connectionCount() { return connectionCount },
    async stop() {
      for (const ws of wss.clients) ws.terminate()
      await new Promise((resolve) => wss.close(resolve))
      if (server.listening) {
        await new Promise((resolve) => {
          server.close(resolve)
          server.closeAllConnections?.()
        })
      }
    }
  }
}

test('a device that never answers pings is terminated and reconnected; a ponging device stays connected', {
  timeout: 30_000
}, async (t) => {
  const silentDevice = await createDevice({
    name: 'Silent Device',
    deviceId: 'keepalive-silent-device',
    autoPong: false
  })
  const healthyDevice = await createDevice({
    name: 'Healthy Device',
    deviceId: 'keepalive-healthy-device',
    autoPong: true
  })

  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-keepalive-'))
  await writeFile(join(manifestsDir, 'silent.json'), JSON.stringify({
    id: 71,
    name: 'SilentDevice',
    type: 'oscquery-device',
    host: LOOPBACK,
    oscQueryPort: silentDevice.port,
    enabled: true
  }, null, 2) + '\n')
  await writeFile(join(manifestsDir, 'healthy.json'), JSON.stringify({
    id: 72,
    name: 'HealthyDevice',
    type: 'oscquery-device',
    host: LOOPBACK,
    oscQueryPort: healthyDevice.port,
    enabled: true
  }, null, 2) + '\n')

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
      HUB_NAME: `Keepalive Integration ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir,
      OSCQUERY_KEEPALIVE_MS: '150'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => { logs = `${logs}${chunk.toString()}`.slice(-100_000) }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)

  t.after(async () => {
    await stopChild(child)
    await silentDevice.stop()
    await healthyDevice.stop()
    await rm(manifestsDir, { recursive: true, force: true })
  })

  const getDevices = async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) throw new Error(`devices HTTP ${response.status}`)
    return (await response.json()).devices
  }

  await waitFor(async () => {
    const devices = await getDevices()
    return devices.filter((device) =>
      [71, 72].includes(device.manifestId) && device.connectionState === 'Connected'
    ).length === 2
  }, 'both devices initially connected')
  assert.equal(silentDevice.connectionCount, 1)
  assert.equal(healthyDevice.connectionCount, 1)

  // Keepalive: ping every 150 ms, terminate after 2 missed pongs (~450 ms),
  // then the standard reconnect path dials again.
  await waitFor(
    () => silentDevice.connectionCount >= 2,
    'silent device terminated and re-dialed by keepalive',
    12_000
  )
  assert.match(logs, /Keepalive: \d+ pings unanswered/)

  // The healthy device must ride on its original socket the whole time.
  assert.equal(healthyDevice.connectionCount, 1, 'a ponging device must never be cycled')
  const healthy = (await getDevices()).find((device) => device.manifestId === 72)
  assert.equal(healthy.connectionState, 'Connected')
})
