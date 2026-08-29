import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
    await delay(20)
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

async function createOscQueryDevice() {
  const namespace = {
    FULL_PATH: '/',
    CONTENTS: {
      value: {
        FULL_PATH: '/value',
        TYPE: 'f',
        VALUE: [0.25],
        ACCESS: 3,
        DESCRIPTION: 'Reconnect lifecycle probe'
      }
    }
  }

  let stopped = false
  let connectionCount = 0
  let namespaceRequestCount = 0
  let reconnectGateClosed = false
  const gatedResponses = new Set()

  const sendNamespace = (res) => {
    if (res.destroyed || res.writableEnded) return
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(namespace))
  }

  const server = http.createServer((req, res) => {
    if (req.url.includes('HOST_INFO')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        NAME: 'Reconnect Lifecycle Device',
        DEVICE_ID: 'manager-reconnect-test-device',
        DEVICE_TYPE: 'OSCQuery',
        OSC_PORT: 19001,
        OSC_TRANSPORT: 'UDP'
      }))
      return
    }

    namespaceRequestCount++
    if (!reconnectGateClosed) {
      sendNamespace(res)
      return
    }

    gatedResponses.add(res)
    res.once('close', () => gatedResponses.delete(res))
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', () => {
    connectionCount++
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK, resolve)
  })

  return {
    port: server.address().port,
    get connectionCount() {
      return connectionCount
    },
    get namespaceRequestCount() {
      return namespaceRequestCount
    },
    holdReconnect() {
      reconnectGateClosed = true
    },
    releaseReconnect() {
      reconnectGateClosed = false
      for (const response of Array.from(gatedResponses)) {
        gatedResponses.delete(response)
        sendNamespace(response)
      }
    },
    dropCurrentConnection() {
      const openClient = Array.from(wss.clients).find((ws) => ws.readyState === WebSocket.OPEN)
      assert.ok(openClient, 'fake OSCQuery device must have an open WebSocket')
      openClient.terminate()
    },
    async stop() {
      if (stopped) return
      stopped = true
      this.releaseReconnect()
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

async function createHangingOscQueryDevice() {
  let activeRequests = 0
  let maxActiveRequests = 0
  const responses = new Set()
  const server = http.createServer((_req, res) => {
    activeRequests++
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
    responses.add(res)
    res.once('close', () => {
      responses.delete(res)
      activeRequests--
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK, resolve)
  })
  return {
    port: server.address().port,
    get activeRequests() { return activeRequests },
    get maxActiveRequests() { return maxActiveRequests },
    async stop() {
      for (const response of responses) response.destroy()
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections?.()
      })
    }
  }
}

async function openHubObserver(port) {
  const messages = []
  const ws = new WebSocket(`ws://${LOOPBACK}:${port}/ws/hub`)
  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()))
    } catch {}
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  await waitFor(
    () => messages.some((message) => message.type === 'INITIAL_STATE'),
    'dashboard INITIAL_STATE'
  )
  return { ws, messages }
}

function stableDeviceFields(device) {
  return {
    id: device.id,
    manifestId: device.manifestId,
    canonicalId: device.canonicalId,
    persistentDeviceId: device.persistentDeviceId,
    deviceType: device.deviceType,
    name: device.name,
    serviceName: device.serviceName,
    host: device.host,
    port: device.port,
    oscQueryPort: device.oscQueryPort,
    saved: device.saved,
    enabled: device.enabled,
    runtimeGeneration: device.runtimeGeneration
  }
}

