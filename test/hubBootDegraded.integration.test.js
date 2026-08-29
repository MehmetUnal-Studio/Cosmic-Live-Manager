// F0-2 regression: a busy OSC UDP listen port must not silently skip the
// hub boot. Manifests and device state must load anyway, the hub must report
// HUB_STATUS oscListen:'degraded' over /ws/hub, and the bind must be retried
// with backoff until the port frees up — at which point the status flips to
// 'ok' without a restart.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import net from 'node:net'
import os from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

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

test('a busy OSC UDP port boots the hub degraded with all manifests, then recovers via bind retry', {
  timeout: 30_000
}, async (t) => {
  // Occupy the UDP port on the wildcard address so the hub's 0.0.0.0 bind fails.
  const blocker = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => {
    blocker.once('error', reject)
    blocker.bind(0, '0.0.0.0', resolve)
  })
  const busyOscPort = blocker.address().port

  const managerPort = await freeTcpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-degraded-boot-'))
  await writeFile(join(manifestsDir, 'device.json'), JSON.stringify({
    id: 61,
    name: 'DegradedBootDevice',
    type: 'oscquery-device',
    host: '10.10.10.61',
    oscQueryPort: 5061,
    enabled: false
  }, null, 2) + '\n')

  let logs = ''
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      PORT: String(managerPort),
      OSC_LISTEN_PORT: String(busyOscPort),
      ABLETON_FORWARD: '0',
      COSMICNOISE_FORWARD: '0',
      COSMICNOISE_SNAPSHOT_MS: '0',
      HUB_NAME: `Degraded Boot Integration ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => { logs = `${logs}${chunk.toString()}`.slice(-100_000) }
  child.stdout.on('data', captureLog)
  child.stderr.on('data', captureLog)

  let hub
  let blockerClosed = false
  t.after(async () => {
    try { hub?.terminate() } catch {}
    await stopChild(child)
    if (!blockerClosed) {
      try { await new Promise((resolve) => blocker.close(resolve)) } catch {}
    }
    await rm(manifestsDir, { recursive: true, force: true })
  })

  // Pre-fix, an EADDRINUSE on the UDP port meant bootHub() never ran: zero
  // manifests, zero devices, while the HTTP server said everything was fine.
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Manager exited early\n${logs}`)
    const response = await fetch(`http://${LOOPBACK}:${managerPort}/_devices`)
    if (!response.ok) return false
    const body = await response.json()
    return body.devices?.some((device) => device.manifestId === 61)
  }, 'manifests loaded despite the busy UDP port')

  const messages = []
  hub = new WebSocket(`ws://${LOOPBACK}:${managerPort}/ws/hub`)
  hub.on('message', (raw) => {
    try { messages.push(JSON.parse(raw.toString())) } catch {}
  })
  await new Promise((resolve, reject) => {
    hub.once('open', resolve)
    hub.once('error', reject)
  })

  const degraded = await waitFor(
    () => messages.find((message) => message.type === 'HUB_STATUS'),
    'HUB_STATUS on connect'
  )
  assert.equal(degraded.oscListen, 'degraded', logs)
  assert.match(logs, /retrying UDP bind/)

  // Free the port: a backoff retry must bind and flip the status to 'ok'.
  blockerClosed = true
  await new Promise((resolve) => blocker.close(resolve))
  const recovered = await waitFor(
    () => messages.find((message) => message.type === 'HUB_STATUS' && message.oscListen === 'ok'),
    'HUB_STATUS ok after the port freed up',
    15_000
  )
  assert.equal(recovered.oscListen, 'ok')
  assert.equal(child.exitCode, null)
})
