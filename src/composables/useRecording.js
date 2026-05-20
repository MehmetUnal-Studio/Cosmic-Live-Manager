import { computed, ref } from 'vue'

// Per-device parameter-stream recording + playback.
//
// Two phases:
//
//   RECORD  - we subscribe to incoming PATH_CHANGED events for the device
//             via useHub().onPathChange and stack them in a buffer with a
//             millisecond timestamp relative to the moment Record was hit.
//
//   PLAYBACK - we walk the buffer and schedule a setValue back to the
//              device at each event's relative time (so a 5-second gesture
//              plays back as 5 seconds). User can filter out noisy paths
//              (e.g. /heartbeat) before pressing Play.
//
// The recording lives entirely in-memory until the user downloads it as JSON.
// On the next page load there's nothing to restore — by design (the user
// chose the "manual file" workflow over auto-persistence).
//
// JSON schema (version 1):
// {
//   "version":     1,
//   "kind":        "clm-recording",
//   "deviceId":    <number, informational only — replay targets whichever
//                   device the panel is mounted on>,
//   "deviceName":  <string, informational>,
//   "recordedAt":  <ISO 8601 string>,
//   "durationMs":  <number>,
//   "eventCount":  <number>,
//   "events":      [{ "t": <ms-from-start>, "path": "/rel", "value": <any> }, ...]
// }

/**
 * @param {number}   deviceId            id of the device this recorder is tied to
 * @param {Function} onPathChange        useHub().onPathChange — returns an unsub fn
 * @param {Function} setDeviceParam      useHub().setDeviceParam(deviceId, path, value)
 * @param {Function} getCurrentDeviceName () => current device name (lazy, so renames are reflected at save time)
 */
