// Integration regression tests for hub-hardening fixes:
//   F0-1  malformed /ws/hub payloads must never kill the hub process
//   F0-7/F1-1 SET_DEVICE_PARAM fails closed without HOST_INFO's OSC port,
//             surfaces PARAM_RESULT, retries HOST_INFO with backoff, and only
//             broadcasts the optimistic PATH_CHANGED after a real send
//   F0-10 duplicate-id shadow manifest files are all deleted on remove
//   F0-14 renaming a device clears its old-name namespace entries

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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
      HUB_NAME: `Hub Hardening Integration ${process.pid} ${Date.now()}`,
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

test('malformed /ws/hub payloads produce error results and never kill the hub; duplicate-id shadow files all die on remove', {
  timeout: 30_000
}, async (t) => {
  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-fuzz-'))
  // Three duplicate-id shadow files with distinct hosts (distinct canonical
  // identities, same routing id). Disabled: no connections needed.
  const shadowHosts = ['10.9.9.1', '10.9.9.2', '10.9.9.3']
  await Promise.all(shadowHosts.map((host, index) => writeFile(
    join(manifestsDir, `shadow_${String.fromCharCode(97 + index)}_7.json`),
    JSON.stringify({
      id: 7,
      name: 'ShadowDevice',
      type: 'oscquery-device',
      host,
      oscQueryPort: 5050,
      enabled: false
    }, null, 2) + '\n'
  )))

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
    return body.devices?.some((device) => device.manifestId === 7)
  }, 'shadow device loaded')

  hub = await openHub(managerPort)

  // The hub reports its OSC listener health to every new dashboard client.
  const hubStatus = await waitFor(
    () => hub.messages.find((message) => message.type === 'HUB_STATUS'),
    'HUB_STATUS on connect'
  )
  assert.equal(hubStatus.oscListen, 'ok')

  // Fuzz barrage. Every UPDATE_DEVICE variant must produce ok:false — and
  // none of them may crash the process (pre-fix, updates.name=123 threw an
  // uncaught TypeError and killed the hub).
  const malformedUpdates = [
    { name: 123 },
    { name: null },
    { name: { nested: true } },
    { name: '' },
    { enabled: 'yes' },
    { description: 42 },
    { host: 123 },
    { host: 'not a host !!' },
    { oscQueryPort: 'eighty' },
    { oscQueryPort: 99 },
    'i-am-a-string',
    [1, 2, 3],
    123
  ]
  let expectedFailures = 0
  for (const updates of malformedUpdates) {
    hub.ws.send(JSON.stringify({ type: 'UPDATE_DEVICE', deviceId: 7, updates }))
    expectedFailures++
  }
  // Assorted other junk that must be ignored or answered with errors.
  hub.ws.send('this is not json')
  hub.ws.send(JSON.stringify({ type: 'SET_DEVICE_PARAM', deviceId: 7, path: 123 }))
  hub.ws.send(JSON.stringify({ type: 'SET_DEVICE_PARAM', deviceId: 999, path: '/x' }))
  hub.ws.send(JSON.stringify({ type: 'ANNOUNCE_DEVICE', deviceId: 7, target: { address: {}, port: 'x' } }))
  hub.ws.send(JSON.stringify({ type: 'ADD_DISCOVERED', host: {}, port: 'x' }))
  hub.ws.send(JSON.stringify({ type: 'SET', path: '../../etc/passwd', value: 1 }))

  const failures = await waitFor(() => {
    const results = hub.messages.filter((message) =>
      message.type === 'UPDATE_DEVICE_RESULT' && message.deviceId === 7 && message.ok === false
    )
    return results.length >= expectedFailures ? results : false
  }, 'error results for every malformed UPDATE_DEVICE')
  assert.equal(failures.every((result) => typeof result.error === 'string'), true)

  const paramFailures = await waitFor(() => {
    const results = hub.messages.filter((message) => message.type === 'PARAM_RESULT' && message.ok === false)
    return results.length >= 2 ? results : false
  }, 'PARAM_RESULT failures for malformed SET_DEVICE_PARAM')
  assert.deepEqual(
    paramFailures.map((result) => result.reason).sort(),
    ['invalid-path', 'unknown-device']
  )

  // The hub must still be alive and functional after the barrage.
  assert.equal(child.exitCode, null, `hub process died during fuzzing\n${logs}`)
  hub.ws.send(JSON.stringify({ type: 'UPDATE_DEVICE', deviceId: 7, updates: { name: 'StillAlive' } }))
  await waitFor(() => hub.messages.some((message) =>
    message.type === 'UPDATE_DEVICE_RESULT' && message.ok === true
  ), 'valid UPDATE_DEVICE still works')

  // F0-10: deleting the device must unlink every shadow file, so a reload
  // cannot resurrect it from a middle duplicate.
  hub.ws.send(JSON.stringify({ type: 'REMOVE_DEVICE', deviceId: 7 }))
  await waitFor(async () => {
    const files = (await readdir(manifestsDir)).filter((file) => file.endsWith('.json'))
    return files.length === 0
  }, 'all duplicate-id manifest files removed')
  await delay(300) // allow the post-delete reload to settle
  const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
  const body = await response.json()
  assert.equal(
    body.devices.some((device) => device.manifestId === 7),
    false,
    'no zombie device may be resurrected from a shadow file'
  )
  assert.equal(child.exitCode, null)
})