test('a connected device becomes Unavailable, reconnects as the same saved card, and keeps its manifest', {
  timeout: 25_000
}, async (t) => {
  const fakeDevice = await createOscQueryDevice()
  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-reconnect-lifecycle-'))
  const manifestPath = join(manifestsDir, 'reconnect-device.json')
  const manifest = {
    id: 41,
    name: 'ReconnectLifecycleDevice',
    type: 'oscquery-device',
    deviceType: 'OSCQuery',
    canonicalId: 'oscquery:uuid:manager-reconnect-test-device',
    persistentDeviceId: 'manager-reconnect-test-device',
    serviceName: 'Reconnect Lifecycle Device',
    host: LOOPBACK,
    oscQueryPort: fakeDevice.port,
    enabled: true,
    description: 'Keep this setting through transient disconnects',
    endpoints: [{
      host: LOOPBACK,
      port: fakeDevice.port,
      source: 'integration-fixture',
      lastSeen: 123456789
    }],
    legacyIds: [7, 19]
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(manifestPath, manifestBytes)

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
      HUB_NAME: `Reconnect Lifecycle Integration ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-100_000)
  }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)

  let observer
  t.after(async () => {
    observer?.ws.close()
    await stopChild(child)
    await fakeDevice.stop()
    await rm(manifestsDir, { recursive: true, force: true })
  })

  const getDevices = async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) throw new Error(`devices HTTP ${response.status}`)
    return (await response.json()).devices
  }
  const matchingDevices = (devices) => devices.filter((device) =>
    device.manifestId === manifest.id ||
    device.canonicalId === manifest.canonicalId ||
    device.persistentDeviceId === manifest.persistentDeviceId
  )

  const initiallyConnected = await waitFor(async () => {
    const matches = matchingDevices(await getDevices())
    return fakeDevice.connectionCount === 1 &&
      matches.length === 1 &&
      matches[0].connectionState === 'Connected'
      ? matches[0]
      : false
  }, 'first Connected state')
  const stableBefore = stableDeviceFields(initiallyConnected)
  assert.equal(stableBefore.id, manifest.id)
  assert.equal(stableBefore.canonicalId, manifest.canonicalId)
  assert.deepEqual(await readFile(manifestPath), manifestBytes)

  observer = await openHubObserver(managerPort)
  fakeDevice.holdReconnect()
  const namespaceRequestsBeforeDrop = fakeDevice.namespaceRequestCount
  const disconnectedAt = Date.now()
  fakeDevice.dropCurrentConnection()

  const unavailableEvent = await waitFor(() => observer.messages.find((message) =>
    message.type === 'DEVICE_UPDATED' &&
    message.device?.manifestId === manifest.id &&
    message.device?.connectionState === 'Unavailable'
  ), 'Unavailable DEVICE_UPDATED event')
  assert.deepEqual(stableDeviceFields(unavailableEvent.device), stableBefore)

  const unavailableRecord = await waitFor(async () => {
    const matches = matchingDevices(await getDevices())
    return matches.length === 1 && matches[0].connectionState === 'Unavailable'
      ? matches[0]
      : false
  }, 'Unavailable registry state')
  assert.equal(unavailableRecord.status, 'lost')
  assert.deepEqual(stableDeviceFields(unavailableRecord), stableBefore)
  assert.deepEqual(await readFile(manifestPath), manifestBytes)

  // Hold the HTTP namespace response until the client's 500 ms retry has
  // actually started. This makes the Unavailable assertion deterministic even
  // on a busy CI machine, while still exercising the real reconnect timer.
  await waitFor(
    () => fakeDevice.namespaceRequestCount > namespaceRequestsBeforeDrop,
    '500 ms reconnect attempt'
  )
  assert.equal(fakeDevice.connectionCount, 1)
  fakeDevice.releaseReconnect()

  const reconnected = await waitFor(async () => {
    const matches = matchingDevices(await getDevices())
    return fakeDevice.connectionCount === 2 &&
      matches.length === 1 &&
      matches[0].connectionState === 'Connected'
      ? matches[0]
      : false
  }, 'automatic reconnect to Connected')

  assert.deepEqual(stableDeviceFields(reconnected), stableBefore)
  assert.equal(reconnected.status, 'connected')
  assert.equal(matchingDevices(await getDevices()).length, 1, 'reconnect must not create a duplicate card')

  // Cross the former three-second expiry boundary. A stale deletion timer
  // would remove the manifest/card here even though reconnect succeeded.
  const oldExpiryBoundary = disconnectedAt + 3400
  if (Date.now() < oldExpiryBoundary) await delay(oldExpiryBoundary - Date.now())

  const afterFormerExpiry = matchingDevices(await getDevices())
  assert.equal(afterFormerExpiry.length, 1)
  assert.equal(afterFormerExpiry[0].connectionState, 'Connected')
  assert.deepEqual(stableDeviceFields(afterFormerExpiry[0]), stableBefore)
  assert.deepEqual(await readFile(manifestPath), manifestBytes)
  assert.deepEqual(await readdir(manifestsDir), ['reconnect-device.json'])
  assert.doesNotMatch(logs, /\[manifest-delete\].*remote_disconnect/)
})

test('an initial connection cannot remain Connecting beyond the three-second deadline', {
  timeout: 15_000
}, async (t) => {
  const hangingDevice = await createHangingOscQueryDevice()
  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-connect-deadline-'))
  const manifestPath = join(manifestsDir, 'deadline-device.json')
  const manifest = {
    id: 52,
    name: 'DeadlineDevice',
    type: 'oscquery-device',
    deviceType: 'OSCQuery',
    canonicalId: 'oscquery:uuid:manager-deadline-test-device',
    persistentDeviceId: 'manager-deadline-test-device',
    serviceName: 'Deadline Device',
    host: LOOPBACK,
    oscQueryPort: hangingDevice.port,
    enabled: true,
    description: 'Must survive connection timeout',
    endpoints: [{ host: LOOPBACK, port: hangingDevice.port, source: 'integration-fixture' }],
    legacyIds: []
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(manifestPath, manifestBytes)

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
      HUB_NAME: `Connection Deadline Integration ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => { logs = `${logs}${chunk.toString()}`.slice(-100_000) }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)

  t.after(async () => {
    await stopChild(child)
    await hangingDevice.stop()
    await rm(manifestsDir, { recursive: true, force: true })
  })

  const getRecord = async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) throw new Error(`devices HTTP ${response.status}`)
    const devices = (await response.json()).devices
    const matches = devices.filter((device) => device.id === manifest.id)
    assert.ok(matches.length <= 1, 'timeout/retry must never create a duplicate entity')
    return matches[0]
  }

  const connecting = await waitFor(async () => {
    const record = await getRecord()
    return record?.connectionState === 'Connecting' ? record : false
  }, 'initial Connecting state')
  const connectingObservedAt = Date.now()
  assert.equal(connecting.canonicalId, manifest.canonicalId)

  const unavailable = await waitFor(async () => {
    const record = await getRecord()
    return record?.connectionState === 'Unavailable' ? record : false
  }, 'three-second Unavailable state', 4500)
  const elapsedMs = Date.now() - connectingObservedAt

  assert.ok(elapsedMs <= 3300, `Connecting remained visible for ${elapsedMs} ms`)
  assert.equal(unavailable.status, 'lost')
  assert.equal(unavailable.error, 'Connection timed out after 3000 ms')
  assert.equal(unavailable.id, connecting.id)
  assert.equal(unavailable.canonicalId, connecting.canonicalId)
  await waitFor(() => hangingDevice.activeRequests === 0, 'aborted HTTP/HOST_INFO requests')
  assert.ok(hangingDevice.maxActiveRequests <= 2, 'only one parallel attempt (namespace + HOST_INFO) is allowed')
  assert.deepEqual(await readFile(manifestPath), manifestBytes)
})
