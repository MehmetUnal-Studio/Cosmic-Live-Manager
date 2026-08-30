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
//     ANNOUNCE_DEVICE (write the selected external OSCQuery peer's contact info
//     onto the CosmicUnity instance's /system/peer/* parameters) over /ws/hub.
//   - Forwards every device value to Ableton on UDP ABLETON_PORT using
//     the historical "device<id> <path> <value>" two-string + value packet
//     shape (compatible with the existing Cosmic Unity M4L patch).
//   - Mirrors every managed-device value to CosmicNoise using the typed,
//     versioned /cosmicnoise/v1/input envelope on a separate UDP port.
//
// All commentary, logs and identifiers are in English.

import express from 'express'
import http from 'node:http'
import os from 'node:os'
import dgram from 'node:dgram'
import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, watch, renameSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { Bonjour } from 'bonjour-service'
import osc from 'osc'
import { OscQueryClient } from './oscqueryClient.js'
import {
  CONNECTION_STATES,
  DeviceRegistry,
  deduplicateManifestEntries,
  getLocalInterfaceAddresses
} from './deviceRegistry.js'
import {
  SNAPSHOT_FRESHNESS_MS,
  createCosmicNoiseForwarderFromEnv
} from './cosmicNoiseForwarder.js'
import {
  findRegistryDeviceForTarget,
  resolveGenericTargetFromRegistry,
  resolveLinkAnnouncement,
  resolveRingReceiverFromRegistry,
  resolveRingInstrumentTargetFromRegistry,
  resolveRingInstrumentSourceFromRegistry,
  resolveOscUdpPort
} from './linkRouting.js'
import { planCollisionHeals } from './collisionHeal.js'
import { planHostFollowHeals } from './hostFollowHeal.js'
import { createAutoLinkEngine } from './autoLink.js'
import { hubBackpressureAction } from './hubBackpressure.js'
import {
  isMaxRingReceiverDevice,
  isRingInstrumentIdentity
} from '../shared/maxRingLink.js'
import { isCosmicRingReceiverDevice } from '../shared/cosmicRingLink.js'

function isAbletonRingReceiverDevice(device) {
  return isMaxRingReceiverDevice(device) || isCosmicRingReceiverDevice(device)
}

// ─── Configuration ────────────────────────────────────────────────────────
const PORT               = Number(process.env.PORT || 7400)          // helper HTTP/WS + hub OSCQuery HTTP
const OSC_LISTEN_PORT    = Number(process.env.OSC_LISTEN_PORT || 9001) // UDP OSC inbound (instruments → us)
const ABLETON_HOST       = process.env.ABLETON_HOST || '127.0.0.1'
const ABLETON_PORT       = Number(process.env.ABLETON_PORT || 10000)   // hub → Ableton M4L udpreceive
const HUB_NAME           = process.env.HUB_NAME || 'Cosmic Live Manager'
const MANIFESTS_DIR      = process.env.MANIFESTS_DIR || './manifests'
const CONNECTION_TIMEOUT_MS = 3000
const DISCOVERY_STALE_TTL_MS = Number(process.env.DISCOVERY_STALE_TTL_MS || 15000)
// WS keepalive toward managed OSCQuery devices (half-open detection).
const OSCQUERY_KEEPALIVE_MS = Number(process.env.OSCQUERY_KEEPALIVE_MS || 5000)
const OSCQUERY_KEEPALIVE_MAX_MISSED = Number(process.env.OSCQUERY_KEEPALIVE_MAX_MISSED || 2)
const OSCQUERY_HOSTINFO_RETRY_MS = Number(process.env.OSCQUERY_HOSTINFO_RETRY_MS || 1000)
// Discovered records with no goodbye: probe after this silence, prune if dead.
const NO_GOODBYE_TTL_MS = Number(process.env.NO_GOODBYE_TTL_MS || 60_000)
const REACHABILITY_PROBE_INTERVAL_MS = Number(process.env.REACHABILITY_PROBE_INTERVAL_MS || 10_000)
const REACHABILITY_PROBE_TIMEOUT_MS = Number(process.env.REACHABILITY_PROBE_TIMEOUT_MS || 1500)
// Persistent-id port-collision auto-heal scan interval.
const COLLISION_HEAL_INTERVAL_MS = Number(process.env.COLLISION_HEAL_INTERVAL_MS || 5000)
// Saved-device fqdn host-follow auto-heal scan interval (DHCP moves).
const HOST_FOLLOW_HEAL_INTERVAL_MS = Number(process.env.HOST_FOLLOW_HEAL_INTERVAL_MS || 5000)

// Make sure `MANIFESTS_DIR` actually exists on disk. Fresh clones, Windows
// machines, or a user who manually deleted the folder would otherwise hit
// ENOENT on the first writeFileSync. mkdirSync with `recursive: true` is a
// no-op when the dir already exists, so it's safe to call as often as we
// want.
function ensureManifestsDir() {
  try {
    if (!existsSync(MANIFESTS_DIR)) {
      mkdirSync(MANIFESTS_DIR, { recursive: true })
      console.log(`  [manifest] created missing dir: ${MANIFESTS_DIR}`)
    }
  } catch (err) {
    console.log(`  [manifest] could not create dir ${MANIFESTS_DIR}: ${err.message}`)
  }
}
ensureManifestsDir()
const ABLETON_FORWARD    = process.env.ABLETON_FORWARD !== '0'         // on by default; set to "0" to disable
const cosmicNoiseForwarder = createCosmicNoiseForwarderFromEnv(process.env)

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
/** @type {Map<number, string[]>} all parsed files, including duplicate-id shadows */
const manifestFilesByDeviceId = new Map()
/** @type {Map<number, OscQueryClient>} */
const oscQueryClients = new Map()
/** @type {Map<number, number>} */
const deviceMsgCount = new Map()
/** @type {Map<string, any>} bonjour-service ServiceInfo by fqdn */
const services = new Map()
let nextDeviceRuntimeGeneration = 1

let isShuttingDown = false
let deviceRegistry = new DeviceRegistry({ localAddresses: getLocalInterfaceAddresses() })

function canReplayCosmicNoiseDevice(deviceId, now) {
  const dev = devices.get(deviceId)
  if (!dev || dev.enabled !== true || dev.status !== 'connected') return false
  const messageAge = now - Number(dev.lastMessageAt)
  return Number.isFinite(messageAge) && messageAge >= 0 && messageAge <= SNAPSHOT_FRESHNESS_MS
}

const cosmicNoiseSnapshotTimer =
  cosmicNoiseForwarder.enabled && cosmicNoiseForwarder.snapshotMs > 0
    ? setInterval(() => {
        cosmicNoiseForwarder.replaySnapshots(canReplayCosmicNoiseDevice)
      }, cosmicNoiseForwarder.snapshotMs)
    : null
if (cosmicNoiseSnapshotTimer) cosmicNoiseSnapshotTimer.unref()

let suppressWatcher = false // flip while we write a manifest ourselves

// ─── Hub WebSocket state ──────────────────────────────────────────────────
/** Browser clients of the new /ws/hub dashboard. */
const hubClients = new Set()
function broadcastHub(data) {
  const json = JSON.stringify(data)
  for (const ws of hubClients) {
    if (ws.readyState !== WebSocket.OPEN) continue
    // Backpressure: never let a sleeping/half-open dashboard socket buffer
    // the whole show. Skip broadcasts while it lags; drop it when hopeless.
    const action = hubBackpressureAction(ws.bufferedAmount)
    if (action === 'drop') {
      console.log(`[hub-ws] dropping stalled client (bufferedAmount=${ws.bufferedAmount})`)
      hubClients.delete(ws)
      try { ws.terminate() } catch {}
      continue
    }
    if (action === 'skip') continue
    ws.send(json)
  }
}

// ─── Hub-level status (OSC UDP listener health) ───────────────────────────
// 'ok' once the UDP OSC listener is bound; 'degraded' while it is not
// (port busy, bind error, or disabled via env). Manifests and device
// connections boot regardless — only the raw UDP inbound path is affected.
let oscListenState = 'degraded'
function currentHubStatus() {
  return { type: 'HUB_STATUS', oscListen: oscListenState === 'ok' ? 'ok' : 'degraded' }
}
function setOscListenState(next) {
  if (oscListenState === next) return
  oscListenState = next
  broadcastHub(currentHubStatus())
}

function connectionStateFor(dev) {
  if (!dev.enabled) return CONNECTION_STATES.DISABLED
  if (dev.connectionState) return dev.connectionState
  if (dev.status === 'connected') return CONNECTION_STATES.CONNECTED
  if (dev.status === 'connecting') return CONNECTION_STATES.CONNECTING
  if (dev.status === 'lost') return CONNECTION_STATES.UNAVAILABLE
  if (dev.status === 'error') return CONNECTION_STATES.ERROR
  return CONNECTION_STATES.DISCOVERED
}

function applyRegistryIdentity(dev, record) {
  if (!record) return dev
  dev.canonicalId = record.canonicalId
  dev.deviceType = record.deviceType
  dev.persistentDeviceId = record.persistentDeviceId
  dev.legacyIds = record.legacyIds || []
  dev.legacyCanonicalIds = record.legacyCanonicalIds || []
  dev.endpoints = record.endpoints
  dev.activeEndpoint = record.activeEndpoint
  dev.isLocal = record.isLocal
  dev.locationLabel = record.locationLabel
  dev.saved = true
  dev.discoveryState = record.discoveryState
  dev.connectionState = record.connectionState
  return dev
}

function registryManifest(dev) {
  return {
    ...dev,
    port: dev.oscQueryPort,
    connectionState: connectionStateFor(dev)
  }
}

function upsertServiceInRegistry(service) {
  const addresses = (service.addresses || [])
    .filter((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address))
  const hosts = addresses.length > 0
    ? addresses
    : [service.referer?.address || service.host].filter(Boolean)
  let record = null
  for (const host of hosts) {
    record = deviceRegistry.upsertDiscovery({
      name: service.name,
      serviceName: service.name,
      host,
      port: Number(service.port),
      fqdn: service.fqdn,
      txt: service.txt || {}
    })
  }
  return record
}