test('SET_DEVICE_PARAM fails closed without an OSC port, HOST_INFO is retried, and success sends UDP + optimistic update', {
  timeout: 30_000
}, async (t) => {
  // The device's real OSC UDP control port (independent from HTTP, like the VST).
  const oscReceiver = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => {
    oscReceiver.once('error', reject)
    oscReceiver.bind(0, LOOPBACK, resolve)
  })
  const deviceOscPort = oscReceiver.address().port
  const udpPackets = []
  oscReceiver.on('message', (packet) => {
    try { udpPackets.push(osc.readPacket(packet, { metadata: true, unpackSingleArgs: false })) } catch {}
  })

  let hostInfoAvailable = false
  let hostInfoRequests = 0
  const namespace = {
    FULL_PATH: '/',
    CONTENTS: {
      value: { FULL_PATH: '/value', TYPE: 'f', VALUE: [0.25], ACCESS: 3 }
    }
  }
  const deviceServer = http.createServer((req, res) => {
    if (req.url.includes('HOST_INFO')) {
      hostInfoRequests++
      if (!hostInfoAvailable) {
        res.statusCode = 500
        res.end('boom')
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        NAME: 'ParamResultDevice',
        DEVICE_ID: 'param-result-device',
        DEVICE_TYPE: 'OSCQuery',
        OSC_PORT: deviceOscPort,
        OSC_TRANSPORT: 'UDP'
      }))
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(namespace))
  })
  const wss = new WebSocketServer({ server: deviceServer })
  const deviceSockets = new Set()
  wss.on('connection', (ws) => {
    deviceSockets.add(ws)
    ws.on('close', () => deviceSockets.delete(ws))
  })
  await new Promise((resolve, reject) => {
    deviceServer.once('error', reject)
    deviceServer.listen(0, LOOPBACK, resolve)
  })
  const devicePort = deviceServer.address().port

  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-param-result-'))
  await writeFile(join(manifestsDir, 'device.json'), JSON.stringify({
    id: 31,
    name: 'ParamDev',
    type: 'oscquery-device',
    host: LOOPBACK,
    oscQueryPort: devicePort,
    enabled: true
  }, null, 2) + '\n')

  let logs = ''
  const child = spawnHub({
    managerPort,
    managerOscPort,
    manifestsDir,
    extraEnv: { OSCQUERY_HOSTINFO_RETRY_MS: '100' },
    onLog: (chunk) => { logs = `${logs}${chunk.toString()}`.slice(-100_000) }
  })

  let hub
  t.after(async () => {
    try { hub?.ws.terminate() } catch {}
    await stopChild(child)
    for (const ws of wss.clients) ws.terminate()
    await new Promise((resolve) => wss.close(resolve))
    if (deviceServer.listening) {
      await new Promise((resolve) => {
        deviceServer.close(resolve)
        deviceServer.closeAllConnections?.()
      })
    }
    try { oscReceiver.close() } catch {}
    await rm(manifestsDir, { recursive: true, force: true })
  })

  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) return false
    const body = await response.json()
    return body.devices?.some((device) =>
      device.manifestId === 31 && device.connectionState === 'Connected'
    )
  }, 'device connected')

  hub = await openHub(managerPort)

  // Populate the hub namespace so the optimistic-update path is armed.
  const deviceWs = Array.from(deviceSockets)[0]
  assert.ok(deviceWs, 'device WS must be open')
  deviceWs.send(JSON.stringify({ FULL_PATH: '/value', VALUE: [0.25], TYPE: 'f' }))
  await waitFor(() => hub.messages.some((message) =>
    message.type === 'PATH_CHANGED' && message.path === '/ParamDev/value'
  ), 'device value visible on hub')

  // HOST_INFO is still failing: the write must fail closed with a surfaced
  // reason — never fall back to the OSCQuery HTTP port.
  hub.ws.send(JSON.stringify({
    type: 'SET_DEVICE_PARAM',
    deviceId: 31,
    path: '/value',
    value: 0.9,
    requestId: 'req-closed'
  }))
  const closedResult = await waitFor(() => hub.messages.find((message) =>
    message.type === 'PARAM_RESULT' && message.requestId === 'req-closed'
  ), 'fail-closed PARAM_RESULT')
  assert.equal(closedResult.ok, false)
  assert.equal(closedResult.reason, 'osc-port-unknown')

  // No optimistic PATH_CHANGED for the failed write, and nothing on UDP.
  await delay(400)
  assert.equal(
    hub.messages.some((message) =>
      message.type === 'PATH_CHANGED' &&
      message.path === '/ParamDev/value' &&
      Array.isArray(message.value) && Number(message.value[0]) === 0.9
    ),
    false,
    'a failed send must not broadcast the value as applied'
  )
  assert.equal(udpPackets.length, 0, 'nothing may be sent before the OSC port is known')

  // Let HOST_INFO recover: the client's backoff retry must pick it up
  // WITHOUT a reconnect, after which writes succeed end-to-end.
  const failedHostInfoRequests = hostInfoRequests
  assert.ok(failedHostInfoRequests >= 1)
  hostInfoAvailable = true
  let attempt = 0
  const okResult = await waitFor(async () => {
    attempt++
    const requestId = `req-retry-${attempt}`
    hub.ws.send(JSON.stringify({
      type: 'SET_DEVICE_PARAM',
      deviceId: 31,
      path: '/value',
      value: 0.9,
      requestId
    }))
    await delay(250)
    return hub.messages.find((message) =>
      message.type === 'PARAM_RESULT' && message.ok === true
    )
  }, 'PARAM_RESULT ok after HOST_INFO retry', 12_000)
  assert.equal(okResult.ok, true)
  assert.ok(hostInfoRequests > failedHostInfoRequests, 'HOST_INFO must have been retried in the background')

  const packet = await waitFor(() => udpPackets.find((item) => item.address === '/value'), 'UDP write at HOST_INFO OSC port')
  assert.ok(Math.abs(Number(packet.args[0].value) - 0.9) < 1e-6)
  await waitFor(() => hub.messages.some((message) =>
    message.type === 'PATH_CHANGED' &&
    message.path === '/ParamDev/value' &&
    Array.isArray(message.value) && Math.abs(Number(message.value[0]) - 0.9) < 1e-6
  ), 'optimistic PATH_CHANGED after a real send')

  // Unknown path on a synced tree: fail closed with 'unknown-path', nothing
  // on UDP — the device would drop the write while the hub reported ok.
  const udpCountBefore = udpPackets.length
  hub.ws.send(JSON.stringify({
    type: 'SET_DEVICE_PARAM',
    deviceId: 31,
    path: '/no/such/node',
    value: 1,
    requestId: 'req-unknown-path'
  }))
  const unknownPathResult = await waitFor(() => hub.messages.find((message) =>
    message.type === 'PARAM_RESULT' && message.requestId === 'req-unknown-path'
  ), 'unknown-path PARAM_RESULT')
  assert.equal(unknownPathResult.ok, false)
  assert.equal(unknownPathResult.reason, 'unknown-path')
  await delay(300)
  assert.equal(udpPackets.length, udpCountBefore, 'unknown path must not reach UDP')

  // F0-14: renaming clears the old-name namespace entries.
  hub.ws.send(JSON.stringify({ type: 'UPDATE_DEVICE', deviceId: 31, updates: { name: 'ParamDevRenamed' } }))
  await waitFor(() => hub.messages.some((message) =>
    message.type === 'UPDATE_DEVICE_RESULT' && message.deviceId === 31 && message.ok === true
  ), 'rename saved')
  await waitFor(async () => {
    const tree = await (await fetch(`http://${LOOPBACK}:${managerPort}/`)).json()
    return !tree.CONTENTS?.ParamDev
  }, 'old-name namespace entries cleared after rename')
})
