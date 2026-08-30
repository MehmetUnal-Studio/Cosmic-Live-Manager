import { ref, shallowRef } from 'vue'
import { serializeLinkTarget } from '../utils/linkTargets.js'
import { createParamBatcher } from '../utils/paramBatcher.js'
import { createRequestTracker } from '../utils/requestTracker.js'

// Hub state — connects to the helper's /ws/hub channel.
//
// The helper aggregates every device's namespace into one central namespace
// and pushes PATH_CHANGED, DEVICE_UPDATED, DEVICE_NAMESPACE,
// DISCOVERED_DEVICES, DEVICE_MSG_COUNTS, ANNOUNCE_RESULT, HUB_STATUS,
// PARAM_RESULT … to every connected dashboard. This composable exposes those
// streams plus the outbound commands (SET_DEVICE_PARAM, ANNOUNCE_DEVICE, …)
// to the UI.
//
// Singleton: the WebSocket and reactive state are shared across every
// component that calls useHub(). First call opens the connection and
// registers the unload teardown; subsequent calls just return the same
// object. Without this, each DeviceCard etc. would open its own /ws/hub
// (4× cards = 4× connections, 4× streams of duplicated PATH_CHANGED events).

let _hub = null

export function useHub() {
  if (_hub) return _hub
  _hub = createHub()
  return _hub
}

// How long after a disconnect we keep reporting 'reconnecting' before
// escalating connectionState to 'down'.
const DOWN_AFTER_MS = 8000
const RETRY_MS = 1500
const PARAM_ACK_TIMEOUT_MS = 2000
const TOGGLE_TIMEOUT_MS = 2000
const EXPORT_TIMEOUT_MS = 3000

