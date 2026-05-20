<script setup>
import { computed, ref } from 'vue'

// Self-contained record/playback panel that sits inside a DeviceCard.
// All the state and logic come from a useRecording() instance passed in
// as a prop — this component is purely presentation + user input.
//
// Implementation note: we destructure the refs/methods out of the prop bag
// so the template can use them as top-level variables (which Vue 3
// auto-unwraps). Accessing them as `props.rec.recording` would yield the
// raw ref object — not the value — because the prop bag is a plain object,
// not a reactive() wrapper.

const props = defineProps({
  rec: { type: Object, required: true }
})

// Refs (reactive state)
const recording             = props.rec.recording
const recordingEventCount   = props.rec.recordingEventCount
const recordingDurationMs   = props.rec.recordingDurationMs
const loaded                = props.rec.loaded
const pathHistogram         = props.rec.pathHistogram
const excludedPaths         = props.rec.excludedPaths
const filteredEventCount    = props.rec.filteredEventCount
const playing               = props.rec.playing
const playbackProgressMs    = props.rec.playbackProgressMs
const looping               = props.rec.looping

// Methods (plain functions)
const startRecording   = props.rec.startRecording
const stopRecording    = props.rec.stopRecording
const discardRecording = props.rec.discardRecording
const downloadAsJSON   = props.rec.downloadAsJSON
const loadFromFile     = props.rec.loadFromFile
const togglePathExcluded = props.rec.togglePathExcluded
const startPlayback    = props.rec.startPlayback
const stopPlayback     = props.rec.stopPlayback

const fileInputRef = ref(null)
function pickFile() {
  if (fileInputRef.value) fileInputRef.value.click()
}
async function onFileChosen(e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  try {
    await loadFromFile(file)
  } catch (err) {
    alert('Could not load recording: ' + err.message)
  } finally {
    e.target.value = ''
  }
}

function formatMs(ms) {
  if (!ms || ms < 0) return '0.0 s'
  const s = ms / 1000
  if (s < 60) return s.toFixed(1) + ' s'
  const m = Math.floor(s / 60)
  const rem = (s - m * 60).toFixed(1)
  return `${m}:${rem.padStart(4, '0')}`
}

const progressPct = computed(() => {
  const total = loaded.value?.durationMs || 0
  if (!total) return 0
  return Math.min(100, (playbackProgressMs.value / total) * 100)
})
</script>

