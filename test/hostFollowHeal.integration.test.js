// Integration regression test for the saved-device host-follow auto-heal.
//
// Real incident (2026-08-30): a TouchDesigner machine moved 192.168.68.63 →
// 192.168.68.51 on a DHCP lease change. mDNS announced the same fqdn on the
// new address immediately and the registry folded the fresh endpoint into the
// saved record, but the managed connection loop kept dialing the manifest's
// dead host:port, so the card stayed Error/Unavailable until an operator
// edited HOST by hand. The hub must follow the fqdn to the fresh endpoint,
// persist the manifest, broadcast DEVICE_UPDATED and reconnect on its own.
//
// The scenario is played on this machine: the manifest points at a dead
// loopback port whose endpoint carries the service fqdn, and the test then
// announces the same fqdn over real Bonjour, which resolves to this machine's
// LAN address — a different host, like after the DHCP move.

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
        DESCRIPTION: 'Host-follow heal probe'
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

test('a saved device follows its fqdn to a fresh discovery endpoint after the manifest host dies', {
  timeout: 40_000
}, async (t) => {
  if (!externalIPv4Address()) {
    t.skip('needs an external IPv4 interface for a non-loopback mDNS announce')
    return
  }

  const serviceName = `TDFollow-${process.pid}-${Date.now() % 1_000_000}`
  const fqdn = `${serviceName}._oscjson._tcp.local`
  const fakeDevice = await createFqdnOnlyOscQueryDevice(serviceName)
  const deadPort = await freeTcpPort()
  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-host-follow-'))
  const manifestPath = join(manifestsDir, 'host-follow-device.json')
  await writeFile(manifestPath, `${JSON.stringify({
    id: 61,
    name: 'TDWallInstrument',
    type: 'oscquery-device',
    deviceType: 'OSCQuery',
    serviceName,
    host: LOOPBACK,
    oscQueryPort: deadPort,
    enabled: true,
    description: 'Moves hosts on DHCP lease changes',
    endpoints: [{
      host: LOOPBACK,
      port: deadPort,
      source: 'discovery',
      fqdn,
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
      HUB_NAME: `Host Follow Integration ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir,
      HOST_FOLLOW_HEAL_INTERVAL_MS: '250'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-100_000)
  }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)

  const bonjour = new Bonjour()
  const hubMessages = []
  let observer
  t.after(async () => {
    observer?.close()
    await new Promise((resolve) => bonjour.unpublishAll(resolve))
    bonjour.destroy()
    await stopChild(child)
    await fakeDevice.stop()
    await rm(manifestsDir, { recursive: true, force: true })
  })

  const getSavedDevice = async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) throw new Error(`devices HTTP ${response.status}`)
    const body = await response.json()
    return body.devices.find((device) => device.manifestId === 61)
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

  // The DHCP move: the same fqdn is announced on a fresh (LAN) address while
  // the manifest endpoint keeps refusing connections.
  bonjour.publish({
    name: serviceName,
    type: 'oscjson',
    protocol: 'tcp',
    port: fakeDevice.port
  })

  const healed = await waitFor(async () => {
    const device = await getSavedDevice()
    return device &&
      device.status === 'connected' &&
      device.host !== LOOPBACK &&
      Number(device.oscQueryPort) === fakeDevice.port
      ? device
      : null
  }, 'saved device reconnected on the followed host', 25_000)
  assert.equal(healed.saved, true)
  assert.equal(healed.manifestId, 61)

  assert.match(logs, /\[heal\] host follow/)

  const persisted = JSON.parse(await readFile(manifestPath, 'utf-8'))
  assert.notEqual(persisted.host, LOOPBACK)
  assert.equal(Number(persisted.oscQueryPort), fakeDevice.port)
  assert.equal(persisted.id, 61)

  assert.ok(
    hubMessages.some((message) =>
      message.type === 'DEVICE_UPDATED' &&
      Number(message.device?.manifestId ?? message.device?.id) === 61 &&
      message.device?.host === persisted.host
    ),
    'DEVICE_UPDATED must broadcast the followed host'
  )
})
