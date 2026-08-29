import { ref, watch } from 'vue'

// Per-device preset store, backed by localStorage.
//
// One list of presets per Hub-managed device (keyed by device.id), so each
// device keeps its own scene-style shortcuts. A preset is just
//   { id, name, path, value }
// where `path` is the device-RELATIVE OSCQuery path (no `/<deviceName>`
// prefix). When fired, the consumer sends a SET_DEVICE_PARAM with the same
// path and value — identical effect to dragging the matching widget.
//
// Storage key:  clm:hub-presets:<deviceId>

const STORAGE_PREFIX = 'clm:hub-presets:'

/**
 * @param {import('vue').Ref<number|string>} deviceIdRef  reactive ref holding
 *   the current device id. Presets are reloaded automatically when this
 *   changes (e.g. manifests reload renumbers ids).
 */
export function useHubPresets(deviceIdRef) {
  const presets = ref([])

  function storageKey() {
    return deviceIdRef.value != null ? STORAGE_PREFIX + deviceIdRef.value : null
  }

  function load() {
    const k = storageKey()
    if (!k) {
      presets.value = []
      return
    }
    try {
      const raw = localStorage.getItem(k)
      presets.value = raw ? JSON.parse(raw) : []
    } catch {
      presets.value = []
    }
  }

  function persist() {
    const k = storageKey()
    if (!k) return
    try {
      localStorage.setItem(k, JSON.stringify(presets.value))
    } catch {
      // localStorage quota — drop silently
    }
  }

  function add(preset) {
    presets.value = [
      ...presets.value,
      { id: String(Date.now() + Math.random()), ...preset }
    ]
    persist()
  }

  function remove(id) {
    presets.value = presets.value.filter((p) => p.id !== id)
    persist()
  }

  function update(id, patch) {
    presets.value = presets.value.map((p) => (p.id === id ? { ...p, ...patch } : p))
    persist()
  }

  function reorder(fromIndex, toIndex) {
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || fromIndex >= presets.value.length) return
    if (toIndex < 0 || toIndex >= presets.value.length) return
    const arr = [...presets.value]
    const [moved] = arr.splice(fromIndex, 1)
    arr.splice(toIndex, 0, moved)
    presets.value = arr
    persist()
  }

  watch(deviceIdRef, load, { immediate: true })

  return { presets, add, remove, update, reorder, reload: load }
}
