<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import ParameterControl from './ParameterControl.vue'
import PresetSection from './PresetSection.vue'
import RecordingPanel from './RecordingPanel.vue'
import { sanitizePeerId } from '../composables/usePeer.js'
import { useHubPresets } from '../composables/useHubPresets.js'
import { useRecording } from '../composables/useRecording.js'
import { useHub } from '../composables/useHub.js'
import {
  findLinkTargetByFqdn,
  isAbletonRingReceiverDevice,
  isCosmicRingReceiverDevice,
  isCosmicUnityOrAbletonDevice,
  isMaxRingIdentity,
  isMaxRingReceiverDevice,
  isRingInstrumentIdentity
} from '../utils/linkTargets.js'
import { MAX_RING_DEFAULT_UDP_PORT } from '../../shared/maxRingLink.js'
import {
  planScopedStorageMigration,
  scopedStorageMigrationKeys,
  STORAGE_MIGRATION_KINDS
} from '../utils/storageMigration.js'

const props = defineProps({
  device: { type: Object, required: true },
  msgCount: { type: Number, default: 0 },
  // Map<relPath, node> — full OSCQuery nodes (TYPE, VALUE, RANGE, ACCESS, …),
  // FULL_PATH is the device-relative path (no /deviceName prefix).
  params: { type: Object, default: () => new Map() },
  hint: { type: Object, default: null },
  // Parent-filtered Bonjour services allowed by the LINK topology.
  services: { type: Array, default: () => [] },
  // Raw services that are definitively incompatible with this source device.
  // Unknown/offline targets are omitted so sticky selections survive reconnects.
  disallowedTargetFqdns: { type: Array, default: () => [] },
  // Result of the last announce attempt, shown as a hint under the button
  announceResult: { type: Object, default: null }
})
const emit = defineEmits(['update', 'reconnect', 'set-param', 'announce', 'clear-link', 'remove', 'save'])

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

// ─── Whole-card collapse (minimal UI) ───────────────────────────────────
// The compact header carries identity + status + LINK health; everything
// else (host row, actions, presets, params, LINK panel, recordings) lives
// in a body that opens on demand. Open state persists per device so a
// reload lands on the same layout.
const CARD_OPEN_KEY = 'clm:hub-card-open'
function loadCardOpenMap() {
  try { return JSON.parse(localStorage.getItem(CARD_OPEN_KEY) || '{}') || {} } catch { return {} }
}
const cardOpenKey = computed(() => String(props.device.canonicalId || props.device.id))
const cardOpen = ref(!!loadCardOpenMap()[String(props.device.canonicalId || props.device.id)])
function toggleCardOpen() {
  cardOpen.value = !cardOpen.value
  try {
    const all = loadCardOpenMap()
    if (cardOpen.value) all[cardOpenKey.value] = true
    else delete all[cardOpenKey.value]
    localStorage.setItem(CARD_OPEN_KEY, JSON.stringify(all))
  } catch { /* storage unavailable */ }
}

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
// ─── Enable/Disable with pending state (F2-7) ───────────────────────────
// The old handler computed `!props.device.enabled` from props that only
// refresh after the server round-trip — a quick double-tap re-sent the
// first tap's value. Route through the state layer's setDeviceEnabled
// (desired-state semantics + pending tracking) and lock the button while
// the request is in flight.
const localEnablePending = ref(false)
let enableTimer = null
// The state layer tracks in-flight toggles in `pendingToggles`
// (Map<deviceId, { desired, requestedAt }>) and clears them on the
// DEVICE_UPDATED ack or a timeout. Fall back to a local lock if absent.
const enablePending = computed(() => {
  const pt = hubApi.pendingToggles?.value
  if (pt && typeof pt.has === 'function') return pt.has(props.device.id)
  return localEnablePending.value
})
const pendingDesired = computed(() => {
  const pt = hubApi.pendingToggles?.value
  const entry = pt && typeof pt.get === 'function' ? pt.get(props.device.id) : null
  return entry ? entry.desired : null
})
function toggleEnabled() {
  if (enablePending.value) return
  const desired = !props.device.enabled
  const fn = hubApi.setDeviceEnabled
  if (typeof fn === 'function') {
    fn(props.device.id, desired) // pendingToggles drives the button lock
    return
  }
  // State layer not present — legacy path via the parent, local lock.
  localEnablePending.value = true
  clearTimeout(enableTimer)
  enableTimer = setTimeout(() => { localEnablePending.value = false }, 2500)
  emit('update', { enabled: desired })
}
// Server ack (DEVICE_UPDATED) reflects into props — release the local lock.
watch(() => props.device.enabled, () => {
  clearTimeout(enableTimer)
  localEnablePending.value = false
})
const isSaved = computed(() => props.device.saved !== false && props.device.id != null)

