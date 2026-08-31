// Integration regression test for the wrong-device HOST_INFO guard.
//
// Real incident (2026-08-31): after a DHCP lease change, Android_Tablet01's
// manifest still resolved 192.168.68.54, but that address now belonged to
// SpectraTablet02. The hub connected, HOST_INFO announced
// NAME="Android_TabletSpectraTablet02", and the card showed "Connected" while
// parameters went to the wrong physical tablet.
//
// The hub must compare the identity HOST_INFO declares with the identity the
// manifest expects, reject the connection with a wrong-device error, keep the
// consecutive-failure counter climbing (so host-follow heal stays armed), and
// never adopt the impostor's DEVICE_ID into the saved record.

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

// A perfectly healthy OSCQuery device — namespace, WebSocket, HOST_INFO — that
// simply is NOT the device the manifest expects at this address.
async function createImpostorDevice() {
  const namespace = {
    FULL_PATH: '/',
    CONTENTS: {
      HandR0: {
        FULL_PATH: '/HandR0',
        TYPE: 'f',
        VALUE: [0.5],
        ACCESS: 3
      }
    }
  }
  const oscPort = await freeUdpPort()
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.includes('HOST_INFO')) {
      res.end(JSON.stringify({
        NAME: 'Android_TabletSpectraTablet02',
        DEVICE_ID: 'f'.repeat(32),
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
    server.listen(0, LOOPBACK, resolve)
  })
  return {
    port: server.address().port,
    async stop() {
      for (const ws of wss.clients) ws.terminate()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections?.()
      })
    }
  }
}

test('a device announcing another identity in HOST_INFO is rejected, surfaced and left heal-eligible', {
  timeout: 40_000
}, async (t) => {
  const impostor = await createImpostorDevice()
  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-wrong-device-'))
  await writeFile(join(manifestsDir, 'android-tablet01.json'), `${JSON.stringify({
    id: 71,
    name: 'Android_Tablet01',
    type: 'oscquery-device',
    deviceType: 'Android',
    serviceName: 'Android_Tablet01',
    host: LOOPBACK,
    oscQueryPort: impostor.port,
    enabled: true,
    description: 'DHCP handed this address to SpectraTablet02',
    // Discovery once vouched for Android_Tablet01's fqdn at this address —
    // that observed service identity is what the name guard enforces.
    endpoints: [{
      host: LOOPBACK,
      port: impostor.port,
      source: 'discovery',
      fqdn: 'Android_Tablet01._oscjson._tcp.local',
      lastSeen: Date.now() - 3_600_000
    }]
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
      HUB_NAME: `Wrong Device Integration ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-100_000)
  }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)

  const hubMessages = []
  let observer
  t.after(async () => {
    observer?.close()
    await stopChild(child)
    await impostor.stop()
    await rm(manifestsDir, { recursive: true, force: true })
  })

  const getSavedDevice = async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) throw new Error(`devices HTTP ${response.status}`)
    const body = await response.json()
    return body.devices.find((device) => device.manifestId === 71)
  }

  await waitFor(getSavedDevice, 'hub serving the saved device')
  observer = new WebSocket(`ws://${LOOPBACK}:${managerPort}/ws/hub`)
  observer.on('message', (raw) => {
    try {
      hubMessages.push(JSON.parse(raw.toString()))
    } catch {}
  })
  await new Promise((resolve, reject) => {
    observer.once('open', resolve)
    observer.once('error', reject)
  })

  // The connection must be rejected with a clear identity error on the card.
  const rejected = await waitFor(async () => {
    const device = await getSavedDevice()
    return device && device.status === 'error' && /Kimlik uyuşmazlığı/.test(device.error || '')
      ? device
      : null
  }, 'saved device rejected with an identity mismatch error')
  assert.match(rejected.error, /wrong-device/)
  assert.match(rejected.error, /beklenen Android_Tablet01/)
  assert.match(rejected.error, /bulunan Android_TabletSpectraTablet02/)

  // The impostor's DEVICE_ID must never be adopted into the saved record.
  assert.equal(rejected.persistentDeviceId, null)

  // Failures must keep climbing across retry cycles so planHostFollowHeals
  // (minimum 2 consecutive failures) can migrate the manifest on its own.
  const healEligible = await waitFor(() =>
    hubMessages.find((message) =>
      message.type === 'DEVICE_UPDATED' &&
      Number(message.device?.manifestId ?? message.device?.id) === 71 &&
      /Kimlik uyuşmazlığı/.test(message.device?.error || '') &&
      Number(message.device?.consecutiveConnectFailures) >= 2
    ), 'DEVICE_UPDATED with at least two consecutive wrong-device failures', 20_000)
  assert.equal(healEligible.device.status, 'error')
})
