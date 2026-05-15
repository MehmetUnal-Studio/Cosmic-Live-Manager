<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  presets: { type: Array, required: true }, // [{id, name, path, value}, ...]
  flat: { type: Object, required: true } // tree { [path]: node }
})
const emit = defineEmits(['add', 'remove', 'update', 'fire', 'reorder'])

// --- Add / edit form state ----------------------------------------------
const adding = ref(false)
const editingId = ref(null)        // null when creating, preset.id when editing
const draftPath = ref('')
const draftName = ref('')
const draftValue = ref('')
const saveError = ref('')

// Suppress one cycle of the auto-fill watch when seeding the form for edit,
// so the saved value isn't immediately overwritten by the current widget
// state of the same path.
let suppressNextAutoFill = false

const writablePaths = computed(() =>
  Object.entries(props.flat)
    .filter(([, node]) => (node.ACCESS ?? 3) & 2)
    .map(([path, node]) => ({
      path,
      node,
      label: `${path}${node.TYPE ? ` · ${node.TYPE}` : ''}`
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
)

const draftNode = computed(() => props.flat[draftPath.value])

function startAdd() {
  adding.value = true
  editingId.value = null
  draftPath.value = ''
  draftName.value = ''
  draftValue.value = ''
  saveError.value = ''
}

function startEdit(p) {
  suppressNextAutoFill = true
  adding.value = true
  editingId.value = p.id
  draftPath.value = p.path
  draftName.value = p.name
  draftValue.value = JSON.stringify(p.value)
  saveError.value = ''
}

function cancelAdd() {
  adding.value = false
  editingId.value = null
  saveError.value = ''
}

// Whenever the user picks a different parameter, pre-fill draftValue with the
// node's current live VALUE so they can save the current state directly.
// Skipped once when seeding the form for edit (we use the saved value).
watch(draftPath, () => {
  if (suppressNextAutoFill) {
    suppressNextAutoFill = false
    return
  }
  if (draftNode.value?.VALUE != null) {
    draftValue.value = JSON.stringify(draftNode.value.VALUE)
  } else {
    draftValue.value = ''
  }
})

function parseValue(text, node) {
  const trimmed = (text ?? '').trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{') || trimmed.startsWith('"')) {
    return JSON.parse(trimmed)
  }
  const t = (node?.TYPE || '').toString()
  if (t === 'T' || t === 'F' || t === 'B' || t === 'TF' || t === 'FT') {
    return [trimmed.toLowerCase() === 'true' || trimmed === '1']
  }
  if (/^[fid]+$/.test(t) && t.length > 1) {
    return trimmed
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((s, i) => (t[i] === 'i' ? parseInt(s, 10) : parseFloat(s)))
  }
  if (t === 'f' || t === 'd') return [parseFloat(trimmed)]
  if (t === 'i') return [parseInt(trimmed, 10)]
  return [trimmed]
}

function saveForm() {
  saveError.value = ''
  if (!draftPath.value) {
    saveError.value = 'Pick a parameter'
    return
  }
  if (!draftName.value.trim()) {
    saveError.value = 'Give it a name'
    return
  }
  let value
  try {
    value = parseValue(draftValue.value, draftNode.value)
  } catch (err) {
    saveError.value = `Bad value: ${err.message}`
    return
  }
  const payload = { name: draftName.value.trim(), path: draftPath.value, value }
  if (editingId.value) {
    emit('update', editingId.value, payload)
  } else {
    emit('add', payload)
  }
  adding.value = false
  editingId.value = null
}

function useCurrentValue() {
  if (draftNode.value?.VALUE != null) {
    draftValue.value = JSON.stringify(draftNode.value.VALUE)
  }
}

function firePreset(p) {
  emit('fire', p)
}

// --- Drag and drop reordering -------------------------------------------
const dragIdx = ref(null)
const overIdx = ref(null)

function onDragStart(e, idx) {
  dragIdx.value = idx
  // Required for Firefox; data type irrelevant for our purposes
  e.dataTransfer.effectAllowed = 'move'
  try {
    e.dataTransfer.setData('text/plain', String(idx))
  } catch {}
}
function onDragOver(e, idx) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  if (overIdx.value !== idx) overIdx.value = idx
}
function onDragLeave(idx) {
  if (overIdx.value === idx) overIdx.value = null
}
function onDrop(e, toIdx) {
  e.preventDefault()
  const fromIdx = dragIdx.value
  dragIdx.value = null
  overIdx.value = null
  if (fromIdx == null || fromIdx === toIdx) return
  emit('reorder', { from: fromIdx, to: toIdx })
}
function onDragEnd() {
  dragIdx.value = null
  overIdx.value = null
}
</script>

<template>
  <div class="presets">
    <div class="preset-chips">
      <button
        v-for="(p, idx) in presets"
        :key="p.id"
        class="preset-chip filled"
        :class="{ dragging: dragIdx === idx, 'drop-target': overIdx === idx && dragIdx !== null && dragIdx !== idx }"
        draggable="true"
        :title="`${p.path} ← ${JSON.stringify(p.value)}\nClick to apply · ✎ edit · × delete · drag to reorder`"
        @click="firePreset(p)"
        @dragstart="onDragStart($event, idx)"
        @dragover="onDragOver($event, idx)"
        @dragleave="onDragLeave(idx)"
        @drop="onDrop($event, idx)"
        @dragend="onDragEnd"
      >
        <span class="preset-name">{{ p.name }}</span>
        <span class="preset-edit" @click.stop="startEdit(p)" title="Edit preset">✎</span>
        <span class="preset-del" @click.stop="emit('remove', p.id)" title="Delete preset">×</span>
      </button>
      <button v-if="!adding" class="preset-chip empty" @click="startAdd" title="Add a new preset">
        +
      </button>
    </div>

    <div v-if="adding" class="preset-form">
      <div class="preset-form-head" v-if="editingId">
        <strong>Editing preset</strong>
        <span class="preset-form-hint">Change parameter, value or name and Save</span>
      </div>
      <div class="preset-form-row">
        <label>Parameter</label>
        <select v-model="draftPath">
          <option value="">— pick parameter —</option>
          <option v-for="p in writablePaths" :key="p.path" :value="p.path">{{ p.label }}</option>
        </select>
      </div>
      <div class="preset-form-row">
        <label>Value</label>
        <input
          v-model="draftValue"
          type="text"
          :disabled="!draftPath"
          :placeholder="draftNode ? `JSON (current: ${JSON.stringify(draftNode.VALUE)})` : 'pick a parameter first'"
        />
        <button v-if="draftPath" @click="useCurrentValue" type="button" title="Snapshot the current widget value">
          Use current
        </button>
      </div>
      <div class="preset-form-row">
        <label>Name</label>
        <input v-model="draftName" type="text" placeholder="e.g. Intro Scene" @keydown.enter="saveForm" />
      </div>
      <div v-if="saveError" class="preset-form-error">{{ saveError }}</div>
      <div class="preset-form-actions">
        <button class="primary" @click="saveForm" :disabled="!draftPath || !draftName.trim()">
          {{ editingId ? 'Save changes' : 'Save preset' }}
        </button>
        <button @click="cancelAdd">Cancel</button>
      </div>
    </div>
  </div>
</template>
