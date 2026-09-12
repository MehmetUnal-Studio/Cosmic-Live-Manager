// A device card must be able to answer "is this instrument speaking NOW", not
// only "how many messages since the hub booted". The hub therefore ships a
// per-second rate in the same tick as the lifetime counter, and the rate must
// fall back to zero on its own when a device goes quiet — otherwise a frozen
// instrument would keep looking alive for the rest of the show.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import osc from 'osc'
import WebSocket, { WebSocketServer } from 'ws'

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const LOOPBACK = '127.0.0.1'
const DEVICE_ID = 3

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  const port = await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, LOOPBACK, () => resolve(socket.address().port))
  })
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

test('the hub reports a live per-device rate that decays when the device goes quiet', {
  timeout: 40_000
}, async (t) => {
  // ─── A fake OSCQuery device that streams on demand ──────────────────────
  const namespace = {
    FULL_PATH: '/',
    CONTENTS: {
      pulse: { FULL_PATH: '/pulse', TYPE: 'f', VALUE: [0], ACCESS: 3 }
    }
  }
  const deviceUdpPort = await freeUdpPort()
  const deviceHttp = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.includes('HOST_INFO')) {
      res.end(JSON.stringify({
        NAME: 'RateProbe',
        OSC_PORT: deviceUdpPort,
        OSC_TRANSPORT: 'UDP'
      }))
      return
    }
    res.end(JSON.stringify(namespace))
  })
  const deviceWss = new WebSocketServer({ server: deviceHttp })
  let streaming = false
  let streamTimer = null
  deviceWss.on('connection', (ws) => {
    streamTimer = setInterval(() => {
      if (!streaming || ws.readyState !== WebSocket.OPEN) return
      ws.send(Buffer.from(osc.writePacket({
        address: '/pulse',
        args: [{ type: 'f', value: Math.random() }]
      }, { metadata: true, unpackSingleArgs: false })))
    }, 20) // ~50 msg/s
  })
  await new Promise((resolve, reject) => {
    deviceHttp.once('error', reject)
    deviceHttp.listen(0, LOOPBACK, resolve)
  })
  const deviceHttpPort = deviceHttp.address().port

  // ─── The hub, isolated from the real rig ────────────────────────────────
  const managerPort = await freeTcpPort()
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'clm-rate-test-'))
  await writeFile(join(manifestsDir, 'probe.json'), JSON.stringify({
    id: DEVICE_ID,
    name: 'RateProbe',
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
      ABLETON_FORWARD: '0',
      COSMICNOISE_FORWARD: '0',
      HUB_NAME: `CLM Rate Integration ${process.pid}`,
      MANIFESTS_DIR: manifestsDir,
      KEEP_MANIFESTS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => { logs = `${logs}${chunk.toString()}`.slice(-20_000) }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)

  let managerWs = null
  t.after(async () => {
    if (streamTimer) clearInterval(streamTimer)
    if (managerWs) try { managerWs.terminate() } catch {}
    for (const ws of deviceWss.clients) ws.terminate()
    await new Promise((resolve) => deviceWss.close(resolve))
    if (deviceHttp.listening) await new Promise((resolve) => deviceHttp.close(resolve))
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGINT')
      const exited = await Promise.race([
        new Promise((resolve) => child.once('exit', () => resolve(true))),
        delay(2000).then(() => false)
      ])
      if (!exited) child.kill('SIGKILL')
    }
  })

  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`hub exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    return response.ok
  }, `hub HTTP on ${managerPort}`)

  managerWs = new WebSocket(`ws://${LOOPBACK}:${managerPort}/ws/hub`)
  await new Promise((resolve, reject) => {
    managerWs.once('open', resolve)
    managerWs.once('error', reject)
  })

  const ticks = []
  managerWs.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.type === 'DEVICE_MSG_COUNTS') ticks.push(msg)
  })

  // ─── Streaming: the rate must reflect the real traffic ───────────────────
  streaming = true
  const busy = await waitFor(
    () => ticks.find((tick) => (tick.rates?.[DEVICE_ID] ?? 0) > 5),
    `a non-trivial rate for device ${DEVICE_ID}\n${logs}`
  )
  assert.ok(busy.counts[DEVICE_ID] > 0, 'a streaming device has a lifetime count')
  assert.ok(
    busy.rates[DEVICE_ID] > 5 && busy.rates[DEVICE_ID] < 500,
    `rate ${busy.rates[DEVICE_ID]} should be near the ~50/s the fake device sends`
  )
  assert.equal(typeof busy.abletonTotal, 'number')

  // ─── Quiet: the rate must fall back to zero on its own ───────────────────
  streaming = false
  const countWhenQuieted = busy.counts[DEVICE_ID]
  const idle = await waitFor(
    () => ticks.find((tick) => tick.counts[DEVICE_ID] >= countWhenQuieted
      && (tick.rates?.[DEVICE_ID] ?? -1) === 0),
    `the rate to decay to zero\n${logs}`
  )
  assert.ok(
    idle.counts[DEVICE_ID] >= countWhenQuieted,
    'the lifetime counter never goes backwards when a device falls silent'
  )

  // The lifetime counter keeps counting from where it was — a quiet moment
  // must not reset the device's history.
  streaming = true
  const resumed = await waitFor(
    () => ticks.find((tick) => tick.counts[DEVICE_ID] > idle.counts[DEVICE_ID]
      && (tick.rates?.[DEVICE_ID] ?? 0) > 0),
    `the counter to resume after the pause\n${logs}`
  )
  assert.ok(resumed.counts[DEVICE_ID] > idle.counts[DEVICE_ID])
  streaming = false
})
