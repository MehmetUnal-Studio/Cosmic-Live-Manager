<script setup>
import { ref } from 'vue'

const props = defineProps({
  scenes: { type: Array, required: true }
})
const emit = defineEmits(['fire', 'save', 'rename', 'remove', 'overwrite', 'reorder'])

// ─── Save form ─────────────────────────────────────────────────────────
const saving = ref(false)
const draftName = ref('')

function openSave() {
  saving.value = true
  draftName.value = `Scene ${props.scenes.length + 1}`
}
function confirmSave() {
  emit('save', draftName.value)
  saving.value = false
  draftName.value = ''
}
function cancelSave() {
  saving.value = false
  draftName.value = ''
}

// ─── Inline rename ─────────────────────────────────────────────────────
const editingId = ref(null)
const editingName = ref('')
function startRename(scene) {
  editingId.value = scene.id
  editingName.value = scene.name
}
function commitRename() {
  if (editingId.value) emit('rename', editingId.value, editingName.value)
  editingId.value = null
  editingName.value = ''
}
function cancelRename() {
  editingId.value = null
  editingName.value = ''
}

// ─── Drag & drop reorder ──────────────────────────────────────────────
const dragIdx = ref(null)
const overIdx = ref(null)
function onDragStart(e, idx) {
  dragIdx.value = idx
  e.dataTransfer.effectAllowed = 'move'
  try { e.dataTransfer.setData('text/plain', String(idx)) } catch {}
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
function onDragEnd() { dragIdx.value = null; overIdx.value = null }
</script>

<template>
  <div class="scene-bar">
    <div class="preset-chips">
      <template v-for="(s, idx) in scenes" :key="s.id">
        <input
          v-if="editingId === s.id"
          class="scene-rename-input"
          v-model="editingName"
          @blur="commitRename"
          @keydown.enter.prevent="commitRename"
          @keydown.escape.prevent="cancelRename"
          autofocus
        />
        <button
          v-else
          class="preset-chip filled scene-chip"
          :class="{
            dragging: dragIdx === idx,
            'drop-target': overIdx === idx && dragIdx !== null && dragIdx !== idx
          }"
          draggable="true"
          :title="`${s.paramCount} parameters · captured ${new Date(s.createdAt).toLocaleString()}\nClick to recall · ✎ rename · ⟳ overwrite · × delete · drag to reorder`"
          @click="emit('fire', s)"
          @dragstart="onDragStart($event, idx)"
          @dragover="onDragOver($event, idx)"
          @dragleave="onDragLeave(idx)"
          @drop="onDrop($event, idx)"
          @dragend="onDragEnd"
        >
          <span class="preset-name">{{ s.name }}</span>
          <span class="scene-count">{{ s.paramCount }}</span>
          <span class="preset-edit" @click.stop="startRename(s)" title="Rename scene">✎</span>
          <span
            class="preset-edit scene-overwrite"
            @click.stop="emit('overwrite', s.id)"
            title="Overwrite this scene with current state"
          >⟳</span>
          <span class="preset-del" @click.stop="emit('remove', s.id)" title="Delete scene">×</span>
        </button>
      </template>

      <button v-if="!saving" class="preset-chip empty" @click="openSave" title="Capture current state as a new scene">
        +
      </button>
    </div>

    <div v-if="saving" class="scene-save-form">
      <input
        v-model="draftName"
        class="scene-save-input"
        placeholder="Scene name…"
        spellcheck="false"
        @keydown.enter.prevent="confirmSave"
        @keydown.escape.prevent="cancelSave"
      />
      <button class="hub-btn hub-btn-primary" @click="confirmSave">Save</button>
      <button class="hub-btn" @click="cancelSave">Cancel</button>
      <span class="scene-save-hint">Captures every writable parameter of every device currently known to the hub.</span>
    </div>
  </div>
</template>
