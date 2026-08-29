import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import osc from 'osc'

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

test('JSON values carry the discovered OSCQuery node TYPE', () => {
  const received = []
  const client = makeClient((path, value, metadata) => received.push({ path, value, metadata }))
  client.nodeTypes.set('/touch/xyz', 'fff')

  client._handleJsonMessage({ FULL_PATH: '/touch/xyz', VALUE: [1, 2, 3] })

  assert.deepEqual(received, [{
    path: '/touch/xyz',
    value: [1, 2, 3],
    metadata: { oscQueryType: 'fff', wireArgs: undefined }
  }])
})

test('binary OSC values carry both node TYPE and original wire argument tags', () => {
  const received = []
  const client = makeClient((path, value, metadata) => received.push({ path, value, metadata }))
  client.nodeTypes.set('/touch/xyz', 'fff')
  const encoded = osc.writePacket({
    address: '/touch/xyz',
    args: [
      { type: 'f', value: 1 },
      { type: 'f', value: 2 },
      { type: 'f', value: 3 }
    ]
  }, { metadata: true, unpackSingleArgs: false })

  client._handleOscBinary(Buffer.from(encoded))

  assert.equal(received.length, 1)
  assert.equal(received[0].path, '/touch/xyz')
  assert.deepEqual(received[0].value, [1, 2, 3])
  assert.equal(received[0].metadata.oscQueryType, 'fff')
  assert.deepEqual(received[0].metadata.wireArgs.map((arg) => arg.type), ['f', 'f', 'f'])
})

test('an inline JSON TYPE applies without growing the namespace TYPE map', () => {
  const received = []
  const client = makeClient((path, value, metadata) => received.push({ path, value, metadata }))

  client._handleJsonMessage({ PATH: '/late/string', TYPE: 's', VALUE: 'hello' })
  client._handleJsonMessage({ PATH: '/late/string', VALUE: 'again' })

  assert.equal(received[0].metadata.oscQueryType, 's')
  assert.equal(received[1].metadata.oscQueryType, undefined)
  assert.equal(client.nodeTypes.has('/late/string'), false)
})

test('refreshing a namespace replaces stale path TYPE metadata', () => {
  const client = makeClient(() => {})
  client.flatNodes = [
    { FULL_PATH: '/old', TYPE: 'i' },
    { FULL_PATH: '/kept', TYPE: 'f' }
  ]
  client._rebuildNodeTypes()
  assert.equal(client.nodeTypes.get('/old'), 'i')

  client.flatNodes = [{ FULL_PATH: '/kept', TYPE: 'd' }]
  client._rebuildNodeTypes()

  assert.equal(client.nodeTypes.has('/old'), false)
  assert.equal(client.nodeTypes.get('/kept'), 'd')
})

test('OSC bundles propagate metadata for every contained message', () => {
  const received = []
  const client = makeClient((path, value, metadata) => received.push({ path, value, metadata }))
  client.nodeTypes.set('/a', 'f')
  client.nodeTypes.set('/b', 's')

  client._processOscPacket({
    packets: [
      { address: '/a', args: [{ type: 'f', value: 1 }] },
      { address: '/b', args: [{ type: 's', value: 'two' }] }
    ]
  })

  assert.deepEqual(received.map((entry) => [
    entry.path,
    entry.metadata.oscQueryType,
    entry.metadata.wireArgs[0].type
  ]), [
    ['/a', 'f', 'f'],
    ['/b', 's', 's']
  ])
})
