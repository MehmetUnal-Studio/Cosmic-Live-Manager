<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { useHub } from '../composables/useHub.js'
import { usePerformancePresets } from '../composables/usePerformancePresets.js'
import PerformancePreset from './PerformancePreset.vue'
import AddPresetModal from './AddPresetModal.vue'

// Performance Mode — a blank canvas of fire-on-click parameter shortcuts.
// Each shortcut (preset) is a free-floating rectangle the user can drag,
// resize from the edges, rename inline, and fire by clicking.
//
// Persistence: usePerformancePresets() auto-saves to localStorage. We also
// expose Export/Import JSON buttons for backup and sharing.

const hub = useHub()
const { devices, deviceParams, setDeviceParam } = hub

// Hub link state — fire surfaces get an inert/dimmed look while the link is
// down, and firing reports failure instead of flashing a false success.
const connState = computed(() => {
  const cs = hub.connectionState
  if (cs && typeof cs === 'object' && 'value' in cs) return cs.value
  return hub.connected?.value ? 'connected' : 'disconnected'
})
const isConnected = computed(() => connState.value === 'connected')
const {
  presets,
  add,
  move,
  resize,
  remove,
  update,
  exportJSON,
  importJSON,
  GRID
} = usePerformancePresets()

const showAdd = ref(false)
const importInputRef = ref(null)
const flashedId = ref(null)
const failedId = ref(null)
let flashTimer = null
let failTimer = null

// Failure toast (delivery feedback)
const toastMsg = ref('')
let toastTimer = null
function showToast(msg) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg.value = '' }, 2500)
}
onBeforeUnmount(() => {
  clearTimeout(toastTimer)
  clearTimeout(flashTimer)
  clearTimeout(failTimer)
})

function flashOk(id) {
  flashedId.value = id
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { flashedId.value = null }, 220)
}
function flashFail(id) {
  failedId.value = id
  clearTimeout(failTimer)
  failTimer = setTimeout(() => { failedId.value = null }, 600)
}

// Fire = send the (path, value) to the device. Delivery-true feedback:
// setDeviceParam resolves {ok, reason} from the state layer — the green
// flash appears ONLY when the command was actually handed to the hub
// socket; otherwise the rect flashes red and a toast explains why.
async function onFire(p) {
  if (!isConnected.value) {
    flashFail(p.id)
    showToast('Hub bağlantısı yok — gönderilemedi')
    return
  }
  let result = null
  try {
    result = await setDeviceParam(p.deviceId, p.path, p.value)
  } catch (err) {
    result = { ok: false, reason: err?.message || String(err) }
  }
  // Legacy state layer returns undefined — treat as sent (old behavior),
  // the connectivity gate above already covers the silent-drop case.
  const ok = result == null ? true : result.ok !== false
  if (ok) {
    flashOk(p.id)
  } else {
    flashFail(p.id)
    showToast(result?.reason
      ? `Gönderilemedi — ${result.reason}`
      : 'Gönderilemedi — hub bağlantısını kontrol edin')
  }
}

function onMove(p, { x, y }) {
  move(p.id, x, y)
}
function onResize(p, { x, y, w, h }) {
  // Resize handle may imply position change (e.g. left/top edge drag).
  // Route through move() + resize() so both x/y and w/h get snapped to GRID
  // and resize() enforces the min-dimension clamp.
  move(p.id, x, y)
  resize(p.id, w, h)
}
function onRename(p, newName) {
  update(p.id, { name: newName })
}
function onRemove(p) {
  remove(p.id)
}

function onAddSave(payload) {
  add(payload)
  showAdd.value = false
}

function pickImport() {
  if (importInputRef.value) importInputRef.value.click()
}
async function onImportChosen(e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  try {
    await importJSON(file, { merge: true })
  } catch (err) {
    alert('Could not import: ' + err.message)
  } finally {
    e.target.value = ''
  }
}
</script>

