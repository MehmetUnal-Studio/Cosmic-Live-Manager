<script setup>
import { computed, ref } from 'vue'

// Single performance-mode preset rectangle.
//
// Three interaction modes on the rectangle:
//   - mousedown on the BODY (away from edges) → drag to move
//   - mousedown on an EDGE/CORNER             → drag to resize
//   - quick click (no significant movement)   → FIRE (emit setDeviceParam)
//
// Edge detection: we look at the cursor position relative to the rect's
// own bounding box on mousedown. Anything inside the EDGE_PX margin from
// the perimeter is treated as a resize handle; everything else is "body".
// This avoids creating 8 invisible handle divs.
//
// Snap to grid (GRID, default 20px): every position/size we COMMIT (via
// emit) is snapped. While dragging, the visual previews real-time at the
// raw pixel position so the cursor feels responsive.

const props = defineProps({
  preset: { type: Object, required: true },
  grid:   { type: Number, default: 20 }
})
const emit = defineEmits(['fire', 'move', 'resize', 'remove', 'rename'])

const EDGE_PX = 8        // border thickness for resize hit testing
const CLICK_TOL = 4      // px the cursor may wander before a click is no longer a "fire"

const editingName = ref(false)
const draftName   = ref(props.preset.name)
const hovered     = ref(false)

// Live overrides used while dragging/resizing so the rectangle re-renders
// at the raw cursor position before we commit a snapped value on mouseup.
const liveX = ref(null)
const liveY = ref(null)
const liveW = ref(null)
const liveH = ref(null)

const style = computed(() => ({
  left:   (liveX.value ?? props.preset.x) + 'px',
  top:    (liveY.value ?? props.preset.y) + 'px',
  width:  (liveW.value ?? props.preset.w) + 'px',
  height: (liveH.value ?? props.preset.h) + 'px',
  background: props.preset.color || '#5bb8ff'
}))

const valueLabel = computed(() => {
  const v = props.preset.value
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string') return v.length > 16 ? v.slice(0, 15) + '…' : v
  return JSON.stringify(v)
})

// Pick a contrasting text color (white on dark backgrounds, dark on light).
// Simple luminance check on the hex/rgb color value.
const textColor = computed(() => {
  const hex = String(props.preset.color || '#5bb8ff').replace('#', '')
  if (hex.length < 6) return '#fff'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? '#111' : '#fff'
})

function snap(n) {
  return Math.round(n / props.grid) * props.grid
}

// Decide whether the mousedown is on the body or on an edge, and which edge.
function hitTest(e, el) {
  const r = el.getBoundingClientRect()
  const x = e.clientX - r.left
  const y = e.clientY - r.top
  const onLeft   = x <= EDGE_PX
  const onRight  = x >= r.width - EDGE_PX
  const onTop    = y <= EDGE_PX
  const onBottom = y >= r.height - EDGE_PX
  if (onLeft || onRight || onTop || onBottom) {
    return { kind: 'resize', onLeft, onRight, onTop, onBottom }
  }
  return { kind: 'body' }
}

function cursorForEdge(edge) {
  if (edge.onTop && edge.onLeft) return 'nwse-resize'
  if (edge.onTop && edge.onRight) return 'nesw-resize'
  if (edge.onBottom && edge.onLeft) return 'nesw-resize'
  if (edge.onBottom && edge.onRight) return 'nwse-resize'
  if (edge.onLeft || edge.onRight) return 'ew-resize'
  if (edge.onTop || edge.onBottom) return 'ns-resize'
  return 'default'
}

// Track hover position so the cursor changes to the appropriate
// resize handle BEFORE the user clicks. Pure CSS can't do this with the
// invisible-margin approach, so we update inline style on the element.
function onHoverMove(e) {
  if (e.pointerType && e.pointerType !== 'mouse') return
  if (liveX.value !== null) return // currently dragging — leave it
  const el = e.currentTarget
  const t = hitTest(e, el)
  el.style.cursor = t.kind === 'body' ? 'grab' : cursorForEdge(t)
}

// ─── Unified pointer interaction (mouse + touch + pen, F2-10) ────────────
//   - edge press          → resize drag (all pointer types, immediately)
//   - body, mouse         → quick click = FIRE, drag past CLICK_TOL = move
//   - body, touch/pen     → tap = FIRE, long-press (PRESS_MS) then drag = move
//     (movement before the long-press arms cancels the gesture — no
//      accidental fire, no accidental move)
const PRESS_MS = 350

