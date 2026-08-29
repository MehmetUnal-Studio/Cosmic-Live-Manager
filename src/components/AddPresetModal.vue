<script setup>
import { computed, ref, watch } from 'vue'

// Modal dialog: pick (device, path, value, name, color) → emits 'save'.
// Mounted by PerformanceMode.vue when the user clicks "+ Add preset".
// Stays purely presentational — the parent decides where to put the new
// preset on the canvas (which it does via the composable).

const props = defineProps({
  // Device list from useHub() — used to populate the device dropdown.
  devices:      { type: Array, required: true },
  // Per-device parameter map (Map<deviceId, Map<relPath, node>>) so we can
  // populate the path dropdown with what's actually exposed.
  deviceParams: { type: Object, required: true }
})
const emit = defineEmits(['close', 'save'])

const PALETTE = [
  '#5bb8ff', // cosmic accent blue
  '#3ddc84', // success green
  '#ffb02e', // warn amber
  '#ff7a6e', // danger coral
  '#8fd0ff', // accent hover (light blue)
  '#8b5cf6', // violet
  '#2c9c8f', // teal
  '#64748b'  // slate
]

const name        = ref('')
const deviceId    = ref(props.devices[0]?.id ?? null)
const path        = ref('')
const value       = ref('')
const color       = ref(PALETTE[0])

// Paths offered for the currently-selected device. Filter to writable nodes
// (ACCESS bit 2 — same convention as PresetSection / ParameterControl).
const pathOptions = computed(() => {
  if (deviceId.value == null) return []
  const map = props.deviceParams.get(deviceId.value)
  if (!map) return []
  const out = []
  for (const [p, node] of map.entries()) {
    if ((node.ACCESS ?? 3) & 2) out.push({ path: p, node })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
})

// When the path selection changes, pre-fill `value` with the parameter's
// CURRENT VALUE so the user just needs to confirm (or tweak) — saves them
// having to look it up.
watch(path, (p) => {
  if (!p) return
  const map = props.deviceParams.get(deviceId.value)
  const node = map ? map.get(p) : null
  if (node && Array.isArray(node.VALUE)) {
    value.value = node.VALUE.length === 1 ? node.VALUE[0] : JSON.stringify(node.VALUE)
  } else if (node && node.VALUE !== undefined) {
    value.value = node.VALUE
  }
  // Also seed the name if empty: use the last segment of the path.
  if (!name.value) name.value = p.split('/').pop()
})

// Resetting path when device changes — the previous selection probably
// doesn't exist in the new device's namespace.
watch(deviceId, () => { path.value = '' })

const canSave = computed(() =>
  deviceId.value != null && !!path.value && value.value !== '' && !!name.value.trim()
)

function parseValue(raw) {
  // Heuristic: JSON array first (multi-component params like ff/fff are
  // pre-filled as "[0.1,0.25]" and MUST go back out as real arrays — a
  // string arg would reach the device as one 's' instead of two floats),
  // then number, then boolean, then fall back to string.
  if (typeof raw === 'number') return raw
  const s = String(raw).trim()
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr)) return arr
    } catch { /* fall through to scalar parsing */ }
  }
  if (s === 'true') return true
  if (s === 'false') return false
  const n = Number(s)
  if (Number.isFinite(n) && s !== '') return n
  return s
}

function onSave() {
  if (!canSave.value) return
  const dev = props.devices.find((d) => d.id === deviceId.value)
  emit('save', {
    name:       name.value.trim(),
    deviceId:   deviceId.value,
    deviceName: dev?.name || '',
    path:       path.value,
    value:      parseValue(value.value),
    color:      color.value
  })
}
</script>

