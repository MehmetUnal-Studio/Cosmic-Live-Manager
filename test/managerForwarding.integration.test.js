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
import osc from 'osc'
import WebSocket, { WebSocketServer } from 'ws'

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const LOOPBACK = '127.0.0.1'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function bindUdp(socket) {
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, LOOPBACK, resolve)
  })
  return socket.address().port
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
  const port = await bindUdp(socket)
  await new Promise((resolve) => socket.close(resolve))
  return port
}

async function waitFor(check, description, timeoutMs = 5000) {
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

function padOscString(value) {
  const source = Buffer.from(`${value}\0`, 'utf8')
  const output = Buffer.alloc(Math.ceil(source.length / 4) * 4)
  source.copy(output)
  return output
}

function expectedLegacyAbletonPacket() {
  const value = Buffer.alloc(4)
  value.writeFloatBE(1.25, 0)
  return Buffer.concat([
    padOscString('device3'),
    padOscString(',sf'),
    padOscString('/vector'),
    value
  ])
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGINT')
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(2000).then(() => false)
  ])
  if (!exited) child.kill('SIGKILL')
}

async function openManagerWebSocket(port) {
  const ws = new WebSocket(`ws://${LOOPBACK}:${port}/ws/hub`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

test('Manager routes managed echoes exactly once and keeps both mirrors independent', {
  timeout: 30_000
}, async (t) => {
  const cosmicReceiver = dgram.createSocket('udp4')
  const abletonReceiver = dgram.createSocket('udp4')
  const deviceUdpReceiver = dgram.createSocket('udp4')
  const cosmicPort = await bindUdp(cosmicReceiver)
  const abletonPort = await bindUdp(abletonReceiver)
  const deviceUdpPort = await bindUdp(deviceUdpReceiver)
  const cosmicPackets = []
  const abletonPackets = []
  cosmicReceiver.on('message', (packet) => cosmicPackets.push(Buffer.from(packet)))
  abletonReceiver.on('message', (packet) => abletonPackets.push(Buffer.from(packet)))

  const sourcePacket = Buffer.from(osc.writePacket({
    address: '/vector',
    args: [
      { type: 'f', value: 1.25 },
      { type: 'f', value: 2.5 },
      { type: 'f', value: 3.75 }
    ]
  }, { metadata: true, unpackSingleArgs: false }))

  const namespace = {
    FULL_PATH: '/',
    CONTENTS: {
      vector: {
        FULL_PATH: '/vector',
        TYPE: 'fff',
        VALUE: [0, 0, 0],
        ACCESS: 3
      }
    }
  }
  const deviceHttp = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.includes('HOST_INFO')) {
      res.end(JSON.stringify({ NAME: 'Fake Device', OSC_PORT: deviceUdpPort, OSC_TRANSPORT: 'UDP' }))
      return
    }
    res.end(JSON.stringify(namespace))
  })
  const deviceWss = new WebSocketServer({ server: deviceHttp })
  deviceWss.on('connection', (ws) => {
    let sent = false
    ws.on('message', () => {
      if (sent) return
      sent = true
      ws.send(sourcePacket)
    })
  })
  await new Promise((resolve, reject) => {
    deviceHttp.once('error', reject)
    deviceHttp.listen(0, LOOPBACK, resolve)
  })
  const deviceHttpPort = deviceHttp.address().port

  t.after(async () => {
    for (const ws of deviceWss.clients) ws.terminate()
    await new Promise((resolve) => deviceWss.close(resolve))
    if (deviceHttp.listening) await new Promise((resolve) => deviceHttp.close(resolve))
    for (const socket of [cosmicReceiver, abletonReceiver, deviceUdpReceiver]) {
      try { socket.close() } catch {}
    }
  })

  const cases = [
    { name: 'both-on', cosmic: true, ableton: true, deviceEnabled: true },
    { name: 'cosmic-only', cosmic: true, ableton: false, deviceEnabled: true },
    { name: 'ableton-only', cosmic: false, ableton: true, deviceEnabled: true },
    { name: 'both-off', cosmic: false, ableton: false, deviceEnabled: true },
    { name: 'device-disabled', cosmic: true, ableton: true, deviceEnabled: false }
  ]

  for (const flags of cases) {
    cosmicPackets.length = 0
    abletonPackets.length = 0
    const managerPort = await freeTcpPort()
    const managerOscPort = await freeUdpPort()
    const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmicnoise-manager-test-'))
    await writeFile(join(manifestsDir, 'fake.json'), JSON.stringify({
      id: 3,
      name: 'FakeDevice',
      type: 'oscquery-device',
      host: LOOPBACK,
      oscQueryPort: deviceHttpPort,
      enabled: flags.deviceEnabled
    }))

    let logs = ''
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: REPO_DIR,
      env: {
        ...process.env,
        PORT: String(managerPort),
        OSC_LISTEN_PORT: String(managerOscPort),
        ABLETON_FORWARD: flags.ableton ? '1' : '0',
        ABLETON_HOST: LOOPBACK,
        ABLETON_PORT: String(abletonPort),
        COSMICNOISE_FORWARD: flags.cosmic ? '1' : '0',
        COSMICNOISE_HOST: LOOPBACK,
        COSMICNOISE_PORT: String(cosmicPort),
        COSMICNOISE_SNAPSHOT_MS: '0',
        HUB_NAME: `CosmicNoise Integration ${process.pid} ${flags.name}`,
        MANIFESTS_DIR: manifestsDir,
        KEEP_MANIFESTS: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const captureLog = (chunk) => {
      logs = `${logs}${chunk.toString()}`.slice(-20_000)
    }
    child.stdout.on('data', captureLog)
    child.stderr.on('data', captureLog)

    let managerWs
    try {
      await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
        const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
        if (!response.ok) return false
        const body = await response.json()
        if (!flags.deviceEnabled) return body.devices[0]?.status === 'disabled'
        return body.devices[0]?.msgCount >= 1
      }, flags.deviceEnabled ? `${flags.name} managed echo` : `${flags.name} manifest load`)
      await delay(100)

      const expectCosmic = flags.cosmic && flags.deviceEnabled
      const expectAbleton = flags.ableton && flags.deviceEnabled

      assert.equal(
        cosmicPackets.length,
        expectCosmic ? 1 : 0,
        `${flags.name}: CosmicNoise packet count\n${logs}`
      )
      assert.equal(
        abletonPackets.length,
        expectAbleton ? 1 : 0,
        `${flags.name}: Ableton packet count\n${logs}`
      )

      if (expectCosmic) {
        const packet = osc.readPacket(cosmicPackets[0], {
          metadata: true,
          unpackSingleArgs: false
        })
        assert.equal(packet.address, '/cosmicnoise/v1/input')
        assert.equal(packet.args.map((arg) => arg.type).join(''), 'isfff')
        assert.deepEqual(packet.args.map((arg) => arg.value), [
          3,
          '/vector',
          1.25,
          2.5,
          3.75
        ])
      }
      if (expectAbleton) {
        assert.deepEqual(abletonPackets[0], expectedLegacyAbletonPacket())
      }

      // Only the both-enabled case needs to prove the other hub ingress paths
      // do not duplicate the managed-device mirror.
      if (flags.cosmic && flags.ableton && flags.deviceEnabled) {
        managerWs = await openManagerWebSocket(managerPort)
        managerWs.send(JSON.stringify({
          type: 'SET_DEVICE_PARAM',
          deviceId: 3,
          path: '/vector',
          value: [9, 8, 7]
        }))
        managerWs.send(JSON.stringify({ type: 'SET', path: '/ui-only', value: 4 }))

        const rawSender = dgram.createSocket('udp4')
        const rawPacket = Buffer.from(osc.writePacket({
          address: '/raw-only',
          args: [{ type: 'f', value: 0.5 }]
        }, { metadata: true, unpackSingleArgs: false }))
        await new Promise((resolve, reject) => {
          rawSender.send(rawPacket, managerOscPort, LOOPBACK, (error) => {
            rawSender.close()
            if (error) reject(error)
            else resolve()
          })
        })
        await delay(200)

        assert.equal(cosmicPackets.length, 1, 'raw/optimistic paths must not reach CosmicNoise')
        assert.equal(abletonPackets.length, 1, 'raw/optimistic paths must not reach legacy Ableton')
      }
    } finally {
      if (managerWs) managerWs.close()
      await stopChild(child)
      await rm(manifestsDir, { recursive: true, force: true })
    }
  }
})

