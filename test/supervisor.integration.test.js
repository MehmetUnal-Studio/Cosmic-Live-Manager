import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import dgram from 'node:dgram'
import net from 'node:net'
import os from 'node:os'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const LOOPBACK = '127.0.0.1'
const execFileAsync = promisify(execFile)

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function freeTcpPort(excluded = new Set()) {
  while (true) {
    const server = net.createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, LOOPBACK, resolve)
    })
    const port = server.address().port
    await new Promise((resolve) => server.close(resolve))
    if (!excluded.has(port)) return port
  }
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

async function waitFor(check, description, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(30)
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`)
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGINT')
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(6500).then(() => false)
  ])
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}

async function requestJson(url, method = 'GET') {
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw new Error(`${method} ${url} returned HTTP ${response.status}`)
  return response.json()
}

async function lsofPids(args) {
  try {
    const { stdout } = await execFileAsync('lsof', [...args, '-Fp'], {
      timeout: 3000,
      maxBuffer: 1024 * 1024
    })
    return Array.from(new Set(
      stdout.split(/\r?\n/)
        .map((line) => line.match(/^p(\d+)$/)?.[1])
        .filter(Boolean)
        .map(Number)
    )).sort((a, b) => a - b)
  } catch (error) {
    if (error?.code === 1) return []
    throw error
  }
}

function closeTcp(server) {
  if (!server?.listening) return Promise.resolve()
  return new Promise((resolve) => server.close(resolve))
}

function closeUdp(socket) {
  if (!socket) return Promise.resolve()
  return new Promise((resolve) => {
    try {
      socket.close(resolve)
    } catch {
      resolve()
    }
  })
}

async function portsAreBindable(tcpPort, udpPort) {
  const tcp = net.createServer()
  const udp = dgram.createSocket('udp4')
  try {
    await new Promise((resolve, reject) => {
      tcp.once('error', reject)
      tcp.listen(tcpPort, LOOPBACK, resolve)
    })
    await new Promise((resolve, reject) => {
      udp.once('error', reject)
      udp.bind(udpPort, LOOPBACK, resolve)
    })
    return true
  } catch (error) {
    if (error?.code === 'EADDRINUSE') return false
    throw error
  } finally {
    await closeUdp(udp)
    await closeTcp(tcp)
  }
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
    connectionState: device.connectionState
  }
}

test('supervisor repeatedly stop/starts/restarts one hub without losing manifest settings', {
  timeout: 60_000
}, async (t) => {
  const supervisorPort = await freeTcpPort()
  const managerPort = await freeTcpPort(new Set([supervisorPort]))
  const managerOscPort = await freeUdpPort()
  const manifestsDir = await mkdtemp(join(os.tmpdir(), 'cosmic-manager-supervisor-lifecycle-'))
  const manifestPath = join(manifestsDir, 'durable-device.json')
  const manifest = {
    id: 73,
    name: 'DurableSupervisorDevice',
    type: 'oscquery-device',
    deviceType: 'OSCQuery',
    canonicalId: 'oscquery:uuid:supervisor-lifecycle-device',
    persistentDeviceId: 'supervisor-lifecycle-device',
    serviceName: 'Durable Supervisor Device',
    host: LOOPBACK,
    oscQueryPort: 19090,
    enabled: false,
    description: 'These bytes and routing settings must survive every lifecycle operation',
    endpoints: [{
      host: LOOPBACK,
      port: 19090,
      source: 'saved-setting',
      lastSeen: 987654321
    }],
    legacyIds: [4, 11, 29]
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(manifestPath, manifestBytes)

  let logs = ''
  const knownHubPids = new Set()
  const supervisor = spawn(process.execPath, ['server/supervisor.js'], {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      SUPERVISOR_PORT: String(supervisorPort),
      PORT: String(managerPort),
      OSC_LISTEN_PORT: String(managerOscPort),
      HUB_START_TIMEOUT_MS: '7000',
      HUB_STOP_TIMEOUT_MS: '3500',
      ABLETON_FORWARD: '0',
      COSMICNOISE_FORWARD: '0',
      COSMICNOISE_SNAPSHOT_MS: '0',
      HUB_NAME: `Supervisor Lifecycle Integration ${process.pid} ${Date.now()}`,
      MANIFESTS_DIR: manifestsDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const captureLog = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-150_000)
  }
  supervisor.stdout.on('data', captureLog)
  supervisor.stderr.on('data', captureLog)

  const controlUrl = `http://${LOOPBACK}:${supervisorPort}/api/manager`
  const managerUrl = `http://${LOOPBACK}:${managerPort}`

  t.after(async () => {
    await stopProcess(supervisor)
    for (const pid of knownHubPids) {
      if (isPidAlive(pid)) {
        try { process.kill(pid, 'SIGTERM') } catch {}
      }
    }
    await rm(manifestsDir, { recursive: true, force: true })
  })

  const getStatus = async () => {
    if (supervisor.exitCode !== null) throw new Error(`Supervisor exited early\n${logs}`)
    return requestJson(`${controlUrl}/status`)
  }

  const waitForRunning = async (description) => {
    const status = await waitFor(async () => {
      const snapshot = await getStatus()
      if (snapshot.state === 'Error') {
        throw new Error(`${snapshot.error || 'unknown supervisor error'}\n${logs}`)
      }
      return snapshot.state === 'Running' && Number.isInteger(snapshot.pid)
        ? snapshot
        : false
    }, description)
    knownHubPids.add(status.pid)
    return status
  }

  const assertManifestAndDevice = async (expectedStable) => {
    const body = await waitFor(async () => {
      const result = await requestJson(`${managerUrl}/_devices`)
      const matches = result.devices.filter((device) =>
        device.manifestId === manifest.id ||
        device.canonicalId === manifest.canonicalId ||
        device.persistentDeviceId === manifest.persistentDeviceId
      )
      return matches.length === 1 ? { result, device: matches[0] } : false
    }, 'one durable registry card')
    assert.equal(body.result.self.port, managerPort)
    const stable = stableDeviceFields(body.device)
    if (expectedStable) assert.deepEqual(stable, expectedStable)
    assert.deepEqual(await readFile(manifestPath), manifestBytes)
    return stable
  }

  const assertOnlyCurrentHubOwnsPorts = async (pid) => {
    const owners = await waitFor(async () => {
      const tcp = await lsofPids(['-nP', '-a', `-iTCP:${managerPort}`, '-sTCP:LISTEN'])
      const udp = await lsofPids(['-nP', '-a', `-iUDP:${managerOscPort}`])
      return tcp.length === 1 && tcp[0] === pid && udp.length === 1 && udp[0] === pid
        ? { tcp, udp }
        : false
    }, `hub PID ${pid} to exclusively own TCP/UDP listeners`)
    assert.deepEqual(owners.tcp, [pid])
    assert.deepEqual(owners.udp, [pid])
  }

  const assertStopped = async (oldPid) => {
    await waitFor(() => !isPidAlive(oldPid), `old hub PID ${oldPid} to exit`)
    await waitFor(
      () => portsAreBindable(managerPort, managerOscPort),
      'stopped hub ports to be bindable'
    )
    assert.deepEqual(
      await lsofPids(['-nP', '-a', `-iTCP:${managerPort}`, '-sTCP:LISTEN']),
      []
    )
    assert.deepEqual(await lsofPids(['-nP', '-a', `-iUDP:${managerOscPort}`]), [])
    assert.deepEqual(await readFile(manifestPath), manifestBytes)
  }

  let current = await waitForRunning('supervisor auto-start')
  let stableSettings = await assertManifestAndDevice()
  assert.deepEqual(stableSettings, {
    id: manifest.id,
    manifestId: manifest.id,
    canonicalId: manifest.canonicalId,
    persistentDeviceId: manifest.persistentDeviceId,
    deviceType: manifest.deviceType,
    name: manifest.name,
    serviceName: manifest.serviceName,
    host: manifest.host,
    port: manifest.oscQueryPort,
    oscQueryPort: manifest.oscQueryPort,
    saved: true,
    enabled: false,
    connectionState: 'Disabled'
  })
  await assertOnlyCurrentHubOwnsPorts(current.pid)

  for (let round = 1; round <= 2; round++) {
    const stopped = await requestJson(`${controlUrl}/stop`, 'POST')
    assert.equal(stopped.state, 'Stopped', `round ${round}: stop state`)
    assert.equal(stopped.pid, null, `round ${round}: stopped PID`)
    await assertStopped(current.pid)

    // A repeated stop is intentionally idempotent and must not touch disk.
    const stoppedAgain = await requestJson(`${controlUrl}/stop`, 'POST')
    assert.equal(stoppedAgain.state, 'Stopped', `round ${round}: repeated stop state`)
    assert.equal(await portsAreBindable(managerPort, managerOscPort), true)
    assert.deepEqual(await readFile(manifestPath), manifestBytes)

    const started = await requestJson(`${controlUrl}/start`, 'POST')
    assert.equal(started.state, 'Running', `round ${round}: start state\n${logs}`)
    assert.notEqual(started.pid, current.pid, `round ${round}: start must use a new PID`)
    current = await waitForRunning(`round ${round} start`)
    knownHubPids.add(current.pid)
    await assertOnlyCurrentHubOwnsPorts(current.pid)
    await assertManifestAndDevice(stableSettings)

    // A repeated start keeps the one existing hub rather than forking another.
    const startedAgain = await requestJson(`${controlUrl}/start`, 'POST')
    assert.equal(startedAgain.state, 'Running', `round ${round}: repeated start state`)
    assert.equal(startedAgain.pid, current.pid, `round ${round}: repeated start PID`)
    await assertOnlyCurrentHubOwnsPorts(current.pid)

    const oldPid = current.pid
    const restarted = await requestJson(`${controlUrl}/restart`, 'POST')
    assert.equal(restarted.state, 'Running', `round ${round}: restart state\n${logs}`)
    assert.notEqual(restarted.pid, oldPid, `round ${round}: restart must replace the PID`)
    knownHubPids.add(restarted.pid)
    await waitFor(() => !isPidAlive(oldPid), `round ${round} pre-restart PID ${oldPid} to exit`)
    current = await waitForRunning(`round ${round} restart`)
    assert.equal(current.pid, restarted.pid)
    await assertOnlyCurrentHubOwnsPorts(current.pid)
    await assertManifestAndDevice(stableSettings)
  }
})
