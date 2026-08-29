<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useHub } from '../composables/useHub.js'
import { useDiscovery } from '../composables/useDiscovery.js'
import { useScenes } from '../composables/useScenes.js'
import { usePerformancePresets } from '../composables/usePerformancePresets.js'
import DeviceCard from './DeviceCard.vue'
import SceneBar from './SceneBar.vue'
import ServerControl from './ServerControl.vue'

const {
  connected,
  devices,
  msgsThisSecond,
  deviceParams,
  deviceMsgCounts,
  saveHints,
  announceResults,
  updateDevice,
  reconnectDevice,
  removeDevice,
  rediscover,
  addDiscovered,
  saveDevice,
  setDeviceParam,
  announceDevice,
  exportManifests,
  importManifests
} = useHub()

// Brief visual feedback on the Rediscover button (so the user knows the click
// was actually sent — the discovery list usually rebuilds in <1s but on a busy
// network might take a moment).
const rediscovering = ref(false)
function onRediscoverClick() {
  rediscover()
  rediscovering.value = true
  setTimeout(() => { rediscovering.value = false }, 600)
}

// ─── Export / Import manifest preset ─────────────────────────────────────
// Export downloads the current manifest set as a JSON file. Import is an
// explicit bulk replacement; ordinary Manager stop/restart preserves files.
const importInputRef = ref(null)