<template>
  <div class="pm-page">
    <header class="pm-header">
      <div class="pm-header-title">Performance Mode</div>
      <div class="pm-header-spacer"></div>
      <div class="pm-header-actions">
        <button
          class="pm-header-btn pm-header-btn-primary"
          @click="showAdd = true"
          :disabled="devices.length === 0"
          :title="devices.length === 0 ? 'No devices available — add one in Dashboard first' : 'Add a new performance preset'"
        >
          + Add preset
        </button>
        <button
          class="pm-header-btn"
          @click="exportJSON"
          :disabled="presets.length === 0"
          title="Download the current layout as a .json file"
        >
          ⬇ Export
        </button>
        <input
          ref="importInputRef"
          type="file"
          accept="application/json,.json"
          style="display:none"
          @change="onImportChosen"
        />
        <button
          class="pm-header-btn"
          @click="pickImport"
          title="Load a previously exported layout (presets are merged with the current ones)"
        >
          ⬆ Import
        </button>
      </div>
    </header>

    <!-- The canvas. background grid mirrors the snap step (GRID px) so users
         can see where their drags will land. -->
    <div
      class="pm-canvas"
      :class="{ 'pm-offline': !isConnected }"
      :style="{
        backgroundImage: `linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px),
                          linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)`,
        backgroundSize: `${GRID}px ${GRID}px`
      }"
    >
      <div
        v-for="p in presets"
        :key="p.id"
        :class="{ 'pm-fire-flash': flashedId === p.id, 'pm-fire-fail': failedId === p.id }"
        style="position: absolute; left: 0; top: 0;"
      >
        <PerformancePreset
          :preset="p"
          :grid="GRID"
          @fire="onFire(p)"
          @move="(d) => onMove(p, d)"
          @resize="(d) => onResize(p, d)"
          @rename="(n) => onRename(p, n)"
          @remove="onRemove(p)"
        />
      </div>

      <div v-if="presets.length === 0" class="pm-empty">
        <div class="pm-empty-icon">◌</div>
        <div class="pm-empty-title">No presets yet</div>
        <div class="pm-empty-hint">
          Click <strong>+ Add preset</strong> to pin a device parameter shortcut to this canvas.<br>
          Drag from the center to move, drag from an edge to resize.
        </div>
      </div>
    </div>

    <AddPresetModal
      v-if="showAdd"
      :devices="devices"
      :device-params="deviceParams"
      @close="showAdd = false"
      @save="onAddSave"
    />

    <div v-if="toastMsg" class="hub-toast err" role="status">{{ toastMsg }}</div>
  </div>
</template>

<style scoped>
.pm-page {
  display: flex; flex-direction: column;
  /* 100% of .app-page (tabs + status bar live above us) — 100vh would
     push the canvas bottom off-screen. */
  height: 100%;
  min-height: 480px;
  background: var(--hub-bg, #0a0c12);
  color: var(--hub-ink, #dfe4ee);
}
.pm-header {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--hub-border, #2a2a2a);
  background: var(--hub-surface, #1a1a1a);
  flex: 0 0 auto;
}
.pm-header-title {
  font-size: 1rem; font-weight: 600;
  letter-spacing: 0.04em;
}
.pm-header-spacer { flex: 1; }
.pm-header-actions { display: flex; gap: 8px; }
.pm-header-btn {
  background: transparent;
  border: 1px solid var(--hub-border, #2a2a2a);
  color: var(--hub-ink-mid, #999);
  padding: 6px 12px;
  border-radius: 4px;
  font: inherit; font-size: 0.78rem;
  cursor: pointer; transition: all 0.15s;
}
.pm-header-btn:hover:not(:disabled) {
  color: var(--hub-ink, #ddd);
  border-color: var(--hub-border-2, #444);
  background: rgba(255,255,255,0.04);
}
.pm-header-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pm-header-btn-primary {
  color: var(--hub-bg, #111);
  background: var(--hub-cyan, #5bb8ff);
  border-color: var(--hub-cyan, #5bb8ff);
  font-weight: 600;
}
.pm-header-btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.pm-canvas {
  position: relative;
  flex: 1 1 auto;
  overflow: auto;
  /* Background grid set inline via :style so it scales with GRID */
}

/* Fire flash styling lives in styles.css (.pm-fire-flash = green success,
   .pm-fire-fail = red failure) — delivery-true feedback, shared tokens. */

.pm-empty {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  color: var(--hub-ink-dim, #777);
  pointer-events: none;
  gap: 10px;
  text-align: center;
}
.pm-empty-icon {
  font-size: 4rem; line-height: 1;
  opacity: 0.4;
}
.pm-empty-title {
  font-size: 1rem; font-weight: 600;
  color: var(--hub-ink-mid, #999);
  letter-spacing: 0.04em;
}
.pm-empty-hint {
  font-size: 0.8rem; max-width: 360px; line-height: 1.5;
}
.pm-empty-hint strong { color: var(--hub-cyan, #5bb8ff); }
</style>
