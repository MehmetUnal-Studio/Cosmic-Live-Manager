// CosmicNoise protocol v1 forwarder.
//
// Every value received from a managed OSCQuery device is mirrored as one OSC
// message. The envelope is stable and intentionally small:
//
//   /cosmicnoise/v1/input  int32 deviceId, string sourcePath, ...source args
//
// OSCQuery TYPE metadata is preferred over JavaScript type inference. This is
// important because JavaScript cannot distinguish an OSC float32 value such as
// 1.0 from an OSC int32 value, and because multi-value nodes such as TYPE=fff
// must keep their original arity.

import dgram from 'node:dgram'
import osc from 'osc'

export const COSMICNOISE_ADDRESS = '/cosmicnoise/v1/input'
export const DEFAULT_COSMICNOISE_HOST = '127.0.0.1'
export const DEFAULT_COSMICNOISE_PORT = 10001
export const DEFAULT_COSMICNOISE_SNAPSHOT_MS = 250
export const MAX_COSMICNOISE_SNAPSHOT_MS = 60_000

// Keep well below the maximum UDP datagram size and reject hostile/unbounded
// input before it can allocate an oversized packet.
// These limits match the CosmicNoise v1 C++ decoder: 32 total OSC args
// (deviceId + sourcePath + at most 30 source args), 1024-byte strings, and a
// 4096-byte UDP packet buffer.
export const MAX_PAYLOAD_ARGS = 30
export const MAX_SOURCE_PATH_BYTES = 1024
export const MAX_STRING_BYTES = 1024
export const MAX_PACKET_BYTES = 4096
export const MAX_SNAPSHOT_DEVICES = 256
export const MAX_SNAPSHOT_ENTRIES_PER_DEVICE = 31
export const SNAPSHOT_FRESHNESS_MS = 1000

const SUPPORTED_TYPES = new Set(['f', 'i', 's', 'T', 'F', 'd'])
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
const FLOAT32_MAX = 3.4028234663852886e38

export class CosmicNoiseForwardError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CosmicNoiseForwardError'
    this.code = code
  }
}

function reject(code, message) {
  throw new CosmicNoiseForwardError(code, message)
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

function paddedOscStringBytes(value) {
  return Math.ceil((byteLength(value) + 1) / 4) * 4
}

function validateOscString(value, label, maxBytes) {
  if (typeof value !== 'string') reject('INVALID_STRING', `${label} must be a string`)
  if (value.includes('\0')) reject('INVALID_STRING', `${label} cannot contain a NUL byte`)
  const bytes = byteLength(value)
  if (bytes > maxBytes) {
    reject('STRING_TOO_LARGE', `${label} is ${bytes} bytes; maximum is ${maxBytes}`)
  }
}

function normalizedTypeString(type) {
  if (typeof type !== 'string') return ''
  const trimmed = type.trim()
  return trimmed.startsWith(',') ? trimmed.slice(1) : trimmed
}

function typeTagsFromMetadata(type, payload) {
  if (type !== undefined && type !== null && typeof type !== 'string') {
    reject('INVALID_TYPE', 'OSCQuery TYPE must be a string')
  }
  if (typeof type === 'string' && type.length > MAX_PAYLOAD_ARGS + 1) {
    reject('TOO_MANY_ARGS', `OSCQuery TYPE exceeds ${MAX_PAYLOAD_ARGS} payload tags`)
  }
  const normalized = normalizedTypeString(type)
  if (!normalized) return null
  if (normalized.length > MAX_PAYLOAD_ARGS) {
    reject('TOO_MANY_ARGS', `OSCQuery TYPE exceeds ${MAX_PAYLOAD_ARGS} payload tags`)
  }

  const tags = [...normalized]
  const unsupported = tags.find((tag) => !SUPPORTED_TYPES.has(tag))
  if (unsupported) {
    reject('UNSUPPORTED_TYPE', `OSCQuery TYPE contains unsupported tag ${unsupported}`)
  }

  // Some OSCQuery implementations advertise a boolean node as TF/FT while
  // carrying one boolean VALUE. OSC itself encodes the current value in the
  // T/F tag, so collapse that declaration to the actual one-value tag.
  if (
    payload.length === 1 &&
    typeof payload[0] === 'boolean' &&
    tags.length >= 1 &&
    tags.every((tag) => tag === 'T' || tag === 'F')
  ) {
    return [payload[0] ? 'T' : 'F']
  }

  if (tags.length !== payload.length) {
    reject(
      'TYPE_ARITY_MISMATCH',
      `OSCQuery TYPE declares ${tags.length} args but payload has ${payload.length}`
    )
  }
  return tags.map((tag, index) => {
    if ((tag === 'T' || tag === 'F') && typeof payload[index] === 'boolean') {
      return payload[index] ? 'T' : 'F'
    }
    return tag
  })
}

function typeTagsFromWireArgs(wireArgs, payload) {
  if (wireArgs === undefined || wireArgs === null) return null
  if (!Array.isArray(wireArgs) || wireArgs.length !== payload.length) {
    reject('WIRE_ARITY_MISMATCH', 'wire argument metadata does not match payload arity')
  }
  const tags = wireArgs.map((arg) => normalizedTypeString(arg?.type))
  const unsupported = tags.find((tag) => tag.length !== 1 || !SUPPORTED_TYPES.has(tag))
  if (unsupported !== undefined) {
    reject('UNSUPPORTED_TYPE', `wire metadata contains unsupported tag ${unsupported || '<empty>'}`)
  }
  return tags.map((tag, index) => {
    if ((tag === 'T' || tag === 'F') && typeof payload[index] === 'boolean') {
      return payload[index] ? 'T' : 'F'
    }
    return tag
  })
}

function inferredTypeTag(value) {
  if (typeof value === 'boolean') return value ? 'T' : 'F'
  if (typeof value === 'string') return 's'
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    reject('UNSUPPORTED_VALUE', `unsupported payload value type: ${typeof value}`)
  }
  if (Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX) return 'i'
  // Use float64 when inference is the only option and float32 would overflow.
  return Math.abs(value) <= FLOAT32_MAX ? 'f' : 'd'
}

