import { ref, watch } from 'vue'

// Global store of "performance mode" presets — pinned (device, path, value)
// shortcuts that the user can lay out spatially on a blank canvas and fire
// during performance.
//
// Each preset is a free-floating rectangle with absolute (x, y) position and
// (w, h) size, all in CSS pixels. Optional color is the rectangle background.
//
// Persistence: auto-save into localStorage on every change AND user can
// Export/Import a JSON file for backup / sharing across machines.
//
// Schema:
//   {
//     id:          string  (uuid)
//     name:        string  (label shown on the rectangle)
//     deviceId:    number  (which device to send to)
//     deviceName:  string  (snapshot — informational, shown in tooltip)
//     path:        string  (OSCQuery path on that device)
//     value:       any     (value to set when fired)
//     x, y:        number  (top-left position on canvas, px)
//     w, h:        number  (size, px)
//     color:       string  (CSS color, e.g. "#6366f1")
//   }

const STORAGE_KEY = 'clm:performance-presets'
const GRID = 20  // snap step in pixels — see snap()

// Module-level singleton so the dashboard and the performance-mode page
// share the same reactive array.
let _store = null

export function usePerformancePresets() {
  if (_store) return _store
  _store = create()
  return _store
}

function create() {
  const presets = ref(load())

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  }
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(presets.value))
    } catch {
      // quota — drop silently
    }
  }
  watch(presets, persist, { deep: true })

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  }

  function snap(n) {
    return Math.round(n / GRID) * GRID
  }

  function add(payload) {
    const next = {
      id: uid(),
      name: payload.name || 'Preset',
      deviceId: payload.deviceId,
      deviceName: payload.deviceName || '',
      path: payload.path,
      value: payload.value,
      x: snap(payload.x ?? 40),
      y: snap(payload.y ?? 40),
      w: snap(payload.w ?? 140),
      h: snap(payload.h ?? 80),
      color: payload.color || '#6366f1'
    }
    presets.value = [...presets.value, next]
    return next.id
  }

  function update(id, patch) {
    presets.value = presets.value.map((p) => (p.id === id ? { ...p, ...patch } : p))
  }

  function move(id, x, y) {
    update(id, { x: snap(x), y: snap(y) })
  }
  function resize(id, w, h) {
    // Enforce sane minimums so the rectangle stays usable.
    const W = Math.max(GRID * 3, snap(w))
    const H = Math.max(GRID * 2, snap(h))
    update(id, { w: W, h: H })
  }

  function remove(id) {
    presets.value = presets.value.filter((p) => p.id !== id)
  }

  function exportJSON() {
    const payload = {
      version: 1,
      kind: 'clm-performance-presets',
      exportedAt: new Date().toISOString(),
      presets: presets.value
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `clm-performance-${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function importJSON(file, { merge = true } = {}) {
    if (!file) return
    const text = await file.text()
    const parsed = JSON.parse(text)
    if (parsed.kind !== 'clm-performance-presets' || !Array.isArray(parsed.presets)) {
      throw new Error('Not a Cosmic Live Manager performance preset file.')
    }
    // Re-id incoming entries on merge to avoid collisions with existing ones.
    const incoming = parsed.presets.map((p) => ({ ...p, id: uid() }))
    presets.value = merge ? [...presets.value, ...incoming] : incoming
  }

  return {
    presets,
    add,
    update,
    move,
    resize,
    remove,
    exportJSON,
    importJSON,
    GRID
  }
}
