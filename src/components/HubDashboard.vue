<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useHub } from '../composables/useHub.js'
import { useDiscovery } from '../composables/useDiscovery.js'
import { useScenes } from '../composables/useScenes.js'
import DeviceCard from './DeviceCard.vue'
import DiscoveredCard from './DiscoveredCard.vue'
import SceneBar from './SceneBar.vue'

const {
  connected,
  devices,
  discovered,
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
// The dashboard starts empty on every helper restart (see server's
// KEEP_MANIFESTS logic). Export downloads the current set as a JSON file;
// Import reads a previously saved JSON and replaces the current set on the
// helper.
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
  fire: fireScene
} = useScenes()

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
// Persisted in localStorage as an array of device.id values. Devices not
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

const customOrder = ref(loadOrder()) // Array<number>  (device.id, in user order)

const orderedDevices = computed(() => {
  const byId = new Map(devices.value.map((d) => [d.id, d]))
  const out = []
  for (const id of customOrder.value) {
    if (byId.has(id)) {
      out.push(byId.get(id))
      byId.delete(id)
    }
  }
  // Append any device that hasn't been ordered yet (sorted by id)
  const remaining = Array.from(byId.values()).sort((a, b) => a.id - b.id)
  return [...out, ...remaining]
})

// Split into two sub-lists for separate rendering: device names that contain
// "max" (case-insensitive) go in the bottom section, everything else in the
// top section. The single underlying `orderedDevices` array is preserved so
// drag-and-drop indexing keeps working across both grids — we just filter
// what each grid renders.
function isMaxDevice(d) {
  return /max/i.test(d?.name || '')
}
const generalDevices = computed(() => orderedDevices.value.filter((d) => !isMaxDevice(d)))
const maxDevices     = computed(() => orderedDevices.value.filter((d) =>  isMaxDevice(d)))

// Stats
const statTotal  = computed(() => devices.value.length)
const statActive = computed(() => devices.value.filter((d) => d.enabled).length)
const statConn   = computed(() => devices.value.filter((d) => d.status === 'connected').length)
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
    const ids = orderedDevices.value.map((d) => d.id)
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
  const valid = new Set(list.map((d) => d.id))
  const filtered = customOrder.value.filter((id) => valid.has(id))
  if (filtered.length !== customOrder.value.length) {
    customOrder.value = filtered
    saveOrder(filtered)
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

      <!-- Discovered devices (moved above Manifest Devices for visibility — new
           devices on the LAN are surfaced right under the Scenes bar instead
           of being buried at the bottom of the page). -->
      <template v-if="discovered.length > 0">
        <div class="section-header">
          <div class="section-title">Discovered on Network</div>
          <div class="section-hint">Devices not yet in your manifests · click Add to register</div>
        </div>
        <div class="discovered-grid">
          <DiscoveredCard
            v-for="d in discovered"
            :key="`${d.host}:${d.port}`"
            :device="d"
            @add="(payload) => addDiscovered(payload.host, payload.port, payload.name)"
          />
        </div>
      </template>

      <!-- Manifest devices — General (everything whose name doesn't contain "max").
           The manual-add form lives inside this header so it stays visible at
           the top of the section, above any registered manifest cards. -->
      <div class="section-header manifest-header">
        <div class="section-title-group">
          <div class="section-title">Manifest Devices</div>
          <div class="section-hint">
            Click host/port to edit · Press &amp; hold a card to drag and reorder · Open Parameters to inspect &amp; control
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
      <div class="devices-grid">
        <div v-if="generalDevices.length === 0" class="empty">No general devices.</div>
        <div
          v-for="dev in generalDevices"
          :key="dev.id"
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
            @set-param="(payload) => setDeviceParam(dev.id, payload.path, payload.value)"
            @announce="(payload) => announceDevice(dev.id, payload.target, payload.peerId, payload.udpPortOverride)"
            @remove="removeDevice(dev.id)"
          />
        </div>
      </div>

      <!-- Manifest devices — Max (anything whose name contains "Max") -->
      <template v-if="maxDevices.length > 0">
        <div class="section-header">
          <div class="section-title">Max Devices</div>
          <div class="section-hint">
            Devices whose name contains "Max" — shown separately for easier triage at a glance
          </div>
        </div>
        <div class="devices-grid">
          <div
            v-for="dev in maxDevices"
            :key="dev.id"
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
              @set-param="(payload) => setDeviceParam(dev.id, payload.path, payload.value)"
              @announce="(payload) => announceDevice(dev.id, payload.target, payload.peerId, payload.udpPortOverride)"
              @remove="removeDevice(dev.id)"
            />
          </div>
        </div>
      </template>

    </main>
  </div>
</template>
