// Cosmic Live Manager — local Node helper / OSCQuery hub.
//
//   - Loads device declarations from manifests/*.json (live-watched).
//   - Opens an OSCQuery client (HTTP + WebSocket) to every enabled device.
//   - Aggregates every received value into a central namespace served as a
//     standard OSCQuery tree at GET /  (so third parties can read us).
//   - Publishes itself as a Bonjour _oscjson._tcp + _osc._udp service and
//     also browses the LAN for other _oscjson._tcp services (shown in the
//     dashboard's "Discovered" section, plus surfaced to the dashboard via
//     /ws/discovery for the Announce target picker).
//   - Listens for UDP/OSC on OSC_PORT, supports /subscribe & /unsubscribe
//     for OSC relay style, and a central /ws/hub WebSocket pushes
//     PATH_CHANGED, DEVICE_UPDATED, DEVICE_NAMESPACE, … to the dashboard.
//   - Accepts SET_DEVICE_PARAM (write a value back to a managed device) and
//     ANNOUNCE_DEVICE (push the device's contact info onto a target's
//     /system/peer/* parameters) over /ws/hub.
//   - Forwards every device value to Ableton on UDP ABLETON_PORT using
//     the historical "device<id> <path> <value>" two-string + value packet
//     shape (compatible with the existing Cosmic Unity M4L patch).
//
// All commentary, logs and identifiers are in English.

import express from 'express'
import http from 'node:http'
import os from 'node:os'
import dgram from 'node:dgram'
import { readdirSync, readFileSync, writeFileSync, unlinkSync, watch } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { Bonjour } from 'bonjour-service'
import osc from 'osc'
import { OscQueryClient } from './oscqueryClient.js'

// ─── Configuration ────────────────────────────────────────────────────────
const PORT               = Number(process.env.PORT || 7400)          // helper HTTP/WS + hub OSCQuery HTTP
const OSC_LISTEN_PORT    = Number(process.env.OSC_LISTEN_PORT || 9001) // UDP OSC inbound (instruments → us)
const ABLETON_HOST       = process.env.ABLETON_HOST || '127.0.0.1'
const ABLETON_PORT       = Number(process.env.ABLETON_PORT || 10000)   // hub → Ableton M4L udpreceive
const HUB_NAME           = process.env.HUB_NAME || 'Cosmic Live Manager'
const MANIFESTS_DIR      = process.env.MANIFESTS_DIR || './manifests'
const ABLETON_FORWARD    = process.env.ABLETON_FORWARD !== '0'         // on by default; set to "0" to disable

// ─── Security constants ───────────────────────────────────────────────────
const MAX_SUBSCRIBERS = 50
const MAX_NAMESPACE   = 10_000
const OSC_PATH_RE     = /^\/[a-zA-Z0-9_./-]{1,256}$/

function isValidHost(host) {
  return /^(localhost|127\.0\.0\.1|((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?))$/.test(host)
    || /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/.test(host)
}
function isValidOscPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535
}

// ─── LAN address enumeration ──────────────────────────────────────────────
function lanAddresses() {
  const out = []
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push({ name, address: i.address })
    }
  }
  return out
}

// ─── Express + HTTP server ────────────────────────────────────────────────
const app = express()
app.use(express.json())

// Security/CORS headers compatible with both the local dev UI and
// third-party OSCQuery consumers on the LAN.
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*')
  } else {
    res.header('Access-Control-Allow-Origin', '*')
  }
  res.header('X-Content-Type-Options', 'nosniff')
  next()
})

const server = http.createServer(app)

// ─── Manifest types & state ───────────────────────────────────────────────
// A device manifest describes one OSCQuery-speaking instrument we want the
// hub to keep a permanent connection to. Files live in manifests/*.json.

/** @type {Map<number, any>} */
const devices = new Map()
/** @type {Map<number, string>} */
const manifestFilenames = new Map()
/** @type {Map<number, OscQueryClient>} */
const oscQueryClients = new Map()
/** @type {Map<number, number>} */
const deviceMsgCount = new Map()

let suppressWatcher = false // flip while we write a manifest ourselves

// ─── Hub WebSocket state ──────────────────────────────────────────────────
/** Browser clients of the new /ws/hub dashboard. */
const hubClients = new Set()
function broadcastHub(data) {
  const json = JSON.stringify(data)
  for (const ws of hubClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json)
  }
}

// ─── Manifest loader ──────────────────────────────────────────────────────
function loadManifests() {
  const before = devices.size
  const oldDevices = new Map(devices)
  devices.clear()
  manifestFilenames.clear()

  try {
    const files = readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.json'))

    for (const file of files) {
      try {
        const content = readFileSync(join(MANIFESTS_DIR, file), 'utf-8')
        const manifest = JSON.parse(content)

        // Status / runtime fields: preserve from the previous load if the
        // device still points at the same host:port AND its OSCQuery client
        // is alive. Without this, every loadManifests() (e.g. triggered by
        // adding a NEW device, or by the folder watcher) would reset every
        // existing device back to 'configured' — making the dashboard show
        // them as disconnected even though their WS is still up.
        const old = oldDevices.get(manifest.id)
        const sameTarget =
          old &&
          old.host === manifest.host &&
          Number(old.oscQueryPort) === Number(manifest.oscQueryPort)
        if (sameTarget && manifest.enabled && oscQueryClients.has(manifest.id)) {
          manifest.status        = old.status || (manifest.enabled ? 'configured' : 'disabled')
          manifest.oscPort       = old.oscPort
          manifest.paramCount    = old.paramCount
          manifest.lastMessageAt = old.lastMessageAt
        } else {
          manifest.status = manifest.enabled ? 'configured' : 'disabled'
        }

        if (devices.has(manifest.id)) {
          console.log(`  [manifest] conflict: id ${manifest.id} already exists, skipping ${file}`)
          continue
        }

        devices.set(manifest.id, manifest)
        manifestFilenames.set(manifest.id, file)
      } catch (err) {
        console.log(`  [manifest] read error (${file}): ${err.message}`)
      }
    }

    console.log(`  [manifest] loaded ${devices.size} device(s)  (was ${before})`)

    reconcileClients(oldDevices)

    broadcastHub({
      type: 'DEVICES_RELOADED',
      devices: Array.from(devices.values())
    })
  } catch (err) {
    console.log(`  [manifest] could not read ${MANIFESTS_DIR}: ${err.message}`)
  }
}