// ─── Identity collision surfacing (F2-3) ────────────────────────────────
// The registry forks a scoped `:port:` identity when two instances share a
// cloned persistent UUID and marks it via identitySource. The fix path is
// on the plugin ("Yeni ID"), so tell the operator exactly that.
const COLLISION_SOURCES = new Set([
  'persistent-id-port-collision',
  'persistent-id-remote-collision'
])
const identityCollision = computed(() => COLLISION_SOURCES.has(props.device.identitySource))
const collisionEndpoints = computed(() =>
  (props.device.endpoints || []).map((ep) => `${ep.host}:${ep.port}`)
)

// ─── Reachability (server-side liveness probe) ──────────────────────────
// 'silent' = link is up but the device has gone mute; 'dead' = probe failed.
const reachability = computed(() => props.device.reachability || null)

// ─── Cheap params reactivity (pairs with the state layer's R9 work) ─────
// When deviceParams becomes a shallowRef Map mutated in place, props.params
// keeps its identity across updates. The state layer bumps a per-device
// deviceParamsVersion instead; depending on it here means only THIS card
// recomputes when its own params change. Defensive across shapes:
// Map<id, Ref<number>>, Map<id, number>, or a single counter ref.
const paramsRev = computed(() => {
  // Preferred: lazily-created per-device version ref from the state layer.
  if (typeof hubApi.paramsVersionFor === 'function') {
    const r = hubApi.paramsVersionFor(props.device.id)
    return (r && typeof r === 'object' && 'value' in r) ? r.value : (Number(r) || 0)
  }
  // Fallback: global counter (coarser, still correct).
  const dpv = hubApi.deviceParamsVersion
  if (!dpv) return 0
  const raw = (typeof dpv === 'object' && 'value' in dpv) ? dpv.value : dpv
  return Number(raw) || 0
})

