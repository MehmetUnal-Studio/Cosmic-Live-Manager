<script setup>
import { ref } from 'vue'
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

const { devices, deviceParams, setDeviceParam } = useHub()
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
let flashTimer = null

// Fire = send the (path, value) to the device. We also flash the rectangle
// briefly so the user gets visual confirmation that the click landed.
function onFire(p) {
  try {
    setDeviceParam(p.deviceId, p.path, p.value)
  } catch (err) {
    console.warn('[performance] setDeviceParam failed:', err)
  }
  flashedId.value = p.id
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { flashedId.value = null }, 220)
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
      :style="{
        backgroundImage: `linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px),
                          linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)`,
        backgroundSize: `${GRID}px ${GRID}px`
      }"
    >
      <div
        v-for="p in presets"
        :key="p.id"
        :class="{ 'pm-fire-flash': flashedId === p.id }"
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
  </div>
</template>

<style scoped>
.pm-page {
  display: flex; flex-direction: column;
  height: 100vh;
  background: var(--hub-bg, #0a0a0a);
  color: var(--hub-ink, #ddd);
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
  background: var(--hub-cyan, #06b6d4);
  border-color: var(--hub-cyan, #06b6d4);
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

/* Fire flash — brief glow on the wrapper div around a preset that was
   just clicked. Applied as outline so the rectangle's own dimensions
   don't shift. */
.pm-fire-flash > :deep(.pm-preset) {
  outline: 2px solid var(--hub-cyan, #06b6d4);
  outline-offset: 2px;
  transition: outline-color 0.2s;
}

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
.pm-empty-hint strong { color: var(--hub-cyan, #06b6d4); }
</style>
