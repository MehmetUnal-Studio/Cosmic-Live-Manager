<script setup>
import { computed, ref, toRef, watch } from 'vue'
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
const emit = defineEmits(['update', 'reconnect', 'set-param', 'announce', 'remove'])

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
const deviceIdRef = toRef(() => props.device.id)
const {
  presets,
  add: addPreset,
  remove: removePreset,
  update: updatePresetFn,
  reorder: reorderPreset
} = useHubPresets(deviceIdRef)

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
const storageKey = computed(() => `clm:hub-announce:${props.device.id}`)

function loadAnnounce() {
  try {
    const raw = localStorage.getItem(storageKey.value)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return { targetFqdn: '', peerId: '', udpPortOverride: 0 }
}
function persistAnnounce() {
  try {
    localStorage.setItem(storageKey.value, JSON.stringify({
      targetFqdn: targetFqdn.value,
      peerId: peerId.value,
      udpPortOverride: Number(udpOverride.value) || 0
    }))
  } catch { /* quota / disabled */ }
}

const _initial = loadAnnounce()
const targetFqdn         = ref(_initial.targetFqdn)
const peerId             = ref(_initial.peerId || sanitizePeerId(props.device.name))
const udpOverride        = ref(_initial.udpPortOverride || 0)

// Reload when the device id changes (e.g. manifest reload renumbers IDs)
watch(() => props.device.id, () => {
  const fresh = loadAnnounce()
  targetFqdn.value  = fresh.targetFqdn
  peerId.value      = fresh.peerId || sanitizePeerId(props.device.name)
  udpOverride.value = fresh.udpPortOverride || 0
})

// Persist on every change
watch([targetFqdn, peerId, udpOverride], persistAnnounce)

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
  props.device.status === 'connected' &&
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
  return props.device.status || 'configured'
})
const statusLabel = computed(() => {
  const d = props.device
  if (!d.enabled) return 'DISABLED'
  if (d.status === 'connecting') return 'CONNECTING…'
  if (d.status === 'connected') return `CONNECTED · ${d.paramCount || 0} params`
  if (d.status === 'lost') return 'CONNECTION LOST'
  return 'CONFIGURED'
})
const paramCount = computed(() => props.params.size)
</script>

<template>
  <div class="device-card" :class="statusClass">
    <button
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
        <div class="device-type">{{ device.type }}</div>
      </div>
    </div>

    <div class="device-host-row">
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

    <div class="device-footer">
      <div class="device-status-row">
        <span class="device-status-text" :class="statusClass">{{ statusLabel }}</span>
        <span v-if="msgCount > 0" class="device-msgs">{{ msgCount }}</span>
      </div>

      <div class="device-actions">
        <button
          class="hub-btn"
          :class="{ 'hub-btn-primary': device.enabled }"
          @click="toggleEnabled"
        >
          <span class="hub-btn-icon">{{ device.enabled ? '●' : '○' }}</span>
          {{ device.enabled ? 'Enabled' : 'Enable' }}
        </button>
        <button class="hub-btn" :disabled="!device.enabled" @click="emit('reconnect')">
          ⟳ Reconnect
        </button>
      </div>

      <div class="save-hint" :class="hint?.type || ''">{{ hint?.text || '' }}</div>

      <!-- ─── Presets ─── -->
      <details class="hub-presets-section" open>
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
              :title="device.status === 'connected'
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

    </div>
  </div>
</template>