function createHub() {
  const connected = ref(false)
  // Coarser tri-state for banners on EVERY page (fix F2-2/F2-11):
  //   'connected'    — WS open
  //   'reconnecting' — WS lost < DOWN_AFTER_MS ago, retrying
  //   'down'         — WS lost for a while; treat data as untrustworthy
  const connectionState = ref('reconnecting')
  // Global stale flag (fix F2-11): true from the moment the hub WS closes
  // until the next INITIAL_STATE replaces the snapshot. While true, every
  // value/param/count shown is frozen at last-known state — UI should grey
  // everything. staleSince = timestamp of the freeze, for "N sn önce" copy.
  const stale = ref(false)
  const staleSince = ref(null)

  const devices = ref([])
  const discovered = ref([])
  const subscribers = ref([])
  const msgsThisSecond = ref(0)
  const abletonTotal = ref(0)
  const hubInfo = ref({ hubName: 'Cosmic Live Manager' })
  // Latest HUB_STATUS payload field: is the helper's OSC UDP listener up?
  // null = unknown (no HUB_STATUS seen yet).
  const oscListen = ref(null)

  // Per-device parameter map. Each entry is a full OSCQuery node:
  //   { FULL_PATH, TYPE, VALUE, RANGE, ACCESS, DESCRIPTION, UNIT }
  // FULL_PATH here is the path RELATIVE TO THE DEVICE (no /deviceName prefix),
  // because that's what the device itself uses and what we need to send
  // back when writing values.
  //   deviceParams: shallowRef<Map<deviceId, Map<relPath, node>>>
  //
  // PERF CONTRACT (fix F2-1): this is a *shallowRef*. Inner maps are plain
  // (non-reactive) Maps. `deviceParams.value` is reassigned at most once per
  // animation frame by the coalescing batcher below; within one flush only
  // the touched devices get fresh inner-Map references, so untouched cards
  // keep prop identity and skip re-render. Components that want a cheap
  // per-device trigger should watch paramsVersionFor(deviceId) or the global
  // deviceParamsVersion counter instead of deep-watching the maps.
  const deviceParams = shallowRef(new Map())
  // Bumped once per applied flush / namespace replace. Cheap dependency for
  // components that need "params changed somewhere" (e.g. stats tiles).
  const deviceParamsVersion = ref(0)
  // Lazily-created per-device version counters.
  const deviceVersionRefs = new Map()
  function paramsVersionFor(deviceId) {
    let r = deviceVersionRefs.get(deviceId)
    if (!r) {
      r = ref(0)
      deviceVersionRefs.set(deviceId, r)
    }
    return r
  }
  function bumpDeviceVersion(deviceId) {
    const r = deviceVersionRefs.get(deviceId)
    if (r) r.value++
  }

  const deviceMsgCounts = ref(new Map())
  const saveHints = ref(new Map())

  // Announce results — keyed by deviceId, cleared after a short delay.
  const announceResults = ref(new Map())

  // In-flight enable/disable intents (fix F2-7 consumer support):
  //   pendingToggles: shallowRef<Map<deviceId, { desired, requestedAt }>>
  // While a device has an entry here, the UI should render the button
  // pending/locked and treat `desired` (not the stale prop) as the truth of
  // what the operator asked for. Cleared on a DEVICE_UPDATED that MATCHES the
  // desired state, on a failed UPDATE_DEVICE_RESULT, or after
  // TOGGLE_TIMEOUT_MS.
  const pendingToggles = shallowRef(new Map())
  const toggleTimers = new Map()

  // Msg/s window
  let rateCounter = 0
  let rateTimer = null
  function startRateTimer() {
    if (rateTimer) return
    rateTimer = setInterval(() => {
      msgsThisSecond.value = rateCounter
      rateCounter = 0
    }, 1000)
  }
  function stopRateTimer() {
    clearInterval(rateTimer)
    rateTimer = null
  }

  let ws = null
  let retry = null
  let downTimer = null
  let suspended = false

  // ── Outbound ────────────────────────────────────────────────────────────

  // Returns { sent: boolean } so callers can give delivery-true feedback
  // (fix F2-2). `sent:false` means the hub WS is not open (or the send threw)
  // and the payload was dropped — nothing reached the helper.
  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(payload))
        return { sent: true }
      } catch {
        return { sent: false }
      }
    }
    return { sent: false }
  }

  function updateDevice(deviceId, updates) {
    const { sent } = send({ type: 'UPDATE_DEVICE', deviceId, updates })
    if (sent) setHint(deviceId, 'Saving…', '', { escalateText: '✗ Yanıt yok' })
    else setHint(deviceId, '✗ Hub bağlantısı yok', 'err')
    return { sent }
  }

  // Optimistic enable/disable with in-flight intent tracking (fix F2-7).
  // Returns { sent, pending }. A second call with the same desired state
  // while one is in flight is a no-op (double-tap guard); a call with the
  // OPPOSITE desired state replaces the intent, so "tap tap" = disable even
  // when the first ack hasn't landed yet.
  function setDeviceEnabled(deviceId, desired) {
    desired = !!desired
    const current = pendingToggles.value.get(deviceId)
    if (current && current.desired === desired) {
      return { sent: false, pending: true }
    }
    const { sent } = send({ type: 'UPDATE_DEVICE', deviceId, updates: { enabled: desired } })
    if (!sent) {
      setHint(deviceId, '✗ Hub bağlantısı yok', 'err')
      return { sent: false, pending: false }
    }
    const m = new Map(pendingToggles.value)
    m.set(deviceId, { desired, requestedAt: Date.now() })
    pendingToggles.value = m
    clearTimeout(toggleTimers.get(deviceId))
    toggleTimers.set(deviceId, setTimeout(() => clearPendingToggle(deviceId), TOGGLE_TIMEOUT_MS))
    return { sent: true, pending: true }
  }
  function clearPendingToggle(deviceId) {
    clearTimeout(toggleTimers.get(deviceId))
    toggleTimers.delete(deviceId)
    if (!pendingToggles.value.has(deviceId)) return
    const m = new Map(pendingToggles.value)
    m.delete(deviceId)
    pendingToggles.value = m
  }
  function clearAllPendingToggles() {
    for (const t of toggleTimers.values()) clearTimeout(t)
    toggleTimers.clear()
    if (pendingToggles.value.size) pendingToggles.value = new Map()
  }

  function reconnectDevice(deviceId) {
    const { sent } = send({ type: 'RECONNECT_DEVICE', deviceId })
    if (sent) setHint(deviceId, 'Reconnecting…', '')
    else setHint(deviceId, '✗ Hub bağlantısı yok', 'err')
    return { sent }
  }
  function removeDevice(deviceId) {
    return send({ type: 'REMOVE_DEVICE', deviceId })
    // No optimistic hint: the helper's DEVICES_RELOADED will drop the card.
  }
  function reloadManifests() {
    return send({ type: 'RELOAD_MANIFESTS' })
  }
  // Tear down + recreate the helper's Bonjour browser. Use when a device has
  // renamed itself or changed port and isn't showing up in the discovery list
  // any more. Equivalent to restarting `npm run dev` for the discovery layer.
  function rediscover() {
    return send({ type: 'REDISCOVER' })
  }

  // Ask the helper to dump the current set of manifests so the user can save
  // them as a JSON. The helper replies on the same socket with
  // { type: 'MANIFESTS_EXPORT', manifests: [...] }.
  //
  // Fix F2-13: requests are tracked as a queue instead of a single slot.
  // MANIFESTS_EXPORT carries no correlation id, so replies settle FIFO; a
  // NEW export request rejects any still-pending prior request (its reply —
  // if it ever comes — would be indistinguishable anyway) instead of
  // silently orphaning it, and each request's timeout can only kill itself.
  const pendingExports = []
  function exportManifests() {
    return new Promise((resolve, reject) => {
      // Reject prior in-flight requests: superseded.
      while (pendingExports.length) {
        const prior = pendingExports.shift()
        clearTimeout(prior.timer)
        prior.reject(new Error('Superseded by a newer export request'))
      }
      const entry = { resolve, reject, timer: null }
      entry.timer = setTimeout(() => {
        const idx = pendingExports.indexOf(entry)
        if (idx !== -1) {
          pendingExports.splice(idx, 1)
          reject(new Error('Helper did not reply with MANIFESTS_EXPORT in time'))
        }
      }, EXPORT_TIMEOUT_MS)
      pendingExports.push(entry)
      const { sent } = send({ type: 'EXPORT_MANIFESTS' })
      if (!sent) {
        clearTimeout(entry.timer)
        const idx = pendingExports.indexOf(entry)
        if (idx !== -1) pendingExports.splice(idx, 1)
        reject(new Error('Hub bağlantısı yok — export gönderilemedi'))
      }
    })
  }
  function rejectPendingExports(message) {
    while (pendingExports.length) {
      const entry = pendingExports.shift()
      clearTimeout(entry.timer)
      entry.reject(new Error(message))
    }
  }

  // Bulk-replace the manifest set with the contents of an imported JSON.
  // The helper clears the manifests folder and writes the new ones.
  function importManifests(manifestsArray) {
    if (!Array.isArray(manifestsArray)) {
      throw new Error('importManifests: expected an array')
    }
    return send({ type: 'IMPORT_MANIFESTS', manifests: manifestsArray })
  }
  function addDiscovered(host, port, name) {
    return send({ type: 'ADD_DISCOVERED', host, port, name: (name || '').trim() || undefined })
  }
  function saveDevice(canonicalId, name) {
    return send({
      type: 'SAVE_DEVICE',
      canonicalId,
      name: (name || '').trim() || undefined
    })
  }

  // Fix F2-2: setDeviceParam now returns a Promise<{ ok, reason? }>:
  //   { ok:true }                          — helper ack'd via PARAM_RESULT
  //   { ok:false, reason:'disconnected' }  — hub WS down, nothing was sent
  //   { ok:false, reason:'timeout' }       — sent, no PARAM_RESULT in 2 s
  //   { ok:false, reason:<server reason> } — helper rejected the write
  // The promise NEVER rejects, so legacy fire-and-forget callers stay safe.
  let paramReqSeq = 0
  const paramRequests = createRequestTracker({
    timeoutMs: PARAM_ACK_TIMEOUT_MS,
    timeoutResult: { ok: false, reason: 'timeout' }
  })
  function setDeviceParam(deviceId, relPath, value) {
    const requestId = `p${++paramReqSeq}`
    const { sent } = send({ type: 'SET_DEVICE_PARAM', deviceId, path: relPath, value, requestId })
    if (!sent) return Promise.resolve({ ok: false, reason: 'disconnected' })
    return paramRequests.register(requestId)
  }

  function announceDevice(deviceId, target, peerId, udpPortOverride) {
    return send({
      type: 'ANNOUNCE_DEVICE',
      deviceId,
      target: serializeLinkTarget(target),
      peerId,
      udpPortOverride: udpPortOverride || 0
    })
  }

  // Drop the manifest-saved link pairing; the hub stops auto re-announcing.
  // Reply arrives as CLEAR_LINK_RESULT and surfaces through the hint slot.
  function clearDeviceLink(deviceId) {
    const { sent } = send({ type: 'CLEAR_DEVICE_LINK', deviceId })
    if (sent) setHint(deviceId, 'Eşleşme kaldırılıyor…', '', { escalateText: '✗ Yanıt yok' })
    else setHint(deviceId, '✗ Hub bağlantısı yok', 'err')
    return { sent }
  }

  // ── Hints (fix F2-9: hints now actually expire via `until`) ─────────────
  // type 'ok'  → expires after 1.5 s
  // type 'err' → expires after 4 s
  // type ''    → pending; expires after 3 s, or escalates to an err hint
  //              (opts.escalateText) when the ack never arrived.
  const hintTimers = new Map()
  function setHint(deviceId, text, type, opts = {}) {
    const ttl = opts.ttl ?? (type === 'ok' ? 1500 : type === 'err' ? 4000 : 3000)
    const until = Date.now() + ttl
    const m = new Map(saveHints.value)
    m.set(deviceId, { text, type, until })
    saveHints.value = m
    clearTimeout(hintTimers.get(deviceId))
    hintTimers.set(deviceId, setTimeout(() => {
      hintTimers.delete(deviceId)
      const cur = saveHints.value.get(deviceId)
      // Replaced by a newer hint in the meantime → that hint owns its own timer.
      if (!cur || cur.until !== until) return
      if (!type && opts.escalateText) {
        // Pending never acked → escalate instead of silently vanishing.
        setHint(deviceId, opts.escalateText, 'err')
        return
      }
      const next = new Map(saveHints.value)
      next.delete(deviceId)
      saveHints.value = next
    }, ttl + 20))
  }
  function clearHint(deviceId) {
    clearTimeout(hintTimers.get(deviceId))
    hintTimers.delete(deviceId)
    if (!saveHints.value.has(deviceId)) return
    const m = new Map(saveHints.value)
    m.delete(deviceId)
    saveHints.value = m
  }

  function setAnnounceResult(deviceId, result) {
    const m = new Map(announceResults.value)
    m.set(deviceId, { ...result, ts: Date.now() })
    announceResults.value = m
    // Auto-clear after 4s
    setTimeout(() => {
      const cur = new Map(announceResults.value)
      const entry = cur.get(deviceId)
      if (entry && Date.now() - entry.ts >= 3500) {
        cur.delete(deviceId)
        announceResults.value = cur
      }
    }, 4000)
  }

  function pruneDeviceCaches(validIds) {
    // Apply anything still buffered before pruning, then drop dead devices.
    paramBatcher.flushNow()
    const pruneShallow = (mapRef) => {
      const next = new Map(
        Array.from(mapRef.value.entries()).filter(([deviceId]) => validIds.has(deviceId))
      )
      mapRef.value = next
    }
    pruneShallow(deviceParams)
    pruneShallow(pendingToggles)
    for (const [deviceId, timer] of Array.from(toggleTimers.entries())) {
      if (!validIds.has(deviceId)) {
        clearTimeout(timer)
        toggleTimers.delete(deviceId)
      }
    }
    for (const deviceId of Array.from(deviceVersionRefs.keys())) {
      if (!validIds.has(deviceId)) deviceVersionRefs.delete(deviceId)
    }
    const prune = (source) => new Map(
      Array.from(source.entries()).filter(([deviceId]) => validIds.has(deviceId))
    )
    deviceMsgCounts.value = prune(deviceMsgCounts.value)
    saveHints.value = prune(saveHints.value)
    announceResults.value = prune(announceResults.value)
  }

  function getDeviceByName(name) {
    for (const d of devices.value) if (d.name === name) return d
    return null
  }

  // Convert a hub-namespace path "/<deviceName>/<rel>" into { deviceId, relPath }.
  function pathToDeviceRel(absPath) {
    if (!absPath || absPath[0] !== '/') return null
    const slash = absPath.indexOf('/', 1)
    const deviceName = slash > 0 ? absPath.slice(1, slash) : absPath.slice(1)
    const relPath = slash > 0 ? absPath.slice(slash) : '/'
    const dev = getDeviceByName(deviceName)
    if (!dev) return null
    return { deviceId: dev.id, relPath }
  }

  // Subscribers that want to be notified of every PATH_CHANGED. Used by the
  // recording feature so each DeviceCard can capture its own stream of value
  // updates without having to deep-watch the reactive Map (cheaper + exact
  // event timing). Listener signature: (deviceId, relPath, value, paramType).
  //
  // NOTE: listeners are fed PRE-coalesce — they see every message at exact
  // arrival timing, even though the reactive map only updates once per frame.
  const pathChangeListeners = new Set()
  function onPathChange(listener) {
    pathChangeListeners.add(listener)
    // Return an unsubscribe handle for ergonomic onMounted/onBeforeUnmount use.
    return () => pathChangeListeners.delete(listener)
  }

  // Verbose drop logging. Toggle from the DevTools console:
  //   localStorage.setItem('clm:debug:applyValue', '1')   // log every drop
  //   localStorage.removeItem('clm:debug:applyValue')
  // Useful to spot PATH_CHANGED events that arrive for a device whose name
  // isn't (yet / any more) in `devices.value` — those are dropped silently
  // by default and that drop is a common cause of "missing" recordings.
  function isDebugApply() {
    try { return localStorage.getItem('clm:debug:applyValue') === '1' } catch { return false }
  }

  // ── Coalesced application of PATH_CHANGED (fix F2-1) ────────────────────
  // The batcher buffers per-(device,path) latest values and flushes once per
  // animation frame. The flush clones the outer Map once and ONLY the
  // touched devices' inner Maps once — instead of outer+inner clones per
  // message as before.
  const paramBatcher = createParamBatcher({ onFlush: applyParamBatch })

  function applyParamBatch(batch) {
    if (!batch || batch.size === 0) return
    const outer = new Map(deviceParams.value)
    for (const [deviceId, changes] of batch) {
      const inner = new Map(outer.get(deviceId) || [])
      for (const [relPath, { value, paramType }] of changes) {
        const existing = inner.get(relPath)
        inner.set(relPath, existing
          ? { ...existing, VALUE: value }
          : { FULL_PATH: relPath, TYPE: paramType || 'f', VALUE: value, ACCESS: 3 }
        )
      }
      outer.set(deviceId, inner)
      bumpDeviceVersion(deviceId)
    }
    deviceParams.value = outer
    deviceParamsVersion.value++
  }

  // Route a single PATH_CHANGED: resolve the device, fan out to exact-timing
  // listeners immediately, and queue the reactive-map update for the next
  // frame flush.
  function applyValue(absPath, value, paramType, explicitDeviceId, fromSnapshot = false) {
    let resolved = null
    if (Number.isInteger(explicitDeviceId)) {
      const dev = devices.value.find((item) => item.id === explicitDeviceId)
      if (dev) {
        const prefix = `/${dev.name}`
        resolved = {
          deviceId: explicitDeviceId,
          relPath: absPath.startsWith(prefix) ? (absPath.slice(prefix.length) || '/') : absPath
        }
      }
    }
    if (!resolved) resolved = pathToDeviceRel(absPath)
    if (!resolved) {
      if (isDebugApply()) {
        // eslint-disable-next-line no-console
        console.warn(
          '[APPLY-DROP] no device for', absPath,
          'known devices:', devices.value.map((d) => d.name)
        )
      }
      return
    }
    const { deviceId, relPath } = resolved

    // Fan out to recording / observer subscribers FIRST (pre-coalesce, exact
    // timing). Errors in one listener must not break the others. Snapshot
    // seeding (INITIAL_STATE walk) must NOT fan out — a reconnect would
    // pollute active recordings and blink every activity dot.
    if (!fromSnapshot) {
      for (const fn of pathChangeListeners) {
        try { fn(deviceId, relPath, value, paramType) } catch (err) {
          // Best-effort: log and keep going
          console.warn('[useHub] pathChange listener threw:', err)
        }
      }
    }

    paramBatcher.push(deviceId, relPath, value, paramType)
  }

  // Walk an initial OSCQuery tree (from INITIAL_STATE.namespace) to seed
  // deviceParams. Each path is "/<deviceName>/<rel>".
  function walkInitialTree(node, path) {
    if (node.TYPE !== undefined) applyValue(path, node.VALUE, node.TYPE, undefined, true)
    if (node.CONTENTS) {
      for (const [k, child] of Object.entries(node.CONTENTS)) walkInitialTree(child, path + '/' + k)
    }
  }

  // ── Connection lifecycle ────────────────────────────────────────────────

  function markDisconnected() {
    connected.value = false
    if (!stale.value && (devices.value.length || deviceParams.value.size)) {
      stale.value = true
      staleSince.value = Date.now()
    }
    if (connectionState.value === 'connected') connectionState.value = 'reconnecting'
    if (!downTimer && connectionState.value === 'reconnecting') {
      downTimer = setTimeout(() => {
        downTimer = null
        if (!connected.value) connectionState.value = 'down'
      }, DOWN_AFTER_MS)
    }
    // In-flight param acks will never arrive on this socket.
    paramRequests.settleAll({ ok: false, reason: 'disconnected' })
    rejectPendingExports('Hub bağlantısı koptu — export yanıtı alınamadı')
    clearAllPendingToggles()
  }

  function open() {
    if (suspended) return
    // Identity-guard every handler (same pattern as useDiscovery): a close
    // event from an ABANDONED socket delivered after suspend→resume must not
    // null the live socket, mark the UI disconnected, or fork a third
    // connection whose duplicate onmessage doubles every broadcast.
    const socket = new WebSocket(`ws://${location.host}/ws/hub`)
    ws = socket
    socket.onopen = () => {
      if (ws !== socket) { try { socket.close() } catch { /* already closing */ } ; return }
      connected.value = true
      connectionState.value = 'connected'
      clearTimeout(downTimer)
      downTimer = null
    }
    socket.onclose = () => {
      if (ws !== socket) return
      ws = null
      markDisconnected()
      // Fix F2-12 pattern: never schedule a reconnect once suspended.
      if (!suspended) retry = setTimeout(open, RETRY_MS)
    }
    socket.onerror = () => { /* surfaced via onclose */ }

    socket.onmessage = (ev) => {
      if (ws !== socket) return
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }

      if (msg.type === 'INITIAL_STATE') {
        hubInfo.value = {
          hubName: msg.hubName || 'Cosmic Live Manager',
          abletonForward: msg.abletonForward,
          ...(msg.oscListen !== undefined ? { oscListen: msg.oscListen } : {})
        }
        if (msg.oscListen !== undefined) oscListen.value = msg.oscListen
        devices.value = msg.registryDevices || msg.devices || []
        discovered.value = msg.discoveredDevices || []
        subscribers.value = msg.subscribers || []
        paramBatcher.clear()
        deviceParams.value = new Map()
        deviceMsgCounts.value = new Map()
        saveHints.value = new Map()
        announceResults.value = new Map()
        clearAllPendingToggles()
        if (msg.namespace) walkInitialTree(msg.namespace, '')
        // Apply the seeded values synchronously — a fresh snapshot should be
        // visible immediately, not one frame later.
        paramBatcher.flushNow()
        deviceParamsVersion.value++
        // Fresh snapshot → data is live again (fix F2-11).
        stale.value = false
        staleSince.value = null
      } else if (msg.type === 'HUB_STATUS') {
        if (msg.oscListen !== undefined) {
          oscListen.value = msg.oscListen
          hubInfo.value = { ...hubInfo.value, oscListen: msg.oscListen }
        }
      } else if (msg.type === 'PATH_CHANGED') {
        applyValue(msg.path, msg.value, msg.paramType, msg.deviceId)
        rateCounter++
      } else if (msg.type === 'PARAM_RESULT') {
        paramRequests.settle(msg.requestId, {
          ok: !!msg.ok,
          ...(msg.reason !== undefined ? { reason: msg.reason } : {})
        })
      } else if (msg.type === 'DEVICE_NAMESPACE') {
        if (!devices.value.some((device) => device.id === msg.deviceId)) return
        // Ordering: apply anything still buffered before wholesale-replacing
        // this device's map, then drop now-superseded buffered entries.
        paramBatcher.flushNow()
        // Replace this device's parameter map with the freshly-fetched
        // metadata. We keep VALUE from previous entries where possible so
        // mid-stream values aren't blanked out on reconnect.
        const prevInner = deviceParams.value.get(msg.deviceId) || new Map()
        const inner = new Map()
        for (const node of msg.nodes || []) {
          const prev = prevInner.get(node.FULL_PATH)
          inner.set(node.FULL_PATH, {
            ...node,
            VALUE: node.VALUE !== undefined ? node.VALUE : prev?.VALUE
          })
        }
        const m = new Map(deviceParams.value)
        m.set(msg.deviceId, inner)
        deviceParams.value = m
        bumpDeviceVersion(msg.deviceId)
        deviceParamsVersion.value++
      } else if (msg.type === 'DEVICES_RELOADED') {
        devices.value = msg.devices || []
        pruneDeviceCaches(new Set(devices.value.map((device) => device.id).filter(Number.isInteger)))
      } else if (msg.type === 'REGISTRY_UPDATED') {
        devices.value = msg.devices || []
        discovered.value = devices.value.filter((device) => !device.saved)
        pruneDeviceCaches(new Set(devices.value.map((device) => device.id).filter(Number.isInteger)))
      } else if (msg.type === 'DEVICE_REMOVED') {
        devices.value = devices.value.filter((device) => device.id !== msg.deviceId)
        paramBatcher.dropDevice(msg.deviceId)
        pruneDeviceCaches(new Set(devices.value.map((device) => device.id)))
      } else if (msg.type === 'DEVICE_UPDATED') {
        const i = devices.value.findIndex((d) =>
          (msg.device.canonicalId && d.canonicalId === msg.device.canonicalId) ||
          (msg.device.id != null && d.id === msg.device.id)
        )
        const next = devices.value.slice()
        if (i >= 0) next[i] = msg.device
        else next.push(msg.device)
        devices.value = next
        // Only an echo CONFIRMING the desired enabled state resolves the
        // toggle intent — unrelated DEVICE_UPDATED broadcasts (reconnect
        // retries, autoLink status ticks) must not unlock the button early
        // and re-expose the stale value mid-flight.
        if (msg.device.id != null) {
          const entry = pendingToggles.value.get(msg.device.id)
          if (entry && !!msg.device.enabled === entry.desired) clearPendingToggle(msg.device.id)
        }
      } else if (msg.type === 'UPDATE_DEVICE_RESULT') {
        if (msg.ok) setHint(msg.deviceId, '✓ Saved', 'ok')
        else setHint(msg.deviceId, '✗ ' + (msg.error || 'Error'), 'err')
        // Success is cleared by the matching DEVICE_UPDATED echo; a failure
        // ends the intent here (the timeout stays as the last-resort unlock).
        if (!msg.ok) clearPendingToggle(msg.deviceId)
      } else if (msg.type === 'DEVICE_MSG_COUNTS') {
        const m = new Map()
        const validIds = new Set(devices.value.map((device) => device.id))
        for (const [id, c] of Object.entries(msg.counts)) {
          const deviceId = parseInt(id, 10)
          if (validIds.has(deviceId)) m.set(deviceId, c)
        }
        deviceMsgCounts.value = m
        if (typeof msg.abletonTotal === 'number') abletonTotal.value = msg.abletonTotal
      } else if (msg.type === 'DISCOVERED_DEVICES') {
        discovered.value = msg.devices || []
      } else if (msg.type === 'SUBSCRIBERS_CHANGED') {
        subscribers.value = msg.subscribers || []
      } else if (msg.type === 'ANNOUNCE_RESULT') {
        setAnnounceResult(msg.deviceId, { ok: msg.ok, error: msg.error, summary: msg.summary })
      } else if (msg.type === 'CLEAR_LINK_RESULT') {
        if (msg.ok) setHint(msg.deviceId, '✓ Eşleşme kaldırıldı', 'ok')
        else setHint(msg.deviceId, '✗ ' + (msg.error || 'Eşleşme kaldırılamadı'), 'err')
      } else if (msg.type === 'MANIFESTS_EXPORT') {
        // Settle the oldest pending exportManifests() request (FIFO — the
        // protocol carries no correlation id for this reply).
        const entry = pendingExports.shift()
        if (entry) {
          clearTimeout(entry.timer)
          entry.resolve(msg)
        }
      }
    }
  }

  // ── Teardown / suspend-resume (fixes F2-12 + F2-18) ─────────────────────
  // iPadOS Safari frequently never fires `beforeunload` (bfcache world), so
  // we also tear down on `pagehide` and `visibilitychange:hidden`, and come
  // back up on `pageshow` / `visibilitychange:visible`. `suspended` guards
  // the onclose handler so a closed socket can never schedule a zombie
  // reconnect after teardown.
  function suspend() {
    if (suspended) return
    suspended = true
    clearTimeout(retry)
    retry = null
    clearTimeout(downTimer)
    downTimer = null
    stopRateTimer()
    if (ws) {
      const socket = ws
      ws = null
      // Belt-and-braces on top of the identity guards in open(): a stale
      // close can never fire once the handlers are detached.
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      try { socket.close() } catch {}
      markDisconnected()
    }
  }
  function resume() {
    if (!suspended) return
    suspended = false
    startRateTimer()
    if (!ws) open()
  }

  // Singleton lifecycle: open the WS immediately on first useHub() call (no
  // component lifecycle to lean on — the singleton lives as long as the page
  // does), and tear down on page unload / hide.
  startRateTimer()
  open()
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', suspend)
    window.addEventListener('pagehide', suspend)
    window.addEventListener('pageshow', resume)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') suspend()
      else resume()
    })
  }

  return {
    connected,
    connectionState,
    stale,
    staleSince,
    devices,
    discovered,
    subscribers,
    msgsThisSecond,
    abletonTotal,
    hubInfo,
    oscListen,
    deviceParams,
    deviceParamsVersion,
    paramsVersionFor,
    deviceMsgCounts,
    saveHints,
    announceResults,
    pendingToggles,
    send,
    updateDevice,
    setDeviceEnabled,
    reconnectDevice,
    removeDevice,
    reloadManifests,
    rediscover,
    addDiscovered,
    saveDevice,
    setDeviceParam,
    announceDevice,
    clearDeviceLink,
    onPathChange,
    exportManifests,
    importManifests,
    clearHint
  }
}