function isTypeCompatibleWithValue(type, value) {
  if (type === 'i') {
    return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX
  }
  if (type === 'f') {
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= FLOAT32_MAX
  }
  if (type === 'd') return typeof value === 'number' && Number.isFinite(value)
  if (type === 's') return typeof value === 'string'
  if (type === 'T' || type === 'F') return typeof value === 'boolean'
  return false
}

function areTypesCompatibleWithPayload(types, payload) {
  return types.every((type, index) => isTypeCompatibleWithValue(type, payload[index]))
}

function validateTypedValue(type, value, index) {
  const label = `payload[${index}]`
  if (type === 'i') {
    if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
      reject('INVALID_INT32', `${label} is not a signed int32`)
    }
    return
  }
  if (type === 'f') {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > FLOAT32_MAX) {
      reject('INVALID_FLOAT32', `${label} is not a finite float32 value`)
    }
    return
  }
  if (type === 'd') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      reject('INVALID_FLOAT64', `${label} is not a finite float64 value`)
    }
    return
  }
  if (type === 's') {
    validateOscString(value, label, MAX_STRING_BYTES)
    return
  }
  if (type === 'T' || type === 'F') {
    if (typeof value !== 'boolean') reject('INVALID_BOOLEAN', `${label} must be boolean`)
    return
  }
  reject('UNSUPPORTED_TYPE', `unsupported OSC type ${type}`)
}

/**
 * Encode one managed-device value as a CosmicNoise v1 OSC packet.
 *
 * @param {{
 *   deviceId: number,
 *   sourcePath: string,
 *   payload: any[] | any,
 *   oscQueryType?: string,
 *   wireArgs?: Array<{type: string, value?: any}>
 * }} input
 * @returns {Buffer}
 */
