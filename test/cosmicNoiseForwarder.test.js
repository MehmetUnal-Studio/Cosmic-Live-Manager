import test from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import osc from 'osc'

import {
  COSMICNOISE_ADDRESS,
  DEFAULT_COSMICNOISE_HOST,
  DEFAULT_COSMICNOISE_PORT,
  DEFAULT_COSMICNOISE_SNAPSHOT_MS,
  MAX_PAYLOAD_ARGS,
  MAX_SOURCE_PATH_BYTES,
  MAX_STRING_BYTES,
  SNAPSHOT_FRESHNESS_MS,
  CosmicNoiseForwardError,
  CosmicNoiseForwarder,
  cosmicNoiseConfigFromEnv,
  encodeCosmicNoiseInput
} from '../server/cosmicNoiseForwarder.js'

function decode(packet) {
  return osc.readPacket(packet, { metadata: true, unpackSingleArgs: false })
}

function types(packet) {
  return packet.args.map((arg) => arg.type).join('')
}

function values(packet) {
  return packet.args.map((arg) => arg.value)
}

test('v1 envelope keeps an integer-looking OSCQuery float as f', () => {
  const packet = decode(encodeCosmicNoiseInput({
    deviceId: 3,
    sourcePath: '/synth/cutoff',
    payload: 1,
    oscQueryType: 'f'
  }))

  assert.equal(packet.address, COSMICNOISE_ADDRESS)
  assert.equal(types(packet), 'isf')
  assert.deepEqual(values(packet), [3, '/synth/cutoff', 1])
})

test('TYPE=fff keeps all values and the original three-float arity', () => {
  const packet = decode(encodeCosmicNoiseInput({
    deviceId: 12,
    sourcePath: '/touch/xyz',
    payload: [1, 2.5, -3],
    oscQueryType: 'fff'
  }))

  assert.equal(types(packet), 'isfff')
  assert.deepEqual(values(packet), [12, '/touch/xyz', 1, 2.5, -3])
})

test('v1 supports mixed f/i/s/T/F/d values without dropping payload args', () => {
  const payload = [0.25, 7, 'Crème 🚀', true, false, Math.PI]
  const packet = decode(encodeCosmicNoiseInput({
    deviceId: -4,
    sourcePath: '/mixed',
    payload,
    oscQueryType: ',fisTFd'
  }))

  assert.equal(types(packet), 'isfisTFd')
  assert.deepEqual(values(packet), [-4, '/mixed', ...payload])
})

test('binary wire metadata is used when OSCQuery TYPE is unavailable', () => {
  const packet = decode(encodeCosmicNoiseInput({
    deviceId: 1,
    sourcePath: '/wire/vector',
    payload: [1, 2, 3],
    wireArgs: [
      { type: 'f', value: 1 },
      { type: 'f', value: 2 },
      { type: 'f', value: 3 }
    ]
  }))

  assert.equal(types(packet), 'isfff')
})

test('incompatible boolean declarations preserve actual int32 wire feedback', () => {
  for (const value of [0, 1]) {
    const packet = decode(encodeCosmicNoiseInput({
      deviceId: 1,
      sourcePath: '/heartbeat',
      payload: value,
      oscQueryType: 'T',
      wireArgs: [{ type: 'i', value }]
    }))
    assert.equal(types(packet), 'isi')
    assert.deepEqual(values(packet), [1, '/heartbeat', value])
  }
})

test('a one-value OSCQuery TF boolean declaration emits its current T/F tag', () => {
  const packet = decode(encodeCosmicNoiseInput({
    deviceId: 2,
    sourcePath: '/enabled',
    payload: false,
    oscQueryType: 'TF'
  }))

  assert.equal(types(packet), 'isF')
  assert.deepEqual(values(packet), [2, '/enabled', false])
})

