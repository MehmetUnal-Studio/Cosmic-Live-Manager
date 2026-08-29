<script setup>
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import ParameterControl from './ParameterControl.vue'
import PresetSection from './PresetSection.vue'
import RecordingPanel from './RecordingPanel.vue'
import { sanitizePeerId } from '../composables/usePeer.js'
import { useHubPresets } from '../composables/useHubPresets.js'
import { useRecording } from '../composables/useRecording.js'
import { useHub } from '../composables/useHub.js'

const props = defineProps({
  device: { type: Object, required: true },
  msgCount: { type: Number, default: 0 },
  // Map<relPath, node> — full OSCQuery nodes (TYPE, VALUE, RANGE, ACCESS, …),
  // FULL_PATH is the device-relative path (no /deviceName prefix).
  params: { type: Object, default: () => new Map() },
  hint: { type: Object, default: null },
  // Discovered Bonjour services on the LAN — feeds the Announce target picker
  services: { type: Array, default: () => [] },
  // Result of the last announce attempt, shown as a hint under the button
  announceResult: { type: Object, default: null }
})
const emit = defineEmits(['update', 'reconnect', 'set-param', 'announce', 'remove', 'save'])

function onRemove() {
  // Block accidental clicks — manifest deletion is permanent on disk.
  const ok = window.confirm(
    `Remove device "${props.device.name}"?\n\nThis deletes its manifest file. ` +
    `You can always re-add it later from Discovered on Network.`
  )
  if (ok) emit('remove')
}

// ─── Card-level expand: keep all the heavy bits hidden until the user opens
//     the card. Once open, "Parameters" and "Announce" can be toggled freely.
const expanded = ref(false)

// ─── Editable header fields ──────────────────────────────────────────────
const draftName = ref(props.device.name)
const draftHost = ref(props.device.host)
const draftPort = ref(String(props.device.oscQueryPort))

watch(() => props.device.name, (v) => { draftName.value = v })
watch(() => props.device.host, (v) => { draftHost.value = v })
watch(() => props.device.oscQueryPort, (v) => { draftPort.value = String(v) })

function isValidIp(s)   { return /^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(s) || /^[a-zA-Z0-9.\-]+$/.test(s) }
function isValidPort(s) { const n = parseInt(s, 10); return Number.isInteger(n) && n > 0 && n < 65536 }

function commitName() {
  const v = draftName.value.trim()
  if (v.length === 0) { draftName.value = props.device.name; return }
  if (!isSaved.value) return
  if (v === props.device.name) return
  emit('update', { name: v })
}
function commitHost() {
  const v = draftHost.value.trim()
  if (!isValidIp(v)) { draftHost.value = props.device.host; return }
  if (v === props.device.host) return
  emit('update', { host: v })
}
function commitPort() {
  const v = draftPort.value.trim()
  if (!isValidPort(v)) { draftPort.value = String(props.device.oscQueryPort); return }
  const n = parseInt(v, 10)
  if (n === props.device.oscQueryPort) return
  emit('update', { oscQueryPort: n })
}
function toggleEnabled() { emit('update', { enabled: !props.device.enabled }) }
const isSaved = computed(() => props.device.saved !== false && props.device.id != null)

// ─── Parameters: group by parent path ────────────────────────────────────
// Split each path into "parent" +
// "leaf" and bucket by parent. Sort alphabetically for stability.
const grouped = computed(() => {
  const out = new Map()
  for (const node of props.params.values()) {
    const p = node.FULL_PATH || ''
    const parent = p.replace(/\/[^/]*$/, '') || '/'
    if (!out.has(parent)) out.set(parent, [])
    out.get(parent).push(node)
  }
  // Sort groups + parameters
  const groups = Array.from(out.entries()).sort(([a], [b]) => a.localeCompare(b))
  for (const [, nodes] of groups) {
    nodes.sort((a, b) => (a.FULL_PATH || '').localeCompare(b.FULL_PATH || ''))
  }
  return groups
})

