<script setup>
import { computed, ref, watch } from 'vue'

// A node from the OSCQuery tree.
// Relevant fields:
//   FULL_PATH, TYPE (e.g. "f", "i", "s", "T", "F", "ff", "fff", "N"), VALUE,
//   RANGE, ACCESS  (ACCESS bits: 1 = read, 2 = write, 3 = read/write)
const props = defineProps({
  node: { type: Object, required: true },
  flashing: { type: Boolean, default: false }
})
const emit = defineEmits(['set'])

const writable = computed(() => (props.node.ACCESS ?? 3) & 2)

// Local draft so the user can type without remote updates blowing away keystrokes.
function copyValue(v) {
  if (Array.isArray(v)) return [...v]
  return v == null ? [] : [v]
}
const draft = ref(copyValue(props.node.VALUE))

const editing = ref(false)
watch(
  () => props.node.VALUE,
  (v) => {
    if (!editing.value) draft.value = copyValue(v)
  },
  { deep: true }
)

const typeStr = computed(() => (props.node.TYPE || '').toString())
const primaryType = computed(() => typeStr.value[0] || 'unknown')

// Boolean: a single T/F pair or just T/F. Some servers also use 'B'.
const isBool = computed(() => {
  const t = typeStr.value
  return t === 'T' || t === 'F' || t === 'TF' || t === 'FT' || t === 'B'
})

const currentBool = computed(() => {
  const v = props.node.VALUE?.[0]
  if (typeof v === 'boolean') return v
  if (v === 1 || v === 'true' || v === 'T') return true
  return false
})

// Multi-component numeric: e.g. fff, ff, ii — render one input per component.
const isMultiNumeric = computed(() => {
  const t = typeStr.value
  return t.length > 1 && /^[fid]+$/.test(t)
})

// "Nil" / impulse / action — render as a trigger button. Many OSCQuery
// servers expose actions (ResetSpectrum, ClearSpectrum, ...) this way.
const isTrigger = computed(() => typeStr.value === 'N' || typeStr.value === 'I')

const range = computed(() => props.node.RANGE?.[0] || {})
const hasRange = computed(() => range.value.MIN != null && range.value.MAX != null)

function commit(newValue) {
  emit('set', { path: props.node.FULL_PATH, value: newValue })
}

function onToggle() {
  if (!writable.value) return
  commit([!currentBool.value])
}

function onNumberInput(e) {
  const v = Number(e.target.value)
  draft.value = [v]
  commit([v])
}

function onMultiComponentInput(idx, val, ch) {
  // Build the full vector from the current node value, replacing one slot.
  const current = Array.isArray(props.node.VALUE) ? [...props.node.VALUE] : []
  while (current.length < typeStr.value.length) current.push(0)
  current[idx] = ch === 'i' ? Math.round(Number(val)) : Number(val)
  commit(current)
}

function onTextCommit() {
  editing.value = false
  commit(Array.isArray(draft.value) ? draft.value : [draft.value])
}

function onTrigger() {
  if (!writable.value) return
  // OSC trigger: send the address with no args. Empty array works for both
  // the helper's UDP sender and JSON SET commands.
  commit([])
}

function formatNumber(v, ch) {
  return Number(v ?? 0).toFixed(ch === 'i' ? 0 : 3)
}
</script>

<template>
  <div class="param-control" :class="{ flash: flashing }">
    <!-- Trigger / action button (TYPE = 'N' or 'I') -->
    <template v-if="isTrigger">
      <button class="trigger-btn" :disabled="!writable" @click="onTrigger">
        ⚡ Trigger
      </button>
    </template>

    <!-- Boolean toggle -->
    <template v-else-if="isBool">
      <div
        class="toggle"
        :class="{ on: currentBool }"
        :aria-disabled="!writable"
        @click="onToggle"
        role="switch"
        :aria-checked="currentBool"
      ></div>
    </template>

    <!-- Float / int with range → slider + numeric -->
    <template v-else-if="(primaryType === 'f' || primaryType === 'i') && hasRange">
      <input
        type="range"
        :min="range.MIN"
        :max="range.MAX"
        :step="primaryType === 'i' ? 1 : (range.MAX - range.MIN) / 1000"
        :value="node.VALUE?.[0] ?? 0"
        :disabled="!writable"
        @input="onNumberInput"
      />
      <span class="num">{{ formatNumber(node.VALUE?.[0], primaryType) }}</span>
    </template>

    <!-- Multi-component numeric (fff, ff, ii, ...) → one input per component -->
    <template v-else-if="isMultiNumeric">
      <div class="multi-inputs">
        <input
          v-for="(ch, idx) in typeStr"
          :key="idx"
          type="number"
          :step="ch === 'i' ? 1 : 'any'"
          :value="node.VALUE?.[idx] ?? 0"
          :disabled="!writable"
          :title="['x', 'y', 'z', 'w'][idx] || `[${idx}]`"
          @change="(e) => onMultiComponentInput(idx, e.target.value, ch)"
        />
      </div>
    </template>

    <!-- Single float / int, no range → numeric input -->
    <template v-else-if="primaryType === 'f' || primaryType === 'i'">
      <input
        type="number"
        :step="primaryType === 'i' ? 1 : 'any'"
        :value="node.VALUE?.[0] ?? 0"
        :disabled="!writable"
        @change="onNumberInput"
      />
    </template>

    <!-- String -->
    <template v-else-if="primaryType === 's'">
      <input
        type="text"
        v-model="draft[0]"
        :disabled="!writable"
        @focus="editing = true"
        @blur="onTextCommit"
        @keydown.enter="onTextCommit"
      />
    </template>

    <!-- Unknown / fallback — show JSON, allow paste-edit -->
    <template v-else>
      <input
        type="text"
        :value="JSON.stringify(node.VALUE)"
        :disabled="!writable"
        @change="(e) => {
          try { commit(JSON.parse(e.target.value)) } catch {}
        }"
      />
    </template>
  </div>
</template>

<style scoped>
.multi-inputs {
  display: flex;
  gap: 6px;
  flex: 1;
}
.multi-inputs input {
  flex: 1;
  min-width: 0;
}
.trigger-btn {
  background: transparent;
  border: 1px solid var(--warn);
  color: var(--warn);
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  font-family: var(--mono);
}
.trigger-btn:hover:not(:disabled) {
  background: var(--warn);
  color: #1a1a1a;
}
</style>