test('encoder rejects excessive args and malformed typed values', () => {
  const maximumArityPacket = decode(encodeCosmicNoiseInput({
    deviceId: 1,
    sourcePath: '/maximum-arity',
    payload: new Array(MAX_PAYLOAD_ARGS).fill(0),
    oscQueryType: 'i'.repeat(MAX_PAYLOAD_ARGS)
  }))
  assert.equal(maximumArityPacket.args.length, 32)

  assert.throws(
    () => encodeCosmicNoiseInput({
      deviceId: 1,
      sourcePath: '/too-many',
      payload: new Array(MAX_PAYLOAD_ARGS + 1).fill(0)
    }),
    (error) => error instanceof CosmicNoiseForwardError && error.code === 'TOO_MANY_ARGS'
  )

  assert.throws(
    () => encodeCosmicNoiseInput({
      deviceId: 1,
      sourcePath: '/bad-int',
      payload: 2147483648,
      oscQueryType: 'i'
    }),
    (error) => error instanceof CosmicNoiseForwardError && error.code === 'INVALID_INT32'
  )

  assert.throws(
    () => encodeCosmicNoiseInput({
      deviceId: 1,
      sourcePath: '/wrong-arity',
      payload: [1, 2],
      oscQueryType: 'fff'
    }),
    (error) => error instanceof CosmicNoiseForwardError && error.code === 'TYPE_ARITY_MISMATCH'
  )

  assert.throws(
    () => encodeCosmicNoiseInput({
      deviceId: 1,
      sourcePath: '/unsupported',
      payload: 1,
      oscQueryType: 'h'
    }),
    (error) => error instanceof CosmicNoiseForwardError && error.code === 'UNSUPPORTED_TYPE'
  )

  assert.throws(
    () => encodeCosmicNoiseInput({
      deviceId: 1,
      sourcePath: '/missing-float',
      payload: [],
      oscQueryType: 'f'
    }),
    (error) => error instanceof CosmicNoiseForwardError && error.code === 'TYPE_ARITY_MISMATCH'
  )

  assert.throws(
    () => encodeCosmicNoiseInput({
      deviceId: 1,
      sourcePath: '/oversized-type',
      payload: 1,
      oscQueryType: 'f'.repeat(MAX_PAYLOAD_ARGS + 1)
    }),
    (error) => error instanceof CosmicNoiseForwardError && error.code === 'TOO_MANY_ARGS'
  )
})

test('encoder bounds source strings, payload strings, and final datagram size', () => {
  assert.throws(
    () => encodeCosmicNoiseInput({
      deviceId: 1,
      sourcePath: `/${'x'.repeat(MAX_SOURCE_PATH_BYTES)}`,
      payload: 0
    }),
    (error) => error instanceof CosmicNoiseForwardError && error.code === 'STRING_TOO_LARGE'
  )

  assert.throws(
    () => encodeCosmicNoiseInput({
      deviceId: 1,
      sourcePath: '/string',
      payload: 'x'.repeat(MAX_STRING_BYTES + 1),
      oscQueryType: 's'
    }),
    (error) => error instanceof CosmicNoiseForwardError && error.code === 'STRING_TOO_LARGE'
  )

  const large = 'x'.repeat(MAX_STRING_BYTES)
  assert.throws(
    () => encodeCosmicNoiseInput({
      deviceId: 1,
      sourcePath: '/packet',
      payload: [large, large, large, large],
      oscQueryType: 'ssss'
    }),
    (error) => error instanceof CosmicNoiseForwardError && error.code === 'PACKET_TOO_LARGE'
  )
})

