import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { OscQueryClient } from '../server/oscqueryClient.js'

function makeClient(onValue) {
  return new OscQueryClient('127.0.0.1', 9000, {
    onConnect() {},
    onDisconnect() {},
    onValue,
    onLog() {}
  })
}

function waitForAttemptFailure(client, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('attempt did not fail')), timeoutMs)
    client.events.onAttemptFailed = (reason, details) => {
      clearTimeout(timeout)
      resolve({ reason, details })
    }
  })
}

test('connection attempt owns one hard deadline and cleans its pending resources', async (t) => {
  const hanging = http.createServer(() => {})
  await new Promise((resolve, reject) => {
    hanging.once('error', reject)
    hanging.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => {
    hanging.close(resolve)
    hanging.closeAllConnections?.()
  }))

  const client = new OscQueryClient('127.0.0.1', hanging.address().port, {
    onConnect() {},
    onDisconnect() {},
    onValue() {},
    onLog() {}
  }, { attemptTimeoutMs: 120, reconnectDelayMs: 60_000 })
  const failed = waitForAttemptFailure(client)
  const startedAt = Date.now()
  client.connect()

  const result = await failed
  const elapsedMs = Date.now() - startedAt
  client.disconnect()

  assert.equal(result.details.timeout, true)
  assert.match(result.reason, /timed out after 120 ms/)
  assert.ok(elapsedMs >= 100 && elapsedMs < 600, `deadline fired after ${elapsedMs} ms`)
  assert.equal(client.isConnected(), false)
  assert.equal(client.ws, null)
  assert.equal(client.fetchControllers.size, 0)
  assert.equal(client.attemptTimer, null)
})

test('production connection deadline defaults to exactly three seconds', () => {
  const client = makeClient(() => {})
  assert.equal(client.attemptTimeoutMs, 3000)
  client.disconnect()
})
