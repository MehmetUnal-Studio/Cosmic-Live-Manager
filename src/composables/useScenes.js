import { ref } from 'vue'

// Global "scene" store — like presets, but across every managed device.
//
// A scene captures a snapshot of every writable parameter we currently know
// about, grouped by device. Firing the scene re-sends every captured value
// to its device via SET_DEVICE_PARAM. Storage is in localStorage so scenes
// persist across page reloads and between days.
//
// Storage key:  clm:hub-scenes
// Shape:
//   [
//     {
//       id: 'unique',
//       name: 'Drop',
//       createdAt: 1715900000000,
//       snapshot: {
//         [deviceId]: { [relPath]: VALUE }   // VALUE is the OSCQuery array
//       },
//       paramCount: 42                       // denormalised for badge
//     },
//     …
//   ]

const STORAGE_KEY = 'clm:hub-scenes'

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}
function persist(value) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)) } catch { /* quota */ }
}

export function useScenes() {
  const scenes = ref(loadFromStorage())

  // Capture the current value of every writable parameter the dashboard
  // currently knows about (i.e. every node in deviceParams whose ACCESS bit
  // 2 is set). Read-only params are deliberately skipped — they can't be
  // recalled, only observed.
  function captureSnapshot(deviceParamsMap) {
    const snapshot = {}
    let paramCount = 0
    for (const [deviceId, params] of deviceParamsMap.entries()) {
      const inner = {}
      for (const [path, node] of params.entries()) {
        const access = node.ACCESS ?? 3
        if (!(access & 2)) continue // not writable
        if (node.VALUE === undefined) continue // never observed
        inner[path] = node.VALUE
        paramCount++
      }
      if (Object.keys(inner).length > 0) snapshot[deviceId] = inner
    }
    return { snapshot, paramCount }
  }

  function add(name, deviceParamsMap) {
    const { snapshot, paramCount } = captureSnapshot(deviceParamsMap)
    const scene = {
      id: String(Date.now() + Math.random()),
      name: (name || '').trim() || `Scene ${scenes.value.length + 1}`,
      createdAt: Date.now(),
      snapshot,
      paramCount
    }
    scenes.value = [...scenes.value, scene]
    persist(scenes.value)
    return scene
  }

  function rename(id, newName) {
    scenes.value = scenes.value.map((s) =>
      s.id === id ? { ...s, name: (newName || '').trim() || s.name } : s
    )
    persist(scenes.value)
  }

  function remove(id) {
    scenes.value = scenes.value.filter((s) => s.id !== id)
    persist(scenes.value)
  }

  function overwrite(id, deviceParamsMap) {
    const { snapshot, paramCount } = captureSnapshot(deviceParamsMap)
    scenes.value = scenes.value.map((s) =>
      s.id === id
        ? { ...s, snapshot, paramCount, createdAt: Date.now() }
        : s
    )
    persist(scenes.value)
  }

  function reorder(fromIndex, toIndex) {
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || fromIndex >= scenes.value.length) return
    if (toIndex < 0 || toIndex >= scenes.value.length) return
    const arr = [...scenes.value]
    const [moved] = arr.splice(fromIndex, 1)
    arr.splice(toIndex, 0, moved)
    scenes.value = arr
    persist(scenes.value)
  }

  // Fire a scene: re-send every captured (deviceId, path, value) tuple via
  // the provided setDeviceParam callback. The server's SET_DEVICE_PARAM
  // handler then routes each one to the device's OSC port. If a device is
  // currently disconnected the message just drops into the void — that's
  // fine and matches what the user expects (it'll snap when reconnected).
  function fire(scene, setDeviceParam) {
    if (!scene || !scene.snapshot) return
    for (const [deviceIdStr, params] of Object.entries(scene.snapshot)) {
      const deviceId = Number(deviceIdStr)
      for (const [path, value] of Object.entries(params)) {
        setDeviceParam(deviceId, path, value)
      }
    }
  }

  return { scenes, add, rename, remove, overwrite, reorder, fire }
}