async function onExportClick() {
  try {
    const payload = await exportManifests()
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `clm-manifests-${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (err) {
    alert('Export failed: ' + (err.message || err))
  }
}

function onImportClick() {
  if (importInputRef.value) importInputRef.value.click()
}
async function onImportFile(e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  try {
    const text = await file.text()
    const parsed = JSON.parse(text)
    const manifests = Array.isArray(parsed) ? parsed
                    : Array.isArray(parsed.manifests) ? parsed.manifests
                    : null
    if (!manifests) throw new Error('JSON missing a `manifests` array')
    if (!window.confirm(`Replace the current ${devices.value.length} device(s) with ${manifests.length} from the file?`)) {
      e.target.value = ''
      return
    }
    importManifests(manifests)
  } catch (err) {
    alert('Import failed: ' + (err.message || err))
  } finally {
    e.target.value = ''
  }
}

const { services } = useDiscovery()
const {
  scenes,
  add: addScene,
  rename: renameScene,
  remove: removeScene,
  overwrite: overwriteScene,
  reorder: reorderScene,
  fire: fireScene,
  migrateDeviceIds: migrateSceneDeviceIds
} = useScenes()
const { migrateDeviceIds: migratePerformanceDeviceIds } = usePerformancePresets()

watch(devices, (current) => {
  migrateSceneDeviceIds(current)
  migratePerformanceDeviceIds(current)
}, { immediate: true })

// Save a scene from the current namespace state. We pass deviceParams (the
// reactive Map) directly — useScenes reads .VALUE / .ACCESS off each node.
function onSceneSave(name) {
  addScene(name, deviceParams.value)
}
function onSceneFire(scene) {
  fireScene(scene, setDeviceParam)
}
function onSceneOverwrite(id) {
  overwriteScene(id, deviceParams.value)
}

// ─── Manual device add ──────────────────────────────────────────────────
// Some devices don't advertise correctly over mDNS (or the OSCQuery server
// on their side hasn't come up in time), so they never appear in the
// Discovered list. This form lets the user register one by IP + port
// directly. The manifest is written to disk by the helper's ADD_DISCOVERED
// handler, which means it persists across restarts and is picked up by
// Export/Import just like any other device.
const manualName = ref('')
const manualHost = ref('')
const manualPort = ref('')
const manualErr  = ref('')

const canManualAdd = computed(() => {
  const host = String(manualHost.value || '').trim()
  const port = parseInt(manualPort.value, 10)
  return host.length > 0 && Number.isFinite(port) && port >= 1 && port <= 65535
})

function onManualAddClick() {
  manualErr.value = ''
  const host = String(manualHost.value || '').trim()
  const port = parseInt(manualPort.value, 10)
  const name = String(manualName.value || '').trim()
  if (!host) { manualErr.value = 'Enter an IP or hostname'; return }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    manualErr.value = 'Port must be 1–65535'
    return
  }
  addDiscovered(host, port, name || undefined)
  manualName.value = ''
  manualHost.value = ''
  manualPort.value = ''
}

// ─── Custom ordering ────────────────────────────────────────────────────
// Persisted in localStorage as canonical IDs. Legacy numeric IDs are accepted
// once and automatically migrated so presets/order survive the registry move.
// listed in the order array (because they're newly discovered, added from
// a manifest, etc.) sort at the end by their id.
const ORDER_KEY = 'clm:hub-device-order'
function loadOrder() {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}
function saveOrder(ids) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)) } catch { /* quota */ }
}

const customOrder = ref(loadOrder())

function deviceOrderKey(device) {
  return device.canonicalId || `legacy:${device.id}`
}

const orderedDevices = computed(() => {
  const byId = new Map(devices.value.map((device) => [deviceOrderKey(device), device]))
  const out = []
  for (const rawKey of customOrder.value) {
    let key = String(rawKey)
    if (!byId.has(key) && /^\d+$/.test(key)) {
      const legacy = devices.value.find((device) => Number(device.id) === Number(key))
      if (legacy) key = deviceOrderKey(legacy)
    }
    if (byId.has(key)) {
      out.push(byId.get(key))
      byId.delete(key)
    }
  }
  const remaining = Array.from(byId.values()).sort((a, b) =>
    Number(a.port || a.oscQueryPort || 0) - Number(b.port || b.oscQueryPort || 0) ||
    String(a.name).localeCompare(String(b.name))
  )
  return [...out, ...remaining]
})

function isCosmicUnity(d) {
  return d?.deviceType === 'CosmicUnity' ||
    (d?.isLocal && Number(d?.port || d?.oscQueryPort) >= 5001 && Number(d?.port || d?.oscQueryPort) <= 5016)
}
function isAndroid(d) {
  return d?.deviceType === 'Android' || /android/i.test(d?.name || '')
}
const deviceGroups = computed(() => {
  const cosmic = orderedDevices.value.filter(isCosmicUnity)
  const android = orderedDevices.value.filter((device) => !isCosmicUnity(device) && isAndroid(device))
  const other = orderedDevices.value.filter((device) => !isCosmicUnity(device) && !isAndroid(device))
  const groups = [
    {
      key: 'cosmic',
      title: 'CosmicUnity / Ableton',
      hint: 'Her port ayrı bir Ableton kanalı ve VST3 instance’ıdır.',
      devices: cosmic,
      empty: 'CosmicUnity instance bulunamadı.'
    },
    {
      key: 'android',
      title: 'Android Tablets',
      hint: 'Kalıcı cihaz kimliği varsa IP değişse bile aynı kart korunur.',
      devices: android,
      empty: 'Android tablet bulunamadı.'
    }
  ]
  if (other.length > 0) {
    groups.push({
      key: 'other',
      title: 'Other OSCQuery Devices',
      hint: 'Tür bilgisi yayınlamayan geriye dönük uyumlu cihazlar.',
      devices: other,
      empty: ''
    })
  }
  return groups
})

// Stats
const statTotal  = computed(() => devices.value.length)
const statActive = computed(() => devices.value.filter((d) => d.saved && d.enabled).length)
const statConn   = computed(() => devices.value.filter((d) => d.connectionState === 'Connected' || d.status === 'connected').length)
const statParams = computed(() => {
  let n = 0
  for (const m of deviceParams.value.values()) n += m.size
  return n
})

// ─── Drag-and-drop with long-press ──────────────────────────────────────
// UX:
//   - Press a card and hold for PRESS_MS without moving (much). The card
//     "lifts up" — slight scale, drop-shadow, cursor: grabbing.
//   - While still holding, drag. The card follows the pointer; other cards
//     get a drop-target outline when hovered.
//   - Release → swap places + persist the new order to localStorage.
//   - Releasing without moving past the lift-off threshold = no-op (so a
//     plain click on the body doesn't trigger anything).
//
// We implement this with pointer events (works on mouse + touch) and a
// global move/up listener registered while a press is active.

const PRESS_MS = 350           // long-press threshold
const PRE_MOVE_TOLERANCE = 6   // px the pointer may wander before we cancel pre-arm
const dragIdx = ref(-1)        // index in orderedDevices being dragged (-1 = none)
const dragOverIdx = ref(-1)    // index hovered as drop target
const dragDX = ref(0)
const dragDY = ref(0)

let pressTimer = null
let pressStart = null          // { x, y, idx, pointerId, cardEl }

function isPrimary(e) {
  // Treat plain mouse left, touch, and pen as primary
  return e.button == null || e.button === 0
}

function onCardPointerDown(e, idx, cardEl) {
  if (!isPrimary(e)) return
  // Ignore presses originating from interactive controls so editing fields,
  // toggling buttons, scrubbing sliders etc. don't accidentally start a drag.
  const t = e.target
  if (t && t.closest('input, select, textarea, button, [contenteditable], .param-control')) return

  pressStart = {
    x: e.clientX, y: e.clientY,
    idx, pointerId: e.pointerId, cardEl
  }
  pressTimer = setTimeout(() => {
    pressTimer = null
    // Enter dragging state. The card now lifts up and follows the pointer.
    // Note: we deliberately do NOT call setPointerCapture here — the global
    // window listeners (registered below) receive every move/up event no
    // matter where the pointer is, and pointer capture has been observed to
    // interact badly with the pointer-events:none we apply to the source
    // card via CSS (needed so elementFromPoint can see the cards below).
    dragIdx.value = idx
    dragDX.value = 0
    dragDY.value = 0
  }, PRESS_MS)

  window.addEventListener('pointermove', onWindowPointerMove)
  window.addEventListener('pointerup', onWindowPointerUp)
  window.addEventListener('pointercancel', onWindowPointerUp)
}

function onWindowPointerMove(e) {
  if (!pressStart) return
  // Phase 1: waiting for press timer to fire — cancel if moved too far
  if (pressTimer && dragIdx.value < 0) {
    const dx = e.clientX - pressStart.x
    const dy = e.clientY - pressStart.y
    if (dx * dx + dy * dy > PRE_MOVE_TOLERANCE * PRE_MOVE_TOLERANCE) {
      cancelDrag()
    }
    return
  }
  if (dragIdx.value < 0) return
  // Phase 2: actively dragging
  dragDX.value = e.clientX - pressStart.x
  dragDY.value = e.clientY - pressStart.y

  // Find the drop target via direct bounding-box hit-testing on every card.
  // We deliberately avoid document.elementFromPoint here because:
  //   - the grid has visible gaps between cards, so elementFromPoint returns
  //     null (or the container) while crossing them — that's the source of
  //     the flicker the user was seeing;
  //   - the source card is visually translated and could intercept the hit
  //     even with pointer-events: none in some edge cases.
  // We iterate the rendered card wrappers, skip the source, and pick the
  // first one whose rect contains the cursor.
  const cards = document.querySelectorAll('.device-card-wrapper[data-drag-idx]')
  let hit = -1
  for (const c of cards) {
    const idx = Number(c.dataset.dragIdx)
    if (idx === dragIdx.value) continue
    const r = c.getBoundingClientRect()
    if (
      e.clientX >= r.left && e.clientX <= r.right &&
      e.clientY >= r.top && e.clientY <= r.bottom
    ) {
      hit = idx
      break
    }
  }
  // If the cursor is currently in a gap or outside every card, we KEEP the
  // previous target rather than clearing it — that way the highlight stays
  // stable while the user wiggles between cards, and a release in a gap
  // still drops onto the last-hovered card (matches the user's intent).
  if (hit !== -1) dragOverIdx.value = hit
}

function onWindowPointerUp(_e) {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = null
  if (dragIdx.value >= 0 && dragOverIdx.value >= 0 && dragOverIdx.value !== dragIdx.value) {
    // Compute new id order from current orderedDevices
    const ids = orderedDevices.value.map(deviceOrderKey)
    const [moved] = ids.splice(dragIdx.value, 1)
    ids.splice(dragOverIdx.value, 0, moved)
    customOrder.value = ids
    saveOrder(ids)
  }
  resetDragState()
}

function cancelDrag() {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = null
  resetDragState()
}
function resetDragState() {
  pressStart = null
  dragIdx.value = -1
  dragOverIdx.value = -1
  dragDX.value = 0
  dragDY.value = 0
  window.removeEventListener('pointermove', onWindowPointerMove)
  window.removeEventListener('pointerup', onWindowPointerUp)
  window.removeEventListener('pointercancel', onWindowPointerUp)
}

onBeforeUnmount(resetDragState)

// When the device list shrinks (e.g. manifest deleted), prune the custom
// order so we don't keep stale ids forever.
watch(devices, (list) => {
  const valid = new Set(list.map(deviceOrderKey))
  const migrated = customOrder.value
    .map((rawKey) => {
      const key = String(rawKey)
      if (valid.has(key)) return key
      const legacy = list.find((device) => Number(device.id) === Number(key))
      return legacy ? deviceOrderKey(legacy) : null
    })
    .filter((key) => key && valid.has(key))
  if (JSON.stringify(migrated) !== JSON.stringify(customOrder.value)) {
    customOrder.value = migrated
    saveOrder(migrated)
  }
})
</script>

<template>
  <div class="hub-dash">
    <header class="hub-topbar">
      <div class="hub-logo">
        <div class="hub-logo-icon">◎</div>
        <div class="hub-logo-text">Cosmic <span>Live Manager</span></div>
      </div>
      <div class="hub-topbar-spacer"></div>
      <button
        class="hub-rediscover-btn"
        type="button"
        title="Download the current manifest set as a JSON preset. Restore it later via Import."
        @click="onExportClick"
        :disabled="devices.length === 0"
      >
        <span class="hub-rediscover-icon">⬇</span>
        Export
      </button>
      <input
        ref="importInputRef"
        type="file"
        accept="application/json,.json"
        style="display:none"
        @change="onImportFile"
      />
      <button
        class="hub-rediscover-btn"
        type="button"
        title="Load a previously exported manifest preset. Replaces the current set."
        @click="onImportClick"
      >
        <span class="hub-rediscover-icon">⬆</span>
        Import
      </button>
      <button
        class="hub-rediscover-btn"
        :class="{ spinning: rediscovering }"
        type="button"
        title="Rebuild the helper's network discovery cache (equivalent of restarting npm run dev). Use when a device has renamed/changed port and isn't showing up."
        @click="onRediscoverClick"
      >
        <span class="hub-rediscover-icon">⟳</span>
        Rediscover
      </button>
      <div class="ws-badge" :class="{ connected }">
        <span class="dot"></span>
        <span>{{ connected ? 'Connected' : 'Reconnecting…' }}</span>
      </div>
    </header>

    <main class="hub-main">
      <ServerControl />

      <!-- Stats row -->
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-num">{{ statTotal }}</div>
          <div class="stat-label">Total Devices</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ statActive }}</div>
          <div class="stat-label">Active</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ statConn }}</div>
          <div class="stat-label">Connected</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ statParams }}</div>
          <div class="stat-label">Parameters</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ msgsThisSecond }}</div>
          <div class="stat-label">Msg / s</div>
        </div>
      </div>

      <!-- Scenes (global snapshot recall) -->
      <div class="section-header">
        <div class="section-title">Scenes</div>
        <div class="section-hint">
          Snapshot current state of every device · click a chip to recall · ⟳ overwrite · ✎ rename · × delete
        </div>
      </div>
      <SceneBar
        :scenes="scenes"
        @save="onSceneSave"
        @fire="onSceneFire"
        @overwrite="onSceneOverwrite"
        @rename="(id, name) => renameScene(id, name)"
        @remove="(id) => removeScene(id)"
        @reorder="({ from, to }) => reorderScene(from, to)"
      />

      <div class="section-header manifest-header">
        <div class="section-title-group">
          <div class="section-title">Add Device Manually</div>
          <div class="section-hint">
            Discovery misses a device only: save it by host and OSCQuery port.
          </div>
        </div>
        <div class="manual-add-row inline" title="Register a device manually by IP + port when discovery misses it. Saved to manifests just like the others.">
          <input
            v-model="manualName"
            type="text"
            class="manual-add-input manual-add-name"
            placeholder="Name (optional)"
            maxlength="64"
            @keydown.enter="canManualAdd && onManualAddClick()"
          />
          <input
            v-model="manualHost"
            type="text"
            class="manual-add-input manual-add-host"
            placeholder="192.168.1.42"
            @keydown.enter="canManualAdd && onManualAddClick()"
          />
          <input
            v-model="manualPort"
            type="number"
            class="manual-add-input manual-add-port"
            placeholder="Port"
            min="1"
            max="65535"
            @keydown.enter="canManualAdd && onManualAddClick()"
          />
          <button
            type="button"
            class="manual-add-btn"
            :disabled="!canManualAdd"
            @click="onManualAddClick"
          >
            + Add
          </button>
          <span v-if="manualErr" class="manual-add-err">{{ manualErr }}</span>
        </div>
      </div>

      <section v-for="group in deviceGroups" :key="group.key" class="device-group">
        <div class="section-header">
          <div class="section-title">{{ group.title }}</div>
          <div class="section-hint">{{ group.hint }}</div>
        </div>
        <div class="devices-grid">
          <div v-if="group.devices.length === 0" class="empty">{{ group.empty }}</div>
          <div
            v-for="dev in group.devices"
            :key="`${dev.canonicalId}:${dev.id ?? 'discovered'}:${dev.runtimeGeneration || 0}`"
            :data-drag-idx="orderedDevices.indexOf(dev)"
            class="device-card-wrapper"
            :class="{
              'drag-source': dragIdx === orderedDevices.indexOf(dev),
              'drag-target': dragOverIdx === orderedDevices.indexOf(dev) && dragIdx !== -1,
            }"
            :style="dragIdx === orderedDevices.indexOf(dev)
              ? { transform: `translate(${dragDX}px, ${dragDY}px) scale(1.025)`, zIndex: 50 }
              : null"
            @pointerdown="onCardPointerDown($event, orderedDevices.indexOf(dev), $event.currentTarget)"
          >
            <DeviceCard
              :device="dev"
              :msg-count="deviceMsgCounts.get(dev.id) || 0"
              :params="deviceParams.get(dev.id) || new Map()"
              :hint="saveHints.get(dev.id) || null"
              :services="services"
              :announce-result="announceResults.get(dev.id) || null"
              @update="(u) => updateDevice(dev.id, u)"
              @reconnect="reconnectDevice(dev.id)"
              @save="(name) => saveDevice(dev.canonicalId, name)"
              @set-param="(payload) => setDeviceParam(dev.id, payload.path, payload.value)"
              @announce="(payload) => announceDevice(dev.id, payload.target, payload.peerId, payload.udpPortOverride)"
              @remove="removeDevice(dev.id)"
            />
          </div>
        </div>
      </section>

    </main>
  </div>
</template>