function prepareCosmicNoiseInput(input) {
  const { deviceId, sourcePath, oscQueryType, wireArgs } = input || {}
  const payload = Array.isArray(input?.payload) ? input.payload : [input?.payload]

  if (!Number.isInteger(deviceId) || deviceId < INT32_MIN || deviceId > INT32_MAX) {
    reject('INVALID_DEVICE_ID', 'deviceId must be a signed int32')
  }
  validateOscString(sourcePath, 'sourcePath', MAX_SOURCE_PATH_BYTES)
  if (!sourcePath.startsWith('/')) reject('INVALID_SOURCE_PATH', 'sourcePath must start with /')
  if (payload.length > MAX_PAYLOAD_ARGS) {
    reject('TOO_MANY_ARGS', `payload has ${payload.length} args; maximum is ${MAX_PAYLOAD_ARGS}`)
  }

  const declaredTypes = typeTagsFromMetadata(oscQueryType, payload)
  let types = declaredTypes
  if (declaredTypes && !areTypesCompatibleWithPayload(declaredTypes, payload)) {
    // A few real OSCQuery servers advertise a boolean TYPE=T but emit binary
    // feedback as int32 0/1. When the declaration cannot represent the value,
    // prefer the actual wire tags instead of dropping or coercing the payload.
    const wireTypes = typeTagsFromWireArgs(wireArgs, payload)
    if (wireTypes && areTypesCompatibleWithPayload(wireTypes, payload)) types = wireTypes
  } else if (!declaredTypes) {
    types = typeTagsFromWireArgs(wireArgs, payload)
  }
  if (!types) types = payload.map(inferredTypeTag)

  const sourceArgs = payload.map((value, index) => {
    const type = types[index]
    validateTypedValue(type, value, index)
    return { type, value }
  })

  // Exact OSC message size: padded address + padded type-tag string + encoded
  // arguments. Check it before asking the OSC library to allocate the packet.
  const typeTag = `,is${types.join('')}`
  const payloadBytes = sourceArgs.reduce((total, arg) => {
    if (arg.type === 's') return total + paddedOscStringBytes(arg.value)
    if (arg.type === 'd') return total + 8
    if (arg.type === 'T' || arg.type === 'F') return total
    return total + 4
  }, 0)
  const projectedPacketBytes =
    paddedOscStringBytes(COSMICNOISE_ADDRESS) +
    paddedOscStringBytes(typeTag) +
    4 + // deviceId int32
    paddedOscStringBytes(sourcePath) +
    payloadBytes
  if (projectedPacketBytes > MAX_PACKET_BYTES) {
    reject(
      'PACKET_TOO_LARGE',
      `packet is ${projectedPacketBytes} bytes; maximum is ${MAX_PACKET_BYTES}`
    )
  }

  let encoded
  try {
    encoded = osc.writePacket(
      {
        address: COSMICNOISE_ADDRESS,
        args: [
          { type: 'i', value: deviceId },
          { type: 's', value: sourcePath },
          ...sourceArgs
        ]
      },
      { metadata: true, unpackSingleArgs: false }
    )
  } catch (error) {
    reject('ENCODE_FAILED', `OSC encode failed: ${error.message}`)
  }

  const packet = Buffer.from(encoded)
  if (packet.length > MAX_PACKET_BYTES) {
    reject('PACKET_TOO_LARGE', `packet is ${packet.length} bytes; maximum is ${MAX_PACKET_BYTES}`)
  }
  return { packet, sourceTypes: types }
}

export function encodeCosmicNoiseInput(input) {
  return prepareCosmicNoiseInput(input).packet
}

function classifyLifecycleSnapshot(sourcePath, sourceTypes) {
  const typeString = sourceTypes.join('')
  const fastFinger = /^\/([0-9])$/.exec(sourcePath)
  if (fastFinger) {
    return typeString === 'ffff'
      ? { order: Number(fastFinger[1]) }
      : null
  }

  const standardFinger = /^\/PerformanceController\/finger([0-9])$/.exec(sourcePath)
  if (standardFinger) {
    return typeString === 'fff'
      ? { order: 100 + Number(standardFinger[1]) * 2 }
      : null
  }

  const standardPlaying = /^\/PerformanceController\/finger([0-9])Playing$/.exec(sourcePath)
  if (standardPlaying) {
    const isFullPlayingState = sourceTypes.length === 1 && ['i', 'T', 'F'].includes(sourceTypes[0])
    return isFullPlayingState
      ? { order: 101 + Number(standardPlaying[1]) * 2 }
      : null
  }

  if (sourcePath === '/PerformanceController/droneWavelengthsString') {
    return typeString === 's' ? { order: 200 } : null
  }
  return null
}