function rebuildDeviceRegistry() {
  deviceRegistry = new DeviceRegistry({ localAddresses: getLocalInterfaceAddresses() })
  for (const dev of devices.values()) {
    const record = deviceRegistry.upsertManifest(registryManifest(dev))
    applyRegistryIdentity(dev, record)
  }
  for (const service of services.values()) {
    if (Number(service.port) === PORT) continue
    upsertServiceInRegistry(service)
  }
  // A later manifest/discovery observation can move or merge a registry
  // entity. Re-read every managed device after the whole rebuild so no client
  // keeps a canonical ID that now belongs to a different physical device.
  for (const dev of devices.values()) {
    applyRegistryIdentity(dev, deviceRegistry.findByManifestId(dev.id))
  }
}

// Registry snapshots sent to dashboards must carry the managed device's
// persisted link and live autoLink status: publicRecord() enumerates only
// registry fields, and REGISTRY_UPDATED wholesale-replaces the dashboard's
// device list — without this merge the fields would flicker for one
// DEVICE_UPDATED frame and then vanish. Internal consumers (engine, heal,
// announce resolution) keep the raw snapshot.
function clientRegistrySnapshot() {
  return deviceRegistry.snapshot().map((record) => {
    if (record.manifestId == null) return record
    const managed = devices.get(record.manifestId)
    if (!managed || (!managed.link && !managed.autoLink)) return record
    return {
      ...record,
      ...(managed.link ? { link: managed.link } : {}),
      ...(managed.autoLink ? { autoLink: managed.autoLink } : {})
    }
  })
}

function broadcastRegistry() {
  broadcastHub({ type: 'REGISTRY_UPDATED', devices: clientRegistrySnapshot() })
  // Registry state feeds link-target resolution; every publish is a poke.
  autoLinkEngine.poke('registry')
}

function clearManagedDeviceRuntimeState(deviceId) {
  cosmicNoiseForwarder.clearDeviceSnapshots(deviceId)
  autoLinkEngine.forgetDevice(deviceId)
  deviceMsgCount.delete(deviceId)
  for (const [path, param] of namespace.entries()) {
    if (param.deviceId === deviceId) namespace.delete(path)
  }
  broadcastHub({ type: 'DEVICE_REMOVED', deviceId })
}

/**
 * Permanently remove one manifest. This path deliberately creates no backup,
 * Trash copy, tombstone, or restore record.
 */
function removeManagedDevicePermanently(
  deviceId,
  { cause = 'manual', expectedClient, armedAt } = {}
) {
  const dev = devices.get(deviceId)
  const filename = manifestFilenames.get(deviceId)
  const filenames = Array.from(new Set([
    filename,
    ...(manifestFilesByDeviceId.get(deviceId) || [])
  ].filter(Boolean)))
  const currentClient = oscQueryClients.get(deviceId)

  if (expectedClient && currentClient !== expectedClient) {
    console.log(`  [manifest-delete] skipped id=${deviceId} reason=stale_client`)
    return { ok: false, stale: true }
  }
  if (!dev || filenames.length === 0) {
    return { ok: false, stale: true, error: `Device not found: id ${deviceId}` }
  }

  suppressWatcher = true
  const failures = []
  for (const manifestFile of filenames) {
    try {
      unlinkSync(join(MANIFESTS_DIR, manifestFile))
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        failures.push({ filename: manifestFile, error: err })
      } else {
        console.log(`  [manifest-delete] already-absent id=${deviceId} file=${manifestFile}`)
      }
    }
  }
  if (failures.length > 0) {
    suppressWatcher = false
    for (const failure of failures) {
      console.log(`  [manifest-delete] failed id=${deviceId} file=${failure.filename} code=${failure.error?.code || 'UNKNOWN'}: ${failure.error.message}`)
    }
    return {
      ok: false,
      error: `Could not delete ${failures.map((failure) => failure.filename).join(', ')}`
    }
  }

  if (currentClient) {
    oscQueryClients.delete(deviceId)
    currentClient.disconnect()
  }
  deviceRegistry.removeManifest(deviceId)
  clearManagedDeviceRuntimeState(deviceId)

  const elapsed = Number.isFinite(armedAt) ? ` elapsedMs=${Date.now() - armedAt}` : ''
  console.log(`  [manifest-delete] complete id=${deviceId} cause=${cause} file=${filenames.join(',')}${elapsed} backup=none`)
  loadManifests()
  setTimeout(() => { suppressWatcher = false }, 300)
  return { ok: true }
}

function migrateManifestEntries(entries) {
  const migration = deduplicateManifestEntries(entries, {
    localAddresses: getLocalInterfaceAddresses()
  })
  const changed = migration.kept.some((entry) => entry.changed) || migration.duplicates.length > 0
  if (!changed) return migration.kept

  suppressWatcher = true
  const archiveDir = migration.duplicates.length > 0
    ? join(MANIFESTS_DIR, '.deduplicated', new Date().toISOString().replace(/[:.]/g, '-'))
    : null
  try {
    if (archiveDir) mkdirSync(archiveDir, { recursive: true })
    for (const entry of migration.kept) {
      if (!entry.changed) continue
      const target = join(MANIFESTS_DIR, entry.file)
      const temp = `${target}.migrating-${process.pid}`
      writeFileSync(temp, JSON.stringify(entry.manifest, null, 2) + '\n', 'utf-8')
      renameSync(temp, target)
    }
    for (const duplicate of migration.duplicates) {
      renameSync(join(MANIFESTS_DIR, duplicate.file), join(archiveDir, duplicate.file))
      console.log(`  [manifest-migrate] merged ${duplicate.file} → ${duplicate.keptFile} (canonical ${duplicate.canonicalId})`)
    }
    console.log(`  [manifest-migrate] canonicalized ${migration.kept.length} device(s); archived ${migration.duplicates.length} duplicate file(s)`)
  } finally {
    setTimeout(() => { suppressWatcher = false }, 300)
  }
  return migration.kept
}

// ─── Manifest loader ──────────────────────────────────────────────────────
function loadManifests() {
  const before = devices.size
  const oldDevices = new Map(devices)
  const oldManifestFilenames = new Map(manifestFilenames)

  try {
    const files = readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.json')).sort()
    const parsedEntries = []
    for (const file of files) {
      try {
        const content = readFileSync(join(MANIFESTS_DIR, file), 'utf-8')
        const manifest = JSON.parse(content)
        if (!Number.isInteger(Number(manifest.id)) || !manifest.host || !manifest.oscQueryPort) {
          throw new Error('manifest requires numeric id, host and oscQueryPort')
        }
        manifest.id = Number(manifest.id)
        manifest.oscQueryPort = Number(manifest.oscQueryPort)
        parsedEntries.push({ file, manifest })
      } catch (err) {
        console.log(`  [manifest] read error (${file}): ${err.message}`)
      }
    }

    const migratedEntries = migrateManifestEntries(parsedEntries)

    // Build the next maps completely BEFORE swapping them in. A mid-load
    // exception must never leave `devices` half-cleared while clients and
    // dashboards still reference the previous set.
    const nextDevices = new Map()
    const nextManifestFilenames = new Map()
    const nextManifestFiles = new Map()
    for (const { file, manifest } of migratedEntries) {
      try {
        // Record EVERY parsed file per id — including duplicate-id shadow
        // files — so a permanent delete removes all of them and none can
        // resurrect the device on the next reload.
        const knownFiles = nextManifestFiles.get(manifest.id) || []
        knownFiles.push(file)
        nextManifestFiles.set(manifest.id, knownFiles)

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
        manifest.runtimeGeneration =
          sameTarget && old.runtimeGeneration
            ? old.runtimeGeneration
            : nextDeviceRuntimeGeneration++
        if (sameTarget && manifest.enabled && oscQueryClients.has(manifest.id)) {
          manifest.status        = old.status || (manifest.enabled ? 'configured' : 'disabled')
          manifest.connectionState = old.connectionState || connectionStateFor(old)
          manifest.oscPort       = old.oscPort
          manifest.paramCount    = old.paramCount
          manifest.lastMessageAt = old.lastMessageAt
        } else {
          manifest.status = manifest.enabled ? 'configured' : 'disabled'
          manifest.connectionState = manifest.enabled
            ? CONNECTION_STATES.DISCOVERED
            : CONNECTION_STATES.DISABLED
        }

        if (nextDevices.has(manifest.id)) {
          console.log(`  [manifest] conflict: id ${manifest.id} already exists, skipping ${file}`)
          continue
        }

        nextDevices.set(manifest.id, manifest)
        nextManifestFilenames.set(manifest.id, file)
      } catch (err) {
        console.log(`  [manifest] read error (${file}): ${err.message}`)
      }
    }

    // Atomic swap: only now touch the shared maps.
    devices.clear()
    for (const [id, manifest] of nextDevices) devices.set(id, manifest)
    manifestFilenames.clear()
    for (const [id, file] of nextManifestFilenames) manifestFilenames.set(id, file)
    manifestFilesByDeviceId.clear()
    for (const [id, list] of nextManifestFiles) manifestFilesByDeviceId.set(id, list)

    rebuildDeviceRegistry()
    console.log(`  [manifest] loaded ${devices.size} canonical device(s)  (was ${before})`)

    reconcileClients(oldDevices, oldManifestFilenames)

    broadcastHub({
      type: 'DEVICES_RELOADED',
      devices: clientRegistrySnapshot()
    })
    broadcastRegistry()
    autoLinkEngine.poke('manifests-loaded')
  } catch (err) {
    console.log(`  [manifest] could not read ${MANIFESTS_DIR}: ${err.message}`)
  }
}