function onPointerDown(e) {
  if (editingName.value) return
  if (e.button != null && e.button !== 0) return
  // Skip if press originated on the inner controls (delete button, name input)
  const tag = e.target.tagName
  if (tag === 'BUTTON' || tag === 'INPUT') return

  const el = e.currentTarget
  const t = hitTest(e, el)
  const isTouch = e.pointerType && e.pointerType !== 'mouse'
  const startX = e.clientX
  const startY = e.clientY
  const start = {
    x: props.preset.x, y: props.preset.y,
    w: props.preset.w, h: props.preset.h
  }
  let moved = false
  // Resize is armed immediately; body-move is armed immediately for mouse,
  // and only after a long-press for touch (so a tap stays a clean FIRE).
  let armed = t.kind === 'resize' || !isTouch
  let cancelled = false
  let pressTimer = null
  if (!armed) {
    pressTimer = setTimeout(() => {
      pressTimer = null
      armed = true
    }, PRESS_MS)
  }

  function onMove(ev) {
    const dx = ev.clientX - startX
    const dy = ev.clientY - startY
    const past = Math.hypot(dx, dy) > CLICK_TOL
    if (!armed) {
      // Touch body-press not yet armed: wandering means this is neither a
      // tap nor a deliberate long-press-drag — cancel the whole gesture.
      if (past) {
        cancelled = true
        cleanup()
      }
      return
    }
    if (!moved && past) moved = true
    if (!moved) return
    ev.preventDefault()

    if (t.kind === 'body') {
      liveX.value = start.x + dx
      liveY.value = start.y + dy
    } else {
      let nx = start.x, ny = start.y, nw = start.w, nh = start.h
      if (t.onRight)  nw = Math.max(props.grid * 3, start.w + dx)
      if (t.onBottom) nh = Math.max(props.grid * 2, start.h + dy)
      if (t.onLeft)   { nx = start.x + dx; nw = Math.max(props.grid * 3, start.w - dx) }
      if (t.onTop)    { ny = start.y + dy; nh = Math.max(props.grid * 2, start.h - dy) }
      liveX.value = nx; liveY.value = ny; liveW.value = nw; liveH.value = nh
    }
  }

  function cleanup() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null }
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    if (cancelled) resetLive()
  }

  function onCancel() {
    cancelled = true
    cleanup()
  }

  function onUp() {
    const wasMoved = moved
    cleanup()
    if (cancelled) return
    if (!wasMoved) {
      // Tap / quick click → fire
      resetLive()
      emit('fire')
      return
    }
    // Commit snapped position/size
    if (t.kind === 'body') {
      emit('move', { x: liveX.value, y: liveY.value })
    } else {
      emit('resize', { x: liveX.value, y: liveY.value, w: liveW.value, h: liveH.value })
    }
    resetLive()
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
}

function resetLive() {
  liveX.value = null; liveY.value = null; liveW.value = null; liveH.value = null
}

function onNameDblClick() {
  editingName.value = true
  draftName.value = props.preset.name
}
function commitName() {
  const v = draftName.value.trim()
  editingName.value = false
  if (v && v !== props.preset.name) emit('rename', v)
}

function onRemove() {
  if (window.confirm(`Remove preset "${props.preset.name}"?`)) emit('remove')
}
</script>

<template>
  <div
    class="pm-preset"
    :style="style"
    @pointermove="onHoverMove"
    @pointerdown="onPointerDown"
    @pointerenter="hovered = true"
    @pointerleave="hovered = false"
    :title="`${preset.deviceName || ''} ${preset.path} = ${valueLabel}`"
  >
    <!-- Always rendered: touch tablets have no hover, so the remove
         affordance stays visible (dimmed) instead of v-if="hovered". -->
    <button
      class="pm-preset-remove"
      :class="{ hovered }"
      :style="{ color: textColor }"
      @click.stop="onRemove"
      @pointerdown.stop
      aria-label="Remove preset"
    >×</button>

    <div class="pm-preset-body" :style="{ color: textColor }">
      <input
        v-if="editingName"
        class="pm-preset-name-input"
        :style="{ color: textColor }"
        v-model="draftName"
        @blur="commitName"
        @keydown.enter.prevent="$event.target.blur()"
        @keydown.esc="editingName = false"
        @mousedown.stop
        @click.stop
        autofocus
      />
      <div
        v-else
        class="pm-preset-name"
        @dblclick.stop="onNameDblClick"
      >{{ preset.name }}</div>

      <div class="pm-preset-meta">
        <span class="pm-preset-path">{{ preset.path }}</span>
        <span class="pm-preset-value">{{ valueLabel }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pm-preset {
  position: absolute;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.3);
  user-select: none;
  -webkit-user-select: none;
  touch-action: none; /* our pointer handlers own move/resize on touch */
  transition: box-shadow 0.15s, transform 0.05s;
  overflow: hidden;
}
.pm-preset:hover { box-shadow: 0 4px 18px rgba(0,0,0,0.45); }
.pm-preset:active { transform: scale(0.99); }

.pm-preset-body {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  justify-content: center; align-items: center;
  padding: 8px 12px;
  text-align: center;
  pointer-events: none; /* let the parent receive all mouse events */
}
.pm-preset-body > * { pointer-events: auto; }

.pm-preset-name {
  font-size: 0.95rem; font-weight: 600;
  line-height: 1.2;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  width: 100%;
  cursor: text;
}
.pm-preset-name-input {
  background: rgba(255,255,255,0.15);
  border: 1px solid rgba(255,255,255,0.4);
  border-radius: 3px;
  font: inherit; font-size: 0.95rem; font-weight: 600;
  text-align: center; padding: 2px 6px;
  width: 90%;
}
.pm-preset-meta {
  display: flex; flex-direction: column; gap: 2px;
  margin-top: 6px;
  font-size: 0.65rem; opacity: 0.85;
  font-family: var(--hub-mono, monospace);
  width: 100%;
}
.pm-preset-path {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pm-preset-value { font-weight: 600; }

.pm-preset-remove {
  position: absolute; top: 2px; right: 2px;
  background: transparent; border: none;
  font-size: 18px; line-height: 1; padding: 0;
  width: 28px; height: 28px; /* stage-friendly hit box */
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0.4;
  z-index: 2;
}
.pm-preset-remove.hovered,
.pm-preset-remove:hover,
.pm-preset-remove:focus-visible { opacity: 1; }
</style>