function immutableSnapshotInput(input) {
  const payload = Object.freeze([
    ...(Array.isArray(input.payload) ? input.payload : [input.payload])
  ])
  const wireArgs = Array.isArray(input.wireArgs)
    ? Object.freeze(input.wireArgs.map((arg) => Object.freeze({
        type: arg.type,
        value: arg.value
      })))
    : undefined
  return Object.freeze({
    deviceId: input.deviceId,
    sourcePath: input.sourcePath,
    payload,
    oscQueryType: input.oscQueryType,
    wireArgs
  })
}

export function cosmicNoiseConfigFromEnv(env = process.env) {
  const enabled = env.COSMICNOISE_FORWARD !== '0'
  const host = String(env.COSMICNOISE_HOST || DEFAULT_COSMICNOISE_HOST).trim()
  const port = Number(env.COSMICNOISE_PORT || DEFAULT_COSMICNOISE_PORT)
  const snapshotMs = Number(
    env.COSMICNOISE_SNAPSHOT_MS === undefined
      ? DEFAULT_COSMICNOISE_SNAPSHOT_MS
      : env.COSMICNOISE_SNAPSHOT_MS
  )
  const hostIsValid = Boolean(host) && host.length <= 253 && !/\s/.test(host)
  const portIsValid = Number.isInteger(port) && port >= 1 && port <= 65535
  const snapshotMsIsValid =
    Number.isInteger(snapshotMs) && snapshotMs >= 0 && snapshotMs <= MAX_COSMICNOISE_SNAPSHOT_MS

  // A disabled optional mirror must never prevent the Manager or the legacy
  // Ableton output from starting because of an irrelevant stale target value.
  if (!enabled) {
    return {
      enabled,
      host: hostIsValid ? host : DEFAULT_COSMICNOISE_HOST,
      port: portIsValid ? port : DEFAULT_COSMICNOISE_PORT,
      snapshotMs: snapshotMsIsValid ? snapshotMs : DEFAULT_COSMICNOISE_SNAPSHOT_MS
    }
  }
  if (!hostIsValid) {
    reject('INVALID_HOST', 'COSMICNOISE_HOST must be a non-empty host without whitespace')
  }
  if (!portIsValid) {
    reject('INVALID_PORT', 'COSMICNOISE_PORT must be an integer from 1 to 65535')
  }
  if (!snapshotMsIsValid) {
    reject(
      'INVALID_SNAPSHOT_MS',
      `COSMICNOISE_SNAPSHOT_MS must be an integer from 0 to ${MAX_COSMICNOISE_SNAPSHOT_MS}`
    )
  }
  return { enabled, host, port, snapshotMs }
}

export class CosmicNoiseForwarder {
  /**
   * @param {{
   *   enabled?: boolean,
   *   host?: string,
   *   port?: number,
   *   snapshotMs?: number,
   *   socket?: import('node:dgram').Socket,
   *   logger?: Pick<Console, 'warn'>,
   *   now?: () => number
   * }} options
   */
  constructor(options = {}) {
    this.enabled = options.enabled ?? true
    this.host = options.host || DEFAULT_COSMICNOISE_HOST
    this.port = options.port ?? DEFAULT_COSMICNOISE_PORT
    this.snapshotMs = options.snapshotMs ?? DEFAULT_COSMICNOISE_SNAPSHOT_MS
    this.logger = options.logger || console
    this.now = options.now || Date.now
    this.sent = 0
    this.dropped = 0
    this.errors = 0
    this.snapshotReplayed = 0
    this.snapshotDropped = 0
    this.reportedErrors = 0
    /** @type {Map<number, Map<string, any>>} */
    this.snapshotCache = new Map()
    this.ownsSocket = this.enabled && !options.socket
    this.socket = this.enabled ? (options.socket || dgram.createSocket('udp4')) : null
    if (this.ownsSocket) {
      // Contain socket-level failures too; without an error listener Node would
      // treat an emitted dgram error as an uncaught process error.
      this.socket.on('error', (error) => {
        this.errors++
        this._warn(`UDP socket error: ${error.message}`)
      })
    }
  }