// ─── Client lifecycle ─────────────────────────────────────────────────────
function manifestDefinitionKey(dev, filename) {
  if (!dev) return ''
  return JSON.stringify([
    filename || '',
    dev.id,
    dev.name,
    dev.type,
    dev.host,
    Number(dev.oscQueryPort),
    dev.enabled !== false,
    dev.description || ''
  ])
}

function reconcileClients(oldDevices, oldManifestFilenames = manifestFilenames) {
  // Disconnect clients whose target moved or was disabled/removed.
  for (const [id, oldDev] of oldDevices.entries()) {
    const newDev = devices.get(id)
    const shouldDisconnect =
      !newDev ||
      !newDev.enabled ||
      newDev.host !== oldDev.host ||
      newDev.oscQueryPort !== oldDev.oscQueryPort

    if (shouldDisconnect) cosmicNoiseForwarder.clearDeviceSnapshots(id)
    // A device dropped by a manifest reload must also leave the auto-link
    // engine, or its per-device retry timers/state leak until process exit.
    if (!newDev) autoLinkEngine.forgetDevice(id)
    if (shouldDisconnect && oscQueryClients.has(id)) {
      const client = oscQueryClients.get(id)
      oscQueryClients.delete(id)
      client.disconnect()
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
  dev.connectionState = CONNECTION_STATES.CONNECTING
  dev.error = null
  broadcastDeviceUpdate(dev)

  const client = new OscQueryClient(dev.host, dev.oscQueryPort, {
    onConnect: () => {
      if (oscQueryClients.get(dev.id) !== client) return
      const currentDev = devices.get(dev.id)
      if (!currentDev) return
      currentDev.status = 'connected'
      currentDev.connectionState = CONNECTION_STATES.CONNECTED
      currentDev.error = null
      currentDev.lastMessageAt = Date.now()
      currentDev.consecutiveConnectFailures = 0
      // Keep only an OSC UDP port actually advertised by HOST_INFO. The
      // OSCQuery HTTP port is not a safe fallback for CosmicUnity: the VST's
      // control UDP listener is intentionally independent.
      currentDev.oscPort = isValidOscPort(Number(client.hostInfo?.OSC_PORT))
        ? Number(client.hostInfo.OSC_PORT)
        : null
      if (client.lastNamespace) {
        // flatNodes is bounded by the client's namespace caps; re-walking
        // the raw tree here would reintroduce unguarded recursion.
        const count = Array.isArray(client.flatNodes)
          ? client.flatNodes.length
          : countParams(client.lastNamespace)
        currentDev.paramCount = count
        console.log(`  [client] ✓ ${currentDev.name} connected (${count} params)`)
      }
      broadcastDeviceUpdate(currentDev)
      // Ship the full per-device parameter list (with TYPE / RANGE / ACCESS /
      // DESCRIPTION / UNIT) to every dashboard so it can render real widgets.
      broadcastHub({
        type: 'DEVICE_NAMESPACE',
        deviceId: currentDev.id,
        deviceName: currentDev.name,
        nodes: client.flatNodes
      })
      // A (re)connected client forgot its peers: drop the applied-link
      // signature so the auto-link engine announces again.
      autoLinkEngine.noteDeviceConnected(currentDev.id)
    },
    onDisconnect: (reason) => {
      if (oscQueryClients.get(dev.id) !== client) return
      cosmicNoiseForwarder.clearDeviceSnapshots(dev.id)
      const currentDev = devices.get(dev.id)
      if (!currentDev) return
      currentDev.status = 'lost'
      currentDev.connectionState = CONNECTION_STATES.UNAVAILABLE
      currentDev.error = reason
      // The cached OSC UDP port dies with the connection. A restarted device
      // rebinds a new ephemeral port; writes to the old one silently vanish.
      currentDev.oscPort = null
      console.log(`  [client] ✗ ${currentDev.name} lost: ${reason}`)
      broadcastDeviceUpdate(currentDev)
    },
    onAttemptFailed: (reason, details) => {
      if (oscQueryClients.get(dev.id) !== client) return
      const currentDev = devices.get(dev.id)
      if (!currentDev) return
      currentDev.consecutiveConnectFailures =
        (Number(currentDev.consecutiveConnectFailures) || 0) + 1
      currentDev.status = details.timeout ? 'unavailable' : 'error'
      currentDev.connectionState = details.timeout
        ? CONNECTION_STATES.UNAVAILABLE
        : CONNECTION_STATES.ERROR
      currentDev.error = reason
      console.log(`  [client] ${details.timeout ? 'timeout' : 'failed'} ${currentDev.name}: ${reason}`)
      broadcastDeviceUpdate(currentDev)
    },
    onHostInfo: (hostInfo) => {
      if (oscQueryClients.get(dev.id) !== client) return
      const currentDev = devices.get(dev.id)
      if (!currentDev) return
      const previousPersistentId = currentDev.persistentDeviceId
      const previousCanonicalId = currentDev.canonicalId
      currentDev.hostInfo = hostInfo
      currentDev.oscPort = isValidOscPort(Number(hostInfo.OSC_PORT))
        ? Number(hostInfo.OSC_PORT)
        : null
      const identityRecord = deviceRegistry.upsertManifest({
        ...registryManifest(currentDev),
        hostInfo,
        persistentDeviceId: hostInfo.DEVICE_ID || currentDev.persistentDeviceId,
        deviceType: hostInfo.DEVICE_TYPE || currentDev.deviceType
      })
      applyRegistryIdentity(currentDev, identityRecord)
      if (
        identityRecord?.persistentDeviceId &&
        (identityRecord.persistentDeviceId !== previousPersistentId ||
          identityRecord.canonicalId !== previousCanonicalId)
      ) {
        // Persist an identity first learned from HOST_INFO so manual devices
        // retain their canonical card across Manager restarts too.
        saveManifest(currentDev.id, {})
      } else {
        broadcastRegistry()
      }
      // HOST_INFO delivers the OSC UDP ports both sides of a link need.
      autoLinkEngine.poke('host-info')
    },
    onLog: (msg) => {
      console.log(`     [${dev.name}] ${msg}`)
    },
    onValue: (path, value, metadata) => {
      if (oscQueryClients.get(dev.id) !== client) return
      const currentDev = devices.get(dev.id)
      if (!currentDev) return
      handleClientValue(currentDev, path, value, metadata)
    }
  }, {
    reconnectDelayMs: 3000,
    disconnectReconnectDelayMs: 500,
    attemptTimeoutMs: CONNECTION_TIMEOUT_MS,
    keepaliveIntervalMs: OSCQUERY_KEEPALIVE_MS,
    keepaliveMaxMissed: OSCQUERY_KEEPALIVE_MAX_MISSED,
    hostInfoRetryBaseMs: OSCQUERY_HOSTINFO_RETRY_MS
  })

  oscQueryClients.set(dev.id, client)
  client.connect()
}

let managedNamespaceCapLogged = false

function handleClientValue(dev, path, value, metadata = {}) {
  const receivedAt = Date.now()
  dev.lastMessageAt = receivedAt
  dev.status = 'connected'
  dev.connectionState = CONNECTION_STATES.CONNECTED
  dev.error = null

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
  const sourceMetadata = metadata || {}

  // Independent of the historical Ableton mirror. This path keeps every
  // payload argument and uses the OSCQuery node TYPE (or binary wire metadata)
  // so f/i/s/T/F/d values are not collapsed by JavaScript inference.
  if (cosmicNoiseForwarder.enabled && dev.enabled) {
    cosmicNoiseForwarder.forward(
      {
        deviceId: dev.id,
        sourcePath: path,
        payload: v,
        oscQueryType: sourceMetadata.oscQueryType,
        wireArgs: sourceMetadata.wireArgs
      },
      { cacheSnapshot: true, receivedAt }
    )
  }

  if (!namespace.has(hubPath) && namespace.size >= MAX_NAMESPACE) {
    // Hard cap to prevent runaway memory if a device misbehaves. Log the
    // first drop so a filled cap is diagnosable, then stay quiet.
    if (!managedNamespaceCapLogged) {
      managedNamespaceCapLogged = true
      console.log(`  [hub] namespace cap reached (${MAX_NAMESPACE}); new managed paths are being dropped (logged once)`)
    }
    return
  }
  namespace.set(hubPath, {
    fullPath: hubPath,
    type,
    value: v,
    lastUpdate: receivedAt,
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
    timestamp: receivedAt
  })

  if (ABLETON_FORWARD && dev.enabled) {
    forwardToAbleton(dev.id, path, v, type)
  }
}

function broadcastDeviceUpdate(dev) {
  const registryRecord = deviceRegistry.updateConnection(dev.canonicalId, {
    connectionState: connectionStateFor(dev),
    error: dev.error || null,
    enabled: dev.enabled,
    paramCount: dev.paramCount || 0,
    runtimeGeneration: dev.runtimeGeneration,
    lastSeen: dev.lastMessageAt || Date.now(),
    activeEndpoint: { host: dev.host, port: dev.oscQueryPort }
  })
  if (registryRecord) applyRegistryIdentity(dev, registryRecord)
  broadcastHub({ type: 'DEVICE_UPDATED', device: { ...dev, ...registryRecord } })
  broadcastRegistry()
}

// ─── Auto-link engine ─────────────────────────────────────────────────────
// Re-applies persisted `link` manifests through the exact same resolution +
// announce core the WS ANNOUNCE_DEVICE handler uses (performAnnounce below).
// Poke-driven only; every timer it creates is unref'd and close() runs in
// shutdown().
const autoLinkEngine = createAutoLinkEngine({
  resolveAndAnnounce: (args) => performAnnounce(args),
  getDevicesWithLinks: () =>
    Array.from(devices.values()).filter((dev) => dev.link && typeof dev.link === 'object'),
  getRegistrySnapshot: () => deviceRegistry.snapshot(),
  getManagedDevice: (deviceId) => devices.get(Number(deviceId)),
  onStatus: (deviceId, status) => {
    const dev = devices.get(deviceId)
    if (!dev) return
    dev.autoLink = status
    broadcastDeviceUpdate(dev)
  },
  log: (line) => console.log(`  [autolink] ${line}`)
})

// ─── Manifest save ────────────────────────────────────────────────────────
const RUNTIME_ONLY_MANIFEST_FIELDS = new Set([
  'activeEndpoint',
  'autoLink',
  'connectionState',
  'consecutiveConnectFailures',
  'discoveryState',
  'error',
  'reachability',
  'hostInfo',
  'isLocal',
  'lastMessageAt',
  'locationLabel',
  'oscPort',
  'paramCount',
  'runtimeGeneration',
  'saved',
  'status'
])

function persistentManifestFields(dev) {
  return Object.fromEntries(
    Object.entries(dev || {}).filter(([key]) => !RUNTIME_ONLY_MANIFEST_FIELDS.has(key))
  )
}

// Shared shape gate for the persisted auto-link field: saveManifest and
// IMPORT_MANIFESTS both accept payloads verbatim from /ws/hub clients, so
// both must run the same bounded validation before anything reaches disk.
function validateLinkField(link) {
  if (typeof link !== 'object' || link === null || Array.isArray(link)) {
    return { ok: false, error: 'Invalid link payload' }
  }
  const targetFqdn = link.targetFqdn ?? ''
  const targetName = link.targetName ?? ''
  const peerId = link.peerId ?? ''
  const udpPortOverride = link.udpPortOverride ?? 0
  if (typeof targetFqdn !== 'string' || targetFqdn.length > 128) {
    return { ok: false, error: 'Invalid link targetFqdn' }
  }
  if (typeof targetName !== 'string' || targetName.length > 128) {
    return { ok: false, error: 'Invalid link targetName' }
  }
  if (targetFqdn.trim().length === 0 && targetName.trim().length === 0) {
    return { ok: false, error: 'Link requires a targetFqdn or targetName' }
  }
  if (typeof peerId !== 'string' || peerId.length > 128) {
    return { ok: false, error: 'Invalid link peerId' }
  }
  if (!Number.isInteger(udpPortOverride) || udpPortOverride < 0 || udpPortOverride > 65535) {
    return { ok: false, error: 'Invalid link udpPortOverride' }
  }
  return { ok: true, value: { targetFqdn, targetName, peerId, udpPortOverride } }
}

function saveManifest(deviceId, updates) {
  const dev = devices.get(deviceId)
  const filename = manifestFilenames.get(deviceId)

  if (!dev || !filename) {
    return { ok: false, error: `Device not found: id ${deviceId}` }
  }

  // `updates` can arrive verbatim from any /ws/hub client. Validate every
  // field type defensively — a malformed payload must produce an error
  // result, never a thrown TypeError that would kill the hub process.
  if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
    return { ok: false, error: 'Invalid updates payload' }
  }
  if (updates.host !== undefined && (typeof updates.host !== 'string' || !isValidHost(updates.host))) {
    return { ok: false, error: `Invalid host: ${updates.host}` }
  }
  if (updates.oscQueryPort !== undefined && !isValidOscPort(updates.oscQueryPort)) {
    return { ok: false, error: `Invalid port: ${updates.oscQueryPort}` }
  }
  if (
    updates.name !== undefined &&
    (typeof updates.name !== 'string' || updates.name.trim().length === 0 || updates.name.length > 64)
  ) {
    return { ok: false, error: 'Invalid device name' }
  }
  if (updates.enabled !== undefined && typeof updates.enabled !== 'boolean') {
    return { ok: false, error: 'Invalid enabled flag' }
  }
  if (updates.description !== undefined && typeof updates.description !== 'string') {
    return { ok: false, error: 'Invalid description' }
  }
  // Persisted auto-link target. `null` removes the link; anything else must
  // match the documented shape exactly — bounded strings and a real port
  // range — because this payload also arrives verbatim from /ws/hub clients.
  let validatedLink
  if (updates.link !== undefined && updates.link !== null) {
    const linkCheck = validateLinkField(updates.link)
    if (!linkCheck.ok) return { ok: false, error: linkCheck.error }
    validatedLink = linkCheck.value
  }

  // Start from every non-runtime field loaded from disk so migrations and
  // identity refreshes cannot silently erase future/extension settings (for
  // example routing, presets metadata or operator-specific configuration).
  const updated = {
    ...persistentManifestFields(dev),
    id: dev.id,
    name: updates.name ?? dev.name,
    type: dev.type || 'oscquery-device',
    deviceType: dev.deviceType,
    canonicalId: (updates.host !== undefined || updates.oscQueryPort !== undefined)
      ? undefined
      : dev.canonicalId,
    persistentDeviceId: dev.persistentDeviceId || null,
    serviceName: dev.serviceName || dev.name,
    host: updates.host ?? dev.host,
    oscQueryPort: updates.oscQueryPort ?? dev.oscQueryPort,
    enabled: updates.enabled ?? dev.enabled,
    description: updates.description ?? dev.description,
    // `link: undefined` (explicit null update) drops the key on serialization.
    link: updates.link !== undefined ? validatedLink : dev.link,
    endpoints: (updates.host !== undefined || updates.oscQueryPort !== undefined)
      ? [{
          host: updates.host ?? dev.host,
          port: updates.oscQueryPort ?? dev.oscQueryPort,
          source: 'manual-update',
          lastSeen: Date.now()
        }]
      : (dev.endpoints || []),
    legacyIds: dev.legacyIds || [],
    legacyCanonicalIds: dev.legacyCanonicalIds || []
  }

  try {
    ensureManifestsDir()
    suppressWatcher = true
    const filePath = join(MANIFESTS_DIR, filename)
    writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n', 'utf-8')

    const oldDev = { ...dev }
    const lifecycleChanged =
      updated.host !== dev.host ||
      Number(updated.oscQueryPort) !== Number(dev.oscQueryPort) ||
      updated.enabled !== dev.enabled
    const newDev = {
      ...updated,
      runtimeGeneration: lifecycleChanged
        ? nextDeviceRuntimeGeneration++
        : (dev.runtimeGeneration || nextDeviceRuntimeGeneration++),
      // Preserve runtime-only state across a plain settings/identity save.
      // Losing dev.oscPort here would forget the HOST_INFO-advertised OSC
      // UDP port and fail-close every subsequent SET_DEVICE_PARAM. A
      // lifecycle change resets these because the client reconnects.
      oscPort: lifecycleChanged ? null : (dev.oscPort ?? null),
      autoLink: lifecycleChanged ? undefined : dev.autoLink,
      hostInfo: lifecycleChanged ? undefined : dev.hostInfo,
      paramCount: lifecycleChanged ? undefined : dev.paramCount,
      lastMessageAt: lifecycleChanged ? undefined : dev.lastMessageAt,
      consecutiveConnectFailures: lifecycleChanged
        ? 0
        : (dev.consecutiveConnectFailures || 0),
      status: updated.enabled
        ? (lifecycleChanged ? 'configured' : dev.status)
        : 'disabled',
      connectionState: updated.enabled
        ? (lifecycleChanged ? CONNECTION_STATES.DISCOVERED : connectionStateFor(dev))
        : CONNECTION_STATES.DISABLED,
      error: lifecycleChanged ? null : dev.error
    }
    devices.set(deviceId, newDev)
    rebuildDeviceRegistry()
    applyRegistryIdentity(newDev, deviceRegistry.findByManifestId(deviceId))

    // Renaming changes the hub-path prefix (/<name>/...). Drop the old-name
    // namespace entries so they don't linger as orphans until restart; live
    // values repopulate immediately under the new prefix.
    if (updates.name !== undefined && updates.name !== oldDev.name) {
      for (const [path, param] of namespace.entries()) {
        if (param.deviceId === deviceId) namespace.delete(path)
      }
    }

    console.log(`  [manifest] saved ${dev.name} (id ${deviceId})`)
    if (updates.host !== undefined) console.log(`     host: ${oldDev.host} → ${updated.host}`)
    if (updates.oscQueryPort !== undefined) console.log(`     port: ${oldDev.oscQueryPort} → ${updated.oscQueryPort}`)
    if (updates.enabled !== undefined) console.log(`     enabled: ${oldDev.enabled} → ${updated.enabled}`)

    const oldMap = new Map(devices)
    oldMap.set(deviceId, oldDev)
    reconcileClients(oldMap)

    setTimeout(() => { suppressWatcher = false }, 500)

    broadcastDeviceUpdate(newDev)
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
  // Out-of-int32 integers fall through to the ,sf float encoding —
  // writeInt32BE would throw a RangeError and kill the forward path.
  const isInt = type === 'i' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647
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
// device) and by announceToTarget() (bootstrap a CosmicUnity peer). Kept separate
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

// Boot the rest of the hub (manifest load + watcher). Extracted so it can be
// called either from the UDP port's 'ready' callback (normal mode) or
// directly when the UDP listener is disabled.
let manifestWatcher = null
let manifestReloadTimer = null
function bootHub() {
  // Device configuration is durable. Restarting the Manager must never erase
  // manifests, presets, routing IDs or links.
  loadManifests()
  try {
    manifestWatcher?.close()
    manifestWatcher = watch(MANIFESTS_DIR, { persistent: false }, () => {
      if (suppressWatcher) return
      console.log('  [manifest] folder changed, reloading…')
      if (manifestReloadTimer) clearTimeout(manifestReloadTimer)
      manifestReloadTimer = setTimeout(() => {
        manifestReloadTimer = null
        loadManifests()
      }, 100)
    })
  } catch {
    console.log('  [manifest] watcher could not start')
  }
}

// The hub boot (manifests, watcher, device clients) must never depend on the
// UDP OSC listener actually binding. When the port is busy the hub runs in a
// degraded mode (HUB_STATUS oscListen:'degraded') and keeps retrying the bind
// with backoff.
let hubBooted = false
function ensureHubBooted() {
  if (hubBooted) return
  hubBooted = true
  bootHub()
}

let oscListenBound = false
let oscRebindTimer = null
let oscRebindAttempts = 0
function scheduleOscListenRebind() {
  if (isShuttingDown || oscRebindTimer || process.env.OSC_LISTEN_DISABLED === '1') return
  const delay = Math.min(1000 * 2 ** Math.min(oscRebindAttempts, 4), 10_000)
  oscRebindAttempts++
  console.log(`[osc-hub] retrying UDP bind on ${OSC_LISTEN_PORT} in ${delay} ms (attempt ${oscRebindAttempts})`)
  oscRebindTimer = setTimeout(() => {
    oscRebindTimer = null
    if (isShuttingDown || oscListenBound) return
    // osc.UDPPort.open() is a no-op while `socket` is set; discard the
    // errored socket so a fresh bind attempt can run.
    try { udpHubPort.socket?.close() } catch {}
    udpHubPort.socket = null
    try {
      udpHubPort.open()
    } catch (err) {
      console.error('[osc-hub] rebind attempt failed:', err.message)
      scheduleOscListenRebind()
    }
  }, delay)
  if (typeof oscRebindTimer.unref === 'function') oscRebindTimer.unref()
}

udpHubPort.on('ready', () => {
  oscListenBound = true
  oscRebindAttempts = 0
  console.log(`[osc-hub] listening for UDP OSC on 0.0.0.0:${OSC_LISTEN_PORT}`)
  for (const ip of lanAddresses()) {
    console.log(`[osc-hub] LAN address: ${ip.address}  (interface ${ip.name})`)
  }
  setOscListenState('ok')
  ensureHubBooted()
})

udpHubPort.on('close', () => {
  oscListenBound = false
})

udpHubPort.on('error', (err) => {
  console.error('[osc-hub] socket error:', err.message)
  if (oscListenBound) return // runtime send error — the listener itself is fine
  // Bind failure (e.g. EADDRINUSE): the hub must still come up with all
  // manifests and device connections. Surface the degraded OSC listener to
  // the UI and keep retrying the bind in the background.
  setOscListenState('degraded')
  ensureHubBooted()
  scheduleOscListenRebind()
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

  // Per-message UDP debug log. Disabled by default because incoming OSC
  // streams (TouchDesigner, motion-tracking rigs, etc.) can produce
  // hundreds of messages per second and quickly flood the terminal.
  // Enable with OSC_VERBOSE=1 env var if you need it for diagnostics.
  if (process.env.OSC_VERBOSE === '1') {
    const marker = isNew ? '*' : ' '
    const valStr = args.map((a) => `${a.value}(${a.type})`).join(', ')
    console.log(`${marker} [${time}] [UDP-direct] ${oscMsg.address.padEnd(28)} → ${valStr}`)
  }

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

// Open the UDP listener unless explicitly disabled via env. Set
// `OSC_LISTEN_DISABLED=1` to skip — useful when:
//   - the OSC_LISTEN_PORT clashes with another app you want to use that port
//   - you don't need the /subscribe relay or OSC-direct UDP inbound
//   - you want a quieter helper that only does OSCQuery WS, no UDP plumbing
// The OSCQuery hub HTTP/WS, Bonjour, and per-device OSCQuery clients still
// work unchanged — only the raw UDP inbound socket is skipped.
if (process.env.OSC_LISTEN_DISABLED === '1') {
  console.log('[osc-hub] UDP inbound disabled via OSC_LISTEN_DISABLED=1')
  // The boot logic normally fires inside the UDP 'ready' callback; since
  // we're not opening that socket, run it directly. Defer one tick so the
  // rest of this module finishes setting up handlers first.
  setImmediate(ensureHubBooted)
} else {
  udpHubPort.open()
}

// ─── Bonjour: discovery (existing CLM behaviour) + publish (new hub) ─────
const bonjour = new Bonjour()
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

function broadcastDiscovered() {
  const unsaved = clientRegistrySnapshot().filter((record) => !record.saved)
  broadcastHub({ type: 'DISCOVERED_DEVICES', devices: unsaved })
  broadcastRegistry()
  autoLinkEngine.poke('discovery')
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

    // Every address is an observation of the same service, never a new card.
    // DeviceRegistry validates local interfaces before folding LAN aliases into
    // a local CosmicUnity instance.
    if (Number(service.port) === PORT) return
    const record = upsertServiceInRegistry(service)
    if (record?.saved) {
      const dev = devices.get(record.manifestId)
      if (dev) {
        const previousPersistentId = dev.persistentDeviceId
        applyRegistryIdentity(dev, record)
        const endpointChanged = record.persistentDeviceId && record.activeEndpoint && (
          dev.host !== record.activeEndpoint.host ||
          Number(dev.oscQueryPort) !== Number(record.activeEndpoint.port)
        )
        if (endpointChanged) {
          saveManifest(dev.id, {
            host: record.activeEndpoint.host,
            oscQueryPort: record.activeEndpoint.port
          })
        } else if (record.persistentDeviceId && previousPersistentId !== record.persistentDeviceId) {
          saveManifest(dev.id, {})
        }
      }
    }
    broadcastDiscovered()
  })
  b.on('down', (service) => {
    services.delete(service.fqdn)
    console.log('[discovery] down ', service.name)
    broadcastDiscovery()

    const ipv4 = (service.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
    deviceRegistry.markDiscoveryDown({
      fqdn: service.fqdn,
      host: ipv4 || service.host,
      port: Number(service.port)
    })
    broadcastDiscovered()
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
  rebuildDeviceRegistry()
  broadcastDiscovery()
  broadcastDiscovered()
  console.log('[discovery] rediscover requested — caches cleared, restarting browser')
  startBrowser()
}

const discoveryStaleTimer = setInterval(() => {
  const removed = deviceRegistry.pruneStale(DISCOVERY_STALE_TTL_MS)
  if (removed.length > 0) broadcastDiscovered()
}, 1000)
discoveryStaleTimer.unref()

// ─── Reachability prober (no-goodbye ghosts) ─────────────────────────────
// bonjour-service only emits 'down' on an explicit TTL=0 goodbye packet.
// Devices that hard-power-off stay 'Discovered' forever without this: after
// NO_GOODBYE_TTL_MS of silence a record is marked 'silent' and probed over
// HTTP; a failed probe marks it 'dead' + Stale, which makes it prunable.
const reachabilityProbesInFlight = new Set()

async function probeEndpointReachability(endpoint) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REACHABILITY_PROBE_TIMEOUT_MS)
  try {
    // Any HTTP response — even an error status — proves the host is alive.
    await fetch(`http://${endpoint.host}:${endpoint.port}/?HOST_INFO`, {
      signal: controller.signal
    })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

const reachabilityTimer = setInterval(() => {
  const candidates = deviceRegistry.reachabilityProbeCandidates(NO_GOODBYE_TTL_MS)
  for (const record of candidates) {
    const endpoint = record.activeEndpoint ||
      (record.endpoints || []).find((item) => item?.host && item?.port)
    if (!endpoint?.host || !endpoint?.port) continue
    if (reachabilityProbesInFlight.has(record.canonicalId)) continue
    reachabilityProbesInFlight.add(record.canonicalId)
    probeEndpointReachability(endpoint)
      .then((ok) => {
        deviceRegistry.markProbeResult(record.canonicalId, ok)
        if (!ok) {
          console.log(`  [registry] no-goodbye ghost pruned to Stale: ${record.canonicalId}`)
          broadcastDiscovered()
        }
      })
      .catch(() => {})
      .finally(() => reachabilityProbesInFlight.delete(record.canonicalId))
  }
}, REACHABILITY_PROBE_INTERVAL_MS)
reachabilityTimer.unref()

// ─── Persistent-id port-collision auto-heal ──────────────────────────────
// A restarted VST that rebinds a fallback OSCQuery port leaves the saved
// card on a dead port plus an unsaved collision card. Once the old endpoint
// is confirmed dead (repeated failed connect attempts) migrate the saved
// manifest to the collision endpoint. Both-alive collisions stay visible.
const collisionHealTimer = setInterval(() => {
  try {
    const plans = planCollisionHeals({
      snapshot: deviceRegistry.snapshot(),
      getManagedDevice: (manifestId) => devices.get(manifestId)
    })
    for (const plan of plans) {
      console.log(
        `  [registry] collision auto-heal: device ${plan.manifestId} → ` +
        `${plan.host}:${plan.oscQueryPort} (old endpoint dead; ${plan.collisionCanonicalId})`
      )
      const result = saveManifest(plan.manifestId, {
        host: plan.host,
        oscQueryPort: plan.oscQueryPort
      })
      if (!result.ok) {
        console.log(`  [registry] collision auto-heal failed for device ${plan.manifestId}: ${result.error}`)
      }
    }
    if (plans.length > 0) broadcastDiscovered()
  } catch (err) {
    console.log(`  [registry] collision heal error: ${err.message}`)
  }
}, COLLISION_HEAL_INTERVAL_MS)
collisionHealTimer.unref()

// ─── Saved-device fqdn host-follow auto-heal ─────────────────────────────
// A DHCP lease change moves a device to a new address under the same mDNS
// fqdn. Discovery folds the fresh endpoint into the saved record immediately,
// but the connection loop keeps dialing the manifest's dead host:port. Once
// that endpoint has failed repeatedly, migrate the manifest to the freshest
// same-fqdn discovery endpoint and reconnect. fqdn identity is mandatory —
// planHostFollowHeals never follows a mere name lookalike.
const hostFollowHealTimer = setInterval(() => {
  try {
    const plans = planHostFollowHeals({
      snapshot: deviceRegistry.snapshot(),
      getManagedDevice: (manifestId) => devices.get(manifestId)
    })
    for (const plan of plans) {
      console.log(
        `  [heal] host follow: device ${plan.manifestId} ` +
        `${plan.fromHost}:${plan.fromPort} → ${plan.host}:${plan.oscQueryPort} (fqdn ${plan.fqdn})`
      )
      const result = saveManifest(plan.manifestId, {
        host: plan.host,
        oscQueryPort: plan.oscQueryPort
      })
      if (!result.ok) {
        console.log(`  [heal] host follow failed for device ${plan.manifestId}: ${result.error}`)
      }
    }
    if (plans.length > 0) broadcastDiscovered()
  } catch (err) {
    console.log(`  [heal] host follow error: ${err.message}`)
  }
}, HOST_FOLLOW_HEAL_INTERVAL_MS)
hostFollowHealTimer.unref()

startBrowser()

function publishBonjour() {
  bonjour.publish({ name: HUB_NAME, type: 'oscjson', protocol: 'tcp', port: PORT })
  bonjour.publish({ name: HUB_NAME, type: 'osc', protocol: 'udp', port: OSC_LISTEN_PORT })
  console.log(`[bonjour] published "${HUB_NAME}" as _oscjson._tcp:${PORT} and _osc._udp:${OSC_LISTEN_PORT}`)
}

// ─── HTTP routes — Hub OSCQuery ───────────────────────────────────────────
app.get('/_devices', (_req, res) => {
  const devs = clientRegistrySnapshot().map((d) => ({
    ...d,
    msgCount: d.manifestId == null ? 0 : (deviceMsgCount.get(d.manifestId) || 0)
  }))
  res.json({ devices: devs, self: { name: HUB_NAME, port: PORT, oscPort: OSC_LISTEN_PORT } })
})

app.get('/_status', (_req, res) => {
  res.json({
    namespace_size: namespace.size,
    ws_clients: hubClients.size,
    osc_subscribers: Array.from(oscSubscribers.values()),
    devices: clientRegistrySnapshot(),
    registryDevices: clientRegistrySnapshot(),
    abletonMsgsSent,
    cosmicNoise: {
      enabled: cosmicNoiseForwarder.enabled,
      host: cosmicNoiseForwarder.host,
      port: cosmicNoiseForwarder.port,
      sent: cosmicNoiseForwarder.sent,
      dropped: cosmicNoiseForwarder.dropped,
      errors: cosmicNoiseForwarder.errors,
      snapshotMs: cosmicNoiseForwarder.snapshotMs,
      snapshotFreshnessMs: SNAPSHOT_FRESHNESS_MS,
      snapshotDevices: cosmicNoiseForwarder.snapshotDevices,
      snapshotEntries: cosmicNoiseForwarder.snapshotEntries,
      snapshotReplayed: cosmicNoiseForwarder.snapshotReplayed,
      snapshotDropped: cosmicNoiseForwarder.snapshotDropped
    }
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
 * Write an external OSCQuery peer's contact info onto a CosmicUnity instance's
 * /system/peer/* OSCQuery parameters by sending five OSC UDP messages.
 *
 * @param {{ target: any, peerId: string, host: string, oscQueryPort: number, udpPort: number }} args
 */
async function announceToTarget({ target, peerId, host, oscQueryPort, udpPort }) {
  // CosmicUnity's OSCQuery HTTP port and OSC UDP control port are independent.
  // The resolver uses cached HOST_INFO first, then performs one bounded refresh
  // and fails closed rather than guessing the HTTP endpoint.
  const targetOscPort = await resolveOscUdpPort(target)
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

/**
 * Shared resolution + announce core used by BOTH the WS ANNOUNCE_DEVICE
 * handler and the auto-link engine, so the two paths cannot drift. The
 * registry trust boundary is unchanged: the caller only *selects* a target;
 * address, port and deviceType always come from server-owned registry state.
 *
 * @param {{ dev: any, target: any, peerId: string, udpPortOverride?: number }} args
 * @returns {Promise<{ announcement: any, selectedRegistryDevice: any, selectedTarget: any, selectedManagedDevice: any }>}
 */
async function performAnnounce({ dev, target, peerId, udpPortOverride }) {
  const sourceRegistryDevice = deviceRegistry.findByManifestId(dev.id)
  const registrySnapshot = deviceRegistry.snapshot()
  let selectedRegistryDevice = findRegistryDeviceForTarget(
    registrySnapshot,
    target
  )
  let selectedTarget = target
  let routedSourceDevice = dev
  if (isAbletonRingReceiverDevice(sourceRegistryDevice)) {
    const resolved = resolveRingInstrumentTargetFromRegistry(registrySnapshot, target)
    selectedRegistryDevice = resolved.record
    selectedTarget = resolved.target
  } else if (isRingInstrumentIdentity(sourceRegistryDevice)) {
    routedSourceDevice = {
      ...dev,
      ...resolveRingInstrumentSourceFromRegistry(sourceRegistryDevice)
    }
    if (isAbletonRingReceiverDevice(selectedRegistryDevice)) {
      const resolved = resolveRingReceiverFromRegistry(registrySnapshot, target)
      selectedRegistryDevice = resolved.record
      selectedTarget = resolved.target
    } else {
      // Ring-Instrument → CosmicUnity/other: same trust boundary as the
      // generic direction — address/port must come from the registry, never
      // from the caller's payload.
      const resolved = resolveGenericTargetFromRegistry(registrySnapshot, target)
      selectedRegistryDevice = resolved.record
      selectedTarget = resolved.target
    }
  } else {
    // Generic (CosmicUnity ↔ Android/OSCQuery) direction: the same
    // server-owned trust boundary as the Ring paths. The caller only
    // selects; address, port and deviceType come from the registry.
    const resolved = resolveGenericTargetFromRegistry(registrySnapshot, target)
    selectedRegistryDevice = resolved.record
    selectedTarget = resolved.target
  }
  const selectedManagedDevice = selectedRegistryDevice?.manifestId != null
    ? devices.get(selectedRegistryDevice.manifestId)
    : null
  const announcement = resolveLinkAnnouncement({
    sourceDevice: {
      ...routedSourceDevice,
      runtimeKind: sourceRegistryDevice?.runtimeKind,
      linkRole: sourceRegistryDevice?.linkRole
    },
    selectedTarget: {
      ...selectedTarget,
      // Registry identity beats any caller-asserted type.
      deviceType: selectedRegistryDevice?.deviceType || selectedTarget.deviceType,
      runtimeKind: selectedRegistryDevice?.runtimeKind,
      linkRole: selectedRegistryDevice?.linkRole,
      oscPort: selectedManagedDevice?.oscPort || selectedTarget.oscPort
    },
    peerId,
    udpPortOverride
  })
  await announceToTarget(announcement)
  return { announcement, selectedRegistryDevice, selectedTarget, selectedManagedDevice }
}

// /ws/hub (and /) — dashboard control channel for the OQH-style UI
wssHub.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress
  console.log(`[hub-ws] connection from ${ip}`)
  hubClients.add(ws)

  const initialSnapshot = clientRegistrySnapshot()
  ws.send(JSON.stringify({
    type: 'INITIAL_STATE',
    namespace: buildTree(),
    devices: initialSnapshot,
    subscribers: Array.from(oscSubscribers.values()),
    discoveredDevices: initialSnapshot.filter((record) => !record.saved),
    registryDevices: initialSnapshot,
    hubName: HUB_NAME,
    abletonForward: ABLETON_FORWARD ? { host: ABLETON_HOST, port: ABLETON_PORT } : null,
    cosmicNoiseForward: cosmicNoiseForwarder.enabled
      ? {
          host: cosmicNoiseForwarder.host,
          port: cosmicNoiseForwarder.port,
          snapshotMs: cosmicNoiseForwarder.snapshotMs
        }
      : null
  }))
  ws.send(JSON.stringify(currentHubStatus()))

  // A browser can open long after devices connected. Re-send each currently
  // known OSCQuery namespace so a page refresh does not show zero/partial
  // Parameters until the next device reconnect.
  for (const [deviceId, client] of oscQueryClients.entries()) {
    if (!Array.isArray(client.flatNodes) || client.flatNodes.length === 0) continue
    const device = devices.get(deviceId)
    ws.send(JSON.stringify({
      type: 'DEVICE_NAMESPACE',
      deviceId,
      deviceName: device?.name || '',
      nodes: client.flatNodes
    }))
  }

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    // Every payload below comes from an unauthenticated LAN client. A throw
    // in this handler would propagate to the emitter and kill the hub
    // process mid-show, so the whole dispatch is fenced.
    try {
      handleHubMessage(ws, ip, msg)
    } catch (err) {
      console.error(`[hub-ws] message handler error (type=${msg?.type}): ${err?.stack || err}`)
      try {
        ws.send(JSON.stringify({
          type: 'ERROR',
          message: `Internal error handling ${String(msg?.type || 'message')}`
        }))
      } catch {}
    }
  })

  ws.on('close', () => hubClients.delete(ws))
})

function handleHubMessage(ws, ip, msg) {
    // OSCQuery-style SET — write a value into the hub namespace and rebroadcast.
    if (msg.type === 'SET' && msg.path && msg.value !== undefined) {
      // RegExp.test() coerces — an array like ["/evil"] would pass the regex
      // and poison the namespace Map with a non-string key, crashing
      // buildTree() for every later GET / and INITIAL_STATE until restart.
      if (typeof msg.path !== 'string' || !OSC_PATH_RE.test(msg.path)) return
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
      const updates = (msg.updates !== undefined && msg.updates !== null)
        ? msg.updates
        : {}
      const result = saveManifest(msg.deviceId, updates)
      if (result.ok && updates && typeof updates === 'object' && 'link' in updates) {
        // Keep both link-removal paths equivalent: clearing via
        // UPDATE_DEVICE {link:null} must drop engine state and the runtime
        // status exactly like CLEAR_DEVICE_LINK, and a changed link must be
        // re-evaluated promptly instead of waiting for an unrelated poke.
        if (updates.link === null) {
          autoLinkEngine.forgetDevice(msg.deviceId)
          const current = devices.get(msg.deviceId)
          if (current && current.autoLink) {
            delete current.autoLink
            broadcastDeviceUpdate(current)
          }
        } else {
          autoLinkEngine.poke('link-updated')
        }
      }
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
        cosmicNoiseForwarder.clearDeviceSnapshots(dev.id)
        if (oscQueryClients.has(dev.id)) {
          const client = oscQueryClients.get(dev.id)
          oscQueryClients.delete(dev.id)
          client.disconnect()
        }
        connectToDevice(dev)
      }
      return
    }

    // SET_DEVICE_PARAM — write a value back to one of the managed devices.
    // The UDP/OSC packet goes to the device's OSC port learned from
    // HOST_INFO. The OSCQuery HTTP port is NEVER a fallback (CosmicUnity's
    // control UDP listener is an independent ephemeral port): when the OSC
    // port is unknown the write fails closed and the failure is surfaced to
    // the UI via PARAM_RESULT so no dashboard displays a value that was
    // never applied.
    if (msg.type === 'SET_DEVICE_PARAM' && typeof msg.deviceId === 'number' && msg.path) {
      const requestId =
        typeof msg.requestId === 'string' || typeof msg.requestId === 'number'
          ? msg.requestId
          : null
      const reply = (ok, reason) => {
        ws.send(JSON.stringify({
          type: 'PARAM_RESULT',
          requestId,
          deviceId: msg.deviceId,
          path: msg.path,
          ok,
          ...(reason ? { reason } : {})
        }))
      }
      const dev = devices.get(msg.deviceId)
      if (!dev) return reply(false, 'unknown-device')
      if (typeof msg.path !== 'string' || !OSC_PATH_RE.test(msg.path)) {
        return reply(false, 'invalid-path')
      }
      const oscPort = Number(dev.oscPort)
      if (!isValidOscPort(oscPort)) {
        // HOST_INFO has not (re)delivered the device's OSC UDP port yet; the
        // client retries it with backoff in the background. Fail closed —
        // sending to the HTTP port number would silently vanish.
        return reply(false, 'osc-port-unknown')
      }
      const hubPath = `/${dev.name}${msg.path}`
      if (!namespace.has(hubPath)) {
        // Fail closed on a path the synced tree has never seen: the device
        // would drop the write while we report ok — a typo or a stale
        // dashboard 99% of the time. Only enforce once at least one node of
        // this device's tree has synced, so a mid-sync write to a node the
        // hub simply hasn't listed yet is not rejected. Dynamically created
        // nodes are covered: they enter `namespace` via PATH_CHANGED isNew.
        const treePrefix = `/${dev.name}/`
        let treeSynced = false
        for (const key of namespace.keys()) {
          if (key.startsWith(treePrefix)) { treeSynced = true; break }
        }
        if (treeSynced) return reply(false, 'unknown-path')
      }
      const args = Array.isArray(msg.value) ? msg.value : (msg.value === undefined ? [] : [msg.value])
      sendOscViaSender(dev.host, oscPort, msg.path, args)
      reply(true)
      // Optimistic local update so other dashboards see the change quickly
      // even before the device echoes it back. Only after a real send: a
      // failed write must never be broadcast as applied.
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

    // ANNOUNCE_DEVICE — resolve the UI selection into the asymmetric VST
    // bootstrap: external OSCQuery coordinates are always written to
    // CosmicUnity. The selected target can come from either card type.
    if (msg.type === 'ANNOUNCE_DEVICE' && typeof msg.deviceId === 'number' && msg.target) {
      const dev = devices.get(msg.deviceId)
      if (!dev) {
        ws.send(JSON.stringify({ type: 'ANNOUNCE_RESULT', deviceId: msg.deviceId, ok: false, error: 'Device not found' }))
        return
      }
      const target = msg.target // { address, port, fqdn, name }
      if (!isValidHost(String(target.address || ''))) {
        ws.send(JSON.stringify({ type: 'ANNOUNCE_RESULT', deviceId: dev.id, ok: false, error: 'Invalid target host' }))
        return
      }
      if (!isValidOscPort(Number(target.port))) {
        ws.send(JSON.stringify({ type: 'ANNOUNCE_RESULT', deviceId: dev.id, ok: false, error: 'Invalid target port' }))
        return
      }
      // Keep an omitted peer id empty until routing knows which side is the
      // external instrument. Falling back to target.name here is wrong for an
      // external-device card because that card's selected target is the VST.
      const peerId = String(msg.peerId || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_')
      performAnnounce({ dev, target, peerId, udpPortOverride: msg.udpPortOverride })
        .then(({ announcement, selectedTarget, selectedManagedDevice }) => {
          const summary = `${announcement.peerName} → ${announcement.receiverName}`
          // Persist the link so the auto-link engine can re-apply it after a
          // VST restart — unless the browser explicitly asked not to.
          if (msg.remember !== false) {
            const overridePort = Number(msg.udpPortOverride)
            const link = {
              targetFqdn: String(selectedTarget.fqdn || target.fqdn || '').slice(0, 128),
              targetName: String(selectedTarget.name || target.name || '').slice(0, 128),
              peerId: peerId.slice(0, 128),
              udpPortOverride:
                Number.isInteger(overridePort) && overridePort >= 0 && overridePort <= 65535
                  ? overridePort
                  : 0
            }
            const saved = saveManifest(dev.id, { link })
            if (!saved.ok) {
              console.log(`  [autolink] link persist failed for device ${dev.id}: ${saved.error}`)
            } else {
              // These exact coordinates were just applied — record them so
              // the engine's next pass does not announce a duplicate.
              autoLinkEngine.recordApplied(dev.id, {
                targetAddress: selectedTarget.address,
                targetPort: Number(selectedTarget.port),
                targetOscPort: isValidOscPort(Number(selectedManagedDevice?.oscPort))
                  ? Number(selectedManagedDevice.oscPort)
                  : '',
                // Must byte-match what the engine will compute from the
                // persisted link: the sanitized peer id as given, possibly
                // empty — resolveLinkAnnouncement owns the name fallback on
                // both paths, so neither side may bake a derived name in.
                peerId: link.peerId,
                udpPortOverride: link.udpPortOverride,
                summary
              })
            }
          }
          ws.send(JSON.stringify({
            type: 'ANNOUNCE_RESULT',
            deviceId: dev.id,
            ok: true,
            summary
          }))
        })
        .catch((err) => ws.send(JSON.stringify({
          type: 'ANNOUNCE_RESULT',
          deviceId: dev.id,
          ok: false,
          error: err.message
        })))
      return
    }

    // CLEAR_DEVICE_LINK — remove the persisted link and the runtime status.
    if (msg.type === 'CLEAR_DEVICE_LINK' && typeof msg.deviceId === 'number') {
      const dev = devices.get(msg.deviceId)
      if (!dev) {
        ws.send(JSON.stringify({
          type: 'CLEAR_LINK_RESULT',
          deviceId: msg.deviceId,
          ok: false,
          error: `Device not found: id ${msg.deviceId}`
        }))
        return
      }
      const result = saveManifest(msg.deviceId, { link: null })
      if (result.ok) {
        autoLinkEngine.forgetDevice(msg.deviceId)
        const current = devices.get(msg.deviceId)
        if (current && current.autoLink) {
          delete current.autoLink
          broadcastDeviceUpdate(current)
        }
        console.log(`  [autolink] link cleared for device ${msg.deviceId}`)
      }
      ws.send(JSON.stringify({
        type: 'CLEAR_LINK_RESULT',
        deviceId: msg.deviceId,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {})
      }))
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
        ...persistentManifestFields(d),
        id:           d.id,
        name:         d.name,
        type:         d.type || 'oscquery-device',
        deviceType:   d.deviceType,
        canonicalId:  d.canonicalId,
        persistentDeviceId: d.persistentDeviceId || null,
        serviceName:  d.serviceName || d.name,
        host:         d.host,
        oscQueryPort: d.oscQueryPort,
        enabled:      d.enabled !== false,
        description:  d.description || '',
        endpoints:    d.endpoints || [],
        legacyIds:    d.legacyIds || [],
        legacyCanonicalIds: d.legacyCanonicalIds || []
      }))
      ws.send(JSON.stringify({
        type: 'MANIFESTS_EXPORT',
        version: 2,
        exportedAt: new Date().toISOString(),
        manifests: payload
      }))
      return
    }

    if (msg.type === 'IMPORT_MANIFESTS' && Array.isArray(msg.manifests)) {
      // Replace the current device set with the imported one.
      // 1. Make sure the manifests folder exists (fresh clones may not have it).
      // 2. Suppress the file watcher while we churn through the folder.
      // 3. Delete every existing .json.
      // 4. Re-id every imported entry (we don't trust the incoming ids — they
      //    might collide with what we have or what's been used before).
      // 5. Write each as a manifest file with a sanitized filename.
      // 6. loadManifests() to bring them online + connect.
      ensureManifestsDir()
      suppressWatcher = true
      try {
        // Disconnect everyone first so reconcileClients doesn't get confused
        // by the in-flight rename.
        cosmicNoiseForwarder.clearSnapshots()
        for (const [id, client] of oscQueryClients.entries()) {
          oscQueryClients.delete(id)
          try { client.disconnect() } catch {}
        }
        // Runtime caches are reset because this is an explicit replace import.
        for (const id of Array.from(devices.keys())) {
          clearManagedDeviceRuntimeState(id)
        }
        deviceMsgCount.clear()
        for (const [path, param] of namespace.entries()) {
          if (param.deviceId !== undefined) namespace.delete(path)
        }
        // Wipe disk
        for (const f of readdirSync(MANIFESTS_DIR).filter((x) => x.endsWith('.json'))) {
          try {
            unlinkSync(join(MANIFESTS_DIR, f))
          } catch (err) {
            if (err?.code !== 'ENOENT') {
              throw new Error(`Could not remove existing manifest ${f}: ${err.message}`)
            }
          }
        }
        // Preserve valid legacy routing IDs. They are part of the historical
        // Ableton `deviceN` contract and of older browser-local settings.
        const usedIds = new Set()
        let nextId = 1
        let importedCount = 0
        for (const m of msg.manifests) {
          if (!m || !m.name || !m.host || !m.oscQueryPort) continue
          if (!isValidHost(String(m.host))) continue
          if (!isValidOscPort(Number(m.oscQueryPort))) continue
          let id = Number.isInteger(Number(m.id)) && Number(m.id) > 0 && !usedIds.has(Number(m.id))
            ? Number(m.id)
            : null
          while (id == null && usedIds.has(nextId)) nextId++
          if (id == null) id = nextId++
          usedIds.add(id)
          const manifest = {
            ...persistentManifestFields(m),
            id,
            name:         String(m.name).slice(0, 64),
            type:         m.type || 'oscquery-device',
            deviceType:   m.deviceType,
            canonicalId:  m.canonicalId,
            persistentDeviceId: m.persistentDeviceId || null,
            serviceName:  m.serviceName || m.name,
            host:         String(m.host),
            oscQueryPort: Number(m.oscQueryPort),
            enabled:      m.enabled !== false,
            description:  m.description || 'Imported',
            endpoints:    Array.isArray(m.endpoints) ? m.endpoints : [],
            legacyIds:    Array.isArray(m.legacyIds) ? m.legacyIds : [],
            legacyCanonicalIds: Array.isArray(m.legacyCanonicalIds) ? m.legacyCanonicalIds : []
          }
          // The persistentManifestFields spread carries `link` verbatim from
          // an arbitrary /ws/hub client — run it through the same shape gate
          // as saveManifest. A bad link drops silently (the device itself is
          // still worth importing); nothing unbounded may reach disk.
          if (manifest.link !== undefined) {
            const linkCheck = validateLinkField(manifest.link)
            if (linkCheck.ok) {
              manifest.link = linkCheck.value
            } else {
              console.log(`  [hub] import: dropped invalid link on "${manifest.name}": ${linkCheck.error}`)
              delete manifest.link
            }
          }
          const filename = `${manifest.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${id}.json`
          writeFileSync(join(MANIFESTS_DIR, filename), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
          importedCount++
        }
        console.log(`  [hub] imported ${importedCount} manifest(s) with stable routing ids`)
      } catch (err) {
        console.log(`  [hub] import failed: ${err.message}`)
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Import failed: ' + err.message }))
      } finally {
        setTimeout(() => { suppressWatcher = false }, 300)
      }
      // Treat every import result (including a reported partial wipe failure)
      // as a fresh runtime generation. loadManifests() will rebuild only what
      // actually remains on disk and create new client/card identities.
      devices.clear()
      manifestFilenames.clear()
      manifestFilesByDeviceId.clear()
      loadManifests()
      return
    }

    if (msg.type === 'REMOVE_DEVICE' && typeof msg.deviceId === 'number') {
      const result = removeManagedDevicePermanently(msg.deviceId, { cause: 'manual' })
      if (!result.ok) {
        ws.send(JSON.stringify({
          type: 'ERROR',
          message: result.error || `Unknown device id ${msg.deviceId}`
        }))
      }
      return
    }

    if (msg.type === 'ADD_DISCOVERED' || msg.type === 'SAVE_DEVICE') {
      let registryRecord = msg.canonicalId ? deviceRegistry.get(msg.canonicalId) : null
      if (!registryRecord && msg.host && msg.port) {
        registryRecord = deviceRegistry.upsertDiscovery({
          name: msg.name,
          serviceName: msg.serviceName || msg.name,
          host: String(msg.host),
          port: Number(msg.port),
          persistentDeviceId: msg.persistentDeviceId,
          deviceType: msg.deviceType
        })
      }
      const endpoint = registryRecord?.activeEndpoint || (msg.host && msg.port
        ? { host: String(msg.host), port: Number(msg.port) }
        : null)
      if (!endpoint || !isValidHost(String(endpoint.host))) {
        ws.send(JSON.stringify({ type: 'ERROR', message: `Invalid host: ${endpoint?.host || ''}` }))
        return
      }
      if (!isValidOscPort(Number(endpoint.port))) {
        ws.send(JSON.stringify({ type: 'ERROR', message: `Invalid port: ${endpoint.port}` }))
        return
      }
      if (registryRecord?.saved) {
        if (msg.name && registryRecord.manifestId != null) {
          saveManifest(registryRecord.manifestId, { name: String(msg.name).trim().slice(0, 64) })
        }
        ws.send(JSON.stringify({
          type: 'ADD_DEVICE_RESULT',
          ok: true,
          existing: true,
          canonicalId: registryRecord.canonicalId,
          deviceId: registryRecord.manifestId
        }))
        return
      }
      const nextId = Math.max(0, ...Array.from(devices.keys())) + 1
      const rawName = String(msg.name || registryRecord?.name || `Device${nextId}`).trim().slice(0, 64)
      const name = rawName.length > 0 ? rawName : `Device${nextId}`
      const manifest = {
        id: nextId,
        name,
        type: 'oscquery-device',
        deviceType: registryRecord?.deviceType,
        canonicalId: registryRecord?.canonicalId,
        persistentDeviceId: registryRecord?.persistentDeviceId || null,
        serviceName: registryRecord?.serviceName || name,
        host: endpoint.host,
        oscQueryPort: endpoint.port,
        enabled: true,
        description: msg.type === 'SAVE_DEVICE' ? 'Saved from Device Registry' : 'Discovered via Bonjour',
        endpoints: registryRecord?.endpoints || [endpoint],
        legacyIds: [],
        legacyCanonicalIds: registryRecord?.legacyCanonicalIds || []
      }
      const filename = `${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${nextId}.json`
      // Suppress the manifest folder watcher so it doesn't race our explicit
      // loadManifests() below. Without this, the watcher's debounced reload
      // can fire AFTER reconcileClients has already started the new client,
      // causing a brief disconnect/reconnect blip.
      ensureManifestsDir()
      suppressWatcher = true
      try {
        writeFileSync(join(MANIFESTS_DIR, filename), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
      } finally {
        // Re-arm after a short grace period so legitimate external edits
        // are still picked up.
        setTimeout(() => { suppressWatcher = false }, 300)
      }
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

      ws.send(JSON.stringify({
        type: 'ADD_DEVICE_RESULT',
        ok: true,
        existing: false,
        canonicalId: manifest.canonicalId,
        deviceId: nextId
      }))
      broadcastDiscovered()
    }
}

// ─── Periodic broadcast: per-device message counters ──────────────────────
const deviceMessageCounterTimer = setInterval(() => {
  if (deviceMsgCount.size === 0) return
  const counts = {}
  for (const [id, c] of deviceMsgCount.entries()) counts[id] = c
  broadcastHub({ type: 'DEVICE_MSG_COUNTS', counts, abletonTotal: abletonMsgsSent })
}, 500)
deviceMessageCounterTimer.unref()

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
  if (cosmicNoiseForwarder.enabled) {
    const snapshot = cosmicNoiseForwarder.snapshotMs > 0
      ? `snapshot ${cosmicNoiseForwarder.snapshotMs} ms`
      : 'snapshot disabled'
    console.log(`  CosmicNoise v1:    UDP ${cosmicNoiseForwarder.host}:${cosmicNoiseForwarder.port} · ${snapshot}`)
  }
  console.log(`  Manifests dir:     ${MANIFESTS_DIR}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  publishBonjour()
  process.send?.({
    type: 'ready',
    ports: { http: PORT, osc: OSC_LISTEN_PORT, ableton: ABLETON_PORT }
  })
})

// ─── Shutdown ─────────────────────────────────────────────────────────────
function shutdown(signal = 'SIGTERM') {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`\nShutting down (${signal})…`)
  if (cosmicNoiseSnapshotTimer) clearInterval(cosmicNoiseSnapshotTimer)
  clearInterval(deviceMessageCounterTimer)
  clearInterval(discoveryStaleTimer)
  clearInterval(reachabilityTimer)
  clearInterval(collisionHealTimer)
  clearInterval(hostFollowHealTimer)
  if (oscRebindTimer) clearTimeout(oscRebindTimer)
  if (manifestReloadTimer) clearTimeout(manifestReloadTimer)
  autoLinkEngine.close()
  try { manifestWatcher?.close() } catch {}
  try { browser?.stop() } catch {}
  for (const [id, client] of oscQueryClients.entries()) {
    oscQueryClients.delete(id)
    client.disconnect()
  }
  cosmicNoiseForwarder.close()
  try { udpSender.close() } catch {}
  try { abletonSocket.close() } catch {}
  const forceExit = setTimeout(() => process.exit(0), 2500)
  forceExit.unref()
  bonjour.unpublishAll(() => {
    bonjour.destroy()
    try { udpHubPort.close() } catch {}
    for (const ws of hubClients) try { ws.close() } catch {}
    for (const ws of discoveryClients) try { ws.close() } catch {}
    try { wssHub.close() } catch {}
    try { wssDiscovery.close() } catch {}
    server.close(() => {
      clearTimeout(forceExit)
      process.exit(0)
    })
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// ─── Last-resort process guards ───────────────────────────────────────────
// Defense in depth behind the per-handler try/catch fences: a bug anywhere
// must be logged loudly but must NOT take the hub down mid-show — the
// supervisor does not auto-restart an unexpected exit, so a crash here means
// every device link stays dark until an operator notices.
process.on('uncaughtException', (err) => {
  console.error('[hub] LAST-RESORT uncaughtException (hub kept alive):', err?.stack || err)
})
process.on('unhandledRejection', (reason) => {
  console.error(
    '[hub] LAST-RESORT unhandledRejection (hub kept alive):',
    reason?.stack || reason
  )
})