test('environment parser provides defaults and honors explicit settings', () => {
  assert.deepEqual(cosmicNoiseConfigFromEnv({}), {
    enabled: true,
    host: DEFAULT_COSMICNOISE_HOST,
    port: DEFAULT_COSMICNOISE_PORT,
    snapshotMs: DEFAULT_COSMICNOISE_SNAPSHOT_MS
  })
  assert.deepEqual(cosmicNoiseConfigFromEnv({
    COSMICNOISE_FORWARD: '0',
    COSMICNOISE_HOST: 'localhost',
    COSMICNOISE_PORT: '12001'
  }), {
    enabled: false,
    host: 'localhost',
    port: 12001,
    snapshotMs: DEFAULT_COSMICNOISE_SNAPSHOT_MS
  })
  assert.deepEqual(cosmicNoiseConfigFromEnv({
    COSMICNOISE_FORWARD: '0',
    COSMICNOISE_HOST: ' ',
    COSMICNOISE_PORT: 'not-a-port'
  }), {
    enabled: false,
    host: DEFAULT_COSMICNOISE_HOST,
    port: DEFAULT_COSMICNOISE_PORT,
    snapshotMs: DEFAULT_COSMICNOISE_SNAPSHOT_MS
  })
  assert.equal(cosmicNoiseConfigFromEnv({ COSMICNOISE_SNAPSHOT_MS: '0' }).snapshotMs, 0)
  assert.throws(
    () => cosmicNoiseConfigFromEnv({ COSMICNOISE_PORT: '70000' }),
    (error) => error instanceof CosmicNoiseForwardError && error.code === 'INVALID_PORT'
  )
  assert.throws(
    () => cosmicNoiseConfigFromEnv({ COSMICNOISE_SNAPSHOT_MS: '-1' }),
    (error) => error instanceof CosmicNoiseForwardError && error.code === 'INVALID_SNAPSHOT_MS'
  )
})

test('forwarder sends one packet to its target and disabled mode is inert', () => {
  const sends = []
  const fakeSocket = {
    send(packet, port, host, callback) {
      sends.push({ packet, port, host })
      callback()
    }
  }
  const forwarder = new CosmicNoiseForwarder({ socket: fakeSocket, logger: { warn() {} } })

  assert.equal(forwarder.forward({
    deviceId: 9,
    sourcePath: '/name',
    payload: 'Cosmic Unity',
    oscQueryType: 's'
  }), true)
  assert.equal(forwarder.sent, 1)
  assert.equal(sends.length, 1)
  assert.equal(sends[0].host, DEFAULT_COSMICNOISE_HOST)
  assert.equal(sends[0].port, DEFAULT_COSMICNOISE_PORT)
  assert.equal(types(decode(sends[0].packet)), 'iss')

  const disabled = new CosmicNoiseForwarder({ enabled: false, socket: fakeSocket })
  assert.equal(disabled.forward({ deviceId: 9, sourcePath: '/ignored', payload: 1 }), false)
  assert.equal(sends.length, 1)
})

test('snapshot replay is byte-exact and copies caller-owned payload/type metadata', () => {
  let now = 1_000
  const sends = []
  const fakeSocket = {
    send(packet, _port, _host, callback) {
      sends.push(Buffer.from(packet))
      callback()
    }
  }
  const forwarder = new CosmicNoiseForwarder({
    socket: fakeSocket,
    snapshotMs: 250,
    logger: { warn() {} },
    now: () => now
  })
  const payload = [0, 0.25, 0.5, 0.75]
  const wireArgs = payload.map((value) => ({ type: 'f', value }))

  assert.equal(forwarder.forward({
    deviceId: 4,
    sourcePath: '/0',
    payload,
    oscQueryType: 'ffff',
    wireArgs
  }, { cacheSnapshot: true, receivedAt: now }), true)
  assert.equal(forwarder.snapshotDevices, 1)
  assert.equal(forwarder.snapshotEntries, 1)
  const initialPacket = Buffer.from(sends[0])

  // Mutation by the caller after ingress must not alter the cached packet or
  // its diagnostic metadata.
  payload[0] = 1
  wireArgs[0].type = 'i'
  const entry = forwarder.snapshotCache.get(4).get('/0')
  assert.equal(Object.isFrozen(entry.input), true)
  assert.equal(Object.isFrozen(entry.input.payload), true)
  assert.equal(Object.isFrozen(entry.input.wireArgs), true)
  assert.deepEqual(entry.input.payload, [0, 0.25, 0.5, 0.75])
  assert.equal(entry.input.wireArgs[0].type, 'f')

  now = 1_999
  assert.equal(forwarder.replaySnapshots(() => true), 1)
  assert.deepEqual(sends[1], initialPacket)

  now = 3_500
  assert.equal(forwarder.replaySnapshots(() => false), 0)
  assert.equal(forwarder.snapshotEntries, 0)
  assert.equal(forwarder.snapshotReplayed, 1)
})