// Per-group collapse state. Default: every group collapsed when params
// first arrive, so the card stays compact until the user opens what they
// want. We track open groups instead of closed ones so newly-discovered
// groups are collapsed by default.
const openGroups = ref(new Set())
function toggleGroup(name) {
  const next = new Set(openGroups.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  openGroups.value = next
}

// Per-parameter flash on value change. Keeps a Set of paths that recently
// updated; each entry auto-clears after FLASH_MS.
const FLASH_MS = 350
const flashed = ref(new Set())
const flashTimers = new Map()
function flashPath(p) {
  const next = new Set(flashed.value)
  next.add(p)
  flashed.value = next
  clearTimeout(flashTimers.get(p))
  flashTimers.set(p, setTimeout(() => {
    const n2 = new Set(flashed.value)
    n2.delete(p)
    flashed.value = n2
  }, FLASH_MS))
}
watch(() => props.params, (m, prev) => {
  if (!prev) return
  for (const [path, node] of m.entries()) {
    const old = prev.get(path)
    if (!old) continue
    if (JSON.stringify(old.VALUE) !== JSON.stringify(node.VALUE)) flashPath(path)
  }
}, { deep: true })

function onParamSet(payload) {
  // ParameterControl emits { path, value } where path is the device-RELATIVE
  // path (because we passed it the node with that FULL_PATH). Forward
  // upstream — the parent relays to useHub.setDeviceParam(deviceId, ...).
  emit('set-param', payload)
}

// ─── Presets ─────────────────────────────────────────────────────────────
// Per-device preset list (localStorage, scoped by device.id). Firing a
// preset just re-emits 'set-param' with the stored {path, value} — same
// pipeline as a widget edit, so the optimistic update + Ableton forward +
// dashboard broadcast all happen identically.
const storageIdentityRef = toRef(() => props.device.canonicalId || props.device.id)

function migrateScopedStorage(prefix) {
  if (!props.device.canonicalId || props.device.id == null) return
  try {
    const canonicalKey = `${prefix}${props.device.canonicalId}`
    const candidates = [props.device.id, ...(props.device.legacyIds || [])]
    if (prefix === 'clm:hub-presets:') {
      const merged = []
      const seen = new Set()
      for (const key of [canonicalKey, ...candidates.map((legacyId) => `${prefix}${legacyId}`)]) {
        const raw = localStorage.getItem(key)
        if (raw == null) continue
        let values
        try { values = JSON.parse(raw) } catch { continue }
        if (!Array.isArray(values)) continue
        for (const value of values) {
          const signature = JSON.stringify([value?.id, value?.name, value?.path, value?.value])
          if (seen.has(signature)) continue
          seen.add(signature)
          merged.push(value)
        }
      }
      if (merged.length > 0) localStorage.setItem(canonicalKey, JSON.stringify(merged))
      return
    }
    if (localStorage.getItem(canonicalKey) != null) return
    for (const legacyId of candidates) {
      const value = localStorage.getItem(`${prefix}${legacyId}`)
      if (value == null) continue
      localStorage.setItem(canonicalKey, value)
      return
    }
  } catch { /* storage unavailable */ }
}

migrateScopedStorage('clm:hub-presets:')
migrateScopedStorage('clm:hub-announce:')
const {
  presets,
  add: addPreset,
  remove: removePreset,
  update: updatePresetFn,
  reorder: reorderPreset
} = useHubPresets(storageIdentityRef)

// ─── Recording / playback panel ───────────────────────────────────────
// Mounts inside the device card so each device has its own buffer + UI.
// We pull `onPathChange` (for capturing) and `setDeviceParam` (for playback
// dispatch) from useHub. The deviceName getter is intentionally a closure
// so renames are reflected at save time without re-subscribing.
const { onPathChange, setDeviceParam } = useHub()
const recording = useRecording(
  props.device.id,
  onPathChange,
  setDeviceParam,
  () => props.device.name
)

// ─── Live activity dot ───────────────────────────────────────────────────
// Lights up whenever a PATH_CHANGED arrives for this specific device. The
// listener re-fires on a continuous stream, so we latch the flag on with a
// timer that gets renewed on every event — a steady stream keeps it glowing.
const msgActive = ref(false)
let msgActiveTimer = null
let stopMsgListener = null
onMounted(() => {
  stopMsgListener = onPathChange((deviceId) => {
    if (deviceId !== props.device.id) return
    msgActive.value = true
    if (msgActiveTimer) clearTimeout(msgActiveTimer)
    msgActiveTimer = setTimeout(() => { msgActive.value = false }, 180)
  })
})
onBeforeUnmount(() => {
  if (msgActiveTimer) clearTimeout(msgActiveTimer)
  if (stopMsgListener) stopMsgListener()
  for (const timer of flashTimers.values()) clearTimeout(timer)
  flashTimers.clear()
  recording.dispose()
})

// PresetSection wants a flat object { [path]: node }. We have a Map; convert
// once here. Lightweight enough to compute on every params change.
const flatObj = computed(() => {
  const o = {}
  for (const [path, node] of props.params.entries()) o[path] = node
  return o
})

function onPresetFire(p) {
  emit('set-param', { path: p.path, value: p.value })
}
function onPresetAdd(payload)             { addPreset(payload) }
function onPresetRemove(id)               { removePreset(id) }
function onPresetUpdate(id, patch)        { updatePresetFn(id, patch) }
function onPresetReorder({ from, to })    { reorderPreset(from, to) }

// ─── Announce section ───────────────────────────────────────────────────
// Per-device persistence in localStorage. The mapping says "device <id> wants
// to announce itself to <target fqdn>, using <peerId> and optionally
// <udpPortOverride>". On Push we resolve the target via the Bonjour services
// list and emit('announce') so the parent sends ANNOUNCE_DEVICE to the hub.

const announceOpen = ref(false)
const storageKey = computed(() => `clm:hub-announce:${props.device.canonicalId || props.device.id}`)

function loadAnnounce() {
  try {
    const raw = localStorage.getItem(storageKey.value)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return { targetFqdn: '', peerId: '' }
}
function persistAnnounce() {
  try {
    // Note: udpPortOverride is INTENTIONALLY not persisted. We want every
    // fresh page load (and every freshly-added device) to start with the
    // default UDP port (0 = use device's HOST_INFO.OSC_PORT). It's an
    // override knob, not a sticky preference.
    localStorage.setItem(storageKey.value, JSON.stringify({
      targetFqdn: targetFqdn.value,
      peerId: peerId.value
    }))
  } catch { /* quota / disabled */ }
}

const _initial = loadAnnounce()
const targetFqdn         = ref(_initial.targetFqdn)
const peerId             = ref(_initial.peerId || sanitizePeerId(props.device.name))
// Always starts at 0 (= "use device default") on every mount / reload.
const udpOverride        = ref(0)

// Reload when the device id changes (e.g. manifest reload renumbers IDs)
watch(() => props.device.id, () => {
  const fresh = loadAnnounce()
  targetFqdn.value  = fresh.targetFqdn
  peerId.value      = fresh.peerId || sanitizePeerId(props.device.name)
  udpOverride.value = 0
})

// Persist only the sticky fields. udpOverride is in-session-only — see
// persistAnnounce comment.
watch([targetFqdn, peerId], persistAnnounce)

// Target list = every discovered service except this device itself.
const targetCandidates = computed(() => {
  return props.services.filter((s) => {
    // Skip if the discovered service matches THIS device's host:port
    if (s.address === props.device.host && Number(s.port) === Number(props.device.oscQueryPort)) return false
    return true
  })
})
const selectedTarget = computed(() => targetCandidates.value.find((s) => s.fqdn === targetFqdn.value))

const canPush = computed(() =>
  (props.device.connectionState === 'Connected' || props.device.status === 'connected') &&
  !!selectedTarget.value &&
  !!peerId.value
)
const announceSummary = computed(() => {
  if (!targetFqdn.value) return 'no target'
  const t = selectedTarget.value
  const tname = t ? t.name : '(target gone)'
  return `${peerId.value || props.device.name} → ${tname}`
})
function onPush() {
  if (!canPush.value) return
  emit('announce', {
    target: selectedTarget.value,
    peerId: sanitizePeerId(peerId.value),
    udpPortOverride: Number(udpOverride.value) || 0
  })
}
// Reset the Peer ID field to the auto-derived value (sanitized device name).
// Useful when localStorage has a stale value left over from a previous device
// name — manual edits get overwritten only when the user explicitly clicks.
function onResetPeerId() {
  peerId.value = sanitizePeerId(props.device.name)
}
// Note: auto-push-on-connect was intentionally removed — the user wants
// LINK pushes to stay manual. The Push button is the only trigger.

// ─── Status visuals ─────────────────────────────────────────────────────
const statusClass = computed(() => {
  if (!props.device.enabled) return 'disabled'
  return String(props.device.connectionState || props.device.status || 'Discovered').toLowerCase()
})
const statusLabel = computed(() => {
  const d = props.device
  if (!d.enabled) return 'DISABLED'
  const state = d.connectionState || d.status
  if (state === 'Connecting' || state === 'connecting') return 'CONNECTING…'
  if (state === 'Connected' || state === 'connected') return `CONNECTED · ${d.paramCount || 0} params`
  if (state === 'Unavailable' || state === 'lost' || state === 'unavailable') return 'UNAVAILABLE'
  if (state === 'Error' || state === 'error') return 'CONNECTION FAILED'
  if (state === 'Disabled' || state === 'disabled') return 'DISABLED'
  return 'DISCOVERED'
})
const connectionLabel = computed(() => {
  if (props.device.locationLabel) return props.device.locationLabel
  const port = props.device.activeEndpoint?.port || props.device.port || props.device.oscQueryPort
  return `${props.device.serviceName || props.device.name} · Port ${port}`
})
const paramCount = computed(() => props.params.size)
</script>

<template>
  <div class="device-card" :class="statusClass">
    <button
      v-if="isSaved"
      class="device-remove"
      type="button"
      title="Remove this device"
      aria-label="Remove device"
      @click.stop="onRemove"
      @pointerdown.stop
    >×</button>

    <div class="device-header">
      <div style="min-width:0;flex:1">
        <div class="device-name-row">
          <div class="device-status-dot"></div>
          <input
            class="device-name-input"
            v-model="draftName"
            @blur="commitName"
            @keydown.enter.prevent="$event.target.blur()"
            spellcheck="false"
          />
        </div>
        <div class="device-type">{{ device.deviceType || device.type }}</div>
      </div>
    </div>

    <div class="device-connection-summary">{{ connectionLabel }}</div>

    <details class="device-technical-details">
      <summary>Details</summary>
      <div v-if="isSaved" class="device-host-row">
        <span class="host-label">HOST</span>
        <input
          class="device-host-input"
          v-model="draftHost"
          @blur="commitHost"
          @keydown.enter.prevent="$event.target.blur()"
          spellcheck="false"
        />
        <span class="host-sep">:</span>
        <input
          class="device-port-input"
          v-model="draftPort"
          @blur="commitPort"
          @keydown.enter.prevent="$event.target.blur()"
          spellcheck="false"
        />
      </div>
      <div class="device-alias-list">
        <div v-for="endpoint in device.endpoints || []" :key="`${endpoint.host}:${endpoint.port}`">
          {{ endpoint.host }}:{{ endpoint.port }}
          <span>{{ endpoint.available === false ? 'stale' : endpoint.source }}</span>
        </div>
      </div>
      <div class="device-canonical-id">{{ device.canonicalId }}</div>
    </details>

    <div class="device-footer">
      <div class="device-status-row">
        <span class="device-status-text" :class="statusClass">{{ statusLabel }}</span>
        <span v-if="msgCount > 0" class="device-msgs">
          <span
            class="msg-activity-dot"
            :class="{ active: msgActive }"
            title="Lights up on each incoming OSC message"
          ></span>
          {{ msgCount }}
        </span>
      </div>

      <div class="device-actions">
        <button
          v-if="isSaved"
          class="hub-btn"
          :class="{ 'hub-btn-primary': device.enabled }"
          @click="toggleEnabled"
        >
          <span class="hub-btn-icon">{{ device.enabled ? '●' : '○' }}</span>
          {{ device.enabled ? 'Enabled' : 'Enable' }}
        </button>
        <button v-if="isSaved" class="hub-btn" :disabled="!device.enabled" @click="emit('reconnect')">
          ⟳ Tekrar Dene
        </button>
        <button v-else class="hub-btn hub-btn-primary" @click="emit('save', draftName)">
          + Save Device
        </button>
      </div>

      <div v-if="device.error" class="device-error-text">{{ device.error }}</div>

      <div class="save-hint" :class="hint?.type || ''">{{ hint?.text || '' }}</div>

      <template v-if="isSaved">
      <!-- ─── Presets ─── -->
      <details class="hub-presets-section">
        <summary>
          Presets
          <span v-if="presets.length" class="hub-presets-count">{{ presets.length }}</span>
        </summary>
        <PresetSection
          :presets="presets"
          :flat="flatObj"
          @add="onPresetAdd"
          @remove="onPresetRemove"
          @update="onPresetUpdate"
          @reorder="onPresetReorder"
          @fire="onPresetFire"
        />
      </details>

      <!-- ─── Parameters (grouped, with widgets) ─── -->
      <div class="device-params-bar">
        <button
          class="params-toggle-btn"
          :class="{ open: expanded }"
          @click="expanded = !expanded"
        >
          <span style="display:flex;align-items:center;gap:0.5rem">
            <span class="hub-chevron">▶</span>
            Parameters
          </span>
          <span class="params-count-badge">{{ paramCount }}</span>
        </button>

        <div class="device-params-list" :class="{ open: expanded }">
          <div v-if="paramCount === 0" class="hub-empty-row">
            No parameters yet. Enable the device to fetch its namespace.
          </div>
          <div v-else class="hub-tree-groups">
            <div
              v-for="[groupPath, nodes] in grouped"
              :key="groupPath"
              class="hub-group-section"
              :class="{ open: openGroups.has(groupPath) }"
            >
              <button class="hub-group-header" @click="toggleGroup(groupPath)">
                <span class="hub-group-chevron">{{ openGroups.has(groupPath) ? '▼' : '▶' }}</span>
                <span class="hub-group-path">{{ groupPath }}</span>
                <span class="hub-group-count">{{ nodes.length }}</span>
              </button>
              <div v-show="openGroups.has(groupPath)" class="hub-tree">
                <template v-for="node in nodes" :key="node.FULL_PATH">
                  <div
                    class="hub-tree-path"
                    :class="{ flash: flashed.has(node.FULL_PATH) }"
                    :title="node.FULL_PATH"
                  >
                    {{ node.DESCRIPTION || node.FULL_PATH.split('/').pop() }}
                  </div>
                  <ParameterControl
                    :node="node"
                    :flashing="flashed.has(node.FULL_PATH)"
                    @set="onParamSet"
                  />
                  <div class="hub-tree-meta">
                    {{ node.TYPE }}<span v-if="node.UNIT"> · {{ node.UNIT }}</span>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ─── LINK (peer announce) ─── -->
      <div class="hub-announce">
        <button
          class="hub-announce-toggle"
          :class="{ open: announceOpen }"
          @click="announceOpen = !announceOpen"
        >
          <span style="display:flex;align-items:center;gap:0.5rem">
            <span class="hub-chevron">▶</span>
            LINK
          </span>
          <span class="announce-summary">{{ announceSummary }}</span>
        </button>
        <div v-show="announceOpen" class="hub-announce-body">
          <div class="hub-announce-row">
            <label>Target</label>
            <select v-model="targetFqdn">
              <option value="">— pick destination —</option>
              <option v-for="s in targetCandidates" :key="s.fqdn" :value="s.fqdn">
                {{ s.name }} ({{ s.address }}:{{ s.port }})
              </option>
            </select>
          </div>
          <div class="hub-announce-row">
            <label>Peer ID</label>
            <input
              v-model="peerId"
              placeholder="announce as…"
              spellcheck="false"
              title="Written to TARGET's /system/peer/peer_id"
            />
            <button
              class="hub-peerid-reset"
              type="button"
              :disabled="peerId === sanitizePeerId(device.name)"
              @click="onResetPeerId"
              :title="`Reset to device name: ${sanitizePeerId(device.name)}`"
            >↺</button>
          </div>
          <div class="hub-announce-row">
            <label>UDP override</label>
            <input
              v-model.number="udpOverride"
              type="number"
              min="0"
              max="65535"
              placeholder="0 = use device OSC port"
              title="Override the announced UDP port. 0 = use HOST_INFO.OSC_PORT or OSCQuery port."
            />
            <span class="hub-announce-hint">0 = use device's OSC port</span>
          </div>
          <div class="hub-announce-row hub-announce-actions">
            <button
              class="hub-btn hub-btn-primary"
              :disabled="!canPush"
              @click="onPush"
              :title="device.connectionState === 'Connected' || device.status === 'connected'
                ? 'Send /system/peer/* + connect to target'
                : 'Device must be connected'"
            >
              Push
            </button>
            <span class="announce-result" :class="announceResult?.ok ? 'ok' : (announceResult ? 'err' : '')">
              <template v-if="announceResult?.ok">✓ {{ announceResult.summary }}</template>
              <template v-else-if="announceResult">✗ {{ announceResult.error }}</template>
            </span>
          </div>
          <div class="hub-announce-hint hub-announce-meta">
            Writes <code>/system/peer/{peer_id, host, oscquery_port, udp_port}</code>
            to target, then bangs <code>/system/peer/connect</code>.
          </div>
        </div>
      </div>

      <!-- ─── Recordings (record / playback per device) ─── -->
      <RecordingPanel :rec="recording" />
      </template>

    </div>
  </div>
</template>