<template>
  <details class="rec-section">
    <summary>
      <span class="rec-title">Recordings</span>
      <span class="rec-status">
        <span v-if="recording" class="rec-dot recording">●</span>
        <span v-else-if="playing" class="rec-dot playing">▶</span>
        <span v-else-if="loaded" class="rec-dot loaded">●</span>
        <span v-if="recording">
          REC · {{ recordingEventCount }} ev · {{ formatMs(recordingDurationMs) }}
        </span>
        <span v-else-if="playing">
          PLAY · {{ formatMs(playbackProgressMs) }} / {{ formatMs(loaded?.durationMs) }}
        </span>
        <span v-else-if="loaded">
          {{ loaded.eventCount }} ev · {{ formatMs(loaded.durationMs) }}
        </span>
        <span v-else class="rec-empty">no recording</span>
      </span>
    </summary>

    <div class="rec-body">
      <!-- Record controls ------------------------------------------------ -->
      <div class="rec-row">
        <button
          v-if="!recording"
          class="rec-btn rec-btn-record"
          :disabled="playing"
          @click="startRecording"
          title="Start capturing every PATH_CHANGED for this device"
        >
          <span class="rec-icon">●</span> Record
        </button>
        <button
          v-else
          class="rec-btn rec-btn-stop"
          @click="stopRecording"
          title="Stop recording — the buffer becomes the current 'loaded' recording"
        >
          <span class="rec-icon">■</span> Stop
        </button>

        <input
          ref="fileInputRef"
          type="file"
          accept="application/json,.json"
          style="display:none"
          @change="onFileChosen"
        />
        <button
          class="rec-btn"
          :disabled="recording || playing"
          @click="pickFile"
          title="Load a previously-downloaded recording JSON"
        >
          <span class="rec-icon">⬆</span> Load JSON
        </button>

        <span class="rec-spacer"></span>

        <button
          v-if="loaded"
          class="rec-btn"
          :disabled="recording || playing"
          @click="downloadAsJSON()"
          title="Download the current loaded recording as a .json file"
        >
          <span class="rec-icon">⬇</span> Download
        </button>
        <button
          v-if="loaded"
          class="rec-btn"
          :disabled="recording || playing"
          @click="discardRecording"
          title="Forget the loaded recording (does not delete the .json on disk)"
        >
          <span class="rec-icon">✕</span> Discard
        </button>
      </div>

      <!-- Loaded recording: path filter + playback ----------------------- -->
      <template v-if="loaded">
        <div class="rec-row rec-info">
          <span>
            <strong>{{ loaded.deviceName || '(unknown device)' }}</strong>
            · {{ formatMs(loaded.durationMs) }}
            · {{ loaded.eventCount }} events
            <span v-if="excludedPaths.size > 0" class="rec-filtered">
              → {{ filteredEventCount }} after filter
            </span>
          </span>
        </div>

        <div class="rec-row rec-paths">
          <span class="rec-label">Paths</span>
          <div class="rec-path-list">
            <label
              v-for="row in pathHistogram"
              :key="row.path"
              class="rec-path-row"
              :class="{ excluded: excludedPaths.has(row.path) }"
              :title="excludedPaths.has(row.path)
                ? 'Excluded from playback — click to include'
                : 'Included in playback — click to exclude (e.g. for noisy heartbeats)'"
            >
              <input
                type="checkbox"
                :checked="!excludedPaths.has(row.path)"
                :disabled="playing"
                @change="togglePathExcluded(row.path)"
              />
              <code class="rec-path">{{ row.path }}</code>
              <span class="rec-path-count">{{ row.count }}</span>
            </label>
          </div>
        </div>

        <div class="rec-row rec-playback">
          <button
            v-if="!playing"
            class="rec-btn rec-btn-play"
            :disabled="recording || filteredEventCount === 0"
            @click="startPlayback"
            :title="filteredEventCount === 0
              ? 'All paths are excluded — nothing to play'
              : 'Play back the recording in real time, preserving original gaps'"
          >
            <span class="rec-icon">▶</span> Play
          </button>
          <button
            v-else
            class="rec-btn rec-btn-stop"
            @click="stopPlayback"
          >
            <span class="rec-icon">■</span> Stop
          </button>

          <label class="rec-checkbox">
            <input type="checkbox" v-model="looping" :disabled="playing" />
            Loop
          </label>

          <div class="rec-progress" :title="formatMs(playbackProgressMs) + ' / ' + formatMs(loaded.durationMs)">
            <div class="rec-progress-bar" :style="{ width: progressPct + '%' }"></div>
          </div>
        </div>
      </template>
    </div>
  </details>
</template>

