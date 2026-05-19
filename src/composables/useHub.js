import { ref, onMounted, onBeforeUnmount } from 'vue'

// Hub state — connects to the helper's /ws/hub channel.
//
// The helper aggregates every device's namespace into one central namespace
// and pushes PATH_CHANGED, DEVICE_UPDATED, DEVICE_NAMESPACE,
// DISCOVERED_DEVICES, DEVICE_MSG_COUNTS, ANNOUNCE_RESULT … to every
// connected dashboard. This composable exposes those streams plus the
// outbound commands (SET_DEVICE_PARAM, ANNOUNCE_DEVICE, …) to the UI.

export function useHub() {
  const connected = ref(false)
  const devices = ref([])
  const discovered = ref([])
  const subscribers = ref([])
  const msgsThisSecond = ref(0)
  const abletonTotal = ref(0)
  const hubInfo = ref({ hubName: 'Cosmic Live Manager' })

  // Per-device parameter map. Each entry is a full OSCQuery node:
  //   { FULL_PATH, TYPE, VALUE, RANGE, ACCESS, DESCRIPTION, UNIT }
  // FULL_PATH here is the path RELATIVE TO THE DEVICE (no /deviceName prefix),
  // because that's what the device itself uses and what we need to send
  // back when writing values.
  //   deviceParams: Map<deviceId, Map<relPath, node>>
  const deviceParams = ref(new Map())
  const deviceMsgCounts = ref(new Map())
  const saveHints = ref(new Map())

  // Announce results — keyed by deviceId, cleared after a short delay.
  const announceResults = ref(new Map())

  // Msg/s window
  let rateCounter = 0
  const rateTimer = setInterval(() => {
    msgsThisSecond.value = rateCounter
    rateCounter = 0
  }, 1000)

  let ws = null
  let retry = null

  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }

  function updateDevice(deviceId, updates) {
    send({ type: 'UPDATE_DEVICE', deviceId, updates })
    setHint(deviceId, 'Saving…', '')
  }
  function reconnectDevice(deviceId) {
    send({ type: 'RECONNECT_DEVICE', deviceId })
    setHint(deviceId, 'Reconnecting…', '')
  }
  function removeDevice(deviceId) {
    send({ type: 'REMOVE_DEVICE', deviceId })
    // No optimistic hint: the helper's DEVICES_RELOADED will drop the card.
  }
  function reloadManifests() {
    send({ type: 'RELOAD_MANIFESTS' })
  }
  // Tear down + recreate the helper's Bonjour browser. Use when a device has
  // renamed itself or changed port and isn't showing up in the discovery list
  // any more. Equivalent to restarting `npm run dev` for the discovery layer.
  function rediscover() {
    send({ type: 'REDISCOVER' })
  }
  function addDiscovered(host, port, name) {
    send({ type: 'ADD_DISCOVERED', host, port, name: (name || '').trim() || undefined })
  }
  function setDeviceParam(deviceId, relPath, value) {
    send({ type: 'SET_DEVICE_PARAM', deviceId, path: relPath, value })
  }
  function announceDevice(deviceId, target, peerId, udpPortOverride) {
    send({
      type: 'ANNOUNCE_DEVICE',
      deviceId,
      target: { address: target.address, port: target.port, name: target.name },
      peerId,
      udpPortOverride: udpPortOverride || 0
    })
  }

  function setHint(deviceId, text, type) {
    const m = new Map(saveHints.value)
    m.set(deviceId, { text, type, until: Date.now() + 1500 })
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

  // Apply a single PATH_CHANGED to the per-device node map.
  function applyValue(absPath, value, paramType) {
    const resolved = pathToDeviceRel(absPath)
    if (!resolved) return
    const { deviceId, relPath } = resolved
    const m = new Map(deviceParams.value)
    if (!m.has(deviceId)) m.set(deviceId, new Map())
    const inner = new Map(m.get(deviceId))
    const existing = inner.get(relPath)
    inner.set(relPath, existing
      ? { ...existing, VALUE: value }
      : { FULL_PATH: relPath, TYPE: paramType || 'f', VALUE: value, ACCESS: 3 }
    )
    m.set(deviceId, inner)
    deviceParams.value = m
  }

  // Walk an initial OSCQuery tree (from INITIAL_STATE.namespace) to seed
  // deviceParams. Each path is "/<deviceName>/<rel>".
  function walkInitialTree(node, path) {
    if (node.TYPE !== undefined) applyValue(path, node.VALUE, node.TYPE)
    if (node.CONTENTS) {
      for (const [k, child] of Object.entries(node.CONTENTS)) walkInitialTree(child, path + '/' + k)
    }
  }

  function open() {
    ws = new WebSocket(`ws://${location.host}/ws/hub`)
    ws.onopen = () => { connected.value = true }
    ws.onclose = () => {
      connected.value = false
      ws = null
      retry = setTimeout(open, 1500)
    }
    ws.onerror = () => { /* surfaced via onclose */ }

    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }

      if (msg.type === 'INITIAL_STATE') {
        hubInfo.value = {
          hubName: msg.hubName || 'Cosmic Live Manager',
          abletonForward: msg.abletonForward
        }
        devices.value = msg.devices || []
        discovered.value = msg.discoveredDevices || []
        subscribers.value = msg.subscribers || []
        deviceParams.value = new Map()
        if (msg.namespace) walkInitialTree(msg.namespace, '')
      } else if (msg.type === 'PATH_CHANGED') {
        applyValue(msg.path, msg.value, msg.paramType)
        rateCounter++
      } else if (msg.type === 'DEVICE_NAMESPACE') {
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
      } else if (msg.type === 'DEVICES_RELOADED') {
        devices.value = msg.devices || []
      } else if (msg.type === 'DEVICE_UPDATED') {
        const i = devices.value.findIndex((d) => d.id === msg.device.id)
        const next = devices.value.slice()
        if (i >= 0) next[i] = msg.device
        else next.push(msg.device)
        devices.value = next
      } else if (msg.type === 'UPDATE_DEVICE_RESULT') {
        if (msg.ok) setHint(msg.deviceId, '✓ Saved', 'ok')
        else setHint(msg.deviceId, '✗ ' + (msg.error || 'Error'), 'err')
      } else if (msg.type === 'DEVICE_MSG_COUNTS') {
        const m = new Map()
        for (const [id, c] of Object.entries(msg.counts)) m.set(parseInt(id, 10), c)
        deviceMsgCounts.value = m
        if (typeof msg.abletonTotal === 'number') abletonTotal.value = msg.abletonTotal
      } else if (msg.type === 'DISCOVERED_DEVICES') {
        discovered.value = msg.devices || []
      } else if (msg.type === 'SUBSCRIBERS_CHANGED') {
        subscribers.value = msg.subscribers || []
      } else if (msg.type === 'ANNOUNCE_RESULT') {
        setAnnounceResult(msg.deviceId, { ok: msg.ok, error: msg.error, summary: msg.summary })
      }
    }
  }

  onMounted(open)
  onBeforeUnmount(() => {
    clearTimeout(retry)
    clearInterval(rateTimer)
    if (ws) try { ws.close() } catch {}
  })

  return {
    connected,
    devices,
    discovered,
    subscribers,
    msgsThisSecond,
    abletonTotal,
    hubInfo,
    deviceParams,
    deviceMsgCounts,
    saveHints,
    announceResults,
    updateDevice,
    reconnectDevice,
    removeDevice,
    reloadManifests,
    rediscover,
    addDiscovered,
    setDeviceParam,
    announceDevice
  }
}