// ─── Client lifecycle ─────────────────────────────────────────────────────
function reconcileClients(oldDevices) {
  // Disconnect clients whose target moved or was disabled/removed.
  for (const [id, oldDev] of oldDevices.entries()) {
    const newDev = devices.get(id)
    const shouldDisconnect =
      !newDev ||
      !newDev.enabled ||
      newDev.host !== oldDev.host ||
      newDev.oscQueryPort !== oldDev.oscQueryPort

    if (shouldDisconnect && oscQueryClients.has(id)) {
      const client = oscQueryClients.get(id)
      client.disconnect()
      oscQueryClients.delete(id)
      console.log(`  [client] disconnect ${oldDev.name}`)
    }
  }

  // Connect any newly-enabled device.
  for (const dev of devices.values()) {
    if (!dev.enabled) continue
    if (oscQueryClients.has(dev.id)) continue
    connectToDevice(dev)
  }
}

function countParams(node) {
  let count = 0
  if (node.TYPE !== undefined) count++
  if (node.CONTENTS) {
    for (const child of Object.values(node.CONTENTS)) count += countParams(child)
  }
  return count
}

function connectToDevice(dev) {
  console.log(`  [client] connecting ${dev.name} → ${dev.host}:${dev.oscQueryPort}`)
  dev.status = 'connecting'
  broadcastDeviceUpdate(dev)

  const client = new OscQueryClient(dev.host, dev.oscQueryPort, {
    onConnect: () => {
      dev.status = 'connected'
      dev.lastMessageAt = Date.now()
      dev.oscPort = client.oscPort || dev.oscQueryPort
      const ns = client.lastNamespace
      if (ns) {
        const count = countParams(ns)
        dev.paramCount = count
        console.log(`  [client] ✓ ${dev.name} connected (${count} params)`)
      }
      broadcastDeviceUpdate(dev)
      // Ship the full per-device parameter list (with TYPE / RANGE / ACCESS /
      // DESCRIPTION / UNIT) to every dashboard so it can render real widgets.
      broadcastHub({
        type: 'DEVICE_NAMESPACE',
        deviceId: dev.id,
        deviceName: dev.name,
        nodes: client.flatNodes
      })
    },
    onDisconnect: (reason) => {
      dev.status = 'lost'
      console.log(`  [client] ✗ ${dev.name} lost: ${reason}`)
      broadcastDeviceUpdate(dev)
    },
    onLog: (msg) => {
      console.log(`     [${dev.name}] ${msg}`)
    },
    onValue: (path, value) => {
      handleClientValue(dev, path, value)
    }
  })

  oscQueryClients.set(dev.id, client)
  client.connect()
}

function handleClientValue(dev, path, value) {
  dev.lastMessageAt = Date.now()
  dev.status = 'connected'

  deviceMsgCount.set(dev.id, (deviceMsgCount.get(dev.id) || 0) + 1)

  // Store in the hub namespace, prefixed with the device name so paths from
  // different devices never collide. e.g. /Tablet2/HandR0/palm/Tx
  const hubPath = `/${dev.name}${path}`
  const v = Array.isArray(value) ? value : [value]
  const firstVal = v[0]
  const type =
    typeof firstVal === 'number'
      ? Number.isInteger(firstVal) ? 'i' : 'f'
      : typeof firstVal === 'boolean'
      ? firstVal ? 'T' : 'F'
      : 's'

  if (!namespace.has(hubPath) && namespace.size >= MAX_NAMESPACE) {
    return // hard cap to prevent runaway memory if a device misbehaves
  }
  namespace.set(hubPath, {
    fullPath: hubPath,
    type,
    value: v,
    lastUpdate: Date.now(),
    source: `${dev.host}:${dev.oscQueryPort}`,
    deviceId: dev.id
  })

  broadcastHub({
    type: 'PATH_CHANGED',
    path: hubPath,
    value: v,
    paramType: type,
    source: `${dev.host}:${dev.oscQueryPort}`,
    deviceId: dev.id,
    deviceName: dev.name,
    isNew: false,
    timestamp: Date.now()
  })

  if (ABLETON_FORWARD && dev.enabled) {
    forwardToAbleton(dev.id, path, v, type)
  }
}

function broadcastDeviceUpdate(dev) {
  broadcastHub({ type: 'DEVICE_UPDATED', device: dev })
}