<template>
  <div class="pm-modal-overlay" @click.self="emit('close')">
    <div class="pm-modal" role="dialog" aria-modal="true">
      <div class="pm-modal-header">
        <span>New performance preset</span>
        <button class="pm-modal-close" @click="emit('close')" aria-label="Close">×</button>
      </div>
      <div class="pm-modal-body">
        <label class="pm-field">
          <span>Name</span>
          <input v-model="name" placeholder="e.g. Cutoff snap" spellcheck="false" autofocus />
        </label>

        <label class="pm-field">
          <span>Device</span>
          <select v-model="deviceId">
            <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
        </label>

        <label class="pm-field">
          <span>Parameter</span>
          <select v-model="path" :disabled="!deviceId">
            <option value="">— pick a writable parameter —</option>
            <option v-for="o in pathOptions" :key="o.path" :value="o.path">
              {{ o.path }}<span v-if="o.node.TYPE"> · {{ o.node.TYPE }}</span>
            </option>
          </select>
        </label>

        <label class="pm-field">
          <span>Value</span>
          <input v-model="value" placeholder="number, string, or true/false" spellcheck="false" />
        </label>

        <div class="pm-field pm-field-color">
          <span>Color</span>
          <div class="pm-palette">
            <button
              v-for="c in PALETTE"
              :key="c"
              type="button"
              class="pm-swatch"
              :class="{ active: color === c }"
              :style="{ background: c }"
              :title="c"
              @click="color = c"
            ></button>
            <label class="pm-swatch pm-swatch-custom" :title="'Custom: ' + color">
              <input type="color" v-model="color" />
              <span class="pm-swatch-custom-dot" :style="{ background: color }"></span>
            </label>
          </div>
        </div>
      </div>
      <div class="pm-modal-footer">
        <button class="pm-btn" @click="emit('close')">Cancel</button>
        <button class="pm-btn pm-btn-primary" :disabled="!canSave" @click="onSave">
          Save
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pm-modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}
.pm-modal {
  background: var(--hub-surface, #1f1f1f);
  border: 1px solid var(--hub-border, #2a2a2a);
  border-radius: 10px;
  min-width: 380px; max-width: 480px; width: 90%;
  box-shadow: 0 20px 60px rgba(0,0,0,0.45);
  color: var(--hub-ink, #ddd);
}
.pm-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--hub-border, #2a2a2a);
  font-size: 0.85rem; font-weight: 600; letter-spacing: 0.04em;
}
.pm-modal-close {
  background: transparent; border: none; color: var(--hub-ink-dim, #777);
  font-size: 20px; line-height: 1; cursor: pointer;
}
.pm-modal-close:hover { color: var(--hub-ink, #ddd); }
.pm-modal-body {
  padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px;
}
.pm-field {
  display: flex; flex-direction: column; gap: 4px;
  font-size: 0.72rem; letter-spacing: 0.04em;
  color: var(--hub-ink-mid, #999);
}
.pm-field input, .pm-field select {
  background: var(--hub-bg, #111);
  border: 1px solid var(--hub-border, #2a2a2a);
  border-radius: 4px;
  color: var(--hub-ink, #ddd);
  padding: 6px 8px;
  font: inherit;
  font-size: 0.82rem;
}
.pm-field input:focus, .pm-field select:focus {
  outline: none; border-color: var(--hub-border-2, #444);
}
.pm-field-color { gap: 6px; }
.pm-palette { display: flex; gap: 6px; flex-wrap: wrap; }
.pm-swatch {
  width: 26px; height: 26px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer; padding: 0;
}
.pm-swatch.active { border-color: var(--hub-ink, #fff); }
.pm-swatch-custom {
  position: relative;
  background: transparent !important;
  display: inline-flex; align-items: center; justify-content: center;
  border: 2px dashed var(--hub-border-2, #444);
}
.pm-swatch-custom input[type="color"] {
  position: absolute; inset: 0; opacity: 0; cursor: pointer; padding: 0; border: 0;
}
.pm-swatch-custom-dot {
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--hub-ink-dim, #777);
}
.pm-modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--hub-border, #2a2a2a);
}
.pm-btn {
  background: transparent;
  border: 1px solid var(--hub-border, #2a2a2a);
  color: var(--hub-ink-mid, #999);
  padding: 6px 14px;
  border-radius: 4px;
  font: inherit; font-size: 0.78rem;
  cursor: pointer; transition: all 0.15s;
}
.pm-btn:hover:not(:disabled) {
  color: var(--hub-ink, #ddd); border-color: var(--hub-border-2, #444);
  background: rgba(255,255,255,0.04);
}
.pm-btn-primary {
  color: var(--hub-bg, #111); background: var(--hub-cyan, #5bb8ff);
  border-color: var(--hub-cyan, #5bb8ff); font-weight: 600;
}
.pm-btn-primary:hover:not(:disabled) {
  background: var(--hub-cyan, #5bb8ff); filter: brightness(1.1);
}
.pm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
