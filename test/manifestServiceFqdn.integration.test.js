// Integration regression test for the manifest's persisted service identity.
//
// Real incident (2026-09-03): DHCP moved the TouchDesigner machine and an
// operator repaired the saved cards by editing HOST. Every hand repair writes
// a single `source: 'manual-update'` endpoint with no fqdn, so the repair
// itself stripped the card of the service identity host-follow heal follows —
// the next move had to be repaired by hand again. `/_devices` on the show
// machine showed exactly that: `ep: 192.168.68.52:9010 src=manual-update
// fqdn=YOK`, while the .68 announcement sat in a separate unsaved row.
//
// A card whose display name is not the mDNS instance name (here: an operator
// named it "ServiceFqdnCard" while the machine announces as `SvcFqdn-…`)
// cannot derive its fqdn from `serviceName`. The hub must persist the fqdn it
// OBSERVED on a successful connection, keep it across restarts and hand
// repairs, and use it to follow the service home.

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
import { Bonjour } from 'bonjour-service'

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const LOOPBACK = '127.0.0.1'
const DEVICE_ID = 71
// The operator's card name — deliberately NOT the mDNS instance name, so no
// fqdn can be derived from it and only a real observation can identify it.
const CARD_NAME = 'ServiceFqdnCard'

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

function externalIPv4Address() {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const iface of interfaces || []) {
      if (iface?.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return null
}

// Identity-less OSCQuery device (like TouchDesigner: no DEVICE_ID anywhere),
// listening on every interface so the announced LAN address is dialable.
async function createFqdnOnlyOscQueryDevice(name) {
  const namespace = {
    FULL_PATH: '/',
    CONTENTS: {
      wall: {
        FULL_PATH: '/wall',
        TYPE: 'f',
        VALUE: [0.5],
        ACCESS: 3,
        DESCRIPTION: 'Service identity probe'
      }
    }
  }
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.includes('HOST_INFO')) {
      res.end(JSON.stringify({ NAME: name, OSC_TRANSPORT: 'UDP' }))
      return
    }
    res.end(JSON.stringify(namespace))
  })
  const wss = new WebSocketServer({ server })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', resolve)
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

// The hub only ever observes an fqdn at the exact address mDNS announces, so
// the manifest must point at the address the announcement actually carries.
// Browse for our own service and read it, instead of guessing an interface.
async function announcedIPv4(bonjour, serviceName, timeoutMs = 15_000) {
  const browser = bonjour.find({ type: 'oscjson' })
  try {
    return await waitFor(async () => {
      const service = browser.services.find((item) => item.name === serviceName)
      const addresses = (service?.addresses || [])
        .filter((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address) && address !== LOOPBACK)
      return addresses[0] || null
    }, `an IPv4 announcement for ${serviceName}`, timeoutMs)
  } finally {
    browser.stop()
  }
}

// One saved card pointing at a live OSCQuery service that announces itself
// under a name the card's own `serviceName` cannot derive.
async function setupScenario(t) {
  if (!externalIPv4Address()) {
    t.skip('needs an external IPv4 interface for a non-loopback mDNS announce')
    return null
  }

  const serviceName = `SvcFqdn-${process.pid}-${Date.now() % 1_000_000}`
  const fqdn = `${serviceName}._oscjson._tcp.local`
  const fakeDevice = await createFqdnOnlyOscQueryDevice(serviceName)
  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-service-fqdn-'))
  const manifestPath = join(manifestsDir, 'service-fqdn-device.json')

  let logs = ''
  let child = null
  const captureLog = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-100_000)
  }
  const bonjour = new Bonjour()
  t.after(async () => {
    await new Promise((resolve) => bonjour.unpublishAll(resolve))
    bonjour.destroy()
    if (child) await stopChild(child)
    await fakeDevice.stop()
    await rm(manifestsDir, { recursive: true, force: true })
  })

  bonjour.publish({
    name: serviceName,
    type: 'oscjson',
    protocol: 'tcp',
    port: fakeDevice.port
  })
  const lanHost = await announcedIPv4(bonjour, serviceName)

  // The saved card as an operator left it: hand-typed HOST, one identity-less
  // manual-update endpoint, and a display name of their own choosing.
  await writeFile(manifestPath, `${JSON.stringify({
    id: DEVICE_ID,
    name: CARD_NAME,
    type: 'oscquery-device',
    deviceType: 'OSCQuery',
    serviceName: CARD_NAME,
    host: lanHost,
    oscQueryPort: fakeDevice.port,
    enabled: true,
    description: 'Repaired by hand after a DHCP move',
    endpoints: [{
      host: lanHost,
      port: fakeDevice.port,
      source: 'manual-update',
      lastSeen: Date.now() - 3_600_000
    }]
  }, null, 2)}\n`)

  const startHub = () => {
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: REPO_DIR,
      env: {
        ...process.env,
        PORT: String(managerPort),
        OSC_LISTEN_PORT: String(managerOscPort),
        ABLETON_FORWARD: '0',
        COSMICNOISE_FORWARD: '0',
        COSMICNOISE_SNAPSHOT_MS: '0',
        HUB_NAME: `Service Fqdn Integration ${process.pid} ${Date.now()}`,
        MANIFESTS_DIR: manifestsDir,
        HOST_FOLLOW_HEAL_INTERVAL_MS: '250'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', captureLog)
    child.stderr.on('data', captureLog)
    return child
  }

  const getSavedDevice = async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) throw new Error(`devices HTTP ${response.status}`)
    const body = await response.json()
    return body.devices.find((device) => device.manifestId === DEVICE_ID)
  }

  const readManifest = async () => JSON.parse(await readFile(manifestPath, 'utf-8'))

  const openHubSocket = async () => {
    const socket = new WebSocket(`ws://${LOOPBACK}:${managerPort}/ws/hub`)
    t.after(() => socket.close())
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return socket
  }

  startHub()
  await waitFor(getSavedDevice, 'hub serving the saved device')
  await waitFor(
    async () => (await getSavedDevice())?.status === 'connected',
    'the saved card connecting to its service'
  )

  return {
    serviceName,
    fqdn,
    lanHost,
    fakeDevice,
    managerPort,
    manifestPath,
    getSavedDevice,
    readManifest,
    openHubSocket,
    logs: () => logs,
    restartHub: async () => {
      await stopChild(child)
      startHub()
      await waitFor(getSavedDevice, 'the restarted hub serving the saved device')
    }
  }
}

