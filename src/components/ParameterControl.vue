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

// Enum / menu: standard OSCQuery uses RANGE[i].VALS as a list of allowed
// values. When present we render a <select> regardless of TYPE (works for
// "s" with label values like TouchDesigner, and for "i" with index values).
const enumValues = computed(() => {
  const v = props.node.RANGE?.[0]?.VALS
  return Array.isArray(v) && v.length > 0 ? v : null
})
const currentEnumValue = computed(() => {
  const v = props.node.VALUE?.[0]
  // For "i" type, the value is an index into VALS; for "s" type it's the label.
  if (primaryType.value === 'i' && typeof v === 'number') {
    return enumValues.value?.[v] ?? ''
  }
  return v ?? ''
})
function onEnumChange(e) {
  const label = e.target.value
  if (primaryType.value === 'i') {
    const idx = enumValues.value.indexOf(label)
    commit([idx >= 0 ? idx : 0])
  } else {
    commit([label])
  }
}

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

// Step the value by ±1 (or ±range for float), clamped to RANGE if defined.
// Used by the custom int spinner buttons on the left of the numbox.
function bumpNumber(delta) {
  if (!writable.value) return
  const cur = Number(props.node.VALUE?.[0] ?? 0)
  const min = props.node.RANGE?.[0]?.MIN
  const max = props.node.RANGE?.[0]?.MAX
  const hasMinMax = typeof min === 'number' && typeof max === 'number'
  let newValue = primaryType.value === 'i'
    ? Math.round(cur) + delta
    : cur + delta
  if (hasMinMax) newValue = Math.max(min, Math.min(max, newValue))
  commit([newValue])
}

// Vertical-drag knob behaviour for the numbox:
//   - mousedown without movement → input keeps default behaviour (focus + type)
//   - mousedown + vertical drag > threshold → input is blurred and value
//     follows the drag (up = increase, down = decrease)
//   - Shift = 10× faster, Alt = 10× finer
const DRAG_THRESHOLD = 4 // pixels before drag kicks in (lets click-to-type work)

function startNumberDrag(e) {
  if (!writable.value) return
  if (e.button !== 0) return

  const inputEl = e.currentTarget
  const startY = e.clientY
  const startX = e.clientX
  const startValue = Number(props.node.VALUE?.[0] ?? 0)
  const ch = primaryType.value

  const min = props.node.RANGE?.[0]?.MIN
  const max = props.node.RANGE?.[0]?.MAX
  const hasMinMax = typeof min === 'number' && typeof max === 'number'

  // Base step per pixel. For ints we want roughly 1 unit every few pixels;
  // for floats with a known range we span ~200px to cover the full range.
  let baseStep
  if (ch === 'i') {
    baseStep = 1 / 3
  } else if (hasMinMax) {
    baseStep = (max - min) / 200
  } else {
    baseStep = 0.01
  }

  let dragging = false

  function onMove(ev) {
    const dy = startY - ev.clientY  // up = positive
    const dx = ev.clientX - startX
    if (!dragging) {
      if (Math.abs(dy) < DRAG_THRESHOLD && Math.abs(dx) < DRAG_THRESHOLD) return
      dragging = true
      inputEl.blur()
      document.body.style.cursor = 'ns-resize'
      inputEl.classList.add('dragging')
    }
    ev.preventDefault()
    const multiplier = ev.shiftKey ? 10 : (ev.altKey ? 0.1 : 1)
    let newValue = startValue + dy * baseStep * multiplier
    if (ch === 'i') newValue = Math.round(newValue)
    if (hasMinMax) newValue = Math.max(min, Math.min(max, newValue))
    commit([newValue])
  }

  function onUp() {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    inputEl.classList.remove('dragging')
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
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

    <!-- Enum / menu (RANGE.VALS present) → dropdown.
         Placed BEFORE the numeric branch so that an int parameter carrying
         a VALS list (= menu/enum) is rendered as a dropdown rather than as
         a plain number input. -->
    <template v-else-if="enumValues">
      <select
        :value="currentEnumValue"
        :disabled="!writable"
        @change="onEnumChange"
      >
        <option v-for="v in enumValues" :key="v" :value="v">{{ v }}</option>
      </select>
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

    <!-- Single float / int → numbox. Vertical mouse drag changes the value;
         click to type. Shift = 10× faster, Alt = 10× finer. Int values get
         a pair of custom ▲/▼ buttons on the left for ±1 stepping. -->
    <template v-else-if="primaryType === 'f' || primaryType === 'i'">
      <div class="num-wrap">
        <div v-if="primaryType === 'i'" class="num-spinner">
          <button
            class="spin-btn"
            type="button"
            :disabled="!writable"
            @click="bumpNumber(+1)"
            tabindex="-1"
            aria-label="increment"
          >▲</button>
          <button
            class="spin-btn"
            type="button"
            :disabled="!writable"
            @click="bumpNumber(-1)"
            tabindex="-1"
            aria-label="decrement"
          >▼</button>
        </div>
        <input
          class="num-input"
          type="number"
          :min="hasRange ? range.MIN : undefined"
          :max="hasRange ? range.MAX : undefined"
          :step="primaryType === 'i' ? 1 : 'any'"
          :value="primaryType === 'i' ? Math.round(node.VALUE?.[0] ?? 0) : (node.VALUE?.[0] ?? 0)"
          :disabled="!writable"
          :title="hasRange ? `drag · type · ${range.MIN}…${range.MAX}` : 'drag · type'"
          @change="onNumberInput"
          @mousedown="startNumberDrag"
        />
      </div>
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
/* numbox + (optional) custom spinner on the left */
.num-wrap {
  display: inline-flex;
  align-items: stretch;
  gap: 0;
  flex: 0 0 auto;
}
.num-input {
  width: 96px;
  flex: 0 0 auto;
  font-family: var(--mono);
  font-size: 12px;
  text-align: right;
  padding: 2px 6px;
  cursor: ns-resize;
}
.num-input:focus {
  cursor: text;
}
.num-input.dragging {
  cursor: ns-resize;
  user-select: none;
}
/* Always hide the native browser spinner — we render our own on the left. */
.num-input {
  appearance: textfield;            /* Firefox */
  -moz-appearance: textfield;
}
.num-input::-webkit-outer-spin-button,
.num-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

/* Custom spinner (only rendered for int) — stacked ▲/▼ on the left side. */
.num-spinner {
  display: flex;
  flex-direction: column;
  width: 16px;
  flex: 0 0 auto;
  margin-right: 2px;
}
.spin-btn {
  flex: 1 1 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--border, #444);
  color: var(--fg, #ccc);
  font-size: 8px;
  line-height: 1;
  padding: 0;
  cursor: pointer;
  user-select: none;
}
.spin-btn:hover:not(:disabled) {
  background: var(--accent, #555);
}
.spin-btn:active:not(:disabled) {
  background: var(--accent-strong, #777);
}
.spin-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.spin-btn:first-child {
  border-radius: 3px 3px 0 0;
  border-bottom-width: 0;
}
.spin-btn:last-child {
  border-radius: 0 0 3px 3px;
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