test('a quiet active drone survives beyond 2 seconds while its device session stays fresh', () => {
  const sends = []
  const forwarder = new CosmicNoiseForwarder({
    socket: {
      send(packet, _port, _host, callback) {
        sends.push(Buffer.from(packet))
        callback()
      }
    },
    snapshotMs: 250,
    logger: { warn() {} }
  })
  forwarder.forward({
    deviceId: 5,
    sourcePath: '/PerformanceController/droneWavelengthsString',
    payload: '1 0.5 0.25',
    oscQueryType: 's'
  }, { cacheSnapshot: true, receivedAt: 1_000 })
  const initialPacket = Buffer.from(sends[0])

  let predicateNow
  assert.equal(forwarder.replaySnapshots((_deviceId, now) => {
    predicateNow = now
    return true // the Manager has observed a fresh heartbeat/session message
  }, 3_500), 1)
  assert.equal(predicateNow, 3_500)
  assert.deepEqual(sends[1], initialPacket)
  assert.equal(forwarder.snapshotEntries, 1)

  // A stale/disconnected device clears the whole session cache. A later
  // heartbeat alone cannot recreate the removed drone state.
  assert.equal(forwarder.replaySnapshots(() => false, 3_501), 0)
  assert.equal(forwarder.snapshotEntries, 0)
  assert.equal(forwarder.replaySnapshots(() => true, 3_502), 0)
})

test('snapshot cache only keeps full lifecycle state and replays position before Playing', () => {
  const sends = []
  const fakeSocket = {
    send(packet, _port, _host, callback) {
      sends.push(Buffer.from(packet))
      callback()
    }
  }
  const forwarder = new CosmicNoiseForwarder({
    socket: fakeSocket,
    snapshotMs: 250,
    logger: { warn() {} },
    now: () => 5_000
  })
  const cache = (sourcePath, payload, oscQueryType, wireArgs) => {
    assert.equal(forwarder.forward({
      deviceId: 7,
      sourcePath,
      payload,
      oscQueryType,
      wireArgs
    }, { cacheSnapshot: true, receivedAt: 5_000 }), true)
  }

  // The latest full state must win, including explicit stop/removal values.
  cache('/0', [1, 0.1, 0.2, 0.3], 'ffff')
  cache('/0', [0, 0.1, 0.2, 0.3], 'ffff')
  cache('/PerformanceController/finger2Playing', [0], 'T', [{ type: 'i', value: 0 }])
  cache('/PerformanceController/droneWavelengthsString', ['1 0.5'], 's')
  cache('/PerformanceController/droneWavelengthsString', ['0'], 's')
  cache('/PerformanceController/finger2', [0.4, 0.5, 0.6], 'fff')

  // Similar-looking paths, the heartbeat, and wrong full-state arities are
  // forwarded once but must never enter the replay cache.
  cache('/10', [1, 0.1, 0.2, 0.3], 'ffff')
  cache('/00', [1, 0.1, 0.2, 0.3], 'ffff')
  cache('/PerformanceController/finger10', [0.4, 0.5, 0.6], 'fff')
  cache('/PerformanceController/heartbeat', [1], 'i')
  cache('/1', [0.1, 0.2, 0.3], 'fff')
  assert.equal(forwarder.snapshotEntries, 4)

  sends.length = 0
  assert.equal(forwarder.replaySnapshots(() => true, 5_250), 4)
  const replay = sends.map(decode)
  assert.deepEqual(replay.map((packet) => packet.args[1].value), [
    '/0',
    '/PerformanceController/finger2',
    '/PerformanceController/finger2Playing',
    '/PerformanceController/droneWavelengthsString'
  ])
  assert.equal(types(replay[0]), 'isffff')
  assert.deepEqual(values(replay[0]).slice(0, 3), [7, '/0', 0])
  assert.deepEqual(values(replay[2]), [7, '/PerformanceController/finger2Playing', 0])
  assert.deepEqual(values(replay[3]), [7, '/PerformanceController/droneWavelengthsString', '0'])
})