test('a connected card persists the fqdn it observed, and keeps it across a hub restart', {
  timeout: 60_000
}, async (t) => {
  const scenario = await setupScenario(t)
  if (!scenario) return

  const persisted = await waitFor(async () => {
    const manifest = await scenario.readManifest()
    return manifest.serviceFqdn ? manifest : null
  }, 'the observed service identity reaching the manifest')
  assert.equal(persisted.serviceFqdn, scenario.fqdn)
  // The identity is an observation, not a guess: nothing about the card's own
  // name could have produced it.
  assert.equal(persisted.serviceName, CARD_NAME)
  assert.notEqual(scenario.fqdn, `${CARD_NAME}._oscjson._tcp.local`)

  await scenario.restartHub()
  await waitFor(
    async () => (await scenario.getSavedDevice())?.status === 'connected',
    'the restarted hub reconnecting the saved card'
  )
  const afterRestart = await scenario.readManifest()
  assert.equal(afterRestart.serviceFqdn, scenario.fqdn)
  assert.equal(afterRestart.id, DEVICE_ID)
})

test('a card moved by hand heals itself on the next announcement of its service', {
  timeout: 60_000
}, async (t) => {
  const scenario = await setupScenario(t)
  if (!scenario) return

  await waitFor(async () => {
    const manifest = await scenario.readManifest()
    return manifest.serviceFqdn === scenario.fqdn
  }, 'the observed service identity reaching the manifest')

  // The hand repair: an operator points HOST at an address that answers
  // nothing. This is the write that used to destroy the card's identity.
  const deadPort = await freeTcpPort()
  const socket = await scenario.openHubSocket()
  const updateResult = new Promise((resolve) => {
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString())
        if (message.type === 'UPDATE_DEVICE_RESULT' && message.deviceId === DEVICE_ID) {
          resolve(message)
        }
      } catch {}
    })
  })
  socket.send(JSON.stringify({
    type: 'UPDATE_DEVICE',
    deviceId: DEVICE_ID,
    updates: { host: LOOPBACK, oscQueryPort: deadPort }
  }))
  assert.equal((await updateResult).ok, true)

  const handRepaired = await waitFor(async () => {
    const manifest = await scenario.readManifest()
    return manifest.host === LOOPBACK ? manifest : null
  }, 'the hand-typed host reaching the manifest')
  assert.equal(Number(handRepaired.oscQueryPort), deadPort)
  assert.equal(handRepaired.endpoints[0].source, 'manual-update')
  // Nothing announces at the typed address, so the endpoint stays identity-
  // less — exactly the shape that used to disarm the heal for good.
  assert.equal(handRepaired.endpoints[0].fqdn, undefined)
  // The card itself must still know who it is.
  assert.equal(handRepaired.serviceFqdn, scenario.fqdn)

  // The next time the service announces (a DHCP move, or an operator pressing
  // Rediscover) the hub must follow its own identity home.
  socket.send(JSON.stringify({ type: 'REDISCOVER' }))

  const healed = await waitFor(async () => {
    const device = await scenario.getSavedDevice()
    return device &&
      device.status === 'connected' &&
      device.host === scenario.lanHost &&
      Number(device.oscQueryPort) === scenario.fakeDevice.port
      ? device
      : null
  }, 'the hand-moved card following its service identity home', 30_000)
  assert.equal(healed.saved, true)
  assert.match(scenario.logs(), /\[heal\] host follow/)

  const afterHeal = await scenario.readManifest()
  assert.equal(afterHeal.host, scenario.lanHost)
  assert.equal(Number(afterHeal.oscQueryPort), scenario.fakeDevice.port)
  // The heal writes a manual-update endpoint too — at an address mDNS is
  // announcing, so the identity is attached instead of being thrown away.
  assert.equal(afterHeal.endpoints[0].fqdn, scenario.fqdn)
  assert.equal(afterHeal.serviceFqdn, scenario.fqdn)
})