  forward(input, options = {}) {
    if (!this.enabled) return false

    let prepared
    try {
      prepared = prepareCosmicNoiseInput(input)
    } catch (error) {
      this.dropped++
      this._warn(`dropped value: ${error.message}`)
      return false
    }

    if (options.cacheSnapshot === true) {
      const receivedAt = Number.isFinite(options.receivedAt)
        ? options.receivedAt
        : this.now()
      this._cacheLifecycleSnapshot(input, prepared, receivedAt)
    }
    return this._sendPacket(prepared.packet, false)
  }

  _sendPacket(packet, isSnapshotReplay) {
    try {
      this.socket.send(packet, this.port, this.host, (error) => {
        if (error) {
          this.errors++
          this._warn(`UDP send failed: ${error.message}`)
          return
        }
        this.sent++
        if (isSnapshotReplay) this.snapshotReplayed++
      })
      return true
    } catch (error) {
      this.errors++
      this._warn(`UDP send failed: ${error.message}`)
      return false
    }
  }

  _cacheLifecycleSnapshot(input, prepared, receivedAt) {
    if (this.snapshotMs === 0) return false
    const descriptor = classifyLifecycleSnapshot(input.sourcePath, prepared.sourceTypes)
    if (!descriptor) return false

    let deviceCache = this.snapshotCache.get(input.deviceId)
    if (!deviceCache) {
      if (this.snapshotCache.size >= MAX_SNAPSHOT_DEVICES) {
        this.snapshotDropped++
        this._warn(`snapshot device limit reached (${MAX_SNAPSHOT_DEVICES})`)
        return false
      }
      deviceCache = new Map()
      this.snapshotCache.set(input.deviceId, deviceCache)
    }
    if (
      !deviceCache.has(input.sourcePath) &&
      deviceCache.size >= MAX_SNAPSHOT_ENTRIES_PER_DEVICE
    ) {
      this.snapshotDropped++
      this._warn(`snapshot entry limit reached for device ${input.deviceId}`)
      return false
    }

    deviceCache.set(input.sourcePath, Object.freeze({
      order: descriptor.order,
      receivedAt,
      input: immutableSnapshotInput(input),
      packet: Buffer.from(prepared.packet)
    }))
    return true
  }

  replaySnapshots(canReplayDevice, now = this.now()) {
    if (!this.enabled || this.snapshotMs === 0 || this.snapshotCache.size === 0) return 0
    let attempts = 0
    const deviceIds = [...this.snapshotCache.keys()].sort((a, b) => a - b)
    for (const deviceId of deviceIds) {
      let canReplay = false
      try { canReplay = canReplayDevice(deviceId, now) === true } catch {}
      if (!canReplay) {
        // Once a state becomes stale/disconnected, do not let a later heartbeat
        // revive that old note-on/drone state. A new lifecycle value must seed
        // a new snapshot first.
        this.clearDeviceSnapshots(deviceId)
        continue
      }

      const deviceCache = this.snapshotCache.get(deviceId)
      const entries = [...deviceCache.entries()]
        .sort(([, a], [, b]) => a.order - b.order)
      for (const [, entry] of entries) {
        // Entry state belongs to the current device connection/session. It
        // remains authoritative while that session is fresh, even if this
        // particular path is quiet (for example, a sustained drone). The
        // Manager predicate owns session freshness; false clears everything.
        if (this._sendPacket(entry.packet, true)) attempts++
      }
    }
    return attempts
  }

  clearDeviceSnapshots(deviceId) {
    return this.snapshotCache.delete(deviceId)
  }

  clearSnapshots() {
    this.snapshotCache.clear()
  }

  get snapshotDevices() {
    return this.snapshotCache.size
  }

  get snapshotEntries() {
    let count = 0
    for (const entries of this.snapshotCache.values()) count += entries.size
    return count
  }

  _warn(message) {
    // A malformed or hostile source must not flood the live-performance log.
    if (this.reportedErrors >= 3) return
    this.reportedErrors++
    try { this.logger.warn(`[cosmicnoise] ${message}`) } catch {}
  }

  close() {
    this.clearSnapshots()
    if (!this.ownsSocket || !this.socket) return
    try { this.socket.close() } catch {}
    this.socket = null
  }
}

export function createCosmicNoiseForwarderFromEnv(env = process.env, options = {}) {
  return new CosmicNoiseForwarder({
    ...cosmicNoiseConfigFromEnv(env),
    ...options
  })
}