export function useRecording(deviceId, onPathChange, setDeviceParam, getCurrentDeviceName) {
  // ─── Recording state ──────────────────────────────────────────────────
  const recording = ref(false)
  const recordingEventCount = ref(0)
  const recordingDurationMs = ref(0)
  let recordBuffer = []
  let recordStart = 0
  let durationTimer = null
  let unsubscribe = null

  function startRecording() {
    if (recording.value) return
    recordBuffer = []
    recordingEventCount.value = 0
    recordingDurationMs.value = 0
    recordStart = performance.now()

    // Subscribe to every path-changed event filtered to THIS device.
    unsubscribe = onPathChange((evDeviceId, relPath, value /*, paramType */) => {
      if (evDeviceId !== deviceId) return
      recordBuffer.push({
        t: Math.round(performance.now() - recordStart),
        path: relPath,
        value: value
      })
      recordingEventCount.value = recordBuffer.length
    })

    // Tick the "live duration" counter so the UI shows elapsed time.
    durationTimer = setInterval(() => {
      recordingDurationMs.value = Math.round(performance.now() - recordStart)
    }, 100)

    recording.value = true
  }

  function stopRecording() {
    if (!recording.value) return null
    if (unsubscribe) {
      try { unsubscribe() } catch {}
      unsubscribe = null
    }
    if (durationTimer) {
      clearInterval(durationTimer)
      durationTimer = null
    }
    const finalDuration = Math.round(performance.now() - recordStart)
    recordingDurationMs.value = finalDuration
    recording.value = false

    // Promote the in-memory buffer to a "loaded" recording so the user can
    // immediately filter + play it back without going through a download/upload
    // round-trip. The download is offered as an additional action.
    const rec = buildRecording(recordBuffer, finalDuration)
    setLoaded(rec)
    return rec
  }

  function discardRecording() {
    if (recording.value) {
      stopRecording()
    }
    recordBuffer = []
    recordingEventCount.value = 0
    recordingDurationMs.value = 0
    setLoaded(null)
  }

  // ─── Loaded recording (in-memory snapshot, either just-stopped or uploaded) ──
  const loaded = ref(null)        // <-- full recording object, see schema above
  const pathHistogram = ref([])   // [{ path, count }] computed from loaded.events
  const excludedPaths = ref(new Set())

  function setLoaded(rec) {
    loaded.value = rec
    excludedPaths.value = new Set()
    if (rec) {
      const counts = new Map()
      for (const ev of rec.events) counts.set(ev.path, (counts.get(ev.path) || 0) + 1)
      pathHistogram.value = Array.from(counts.entries())
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count)
    } else {
      pathHistogram.value = []
    }
  }

  function togglePathExcluded(path) {
    const next = new Set(excludedPaths.value)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    excludedPaths.value = next
  }

  const filteredEventCount = computed(() => {
    if (!loaded.value) return 0
    if (excludedPaths.value.size === 0) return loaded.value.events.length
    let n = 0
    for (const ev of loaded.value.events) if (!excludedPaths.value.has(ev.path)) n++
    return n
  })

  // ─── Helpers ──────────────────────────────────────────────────────────
  function buildRecording(events, durationMs) {
    return {
      version: 1,
      kind: 'clm-recording',
      deviceId,
      deviceName: getCurrentDeviceName ? getCurrentDeviceName() : '',
      recordedAt: new Date().toISOString(),
      durationMs,
      eventCount: events.length,
      events: events.slice()
    }
  }

  function downloadAsJSON(filenameHint) {
    if (!loaded.value) return
    const json = JSON.stringify(loaded.value, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const safeName = (filenameHint || loaded.value.deviceName || 'recording')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
    a.download = `clm-recording-${safeName}-${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function loadFromFile(file) {
    if (!file) return null
    const text = await file.text()
    const parsed = JSON.parse(text)
    if (parsed.kind !== 'clm-recording' || !Array.isArray(parsed.events)) {
      throw new Error('Not a Cosmic Live Manager recording (missing kind/events).')
    }
    setLoaded(parsed)
    return parsed
  }

  // ─── Playback ─────────────────────────────────────────────────────────
  const playing = ref(false)
  const playbackProgressMs = ref(0)
  const looping = ref(false)
  let playbackTimers = []
  let playbackStart = 0
  let progressTimer = null

  function startPlayback() {
    if (playing.value || !loaded.value) return
    const events = loaded.value.events.filter((ev) => !excludedPaths.value.has(ev.path))
    if (events.length === 0) return

    playing.value = true
    playbackProgressMs.value = 0
    playbackStart = performance.now()

    // Schedule each event with a setTimeout. For very long recordings or
    // many events this is fine — browsers handle thousands of timers without
    // issue, and we trade a bit of memory for precise timing per event.
    playbackTimers = events.map((ev) =>
      setTimeout(() => {
        try {
          setDeviceParam(deviceId, ev.path, ev.value)
        } catch (err) {
          // Best-effort: keep playing even if one set fails (e.g. path missing)
          console.warn('[recording] setDeviceParam failed:', err)
        }
      }, ev.t)
    )

    // End-of-recording cleanup, loop if requested.
    const totalDuration = loaded.value.durationMs
    playbackTimers.push(
      setTimeout(() => {
        finishPlayback()
        if (looping.value) startPlayback()
      }, totalDuration + 20) // small grace
    )

    // Live progress tick for the UI bar.
    progressTimer = setInterval(() => {
      playbackProgressMs.value = Math.round(performance.now() - playbackStart)
    }, 50)
  }

  function stopPlayback() {
    if (!playing.value) return
    for (const t of playbackTimers) clearTimeout(t)
    playbackTimers = []
    if (progressTimer) {
      clearInterval(progressTimer)
      progressTimer = null
    }
    playing.value = false
    playbackProgressMs.value = 0
  }

  function finishPlayback() {
    for (const t of playbackTimers) clearTimeout(t)
    playbackTimers = []
    if (progressTimer) {
      clearInterval(progressTimer)
      progressTimer = null
    }
    playing.value = false
    playbackProgressMs.value = loaded.value ? loaded.value.durationMs : 0
  }

  // ─── Public API ───────────────────────────────────────────────────────
  return {
    // record
    recording,
    recordingEventCount,
    recordingDurationMs,
    startRecording,
    stopRecording,
    discardRecording,

    // loaded recording + filtering
    loaded,
    pathHistogram,
    excludedPaths,
    filteredEventCount,
    togglePathExcluded,
    downloadAsJSON,
    loadFromFile,

    // playback
    playing,
    playbackProgressMs,
    looping,
    startPlayback,
    stopPlayback
  }
}
