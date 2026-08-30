import { fork } from 'node:child_process'
import express from 'express'
import { fileURLToPath } from 'node:url'

const SUPERVISOR_PORT = Number(process.env.SUPERVISOR_PORT || 7399)
const HUB_PORT = Number(process.env.PORT || 7400)
const OSC_PORT = Number(process.env.OSC_LISTEN_PORT || 9001)
const START_TIMEOUT_MS = Number(process.env.HUB_START_TIMEOUT_MS || 7000)
const STOP_TIMEOUT_MS = Number(process.env.HUB_STOP_TIMEOUT_MS || 3500)
const HUB_ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

const app = express()
app.use(express.json())

let child = null
let generation = 0
let state = 'Stopped'
let lastError = null
let startedAt = null
let operation = Promise.resolve()
let supervisorStopping = false
const expectedExits = new WeakSet()

function snapshot() {
  return {
    service: 'Manager Bridge',
    state,
    pid: child?.pid || null,
    ports: {
      http: HUB_PORT,
      websocket: HUB_PORT,
      oscUdp: OSC_PORT
    },
    startedAt,
    error: lastError
  }
}

function waitForExit(target, timeoutMs) {
  if (!target || target.exitCode != null || target.signalCode != null) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(killTimeout)
      clearTimeout(hardTimeout)
      resolve()
    }
    const killTimeout = setTimeout(() => {
      try { target.kill('SIGKILL') } catch {}
    }, timeoutMs)
    // SIGKILL is asynchronous too. Wait for the actual exit so a restart does
    // not race the old process while it still owns HTTP/UDP ports.
    const hardTimeout = setTimeout(finish, timeoutMs + 1000)
    target.once('exit', finish)
  })
}

async function stopHub({ restarting = false } = {}) {
  const target = child
  if (!target) {
    if (!restarting) state = 'Stopped'
    return snapshot()
  }
  if (restarting) state = 'Restarting'
  expectedExits.add(target)
  try { target.kill('SIGTERM') } catch {}
  await waitForExit(target, STOP_TIMEOUT_MS)
  if (child === target) child = null
  if (!restarting) {
    state = 'Stopped'
    startedAt = null
  }
  return snapshot()
}

async function startHub({ restarting = false } = {}) {
  // A serialized start/restart that dequeues after SIGTERM must not fork a
  // hub the dying supervisor will orphan.
  if (supervisorStopping) {
    state = 'Stopped'
    return snapshot()
  }
  if (child && state === 'Running') return snapshot()
  const currentGeneration = ++generation
  state = 'Restarting'
  lastError = null

  const target = fork(HUB_ENTRY, [], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(HUB_PORT), OSC_LISTEN_PORT: String(OSC_PORT) },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })
  child = target

  return new Promise((resolve) => {
    let settled = false
    const finish = (nextState, error = null) => {
      if (settled || currentGeneration !== generation) return
      settled = true
      clearTimeout(timeout)
      state = nextState
      lastError = error
      if (nextState === 'Running') startedAt = new Date().toISOString()
      resolve(snapshot())
    }

    const timeout = setTimeout(async () => {
      if (currentGeneration !== generation) return
      lastError = `Manager Bridge did not bind within ${START_TIMEOUT_MS} ms`
      try { target.kill('SIGTERM') } catch {}
      await waitForExit(target, STOP_TIMEOUT_MS)
      if (child === target) child = null
      finish('Error', lastError)
    }, START_TIMEOUT_MS)

    target.on('message', (message) => {
      if (message?.type === 'ready') finish('Running')
    })
    target.once('error', (error) => finish('Error', error.message))
    target.once('exit', (code, signal) => {
      if (child === target) child = null
      if (currentGeneration !== generation || supervisorStopping || expectedExits.has(target)) return
      const error = `Manager Bridge exited unexpectedly (${signal || code})`
      if (settled) {
        state = 'Error'
        lastError = error
        startedAt = null
      } else {
        finish('Error', error)
      }
    })
  })
}

function serialize(action) {
  operation = operation.then(action, action)
  return operation
}

app.get('/api/manager/status', (_req, res) => res.json(snapshot()))

app.post('/api/manager/start', async (_req, res) => {
  res.json(await serialize(() => startHub()))
})

app.post('/api/manager/stop', async (_req, res) => {
  res.json(await serialize(() => stopHub()))
})

app.post('/api/manager/restart', async (_req, res) => {
  res.json(await serialize(async () => {
    state = 'Restarting'
    await stopHub({ restarting: true })
    return startHub({ restarting: true })
  }))
})

const controlServer = app.listen(SUPERVISOR_PORT, '127.0.0.1', async () => {
  console.log(`[supervisor] Manager Bridge control plane: http://127.0.0.1:${SUPERVISOR_PORT}`)
  await serialize(() => startHub())
})

async function shutdown(signal) {
  if (supervisorStopping) return
  supervisorStopping = true
  generation++
  console.log(`[supervisor] shutting down (${signal})`)
  // Order the final stop behind any in-flight serialized operation; its
  // startHub now no-ops via the supervisorStopping guard above.
  await serialize(() => stopHub())
  controlServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), STOP_TIMEOUT_MS + 500).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
