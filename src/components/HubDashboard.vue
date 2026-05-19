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
  addDiscovered,
  setDeviceParam,
  announceDevice
} = useHub()

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

      <!-- Manifest devices -->
      <div class="section-header">
        <div class="section-title">Manifest Devices</div>
        <div class="section-hint">
          Click host/port to edit · Press &amp; hold a card to drag and reorder · Open Parameters to inspect &amp; control
        </div>
      </div>
      <div class="devices-grid">
        <div v-if="orderedDevices.length === 0" class="empty">No manifest files yet.</div>
        <div
          v-for="(dev, idx) in orderedDevices"
          :key="dev.id"
          :data-drag-idx="idx"
          class="device-card-wrapper"
          :class="{
            'drag-source': dragIdx === idx,
            'drag-target': dragOverIdx === idx && dragIdx !== -1,
          }"
          :style="dragIdx === idx
            ? { transform: `translate(${dragDX}px, ${dragDY}px) scale(1.025)`, zIndex: 50 }
            : null"
          @pointerdown="onCardPointerDown($event, idx, $event.currentTarget)"
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

      <!-- Discovered devices -->
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
    </main>
  </div>
</template>