// ─── Manifest save ────────────────────────────────────────────────────────
function saveManifest(deviceId, updates) {
  const dev = devices.get(deviceId)
  const filename = manifestFilenames.get(deviceId)

  if (!dev || !filename) {
    return { ok: false, error: `Device not found: id ${deviceId}` }
  }

  if (updates.host !== undefined && !isValidHost(updates.host)) {
    return { ok: false, error: `Invalid host: ${updates.host}` }
  }
  if (updates.oscQueryPort !== undefined && !isValidOscPort(updates.oscQueryPort)) {
    return { ok: false, error: `Invalid port: ${updates.oscQueryPort}` }
  }
  if (
    updates.name !== undefined &&
    (updates.name.trim().length === 0 || updates.name.length > 64)
  ) {
    return { ok: false, error: 'Invalid device name' }
  }

  const updated = {
    id: dev.id,
    name: updates.name ?? dev.name,
    type: dev.type,
    host: updates.host ?? dev.host,
    oscQueryPort: updates.oscQueryPort ?? dev.oscQueryPort,
    enabled: updates.enabled ?? dev.enabled,
    description: updates.description ?? dev.description
  }

  try {
    suppressWatcher = true
    const filePath = join(MANIFESTS_DIR, filename)
    writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n', 'utf-8')

    const oldDev = { ...dev }
    const newDev = { ...updated, status: updated.enabled ? 'configured' : 'disabled' }
    devices.set(deviceId, newDev)

    console.log(`  [manifest] saved ${dev.name} (id ${deviceId})`)
    if (updates.host !== undefined) console.log(`     host: ${oldDev.host} → ${updated.host}`)
    if (updates.oscQueryPort !== undefined) console.log(`     port: ${oldDev.oscQueryPort} → ${updated.oscQueryPort}`)
    if (updates.enabled !== undefined) console.log(`     enabled: ${oldDev.enabled} → ${updated.enabled}`)

    const oldMap = new Map(devices)
    oldMap.set(deviceId, oldDev)
    reconcileClients(oldMap)

    setTimeout(() => { suppressWatcher = false }, 500)

    broadcastHub({ type: 'DEVICE_UPDATED', device: newDev })
    return { ok: true }
  } catch (err) {
    suppressWatcher = false
    return { ok: false, error: err.message }
  }
}

// ─── Namespace storage ────────────────────────────────────────────────────
/** Central name → parameter map. Built up from managed device values,
 *  /subscribe pushes, and direct UDP OSC inbound. Served as an OSCQuery tree. */
const namespace = new Map()

/** OSC UDP subscribers — destinations that asked the hub to relay packets
 *  to them via `/subscribe`. */
const oscSubscribers = new Map()
const subKey = (a, p) => `${a}:${p}`

function oscTypeToQueryType(t) {
  const map = { f: 'f', i: 'i', s: 's', T: 'T', F: 'F', d: 'd' }
  return map[t] || 's'
}

function buildTree() {
  const root = { FULL_PATH: '/', DESCRIPTION: HUB_NAME, CONTENTS: {} }
  for (const [path, param] of namespace.entries()) {
    const parts = path.split('/').filter((p) => p.length > 0)
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      const fullPath = '/' + parts.slice(0, i + 1).join('/')
      if (!current.CONTENTS) current.CONTENTS = {}
      if (!current.CONTENTS[part]) current.CONTENTS[part] = { FULL_PATH: fullPath }
      if (isLast) {
        current.CONTENTS[part].TYPE = param.type
        current.CONTENTS[part].VALUE = param.value
        current.CONTENTS[part].ACCESS = 3
        current.CONTENTS[part].DESCRIPTION = `From ${param.source}`
      }
      current = current.CONTENTS[part]
    }
  }
  return root
}

// ─── Ableton forwarder (custom UDP, slash-less inner address) ─────────────
// Builds the historical "device<id> <path> <value>" packet shape that the
// existing Cosmic Unity M4L patch parses — two strings then one value.
const abletonSocket = dgram.createSocket('udp4')

function oscPad(buf) {
  const padded = Math.ceil(buf.length / 4) * 4
  const out = Buffer.alloc(padded)
  buf.copy(out)
  return out
}
function encodeOscString(s) {
  return oscPad(Buffer.from(s + '\0', 'utf8'))
}
function buildAbletonPacket(address, path, value, isInt) {
  const addrBuf = encodeOscString(address)
  const typeBuf = encodeOscString(isInt ? ',si' : ',sf')
  const pathBuf = encodeOscString(path)
  const valBuf  = Buffer.alloc(4)
  if (isInt) valBuf.writeInt32BE(Math.round(value), 0)
  else       valBuf.writeFloatBE(value, 0)
  return Buffer.concat([addrBuf, typeBuf, pathBuf, valBuf])
}

let abletonMsgsSent = 0
function forwardToAbleton(deviceId, paramPath, value, type) {
  const address = `device${deviceId}`
  const vals = Array.isArray(value) ? value : [value]
  const v = vals[0]
  const isInt = type === 'i' && Number.isInteger(v)
  const packet = buildAbletonPacket(address, paramPath, typeof v === 'number' ? v : 0, isInt)
  abletonSocket.send(packet, ABLETON_PORT, ABLETON_HOST)
  abletonMsgsSent++
}

// ─── Outgoing OSC relay (to /subscribe destinations) ──────────────────────
function broadcastToOscSubscribers(path, value, type, exceptSource) {
  const args = (Array.isArray(value) ? value : [value]).map((v) => {
    let oscType = type
    if (typeof v === 'number') oscType = Number.isInteger(v) && type === 'i' ? 'i' : 'f'
    return { type: oscType, value: v }
  })
  for (const sub of oscSubscribers.values()) {
    const key = subKey(sub.address, sub.port)
    if (exceptSource && key === exceptSource) continue
    udpHubPort.send({ address: path, args }, sub.address, sub.port)
  }
}