// ─── Parameters: group by parent path ────────────────────────────────────
// Split each path into "parent" +
// "leaf" and bucket by parent. Sort alphabetically for stability.
const grouped = computed(() => {
  void paramsRev.value // dependency: in-place Map mutations bump this
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
// Flash marking now hangs off the exact PATH_CHANGED event (see the
// onPathChange listener below) instead of a deep JSON.stringify watch over
// every param per message — zero diffing, and it pauses while the
// Dashboard page is hidden (v-show'd away during a performance).

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
const PRESET_STORAGE_PREFIX = 'clm:hub-presets:'
const ANNOUNCE_STORAGE_PREFIX = 'clm:hub-announce:'
let reloadPresets = () => {}

function migrateScopedStorage(prefix, kind) {
  if (!props.device.canonicalId || props.device.id == null) return
  try {
    const migration = {
      prefix,
      canonicalId: props.device.canonicalId,
      manifestId: props.device.id,
      legacyCanonicalIds: props.device.legacyCanonicalIds || [],
      legacyIds: props.device.legacyIds || []
    }
    const { canonicalKey, lineageKey, sources } = scopedStorageMigrationKeys(migration)
    const values = new Map([
      [canonicalKey, localStorage.getItem(canonicalKey)],
      [lineageKey, localStorage.getItem(lineageKey)]
    ])
    for (const { key, markerKey, lineageKey: sourceLineageKey } of sources) {
      values.set(key, localStorage.getItem(key))
      values.set(markerKey, localStorage.getItem(markerKey))
      values.set(sourceLineageKey, localStorage.getItem(sourceLineageKey))
    }
    const plan = planScopedStorageMigration({ ...migration, kind, values })
    for (const write of plan.writes) localStorage.setItem(write.key, write.value)
  } catch { /* storage unavailable */ }
}

function migrateDeviceScopedStorage() {
  migrateScopedStorage(PRESET_STORAGE_PREFIX, STORAGE_MIGRATION_KINDS.PRESETS)
  migrateScopedStorage(ANNOUNCE_STORAGE_PREFIX, STORAGE_MIGRATION_KINDS.SCALAR)
  // Alias-only registry updates do not change storageIdentityRef, so the
  // preset composable's normal identity watcher would not reload the just-
  // migrated canonical data. Keep its live ref synchronized immediately.
  reloadPresets()
}

watch(
  [
    () => props.device.id,
    () => props.device.canonicalId,
    () => JSON.stringify(props.device.legacyCanonicalIds || []),
    () => JSON.stringify(props.device.legacyIds || [])
  ],
  migrateDeviceScopedStorage,
  { immediate: true }
)
const {
  presets,
  add: addPreset,
  remove: removePreset,
  update: updatePresetFn,
  reorder: reorderPreset,
  reload: reloadPresetStorage
} = useHubPresets(storageIdentityRef)
reloadPresets = reloadPresetStorage

// ─── Recording / playback panel ───────────────────────────────────────
// Mounts inside the device card so each device has its own buffer + UI.
// We pull `onPathChange` (for capturing) and `setDeviceParam` (for playback
// dispatch) from useHub. The deviceName getter is intentionally a closure
// so renames are reflected at save time without re-subscribing.
const hubApi = useHub()
const { onPathChange, setDeviceParam } = hubApi
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
// Injected from App.vue — false while the operator is on the Performance
// page. Both pages stay mounted (v-show), so cosmetic per-message work
// (activity dot, value flashes) must pause when this card isn't on screen.
const dashboardVisible = inject('dashboardVisible', ref(true))
onMounted(() => {
  stopMsgListener = onPathChange((deviceId, relPath) => {
    if (deviceId !== props.device.id) return
    if (!dashboardVisible.value) return
    msgActive.value = true
    if (msgActiveTimer) clearTimeout(msgActiveTimer)
    msgActiveTimer = setTimeout(() => { msgActive.value = false }, 180)
    // Value flash — only pay for it while the params list can be seen.
    if (cardOpen.value && expanded.value && relPath) flashPath(relPath)
  })
})
onBeforeUnmount(() => {
  if (msgActiveTimer) clearTimeout(msgActiveTimer)
  if (stopMsgListener) stopMsgListener()
  for (const timer of flashTimers.values()) clearTimeout(timer)
  flashTimers.clear()
  clearInterval(nowTimer)
  recording.dispose()
})

// PresetSection wants a flat object { [path]: node }. We have a Map; convert
// once here. Lightweight enough to compute on every params change.
const flatObj = computed(() => {
  void paramsRev.value
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
// Per-device persistence in localStorage. On a CosmicUnity card, the selected
// Android or generic OSCQuery service is the instrument peer; Push writes that
// peer's coordinates to this VST. The server also accepts the external-device
// card direction and resolves both UI shapes to the same asymmetric bootstrap.

const announceOpen = ref(false)
const storageKey = computed(() => `${ANNOUNCE_STORAGE_PREFIX}${props.device.canonicalId || props.device.id}`)
const isMaxRingReceiver = computed(() => isMaxRingReceiverDevice(props.device))
const isCosmicRingReceiver = computed(() => isCosmicRingReceiverDevice(props.device))
const isFixedRingReceiver = computed(() => isAbletonRingReceiverDevice(props.device))
const isRingInstrumentPeer = computed(() => isRingInstrumentIdentity(props.device))
const defaultUdpOverride = () => isMaxRingReceiver.value
  ? MAX_RING_DEFAULT_UDP_PORT
  : 0

function loadAnnounce() {
  try {
    const raw = localStorage.getItem(storageKey.value)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return { targetFqdn: '', peerId: '' }
}
function persistAnnounce() {
  try {
    // Note: udpPortOverride is intentionally not persisted. Zero means the VST
    // binds its own unique ephemeral receive port. A positive value is an
    // expert-only, per-session override.
    localStorage.setItem(storageKey.value, JSON.stringify({
      targetFqdn: targetFqdn.value,
      peerId: peerId.value
    }))
  } catch { /* quota / disabled */ }
}

// The manifest-saved link (written by the hub on a successful announce) is
// the authoritative selection; localStorage stays as the legacy fallback for
// cards that never pushed since the hub learned to persist pairings.
const savedLink = computed(() => {
  const link = props.device.link
  if (!link || (!link.targetFqdn && !link.targetName)) return null
  return link
})
function announceInitialState() {
  const link = savedLink.value
  if (link) {
    return {
      targetFqdn: link.targetFqdn || '',
      peerId: link.peerId || '',
      udpOverride: Number.isInteger(link.udpPortOverride) && link.udpPortOverride > 0
        ? link.udpPortOverride
        : defaultUdpOverride()
    }
  }
  const legacy = loadAnnounce()
  return {
    targetFqdn: legacy.targetFqdn,
    peerId: legacy.peerId || '',
    // VST receivers choose a unique ephemeral port from zero. The current
    // Node-for-Max bridge cannot publish the actual ephemeral bind, so
    // Max/Ring uses its own stable, non-Manager receive port.
    udpOverride: defaultUdpOverride()
  }
}

const _initial = announceInitialState()
const targetFqdn         = ref(_initial.targetFqdn)
const peerId             = ref(_initial.peerId)
const udpOverride        = ref(_initial.udpOverride)

// Reload after the earlier migration watcher has handled identity changes.
watch([
  () => props.device.id,
  () => props.device.canonicalId,
  () => props.device.linkRole,
  () => JSON.stringify(props.device.legacyCanonicalIds || []),
  () => JSON.stringify(props.device.legacyIds || [])
], () => {
  const fresh = announceInitialState()
  targetFqdn.value  = fresh.targetFqdn
  peerId.value      = fresh.peerId
  udpOverride.value = fresh.udpOverride
})

// A NEW saved link landing from the hub (this or another dashboard pushed)
// re-syncs the fields. Stringify-compare so unrelated DEVICE_UPDATED
// broadcasts (autoLink status ticks) cannot stomp in-progress edits.
watch(() => JSON.stringify(props.device.link || null), (raw) => {
  const link = raw ? JSON.parse(raw) : null
  if (!link || (!link.targetFqdn && !link.targetName)) return
  if (link.targetFqdn) targetFqdn.value = link.targetFqdn
  if (link.peerId) peerId.value = link.peerId
  if (Number.isInteger(link.udpPortOverride) && link.udpPortOverride > 0) {
    udpOverride.value = link.udpPortOverride
  }
})

// Persist only the sticky fields. udpOverride is in-session-only — see
// persistAnnounce comment.
watch([targetFqdn, peerId], persistAnnounce)

// The parent applies the source/target topology; keep a defensive self check
// here so manually supplied candidates cannot link a device to itself.
const targetCandidates = computed(() => {
  return props.services.filter((s) => {
    // Skip if the discovered service matches THIS device's host:port
    if (s.address === props.device.host && Number(s.port) === Number(props.device.oscQueryPort)) return false
    return true
  })
})
const selectedTarget = computed(() => {
  return findLinkTargetByFqdn(targetCandidates.value, targetFqdn.value)
})

// Live-Ring is a dedicated Ableton receiver with one legal peer. Keep that
// pairing sticky without auto-sending the connect command; Push remains the
// explicit operator action used everywhere else in the Manager.
watch(
  [isCosmicRingReceiver, targetCandidates, targetFqdn],
  ([isLiveRing, candidates, selectedFqdn]) => {
    if (!isLiveRing || selectedFqdn) return
    const ring = candidates.find((candidate) => isRingInstrumentIdentity(candidate))
    if (ring?.fqdn) targetFqdn.value = ring.fqdn
  },
  { immediate: true, flush: 'post' }
)

// Canonical dedup may replace a historical Bonjour alias with the preferred
// live endpoint. Preserve the saved LINK by migrating its stored FQDN to the
// surviving option instead of showing an empty/offline selection.
watch(
  [targetFqdn, targetCandidates],
  ([selectedFqdn]) => {
    if (!selectedFqdn) return
    const target = findLinkTargetByFqdn(targetCandidates.value, selectedFqdn)
    if (target?.fqdn && target.fqdn !== selectedFqdn) {
      targetFqdn.value = target.fqdn
    }
  },
  { immediate: true, flush: 'post' }
)
const usesMaxRingRoute = computed(() =>
  isMaxRingReceiver.value ||
  (isRingInstrumentPeer.value && isMaxRingIdentity(selectedTarget.value))
)
const usesFixedRingRoute = computed(() =>
  isFixedRingReceiver.value ||
  (isRingInstrumentPeer.value && isAbletonRingReceiverDevice(selectedTarget.value))
)
const usesExternalTargets = computed(() => isCosmicUnityOrAbletonDevice(props.device))
const usesCosmicUnityTargets = computed(() => !isCosmicUnityOrAbletonDevice(props.device))
const automaticPeerId = computed(() => {
  // peer_id identifies the external instrument in both supported UI shapes:
  // external card -> its source name; CosmicUnity card -> selected peer.
  if (usesCosmicUnityTargets.value) return sanitizePeerId(props.device.name)
  if (usesExternalTargets.value) return sanitizePeerId(selectedTarget.value?.name || '')
  return sanitizePeerId(props.device.name)
})
let previousAutomaticPeerId = automaticPeerId.value
watch(
  [automaticPeerId, selectedTarget, () => props.device.name],
  ([nextAutomaticPeerId, target]) => {
    const legacyAutomaticPeerId = usesCosmicUnityTargets.value
      ? sanitizePeerId(target?.name || '')
      : sanitizePeerId(props.device.name)
    if (usesFixedRingRoute.value && nextAutomaticPeerId) {
      // The Max/Ring route is a fixed one-to-one contract. Do not preserve a
      // stale custom peer id from an older generic LINK configuration.
      peerId.value = nextAutomaticPeerId
    } else if (
      nextAutomaticPeerId &&
      (
        !peerId.value ||
        peerId.value === previousAutomaticPeerId ||
        peerId.value === legacyAutomaticPeerId
      )
    ) {
      peerId.value = nextAutomaticPeerId
    }
    previousAutomaticPeerId = nextAutomaticPeerId || previousAutomaticPeerId
  },
  { immediate: true }
)

watch(usesMaxRingRoute, (active, wasActive) => {
  const current = Number(udpOverride.value) || 0
  if (active && current === 0) {
    udpOverride.value = MAX_RING_DEFAULT_UDP_PORT
  } else if (!active && wasActive && current === MAX_RING_DEFAULT_UDP_PORT) {
    udpOverride.value = 0
  }
}, { immediate: true })
const targetPlaceholder = computed(() => {
  if (usesExternalTargets.value) {
    if (isFixedRingReceiver.value) {
      return targetCandidates.value.length > 0
        ? '— Ring-Instrument seç —'
        : '— Ağda Ring-Instrument:9011 bulunamadı —'
    }
    return targetCandidates.value.length > 0
      ? '— Android / OSCQuery cihazı seç —'
      : '— Ağda Android / OSCQuery cihazı bulunamadı —'
  }
  if (usesCosmicUnityTargets.value) {
    return targetCandidates.value.length > 0
      ? '— CosmicUnity / Ableton seç —'
      : '— Ağda CosmicUnity / Ableton bulunamadı —'
  }
  return '— pick destination —'
})

// Migrate only selections proven incompatible by current registry identity.
// Do not clear an absent target: it may simply be offline or discovery may
// still be converging after a restart.
watch(
  [targetFqdn, () => props.disallowedTargetFqdns],
  ([selectedFqdn, disallowedFqdns]) => {
    if (!selectedFqdn) return
    const selectedKey = String(selectedFqdn).toLowerCase()
    const isDisallowed = disallowedFqdns.some(
      (fqdn) => String(fqdn).toLowerCase() === selectedKey
    )
    if (isDisallowed) targetFqdn.value = ''
  },
  { immediate: true, flush: 'post' }
)

const canPush = computed(() =>
  (props.device.connectionState === 'Connected' || props.device.status === 'connected') &&
  !!selectedTarget.value &&
  !!peerId.value
)
const announceSummary = computed(() => {
  if (!targetFqdn.value) {
    if (isFixedRingReceiver.value) return 'Ring-Instrument hedefi yok'
    if (usesExternalTargets.value) return 'Harici OSCQuery hedefi yok'
    if (isRingInstrumentPeer.value) return 'CosmicUnity / Max hedefi yok'
    if (usesCosmicUnityTargets.value) return 'CosmicUnity hedefi yok'
    return 'no target'
  }
  const t = selectedTarget.value
  if (!t) return 'Hedef çevrimdışı'
  const tname = t ? t.name : '(target gone)'
  return usesExternalTargets.value
    ? `${tname} → ${props.device.name}`
    : `${props.device.name} → ${tname}`
})
function onPush() {
  if (!canPush.value) return
  emit('announce', {
    target: selectedTarget.value,
    peerId: sanitizePeerId(peerId.value),
    udpPortOverride: Number(udpOverride.value) || 0
  })
}
// Reset the Peer ID field to the auto-derived selected peer identity.
// Useful when localStorage has a stale value left over from a previous device
// name — manual edits get overwritten only when the user explicitly clicks.
function onResetPeerId() {
  peerId.value = automaticPeerId.value
}
// The hub re-announces saved links on its own; the Push button remains the
// explicit way to create or change a pairing.

// ─── Saved-link chip + live auto-link status ────────────────────────────
const savedLinkTargetLabel = computed(() =>
  savedLink.value ? (savedLink.value.targetName || savedLink.value.targetFqdn || '') : ''
)
// Relative-time tick for the "N sn önce" copy — only while the panel is open.
const nowTick = ref(Date.now())
let nowTimer = null
watch(announceOpen, (open) => {
  clearInterval(nowTimer)
  nowTimer = null
  if (open) {
    nowTick.value = Date.now()
    nowTimer = setInterval(() => { nowTick.value = Date.now() }, 5000)
  }
}, { immediate: true })
function relTime(ts) {
  if (!ts) return ''
  const s = Math.max(0, Math.round((nowTick.value - ts) / 1000))
  if (s < 5) return 'şimdi'
  if (s < 60) return `${s} sn önce`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} dk önce`
  return `${Math.floor(m / 60)} sa önce`
}
// dev.autoLink is runtime-only status broadcast by the hub's auto-announce
// engine: 'ok' | 'pending' | 'failed'. A saved link without status yet reads
// as pending (engine has not evaluated it since the manifests loaded).
const autoLinkStatus = computed(() => {
  if (!savedLink.value) return null
  const a = props.device.autoLink
  if (!a || a.state === 'pending') return { cls: 'pending', text: '⋯ hedef bekleniyor' }
  if (a.state === 'ok') {
    const when = a.at ? ` · ${relTime(a.at)}` : ''
    return { cls: 'ok', text: `✓ ${a.summary || 'Otomatik bağlandı'}${when}` }
  }
  return { cls: 'err', text: `✗ ${a.error || 'Otomatik bağlantı başarısız'}` }
})
function onClearLink() {
  emit('clear-link')
}

// Compact LINK health glyph for the collapsed header — same data as
// autoLinkStatus, one character wide.
const linkGlyph = computed(() => {
  if (!savedLink.value) return null
  const target = savedLinkTargetLabel.value
  const a = props.device.autoLink
  if (!a || a.state === 'pending') return { cls: 'pending', icon: '⋯', title: `LINK → ${target}: hedef bekleniyor` }
  if (a.state === 'ok') return { cls: 'ok', icon: '✓', title: `LINK → ${target}: ${a.summary || 'otomatik bağlı'}` }
  return { cls: 'err', icon: '✗', title: `LINK → ${target}: ${a.error || 'otomatik bağlantı başarısız'}` }
})

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
// The fixed-rig port (5001–5005) is identity for the operator — keep it in
// the compact meta line even when everything else is collapsed.
const displayPort = computed(() =>
  props.device.activeEndpoint?.port || props.device.port || props.device.oscQueryPort
)
const deviceTypeLabel = computed(() => isMaxRingReceiver.value
  ? 'ABLETON / MAX'
  : isCosmicRingReceiver.value
    ? 'COSMICRING / ABLETON'
    : (props.device.deviceType || props.device.type))
const udpOverrideHint = computed(() => usesMaxRingRoute.value
  ? `${MAX_RING_DEFAULT_UDP_PORT} = Max/Ring alım portu`
  : '0 = VST için otomatik benzersiz port')
const paramCount = computed(() => {
  void paramsRev.value
  return props.params.size
})
</script>

<template>
  <div class="device-card" :class="[statusClass, { 'identity-collision': identityCollision, 'card-collapsed': !cardOpen }]">
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
          <span
            v-if="linkGlyph"
            class="device-link-glyph"
            :class="linkGlyph.cls"
            :title="linkGlyph.title"
          >{{ linkGlyph.icon }}</span>
          <span v-if="msgCount > 0" class="device-msgs">
            <span
              class="msg-activity-dot"
              :class="{ active: msgActive }"
              title="Lights up on each incoming OSC message"
            ></span>
            {{ msgCount }}
          </span>
          <button
            class="device-expand-btn"
            :class="{ open: cardOpen }"
            type="button"
            :title="cardOpen ? 'Detayları gizle' : 'Detayları göster'"
            :aria-expanded="cardOpen ? 'true' : 'false'"
            @click.stop="toggleCardOpen"
          ><span class="hub-chevron">▶</span></button>
        </div>
        <!-- One-line summary: type · port · status. Clicking it toggles the
             body — the whole line is the touch target on a dark stage. -->
        <button class="device-meta-line" type="button" :title="connectionLabel" @click="toggleCardOpen">
          <span class="device-meta-type">{{ deviceTypeLabel }}</span>
          <span class="device-meta-sep">·</span>
          <span class="device-meta-port">:{{ displayPort }}</span>
          <span class="device-meta-sep">·</span>
          <span class="device-status-text device-meta-status" :class="statusClass">{{ statusLabel }}</span>
          <span
            v-if="reachability === 'silent'"
            class="device-reach-badge"
            title="Bağlantı açık ama cihazdan veri gelmiyor"
          >SESSİZ</span>
          <span
            v-else-if="reachability === 'dead'"
            class="device-reach-badge dead"
            title="Cihaz yanıt vermiyor"
          >YANIT YOK</span>
          <span v-if="identityCollision" class="device-collision-badge">Kimlik Çakışması</span>
        </button>
      </div>
    </div>

    <!-- Cloned persistent-ID collision: the fix lives on the plugin side
         ("Yeni ID"), so surface it here loudly instead of hiding a :port:
         suffix inside the Details block. -->
    <div v-if="identityCollision" class="device-collision-banner" role="alert">
      <strong>⚠ KLONLANMIŞ KİMLİK ÇAKIŞMASI</strong>
      <span>
        Klonlanmış kimlik çakışması — cihazın editöründeki <strong>YENİ ID</strong>
        butonuna basın, ardından <strong>Rediscover</strong>'a tıklayın.
      </span>
      <div v-if="collisionEndpoints.length" class="dcb-endpoints">
        <div v-for="ep in collisionEndpoints" :key="ep">{{ ep }}</div>
      </div>
    </div>

    <!-- Faults and save feedback must not hide behind the collapse. -->
    <div v-if="device.error" class="device-error-text">{{ device.error }}</div>
    <div v-if="hint?.text" class="save-hint" :class="hint?.type || ''">{{ hint.text }}</div>

    <!-- Discovered cards keep their one meaningful action visible. -->
    <div v-if="!isSaved" class="device-actions">
      <button class="hub-btn hub-btn-primary" @click="emit('save', draftName)">
        + Save Device
      </button>
    </div>

    <div v-show="cardOpen" class="device-body">
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
      <div v-if="isSaved" class="device-actions">
        <button
          class="hub-btn"
          :class="{ 'hub-btn-primary': device.enabled, pending: enablePending }"
          :disabled="enablePending"
          @click="toggleEnabled"
        >
          <span class="hub-btn-icon">{{ enablePending ? '◌' : (device.enabled ? '●' : '○') }}</span>
          {{ enablePending
            ? ((pendingDesired ?? !device.enabled) ? 'Açılıyor…' : 'Kapatılıyor…')
            : (device.enabled ? 'Enabled' : 'Enable') }}
        </button>
        <button class="hub-btn" :disabled="!device.enabled" @click="emit('reconnect')">
          ⟳ Tekrar Dene
        </button>
      </div>

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
          <span style="display:flex;align-items:center;gap:0.5rem;min-width:0">
            <span class="hub-chevron">▶</span>
            LINK
            <span v-if="savedLink" class="hub-link-chip">OTOMATİK</span>
            <span v-if="savedLink" class="hub-link-chip-target" :title="savedLink.targetFqdn">
              {{ savedLinkTargetLabel }}
            </span>
          </span>
          <span class="announce-summary">{{ announceSummary }}</span>
        </button>
        <div v-show="announceOpen" class="hub-announce-body">
          <div
            v-if="savedLink && autoLinkStatus"
            class="hub-autolink-status"
            :class="autoLinkStatus.cls"
            :title="autoLinkStatus.text"
          >{{ autoLinkStatus.text }}</div>
          <div class="hub-announce-row">
            <label>Target</label>
            <select
              v-model="targetFqdn"
              :disabled="targetCandidates.length === 0"
            >
              <option value="">{{ targetPlaceholder }}</option>
              <option v-for="s in targetCandidates" :key="s.fqdn" :value="s.fqdn">
                {{ s.name }} ({{ s.address }}:{{ s.port }})
              </option>
            </select>
          </div>
          <div class="hub-announce-row">
            <label>Peer ID</label>
            <input
              v-model="peerId"
              :readonly="usesFixedRingRoute"
              placeholder="announce as…"
              spellcheck="false"
              title="Written to the CosmicUnity device as /system/peer/peer_id"
            />
            <button
              class="hub-peerid-reset"
              type="button"
              :disabled="peerId === automaticPeerId"
              @click="onResetPeerId"
              :title="`Reset to peer name: ${automaticPeerId}`"
            >↺</button>
          </div>
          <div class="hub-announce-row">
            <label>UDP override</label>
            <input
              v-model.number="udpOverride"
              type="number"
              min="0"
              max="65535"
              :placeholder="udpOverrideHint"
              :title="udpOverrideHint"
            />
            <span class="hub-announce-hint">{{ udpOverrideHint }}</span>
          </div>
          <div class="hub-announce-row hub-announce-actions">
            <button
              class="hub-btn hub-btn-primary"
              :disabled="!canPush"
              @click="onPush"
              :title="device.connectionState === 'Connected' || device.status === 'connected'
                ? 'Write the external OSCQuery peer to CosmicUnity and connect'
                : 'Device must be connected'"
            >
              Push
            </button>
            <button
              v-if="savedLink"
              class="hub-btn hub-link-remove"
              @click="onClearLink"
              title="Kayıtlı eşleşmeyi manifestten siler — otomatik yeniden bağlama durur"
            >
              Kaldır
            </button>
            <span class="announce-result" :class="announceResult?.ok ? 'ok' : (announceResult ? 'err' : '')">
              <template v-if="announceResult?.ok">✓ {{ announceResult.summary }}</template>
              <template v-else-if="announceResult">✗ {{ announceResult.error }}</template>
            </span>
          </div>
          <div class="hub-announce-hint hub-announce-meta">
            {{ usesFixedRingRoute
              ? 'Ring-Instrument peer bilgisini Ableton Ring alıcısına yazar, ardından'
              : 'Android/OSCQuery peer bilgisini CosmicUnity cihazına yazar, ardından' }}
            <code>/system/peer/connect</code> gönderir.
            Push bir kez yeter — hub eşleşmeyi kaydeder ve kopan taraf geri geldiğinde otomatik yeniden bağlar.
          </div>
        </div>
      </div>

      <!-- ─── Recordings (record / playback per device) ─── -->
      <RecordingPanel :rec="recording" />
      </template>

    </div>
    </div>
  </div>
</template>