test('snapshot replay is inert when disabled and clears state for an ineligible device', () => {
  const sends = []
  const fakeSocket = {
    send(packet, _port, _host, callback) {
      sends.push(Buffer.from(packet))
      callback()
    }
  }
  const disabledSnapshot = new CosmicNoiseForwarder({
    socket: fakeSocket,
    snapshotMs: 0,
    logger: { warn() {} }
  })
  disabledSnapshot.forward({
    deviceId: 1,
    sourcePath: '/1',
    payload: [0, 0, 0, 0],
    oscQueryType: 'ffff'
  }, { cacheSnapshot: true, receivedAt: 1_000 })
  assert.equal(disabledSnapshot.snapshotEntries, 0)
  assert.equal(disabledSnapshot.replaySnapshots(() => true, 1_250), 0)

  const active = new CosmicNoiseForwarder({
    socket: fakeSocket,
    snapshotMs: 250,
    logger: { warn() {} }
  })
  active.forward({
    deviceId: 2,
    sourcePath: '/2',
    payload: [0, 0, 0, 0],
    oscQueryType: 'ffff'
  }, { cacheSnapshot: true, receivedAt: 1_000 })
  assert.equal(active.snapshotEntries, 1)
  assert.equal(active.replaySnapshots(() => false, 1_250), 0)
  assert.equal(active.snapshotEntries, 0)
  assert.equal(active.replaySnapshots(() => true, 1_500), 0)
})

test('an asynchronous UDP callback error is counted as error, not sent', () => {
  const forwarder = new CosmicNoiseForwarder({
    socket: {
      send(_packet, _port, _host, callback) {
        callback(new Error('unreachable'))
      }
    },
    logger: { warn() {} }
  })

  assert.equal(forwarder.forward({ deviceId: 1, sourcePath: '/value', payload: 1 }), true)
  assert.equal(forwarder.sent, 0)
  assert.equal(forwarder.errors, 1)
})

test('forwarder sends a decodable packet over a real UDP loopback socket', async (t) => {
  const receiver = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => {
    receiver.once('error', reject)
    receiver.bind(0, DEFAULT_COSMICNOISE_HOST, resolve)
  })
  const port = receiver.address().port
  const forwarder = new CosmicNoiseForwarder({
    host: DEFAULT_COSMICNOISE_HOST,
    port,
    logger: { warn() {} }
  })
  t.after(() => {
    forwarder.close()
    try { receiver.close() } catch {}
  })

  const received = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('loopback packet timed out')), 1000)
    receiver.once('message', (packet) => {
      clearTimeout(timeout)
      resolve(packet)
    })
  })

  assert.equal(forwarder.forward({
    deviceId: 6,
    sourcePath: '/loopback',
    payload: [1, 'ok'],
    oscQueryType: 'fs'
  }), true)
  const packet = decode(await received)
  assert.equal(packet.address, COSMICNOISE_ADDRESS)
  assert.equal(types(packet), 'isfs')
  assert.deepEqual(values(packet), [6, '/loopback', 1, 'ok'])
})

test('forwarder drops invalid input without throwing and rate-limits warnings', () => {
  const warnings = []
  const forwarder = new CosmicNoiseForwarder({
    socket: { send() { throw new Error('should not send') } },
    logger: { warn(message) { warnings.push(message) } }
  })

  for (let i = 0; i < 5; i++) {
    assert.equal(forwarder.forward({ deviceId: 1, sourcePath: 'missing-slash', payload: 1 }), false)
  }
  assert.equal(forwarder.dropped, 5)
  assert.equal(warnings.length, 3)
})