test('Manager periodically replays fresh CosmicNoise lifecycle state without touching Ableton', {
  timeout: 30_000
}, async (t) => {
  const cosmicReceiver = dgram.createSocket('udp4')
  const abletonReceiver = dgram.createSocket('udp4')
  const deviceUdpReceiver = dgram.createSocket('udp4')
  const cosmicPort = await bindUdp(cosmicReceiver)
  const abletonPort = await bindUdp(abletonReceiver)
  const deviceUdpPort = await bindUdp(deviceUdpReceiver)
  const cosmicPackets = []
  const abletonPackets = []
  cosmicReceiver.on('message', (packet) => cosmicPackets.push(Buffer.from(packet)))
  abletonReceiver.on('message', (packet) => abletonPackets.push(Buffer.from(packet)))

  const makePacket = (address, args) => Buffer.from(osc.writePacket({ address, args }, {
    metadata: true,
    unpackSingleArgs: false
  }))
  const lifecycleSourcePackets = [
    makePacket('/0', [
      { type: 'f', value: 0 },
      { type: 'f', value: 0.1 },
      { type: 'f', value: 0.2 },
      { type: 'f', value: 0.3 }
    ]),
    // Deliberately publish Playing before position. Snapshot replay must fix
    // this order so a receiver never applies Playing against old coordinates.
    makePacket('/PerformanceController/finger0Playing', [
      { type: 'i', value: 0 }
    ]),
    makePacket('/PerformanceController/droneWavelengthsString', [
      { type: 's', value: '0' }
    ]),
    makePacket('/PerformanceController/finger0', [
      { type: 'f', value: 0.4 },
      { type: 'f', value: 0.5 },
      { type: 'f', value: 0.6 }
    ])
  ]
  const heartbeatPacket = makePacket('/PerformanceController/heartbeat', [
    { type: 'i', value: 1 }
  ])
  const namespace = {
    FULL_PATH: '/',
    CONTENTS: {
      0: { FULL_PATH: '/0', TYPE: 'ffff', VALUE: [0, 0, 0, 0], ACCESS: 3 },
      PerformanceController: {
        FULL_PATH: '/PerformanceController',
        CONTENTS: {
          finger0: {
            FULL_PATH: '/PerformanceController/finger0',
            TYPE: 'fff',
            VALUE: [0, 0, 0],
            ACCESS: 3
          },
          finger0Playing: {
            FULL_PATH: '/PerformanceController/finger0Playing',
            TYPE: 'T',
            VALUE: [true],
            ACCESS: 3
          },
          droneWavelengthsString: {
            FULL_PATH: '/PerformanceController/droneWavelengthsString',
            TYPE: 's',
            VALUE: ['0'],
            ACCESS: 3
          },
          heartbeat: {
            FULL_PATH: '/PerformanceController/heartbeat',
            TYPE: 'i',
            VALUE: [0],
            ACCESS: 3
          }
        }
      }
    }
  }

  const deviceHttp = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.includes('HOST_INFO')) {
      res.end(JSON.stringify({
        NAME: 'Snapshot Fake Device',
        OSC_PORT: deviceUdpPort,
        OSC_TRANSPORT: 'UDP'
      }))
      return
    }
    res.end(JSON.stringify(namespace))
  })
  const deviceWss = new WebSocketServer({ server: deviceHttp })
  const sendToDeviceClients = (packets) => {
    for (const ws of deviceWss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      for (const packet of packets) ws.send(packet)
    }
  }
  deviceWss.on('connection', (ws) => {
    let initialStateSent = false
    ws.on('message', () => {
      if (initialStateSent) return
      initialStateSent = true
      sendToDeviceClients(lifecycleSourcePackets)
    })
  })
  await new Promise((resolve, reject) => {
    deviceHttp.once('error', reject)
    deviceHttp.listen(0, LOOPBACK, resolve)
  })
  const deviceHttpPort = deviceHttp.address().port
  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmicnoise-snapshot-test-'))
  await writeFile(join(manifestsDir, 'snapshot.json'), JSON.stringify({
    id: 7,
    name: 'SnapshotDevice',
    type: 'oscquery-device',
    host: LOOPBACK,
    oscQueryPort: deviceHttpPort,
    enabled: true
  }))

  let logs = ''
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      PORT: String(managerPort),
      OSC_LISTEN_PORT: String(managerOscPort),
      ABLETON_FORWARD: '1',
      ABLETON_HOST: LOOPBACK,
      ABLETON_PORT: String(abletonPort),
      COSMICNOISE_FORWARD: '1',
      COSMICNOISE_HOST: LOOPBACK,
      COSMICNOISE_PORT: String(cosmicPort),
      COSMICNOISE_SNAPSHOT_MS: '50',
      HUB_NAME: `CosmicNoise Snapshot Integration ${process.pid}`,
      MANIFESTS_DIR: manifestsDir,
      KEEP_MANIFESTS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-20_000)
  }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)
  let managerWs

  t.after(async () => {
    if (managerWs) managerWs.close()
    await stopChild(child)
    for (const ws of deviceWss.clients) ws.terminate()
    await new Promise((resolve) => deviceWss.close(resolve))
    if (deviceHttp.listening) await new Promise((resolve) => deviceHttp.close(resolve))
    for (const socket of [cosmicReceiver, abletonReceiver, deviceUdpReceiver]) {
      try { socket.close() } catch {}
    }
    await rm(manifestsDir, { recursive: true, force: true })
  })

  const getStatus = async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_status`)
    if (!response.ok) throw new Error(`status HTTP ${response.status}`)
    return response.json()
  }
  const lifecyclePackets = () => cosmicPackets.flatMap((raw) => {
    const packet = osc.readPacket(raw, { metadata: true, unpackSingleArgs: false })
    const sourcePath = packet.args?.[1]?.value
    return lifecycleSourcePackets.some((sourceRaw) => {
      const source = osc.readPacket(sourceRaw, { metadata: true, unpackSingleArgs: false })
      return source.address === sourcePath
    })
      ? [{ raw, packet, sourcePath }]
      : []
  })

  await waitFor(async () => {
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) return false
    const body = await response.json()
    return body.devices[0]?.msgCount >= lifecycleSourcePackets.length
  }, 'initial lifecycle state')
  await waitFor(
    () => lifecyclePackets().length >= lifecycleSourcePackets.length * 3,
    'periodic lifecycle replay'
  )

  const firstRunPackets = lifecyclePackets()
  const lifecyclePaths = [
    '/0',
    '/PerformanceController/finger0',
    '/PerformanceController/finger0Playing',
    '/PerformanceController/droneWavelengthsString'
  ]
  for (const sourcePath of lifecyclePaths) {
    const packetsForPath = firstRunPackets.filter((entry) => entry.sourcePath === sourcePath)
    assert.ok(packetsForPath.length >= 2, `${sourcePath} was not replayed\n${logs}`)
    for (const entry of packetsForPath.slice(1)) {
      assert.deepEqual(entry.raw, packetsForPath[0].raw, `${sourcePath} replay changed bytes`)
    }
  }
  const observedPaths = firstRunPackets.map((entry) => entry.sourcePath)
  let orderedCycleFound = false
  for (let i = 0; i <= observedPaths.length - lifecyclePaths.length; i++) {
    if (lifecyclePaths.every((path, offset) => observedPaths[i + offset] === path)) {
      orderedCycleFound = true
      break
    }
  }
  assert.equal(orderedCycleFound, true, `ordered replay cycle not found: ${observedPaths.join(', ')}`)
  assert.equal(
    abletonPackets.length,
    lifecycleSourcePackets.length,
    'periodic CosmicNoise snapshots must not enter the legacy Ableton mirror'
  )

  // Keep only the device session fresh for more than two seconds. A sustained,
  // otherwise quiet drone must remain replayable for receiver-side reset/panic
  // recovery; the heartbeat itself is not a cached lifecycle path.
  const dronePath = '/PerformanceController/droneWavelengthsString'
  const droneBeforeHeartbeat = lifecyclePackets()
    .filter((entry) => entry.sourcePath === dronePath).length
  for (let i = 0; i < 12; i++) {
    sendToDeviceClients([heartbeatPacket])
    await delay(200)
  }
  const afterHeartbeatStatus = await getStatus()
  const droneAfterHeartbeat = lifecyclePackets()
    .filter((entry) => entry.sourcePath === dronePath)
  assert.equal(afterHeartbeatStatus.cosmicNoise.snapshotEntries, 4)
  assert.ok(droneAfterHeartbeat.length > droneBeforeHeartbeat, 'quiet active drone stopped replaying')
  assert.deepEqual(
    droneAfterHeartbeat.at(-1).raw,
    droneAfterHeartbeat[0].raw,
    'long-lived drone replay changed bytes'
  )

  // Once the entire device session goes stale, the cache is destroyed. A
  // later heartbeat can make the connection fresh but cannot revive it.
  await waitFor(async () => (await getStatus()).cosmicNoise.snapshotEntries === 0, 'stale cutoff')
  const staleLifecycleCount = lifecyclePackets().length
  sendToDeviceClients([heartbeatPacket])
  await delay(200)
  assert.equal(lifecyclePackets().length, staleLifecycleCount, 'heartbeat revived stale state')
  assert.equal((await getStatus()).cosmicNoise.snapshotEntries, 0)

  // A new full-state update is allowed to seed replay again.
  const beforeReseed = lifecyclePackets().length
  sendToDeviceClients(lifecycleSourcePackets)
  await waitFor(async () => (await getStatus()).cosmicNoise.snapshotEntries === 4, 'snapshot reseed')
  await waitFor(
    () => lifecyclePackets().length >= beforeReseed + lifecycleSourcePackets.length * 2,
    'reseed replay'
  )

  managerWs = await openManagerWebSocket(managerPort)
  managerWs.send(JSON.stringify({
    type: 'UPDATE_DEVICE',
    deviceId: 7,
    updates: { enabled: false }
  }))
  await waitFor(async () => {
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) return false
    const body = await response.json()
    const status = await getStatus()
    return body.devices[0]?.enabled === false &&
      body.devices[0]?.status === 'disabled' &&
      status.cosmicNoise.snapshotEntries === 0
  }, 'disabled device cache clear')
  await delay(100)
  const disabledLifecycleCount = lifecyclePackets().length
  await delay(200)
  assert.equal(
    lifecyclePackets().length,
    disabledLifecycleCount,
    'disabled device continued snapshot replay'
  )
})