// ─── Shared UDP OSC sender ────────────────────────────────────────────────
// One outbound-only socket used by SET_DEVICE_PARAM (write to managed
// device) and by announceToTarget() (announce to LAN peer). Kept separate
// from the hub's inbound UDP port so the two listeners don't collide.
const udpSender = new osc.UDPPort({
  localAddress: '0.0.0.0',
  localPort: 0,
  metadata: true
})
udpSender.on('error', (err) => console.error('[osc-tx]', err.message))
udpSender.open()

// ─── Hub UDP OSC port (combined listener + relay sender) ──────────────────
// Single socket: listens on OSC_LISTEN_PORT for inbound OSC AND is used to
// send relay frames out to /subscribe destinations.
const udpHubPort = new osc.UDPPort({
  localAddress: '0.0.0.0',
  localPort: OSC_LISTEN_PORT,
  metadata: true
})

udpHubPort.on('ready', () => {
  console.log(`[osc-hub] listening for UDP OSC on 0.0.0.0:${OSC_LISTEN_PORT}`)
  for (const ip of lanAddresses()) {
    console.log(`[osc-hub] LAN address: ${ip.address}  (interface ${ip.name})`)
  }

  // Boot the rest of the hub once the OSC socket is up.
  // Empty-on-start: by default we wipe the manifests folder on every helper
  // startup so each fresh session begins with no devices on the dashboard.
  // The user can preserve the previous set by Exporting BEFORE restarting
  // (and re-Importing after). Set KEEP_MANIFESTS=1 to disable this and keep
  // the legacy auto-load-from-disk behaviour.
  if (process.env.KEEP_MANIFESTS !== '1') {
    try {
      const files = readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.json'))
      suppressWatcher = true
      for (const f of files) {
        try { unlinkSync(join(MANIFESTS_DIR, f)) } catch {}
      }
      setTimeout(() => { suppressWatcher = false }, 300)
      if (files.length > 0) {
        console.log(`  [manifest] cleared ${files.length} stale manifest(s) on startup (set KEEP_MANIFESTS=1 to preserve)`)
      }
    } catch { /* dir may not exist yet — loadManifests handles that */ }
  }
  loadManifests()
  try {
    watch(MANIFESTS_DIR, { persistent: false }, () => {
      if (suppressWatcher) return
      console.log('  [manifest] folder changed, reloading…')
      setTimeout(loadManifests, 100)
    })
  } catch {
    console.log('  [manifest] watcher could not start')
  }
})

udpHubPort.on('error', (err) => {
  console.error('[osc-hub] socket error:', err.message)
})

udpHubPort.on('message', (oscMsg, _timeTag, info) => {
  const time = new Date().toISOString().substring(11, 23)
  const from = info ? `${info.address}:${info.port}` : 'unknown'

  // /subscribe <port> — register a UDP destination to relay future updates
  if (oscMsg.address === '/subscribe' && info) {
    const port = oscMsg.args[0]?.value
    if (typeof port === 'number') {
      const k = subKey(info.address, port)
      if (!oscSubscribers.has(k) && oscSubscribers.size >= MAX_SUBSCRIBERS) {
        console.log(`  [osc-hub] subscriber limit reached (${MAX_SUBSCRIBERS}), rejecting ${info.address}:${port}`)
        return
      }
      oscSubscribers.set(k, { address: info.address, port, registeredAt: Date.now() })
      console.log(`  [osc-hub] subscribed: ${info.address}:${port}`)
      broadcastHub({ type: 'SUBSCRIBERS_CHANGED', subscribers: Array.from(oscSubscribers.values()) })
    }
    return
  }

  if (oscMsg.address === '/unsubscribe' && info) {
    const port = oscMsg.args[0]?.value
    if (typeof port === 'number') {
      oscSubscribers.delete(subKey(info.address, port))
      broadcastHub({ type: 'SUBSCRIBERS_CHANGED', subscribers: Array.from(oscSubscribers.values()) })
    }
    return
  }

  // Plain OSC value → store in namespace, broadcast to UI + subscribers.
  const args = (oscMsg.args || []).map((a) => ({ type: a.type, value: a.value }))
  const param = {
    fullPath: oscMsg.address,
    type: args.length > 0 ? oscTypeToQueryType(args[0].type) : 's',
    value: args.map((a) => a.value),
    lastUpdate: Date.now(),
    source: from
  }
  const isNew = !namespace.has(oscMsg.address)
  if (isNew && namespace.size >= MAX_NAMESPACE) {
    console.log(`  [osc-hub] namespace cap reached (${MAX_NAMESPACE}), skipping ${oscMsg.address}`)
    return
  }
  namespace.set(oscMsg.address, param)

  const marker = isNew ? '*' : ' '
  const valStr = args.map((a) => `${a.value}(${a.type})`).join(', ')
  console.log(`${marker} [${time}] [UDP-direct] ${oscMsg.address.padEnd(28)} → ${valStr}`)

  broadcastHub({
    type: 'PATH_CHANGED',
    path: oscMsg.address,
    value: param.value,
    paramType: param.type,
    source: from,
    isNew,
    timestamp: param.lastUpdate
  })

  broadcastToOscSubscribers(oscMsg.address, param.value, param.type, from)
})

udpHubPort.open()

// ─── Bonjour: discovery (existing CLM behaviour) + publish (new hub) ─────
const bonjour = new Bonjour()
/** @type {Map<string, any>} bonjour-service ServiceInfo by fqdn */
const services = new Map()
/** @type {Map<string, {name:string, host:string, port:number, firstSeen:number}>} */
const discoveredDevices = new Map()

function serializeService(s) {
  const ipv4 = (s.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
  return {
    fqdn: s.fqdn,
    name: s.name,
    host: s.host,
    address: ipv4 || s.referer?.address || (s.addresses || [])[0] || null,
    port: s.port,
    txt: s.txt || {}
  }
}

const discoveryClients = new Set()
function broadcastDiscovery() {
  const payload = JSON.stringify({
    type: 'services',
    services: Array.from(services.values()).map(serializeService)
  })
  for (const ws of discoveryClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload)
  }
}