<style scoped>
.rec-section {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--hub-border, #2a2a2a);
  border-radius: 6px;
  padding: 6px 10px;
  margin-bottom: 8px;
}
.rec-section summary {
  cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.72rem; font-weight: 500;
  color: var(--hub-ink, #ddd);
  letter-spacing: 0.04em;
  list-style: none;
}
/* Match the Presets/Parameters/Announce chevron exactly so all four section
   toggles in a DeviceCard read as the same family. ▶ rotates to ▼ on open. */
.rec-section summary::-webkit-details-marker { display: none; }
.rec-section summary::before {
  content: '▶'; font-size: 13px; color: var(--hub-ink-dim, #777);
  transition: transform 0.15s;
  display: inline-block;
}
.rec-section[open] summary::before { transform: rotate(90deg); }
.rec-title { letter-spacing: 0.02em; }
.rec-status {
  font-weight: 400; font-size: 12px;
  color: var(--hub-ink-mid, #999);
  font-family: var(--mono, monospace);
  display: inline-flex; align-items: center; gap: 0.4rem;
}
.rec-dot { font-size: 0.7rem; }
.rec-dot.recording { color: var(--hub-red, #ef4444); animation: rec-pulse 1.1s ease-in-out infinite; }
.rec-dot.playing   { color: var(--hub-green, #10b981); }
.rec-dot.loaded    { color: var(--hub-ink-dim, #777); }
.rec-empty { color: var(--hub-ink-dim, #777); font-style: italic; }
@keyframes rec-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

.rec-body {
  display: flex; flex-direction: column; gap: 8px;
  padding-top: 8px;
}
.rec-row {
  display: flex; align-items: center; gap: 8px;
  flex-wrap: wrap;
}
.rec-spacer { flex: 1 1 auto; }

.rec-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px;
  background: var(--hub-surface, #1f1f1f);
  border: 1px solid var(--hub-border, #2a2a2a);
  border-radius: 4px;
  color: var(--hub-ink-mid, #999);
  font-size: 12px; cursor: pointer; user-select: none;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.rec-btn:hover:not(:disabled) {
  color: var(--hub-text, #ddd);
  background: rgba(255,255,255,0.04);
  border-color: var(--hub-border-2, #444);
}
.rec-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.rec-btn-record { color: var(--hub-red, #ef4444); border-color: rgba(239,68,68,0.4); }
.rec-btn-record:hover:not(:disabled) { background: rgba(239,68,68,0.1); }
.rec-btn-stop   { color: var(--hub-red, #ef4444); border-color: rgba(239,68,68,0.4); }
.rec-btn-play   { color: var(--hub-green, #10b981); border-color: rgba(16,185,129,0.4); }
.rec-btn-play:hover:not(:disabled) { background: rgba(16,185,129,0.1); }
.rec-icon { font-size: 10px; line-height: 1; }

.rec-info { font-size: 12px; color: var(--hub-ink-mid, #999); }
.rec-filtered { color: var(--hub-accent, #e3a857); margin-left: 6px; }

.rec-label {
  font-size: 11px; color: var(--hub-ink-dim, #777);
  width: 64px; text-transform: uppercase; letter-spacing: 0.04em;
}
.rec-paths { align-items: flex-start; }
.rec-path-list {
  display: flex; flex-direction: column; gap: 2px;
  flex: 1 1 auto; max-height: 180px; overflow-y: auto;
  background: rgba(0,0,0,0.15);
  border: 1px solid var(--hub-border, #2a2a2a);
  border-radius: 4px;
  padding: 4px;
}
.rec-path-row {
  display: flex; align-items: center; gap: 6px;
  padding: 2px 4px; border-radius: 2px;
  cursor: pointer;
  font-family: var(--mono, monospace); font-size: 11px;
  color: var(--hub-text, #ddd);
}
.rec-path-row:hover { background: rgba(255,255,255,0.04); }
.rec-path-row.excluded { color: var(--hub-ink-dim, #777); text-decoration: line-through; }
.rec-path-row input[type="checkbox"] { cursor: pointer; }
.rec-path { flex: 1 1 auto; }
.rec-path-count {
  font-size: 10px; color: var(--hub-ink-mid, #999);
  background: rgba(255,255,255,0.05);
  padding: 0 5px; border-radius: 8px; min-width: 24px; text-align: center;
}

.rec-playback { gap: 12px; }
.rec-checkbox {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; color: var(--hub-ink-mid, #999);
}
.rec-progress {
  flex: 1 1 auto; height: 6px;
  background: var(--hub-border, #2a2a2a);
  border-radius: 3px; overflow: hidden;
}
.rec-progress-bar {
  height: 100%;
  background: var(--hub-green, #10b981);
  transition: width 50ms linear;
}
</style>
