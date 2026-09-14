// The hub pings every managed OSCQuery WebSocket to catch half-open sockets.
// But not every OSCQuery server answers WS control pings — TouchDesigner's Web
// Server DAT only pongs if its callbacks DAT sends one, and a build that lost
// that handler is fully alive yet pong-silent: its HTTP answers instantly and
// it streams OSC as binary WS frames. So "no pong" alone must NOT be read as
// "dead", or the hub tears the Ring instrument down every ~13 s mid-show.
//
// Equally, HTTP reachability is NOT WebSocket liveness: a server whose HTTP
// answers while its WS push path is wedged must still be recycled, or the
// instrument goes dark forever with no self-heal.
//
// Liveness policy exercised here:
//   A. A device that answers pings rides one socket.                 (classic)
//   B. A device that never pongs but STREAMS data rides one socket.  (TD played)
//   C. A device that neither pongs nor answers HTTP is torn down.     (dead)
//   D. A device that never pongs, sends nothing, but answers HTTP is
//      tolerated for a bounded number of rescues, then recycled so a
//      wedged WS cannot hide behind a live HTTP endpoint.            (wedged)

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

const PULSE = Buffer.from(osc.writePacket(
  { address: '/value', args: [{ type: 'f', value: 0.5 }] },
  { metadata: true, unpackSingleArgs: false }
))

// A fake OSCQuery device.
//   autoPong      — whether its WebSocket answers the hub's control pings.
//   stream        — push a binary OSC frame every ~60 ms on every connection
//                   (a pong-silent server that is nevertheless alive and busy).
//   setHttpAlive  — false makes HTTP stop responding (requests hang until the
//                   client aborts): a host that dropped off the network while
//                   its TCP socket lingers half-open.
async function createDevice({ name, deviceId, autoPong, stream = false }) {
  const namespace = {
    FULL_PATH: '/',
    CONTENTS: {
      value: { FULL_PATH: '/value', TYPE: 'f', VALUE: [0.5], ACCESS: 3 }
    }
  }
  let connectionCount = 0
  let httpAlive = true
  const hungRequests = new Set()
  const pumps = new Set()
  const server = http.createServer((req, res) => {
    if (!httpAlive) {
      hungRequests.add(res)
      req.on('close', () => hungRequests.delete(res))
      return
    }
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
  const wss = new WebSocketServer({ server, autoPong })
  wss.on('connection', (ws) => {
    connectionCount++
    if (!stream) return
    const pump = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(PULSE)
    }, 60)
    pumps.add(pump)
    ws.on('close', () => { clearInterval(pump); pumps.delete(pump) })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK, resolve)
  })
  return {
    port: server.address().port,
    get connectionCount() { return connectionCount },
    setHttpAlive(v) { httpAlive = v },
    async stop() {
      for (const pump of pumps) clearInterval(pump)
      for (const res of hungRequests) { try { res.destroy() } catch {} }
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

test('liveness: ponging and streaming stay up; wedged is bounded; dark is torn down', {
  timeout: 45_000
}, async (t) => {
  const healthy = await createDevice({
    name: 'Healthy', deviceId: 'ka-healthy', autoPong: true
  })
  // TouchDesigner being played: never pongs, but streams OSC over the WS.
  const streaming = await createDevice({
    name: 'Streaming', deviceId: 'ka-streaming', autoPong: false, stream: true
  })
  // HTTP alive, but the WS neither pongs nor delivers anything — a wedged push
  // path (or an idle pong-less server; the hub cannot tell them apart, and must
  // err toward recycling so a real wedge never hides forever).
  const wedged = await createDevice({
    name: 'Wedged', deviceId: 'ka-wedged', autoPong: false
  })
  // Genuine half-open: never pongs, and we cut its HTTP mid-test.
  const dead = await createDevice({
    name: 'Dead', deviceId: 'ka-dead', autoPong: false
  })

  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-keepalive-'))
  const write = (file, id, port) => writeFile(join(manifestsDir, file), JSON.stringify({
    id, name: file.replace('.json', ''), type: 'oscquery-device',
    host: LOOPBACK, oscQueryPort: port, enabled: true
  }, null, 2) + '\n')
  await write('healthy.json', 72, healthy.port)
  await write('streaming.json', 73, streaming.port)
  await write('wedged.json', 74, wedged.port)
  await write('dead.json', 75, dead.port)

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
    await healthy.stop()
    await streaming.stop()
    await wedged.stop()
    await dead.stop()
    await rm(manifestsDir, { recursive: true, force: true })
  })

  const getDevices = async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) throw new Error(`devices HTTP ${response.status}`)
    return (await response.json()).devices
  }
  const stateOf = (devices, id) => devices.find((d) => d.manifestId === id)?.connectionState

  await waitFor(async () => {
    const d = await getDevices()
    return [72, 73, 74, 75].every((id) => stateOf(d, id) === 'Connected')
  }, 'all four devices initially connected')
  for (const d of [healthy, streaming, wedged, dead]) assert.equal(d.connectionCount, 1)

  // Many keepalive cycles at 150 ms. Ping every tick, terminate-threshold after
  // 2 misses (~300 ms), bounded HTTP rescues after that.
  await delay(3500)

  // A + B: the ponging device and the pong-silent-but-streaming device must
  // each ride their ORIGINAL socket — the whole point of the fix.
  assert.equal(healthy.connectionCount, 1, 'a ponging device must never be cycled')
  assert.equal(
    streaming.connectionCount, 1,
    'a pong-silent device that streams data must never be cycled (inbound frames are proof of life)'
  )
  const mid = await getDevices()
  assert.equal(stateOf(mid, 72), 'Connected')
  assert.equal(stateOf(mid, 73), 'Connected')

  // D: the wedged device (HTTP alive, WS silent) was rescued by HTTP a bounded
  // number of times and then recycled — it must NOT hang on one dead socket
  // forever. It reconnects (HTTP is up) and the cycle repeats.
  assert.ok(
    wedged.connectionCount >= 2,
    `a wedged socket (HTTP alive, no pong, no data) must be recycled, got ${wedged.connectionCount} connection(s)`
  )
  assert.match(logs, /recycling wedged socket/)
  // ...and the log shows it was first tolerated as pong-silent-but-alive.
  assert.match(logs, /HTTP alive — treating as live/)

  // C: cut the dead device's HTTP too. With neither pong, data, nor HTTP, the
  // hub must terminate the half-open socket via the HTTP-unreachable path.
  dead.setHttpAlive(false)
  await waitFor(
    async () => stateOf(await getDevices(), 75) !== 'Connected',
    'a fully dark device (no pong, no data, no HTTP) is terminated',
    15_000
  )
  assert.match(logs, /HTTP unreachable — terminating half-open WS/)

  // The healthy and streaming devices are untouched by all of the above.
  const end = await getDevices()
  assert.equal(stateOf(end, 72), 'Connected', 'healthy device unaffected')
  assert.equal(stateOf(end, 73), 'Connected', 'streaming device unaffected')
  assert.equal(healthy.connectionCount, 1)
  assert.equal(streaming.connectionCount, 1, 'streaming device never cycled across the whole test')
})