function isAlreadyKnown(host, port) {
  return Array.from(devices.values()).some((d) => d.host === host && d.oscQueryPort === port)
}

function broadcastDiscovered() {
  broadcastHub({ type: 'DISCOVERED_DEVICES', devices: Array.from(discoveredDevices.values()) })
}

// We keep the browser in a `let` (not `const`) so it can be torn down and
// recreated on demand — see `rediscoverNetwork()` below. The Bonjour browser
// holds an in-memory cache of "alive" services that gets stale when devices
// rename or change ports without sending a clean mDNS goodbye. Rebuilding the
// browser forces a fresh round of network queries and rebuilds the cache.
let browser = null

function attachBrowserHandlers(b) {
  b.on('up', (service) => {
    services.set(service.fqdn, service)
    console.log('[discovery] up   ', service.name, service.addresses)
    broadcastDiscovery()

    // Mirror into the hub's "discovered" list, skipping ourselves and manifest-known devices.
    const ipv4 = (service.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
    const host = ipv4 || service.host
    const port = service.port
    if (port === PORT) return
    if (isAlreadyKnown(host, port)) return
    discoveredDevices.set(`${host}:${port}`, {
      name: service.name,
      host,
      port,
      firstSeen: Date.now()
    })
    broadcastDiscovered()
  })
  b.on('down', (service) => {
    services.delete(service.fqdn)
    console.log('[discovery] down ', service.name)
    broadcastDiscovery()

    const ipv4 = (service.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
    const host = ipv4 || service.host
    const key = `${host}:${service.port}`
    if (discoveredDevices.delete(key)) broadcastDiscovered()
  })
}

function startBrowser() {
  browser = bonjour.find({ type: 'oscjson' })
  attachBrowserHandlers(browser)
}

/**
 * Tear down the Bonjour browser, wipe the helper's in-memory caches of
 * discovered services, and start a fresh browser. This is the equivalent
 * of restarting `npm run dev` for the discovery layer — it does NOT flush
 * macOS's mDNSResponder cache (which would need sudo), but in practice the
 * vast majority of "I changed the device name/port and the web doesn't see
 * it" issues live in OUR Map<fqdn, ServiceInfo> rather than in the OS.
 */
function rediscoverNetwork() {
  try {
    if (browser && typeof browser.stop === 'function') browser.stop()
  } catch (err) {
    console.log('[discovery] browser.stop() error:', err.message)
  }
  services.clear()
  discoveredDevices.clear()
  broadcastDiscovery()
  broadcastDiscovered()
  console.log('[discovery] rediscover requested — caches cleared, restarting browser')
  startBrowser()
}

startBrowser()

function publishBonjour() {
  bonjour.publish({ name: HUB_NAME, type: 'oscjson', protocol: 'tcp', port: PORT })
  bonjour.publish({ name: HUB_NAME, type: 'osc', protocol: 'udp', port: OSC_LISTEN_PORT })
  console.log(`[bonjour] published "${HUB_NAME}" as _oscjson._tcp:${PORT} and _osc._udp:${OSC_LISTEN_PORT}`)
}

// ─── HTTP routes — Hub OSCQuery ───────────────────────────────────────────
app.get('/_devices', (_req, res) => {
  const devs = Array.from(devices.values()).map((d) => ({
    ...d,
    msgCount: deviceMsgCount.get(d.id) || 0
  }))
  res.json({ devices: devs, self: { name: HUB_NAME, port: PORT, oscPort: OSC_LISTEN_PORT } })
})

app.get('/_status', (_req, res) => {
  res.json({
    namespace_size: namespace.size,
    ws_clients: hubClients.size,
    osc_subscribers: Array.from(oscSubscribers.values()),
    devices: Array.from(devices.values()),
    abletonMsgsSent
  })
})

// OSCQuery root — HOST_INFO when ?HOST_INFO is present, otherwise full tree.
// Registered last among GETs so it doesn't shadow the /_* routes.
app.get('/', (req, res) => {
  if ('HOST_INFO' in req.query) {
    return res.json({
      NAME: HUB_NAME,
      OSC_PORT: OSC_LISTEN_PORT,
      OSC_TRANSPORT: 'UDP',
      EXTENSIONS: { ACCESS: true, VALUE: true, DESCRIPTION: true, TYPE: true, OSC_STREAMING: true }
    })
  }
  res.json(buildTree())
})

// Sub-path lookup — must be registered last so it doesn't shadow /_*.
app.get(/^\/(?!_devices|_status|ws).+/, (req, res) => {
  const path = req.path
  const param = namespace.get(path)
  if (param) {
    return res.json({
      FULL_PATH: path,
      TYPE: param.type,
      VALUE: param.value,
      ACCESS: 3,
      DESCRIPTION: `From ${param.source}`
    })
  }
  const tree = buildTree()
  const parts = path.split('/').filter((p) => p.length > 0)
  let current = tree
  for (const part of parts) {
    if (current.CONTENTS && current.CONTENTS[part]) current = current.CONTENTS[part]
    else return res.status(404).json({ error: 'Not found' })
  }
  res.json(current)
})

// ─── WebSocket servers ────────────────────────────────────────────────────
const wssDiscovery = new WebSocketServer({ noServer: true })
const wssHub       = new WebSocketServer({ noServer: true, maxPayload: 65_536 })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  if (pathname === '/ws/discovery') {
    wssDiscovery.handleUpgrade(req, socket, head, (ws) => wssDiscovery.emit('connection', ws, req))
  } else if (pathname === '/ws/hub' || pathname === '/') {
    wssHub.handleUpgrade(req, socket, head, (ws) => wssHub.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

// /ws/discovery — list of OSCQuery services on the LAN
wssDiscovery.on('connection', (ws) => {
  discoveryClients.add(ws)
  ws.send(
    JSON.stringify({
      type: 'services',
      services: Array.from(services.values()).map(serializeService)
    })
  )
  ws.on('close', () => discoveryClients.delete(ws))
})

/**
 * Push a device's contact info onto a target's /system/peer/* OSCQuery
 * parameters by sending five OSC UDP messages to the target.
 *
 * @param {{ target: any, peerId: string, host: string, oscQueryPort: number, udpPort: number }} args
 */
async function announceToTarget({ target, peerId, host, oscQueryPort, udpPort }) {
  // Resolve the target's OSC UDP port: prefer HOST_INFO.OSC_PORT, fall back
  // to the OSCQuery HTTP port (often the same on devices like Max/Chataigne).
  let targetOscPort = Number(target.port)
  try {
    const ctl = new AbortController()
    const to = setTimeout(() => ctl.abort(), 2000)
    const r = await fetch(`http://${target.address}:${target.port}/?HOST_INFO`, {
      signal: ctl.signal
    })
    clearTimeout(to)
    if (r.ok) {
      const info = await r.json()
      if (info && Number(info.OSC_PORT)) targetOscPort = Number(info.OSC_PORT)
    }
  } catch {
    // HOST_INFO unsupported → keep the fallback port
  }
  // Fire the five canonical announce messages. We use the shared UDP sender.
  sendOscViaSender(target.address, targetOscPort, '/system/peer/peer_id', [peerId])
  sendOscViaSender(target.address, targetOscPort, '/system/peer/host', [host])
  sendOscViaSender(target.address, targetOscPort, '/system/peer/oscquery_port', [oscQueryPort])
  sendOscViaSender(target.address, targetOscPort, '/system/peer/udp_port', [udpPort])
  sendOscViaSender(target.address, targetOscPort, '/system/peer/connect', [true])
  console.log(`  [announce] ${peerId} → ${target.address}:${targetOscPort}  (oscq=${oscQueryPort} udp=${udpPort})`)
}

function sendOscViaSender(host, port, address, args) {
  const oscArgs = (args || []).map((a) => {
    if (a && typeof a === 'object' && 'type' in a && 'value' in a) return a
    if (typeof a === 'number') {
      return Number.isInteger(a) ? { type: 'i', value: a } : { type: 'f', value: a }
    }
    if (typeof a === 'boolean') return { type: a ? 'T' : 'F' }
    if (typeof a === 'string') return { type: 's', value: a }
    return { type: 's', value: String(a) }
  })
  try {
    udpSender.send({ address, args: oscArgs }, host, Number(port))
  } catch (err) {
    console.error(`[osc-tx] send failed → ${host}:${port} ${address}: ${err.message}`)
  }
}

// /ws/hub (and /) — dashboard control channel for the OQH-style UI
wssHub.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress
  console.log(`[hub-ws] connection from ${ip}`)
  hubClients.add(ws)

  ws.send(JSON.stringify({
    type: 'INITIAL_STATE',
    namespace: buildTree(),
    devices: Array.from(devices.values()),
    subscribers: Array.from(oscSubscribers.values()),
    discoveredDevices: Array.from(discoveredDevices.values()),
    hubName: HUB_NAME,
    abletonForward: ABLETON_FORWARD ? { host: ABLETON_HOST, port: ABLETON_PORT } : null
  }))

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    // OSCQuery-style SET — write a value into the hub namespace and rebroadcast.
    if (msg.type === 'SET' && msg.path && msg.value !== undefined) {
      if (!OSC_PATH_RE.test(msg.path)) return
      if (!namespace.has(msg.path) && namespace.size >= MAX_NAMESPACE) return
      const newValue = Array.isArray(msg.value) ? msg.value : [msg.value]
      const existing = namespace.get(msg.path)
      const param = existing || {
        fullPath: msg.path,
        type: typeof msg.value === 'number' ? 'f' : 's',
        value: newValue,
        lastUpdate: Date.now(),
        source: `web:${ip}`
      }
      param.value = newValue
      param.lastUpdate = Date.now()
      param.source = `web:${ip}`
      namespace.set(msg.path, param)

      broadcastHub({
        type: 'PATH_CHANGED',
        path: msg.path,
        value: param.value,
        paramType: param.type,
        source: param.source,
        isNew: !existing,
        timestamp: param.lastUpdate
      })
      broadcastToOscSubscribers(msg.path, param.value, param.type)
      return
    }

    if (msg.type === 'UPDATE_DEVICE' && typeof msg.deviceId === 'number') {
      const result = saveManifest(msg.deviceId, msg.updates || {})
      ws.send(JSON.stringify({
        type: 'UPDATE_DEVICE_RESULT',
        deviceId: msg.deviceId,
        ok: result.ok,
        error: result.error
      }))
      return
    }

    if (msg.type === 'RECONNECT_DEVICE' && typeof msg.deviceId === 'number') {
      const dev = devices.get(msg.deviceId)
      if (dev && dev.enabled) {
        if (oscQueryClients.has(dev.id)) {
          oscQueryClients.get(dev.id).disconnect()
          oscQueryClients.delete(dev.id)
        }
        connectToDevice(dev)
      }
      return
    }

    // SET_DEVICE_PARAM — write a value back to one of the managed devices.
    // We send it as a UDP/OSC packet to the device's OSC port (from
    // HOST_INFO, falling back to the OSCQuery HTTP port). The device should
    // echo the new value back over its WS, which then re-broadcasts via
    // PATH_CHANGED so every dashboard sees the update.
    if (msg.type === 'SET_DEVICE_PARAM' && typeof msg.deviceId === 'number' && msg.path) {
      const dev = devices.get(msg.deviceId)
      if (!dev) return
      if (!OSC_PATH_RE.test(msg.path)) return
      const oscPort = Number(dev.oscPort) || Number(dev.oscQueryPort)
      const args = Array.isArray(msg.value) ? msg.value : (msg.value === undefined ? [] : [msg.value])
      sendOscViaSender(dev.host, oscPort, msg.path, args)
      // Optimistic local update so other dashboards see the change quickly
      // even before the device echoes it back.
      const hubPath = `/${dev.name}${msg.path}`
      const existing = namespace.get(hubPath)
      if (existing) {
        existing.value = args
        existing.lastUpdate = Date.now()
        existing.source = `web:${ip}`
        namespace.set(hubPath, existing)
        broadcastHub({
          type: 'PATH_CHANGED',
          path: hubPath,
          value: args,
          paramType: existing.type,
          source: existing.source,
          deviceId: dev.id,
          deviceName: dev.name,
          isNew: false,
          timestamp: existing.lastUpdate
        })
      }
      return
    }

    // ANNOUNCE_DEVICE — push one of our managed devices' contact info onto a
    // discovered target's /system/peer/* OSCQuery parameters. The hub
    // resolves the target's OSC UDP port via HOST_INFO, then fires five OSC
    // UDP messages: peer_id, host, oscquery_port, udp_port, connect.
    if (msg.type === 'ANNOUNCE_DEVICE' && typeof msg.deviceId === 'number' && msg.target) {
      const dev = devices.get(msg.deviceId)
      if (!dev) {
        ws.send(JSON.stringify({ type: 'ANNOUNCE_RESULT', deviceId: msg.deviceId, ok: false, error: 'Device not found' }))
        return
      }
      const target = msg.target // { address, port }
      if (!isValidHost(String(target.address || ''))) {
        ws.send(JSON.stringify({ type: 'ANNOUNCE_RESULT', deviceId: dev.id, ok: false, error: 'Invalid target host' }))
        return
      }
      if (!isValidOscPort(Number(target.port))) {
        ws.send(JSON.stringify({ type: 'ANNOUNCE_RESULT', deviceId: dev.id, ok: false, error: 'Invalid target port' }))
        return
      }
      const peerId = String(msg.peerId || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || dev.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_')
      const udpPort = Number(msg.udpPortOverride) > 0
        ? Number(msg.udpPortOverride)
        : (Number(dev.oscPort) || Number(dev.oscQueryPort))

      announceToTarget({
        target,
        peerId,
        host: dev.host,
        oscQueryPort: Number(dev.oscQueryPort),
        udpPort
      })
        .then(() => ws.send(JSON.stringify({
          type: 'ANNOUNCE_RESULT',
          deviceId: dev.id,
          ok: true,
          summary: `${peerId} → ${target.name || target.address}`
        })))
        .catch((err) => ws.send(JSON.stringify({
          type: 'ANNOUNCE_RESULT',
          deviceId: dev.id,
          ok: false,
          error: err.message
        })))
      return
    }

    if (msg.type === 'RELOAD_MANIFESTS') {
      loadManifests()
      return
    }

    if (msg.type === 'REDISCOVER') {
      rediscoverNetwork()
      return
    }

    if (msg.type === 'EXPORT_MANIFESTS') {
      // Dump the current device list as a JSON manifest set the user can
      // save and re-import later. We send only the on-disk fields (not the
      // runtime ones like status / paramCount / lastMessageAt).
      const payload = Array.from(devices.values()).map((d) => ({
        id:           d.id,
        name:         d.name,
        type:         d.type || 'oscquery-device',
        host:         d.host,
        oscQueryPort: d.oscQueryPort,
        enabled:      d.enabled !== false,
        description:  d.description || ''
      }))
      ws.send(JSON.stringify({
        type: 'MANIFESTS_EXPORT',
        version: 1,
        exportedAt: new Date().toISOString(),
        manifests: payload
      }))
      return
    }

    if (msg.type === 'IMPORT_MANIFESTS' && Array.isArray(msg.manifests)) {
      // Replace the current device set with the imported one.
      // 1. Suppress the file watcher while we churn through the folder.
      // 2. Delete every existing .json.
      // 3. Re-id every imported entry (we don't trust the incoming ids — they
      //    might collide with what we have or what's been used before).
      // 4. Write each as a manifest file with a sanitized filename.
      // 5. loadManifests() to bring them online + connect.
      suppressWatcher = true
      try {
        // Disconnect everyone first so reconcileClients doesn't get confused
        // by the in-flight rename.
        for (const [id, client] of oscQueryClients.entries()) {
          try { client.disconnect() } catch {}
          oscQueryClients.delete(id)
        }
        // Wipe disk
        for (const f of readdirSync(MANIFESTS_DIR).filter((x) => x.endsWith('.json'))) {
          try { unlinkSync(join(MANIFESTS_DIR, f)) } catch {}
        }
        // Write fresh manifests with stable, gap-free ids starting at 1.
        let nextId = 1
        for (const m of msg.manifests) {
          if (!m || !m.name || !m.host || !m.oscQueryPort) continue
          if (!isValidHost(String(m.host))) continue
          if (!isValidOscPort(Number(m.oscQueryPort))) continue
          const id = nextId++
          const manifest = {
            id,
            name:         String(m.name).slice(0, 64),
            type:         m.type || 'oscquery-device',
            host:         String(m.host),
            oscQueryPort: Number(m.oscQueryPort),
            enabled:      m.enabled !== false,
            description:  m.description || 'Imported'
          }
          const filename = `${manifest.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${id}.json`
          writeFileSync(join(MANIFESTS_DIR, filename), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
        }
        console.log(`  [hub] imported ${nextId - 1} manifest(s)`)
      } catch (err) {
        console.log(`  [hub] import failed: ${err.message}`)
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Import failed: ' + err.message }))
      } finally {
        setTimeout(() => { suppressWatcher = false }, 300)
      }
      loadManifests()
      return
    }

    if (msg.type === 'REMOVE_DEVICE' && typeof msg.deviceId === 'number') {
      const filename = manifestFilenames.get(msg.deviceId)
      const dev = devices.get(msg.deviceId)
      if (!dev || !filename) {
        ws.send(JSON.stringify({
          type: 'ERROR',
          message: `Unknown device id ${msg.deviceId}`
        }))
        return
      }
      try {
        // Suppress the watcher reload so we don't race with our own delete:
        // we'll call loadManifests() explicitly after the unlink.
        suppressWatcher = true
        unlinkSync(join(MANIFESTS_DIR, filename))
        console.log(`  [hub] removed device: ${dev.name} (id ${msg.deviceId})  [${filename}]`)
      } catch (err) {
        console.log(`  [hub] remove failed for id ${msg.deviceId}: ${err.message}`)
        ws.send(JSON.stringify({
          type: 'ERROR',
          message: `Could not delete manifest: ${err.message}`
        }))
        suppressWatcher = false
        return
      }
      suppressWatcher = false
      loadManifests()
      return
    }

    if (msg.type === 'ADD_DISCOVERED' && msg.host && msg.port) {
      if (!isValidHost(String(msg.host))) {
        ws.send(JSON.stringify({ type: 'ERROR', message: `Invalid host: ${msg.host}` }))
        return
      }
      if (!isValidOscPort(Number(msg.port))) {
        ws.send(JSON.stringify({ type: 'ERROR', message: `Invalid port: ${msg.port}` }))
        return
      }
      const nextId = Math.max(0, ...Array.from(devices.keys())) + 1
      const rawName = (msg.name || `Device${nextId}`).trim().slice(0, 64)
      const name = rawName.length > 0 ? rawName : `Device${nextId}`
      const manifest = {
        id: nextId,
        name,
        type: 'oscquery-device',
        host: msg.host,
        oscQueryPort: msg.port,
        enabled: true,
        description: 'Discovered via Bonjour'
      }
      const filename = `${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${nextId}.json`
      // Suppress the manifest folder watcher so it doesn't race our explicit
      // loadManifests() below. Without this, the watcher's debounced reload
      // can fire AFTER reconcileClients has already started the new client,
      // causing a brief disconnect/reconnect blip.
      suppressWatcher = true
      try {
        writeFileSync(join(MANIFESTS_DIR, filename), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
      } finally {
        // Re-arm after a short grace period so legitimate external edits
        // are still picked up.
        setTimeout(() => { suppressWatcher = false }, 300)
      }
      discoveredDevices.delete(`${msg.host}:${msg.port}`)
      console.log(`  [hub] added device: ${name} (id ${nextId})`)
      loadManifests()

      // Belt & suspenders: reconcileClients (called by loadManifests) should
      // already have started the connection because the manifest is created
      // with enabled:true. But in case the new device wasn't picked up for
      // any reason (race, filename normalization, etc.), force the connect
      // explicitly here so the user doesn't have to click Reconnect.
      const newDev = devices.get(nextId)
      if (newDev && newDev.enabled && !oscQueryClients.has(newDev.id)) {
        connectToDevice(newDev)
      }

      broadcastDiscovered()
    }
  })

  ws.on('close', () => hubClients.delete(ws))
})

// ─── Periodic broadcast: per-device message counters ──────────────────────
setInterval(() => {
  if (deviceMsgCount.size === 0) return
  const counts = {}
  for (const [id, c] of deviceMsgCount.entries()) counts[id] = c
  broadcastHub({ type: 'DEVICE_MSG_COUNTS', counts, abletonTotal: abletonMsgsSent })
}, 500)

// ─── Server startup ───────────────────────────────────────────────────────
// Bind the HTTP/WS server on all interfaces so LAN clients can reach it.
// (Node's `listen(PORT)` without a host arg already does this, but we pass
// '0.0.0.0' explicitly for clarity.)
server.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ${HUB_NAME}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  HTTP + WS:         http://localhost:${PORT}`)
  for (const ip of lanAddresses()) {
    console.log(`                     http://${ip.address}:${PORT}  (${ip.name})`)
  }
  console.log(`  OSC inbound:       UDP port ${OSC_LISTEN_PORT}`)
  if (ABLETON_FORWARD) {
    console.log(`  Ableton forward:   UDP ${ABLETON_HOST}:${ABLETON_PORT}`)
  }
  console.log(`  Manifests dir:     ${MANIFESTS_DIR}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  publishBonjour()
})

// ─── Shutdown ─────────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\nShutting down…')
  for (const client of oscQueryClients.values()) client.disconnect()
  bonjour.unpublishAll(() => {
    bonjour.destroy()
    try { udpHubPort.close() } catch {}
    for (const ws of hubClients) try { ws.close() } catch {}
    for (const ws of discoveryClients) try { ws.close() } catch {}
    server.close(() => process.exit(0))
  })
})
