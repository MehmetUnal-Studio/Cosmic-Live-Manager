<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useHub } from '../composables/useHub.js'

// Global status bar — mounted once in App.vue so it is visible on BOTH the
// Dashboard and the Performance page (the hub-link state was previously a
// 12px badge on the Dashboard only; invisible mid-show).
//
// Reads everything straight from the useHub() singleton:
//   - connectionState: 'connected' | 'connecting' | 'disconnected' (falls
//     back to the boolean `connected` ref while the state layer lands)
//   - hubStatus.oscListen: 'ok' | 'degraded'  (HUB_STATUS from the server)
//   - devices[].connectionState / reachability / identitySource

const hub = useHub()

// 'connected' | 'reconnecting' | 'down' from the state layer.
const connState = computed(() => {
  const cs = hub.connectionState
  if (cs && typeof cs === 'object' && 'value' in cs) return cs.value
  return hub.connected?.value ? 'connected' : 'down'
})
const isConnected = computed(() => connState.value === 'connected')

// OSC listen health — server-side UDP ingest (HUB_STATUS). 'degraded' means
// the hub is up but cannot hear devices (port conflict etc.).
const oscListen = computed(() => {
  const ol = hub.oscListen
  const v = (ol && typeof ol === 'object' && 'value' in ol) ? ol.value : ol
  if (v === 'ok' || v === 'degraded') return v
  const hi = hub.hubInfo?.value
  return hi?.oscListen || 'ok'
})

const devices = computed(() => hub.devices?.value || [])
const savedDevices = computed(() => devices.value.filter((d) => d.saved !== false && d.id != null))
const upCount = computed(() => savedDevices.value.filter(
  (d) => d.connectionState === 'Connected' || d.status === 'connected'
).length)
const totalCount = computed(() => savedDevices.value.length)
const allUp = computed(() => totalCount.value > 0 && upCount.value === totalCount.value)

const COLLISION_SOURCES = new Set([
  'persistent-id-port-collision',
  'persistent-id-remote-collision'
])
const collisionCount = computed(() =>
  devices.value.filter((d) => COLLISION_SOURCES.has(d.identitySource)).length
)

function scrollToFirstCollision() {
  const el = document.querySelector('.device-card.identity-collision')
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

// "Frozen N s ago" counter while the hub link is down. All grid data below
// is last-known (stale) during an outage — say so, loudly. Prefer the state
// layer's staleSince timestamp; fall back to a local clock.
const frozenSeconds = ref(0)
let frozenTimer = null
let localSince = 0
function frozenOrigin() {
  const ss = hub.staleSince
  const v = (ss && typeof ss === 'object' && 'value' in ss) ? ss.value : ss
  return Number(v) || localSince
}
watch(isConnected, (up) => {
  if (up) {
    if (frozenTimer) { clearInterval(frozenTimer); frozenTimer = null }
    frozenSeconds.value = 0
  } else {
    localSince = Date.now()
    frozenSeconds.value = 0
    if (!frozenTimer) {
      frozenTimer = setInterval(() => {
        frozenSeconds.value = Math.max(0, Math.round((Date.now() - frozenOrigin()) / 1000))
      }, 1000)
    }
  }
}, { immediate: true })
onBeforeUnmount(() => { if (frozenTimer) clearInterval(frozenTimer) })

const linkChipLabel = computed(() => {
  if (connState.value === 'connected') return 'HUB BAĞLI'
  if (connState.value === 'reconnecting') return 'YENİDEN BAĞLANIYOR…'
  return 'HUB KOPUK'
})
const linkChipClass = computed(() => {
  if (connState.value === 'connected') return 'ok'
  if (connState.value === 'reconnecting') return 'warn'
  return 'danger'
})
</script>

<template>
  <div class="hub-status-wrap">
    <div class="hub-status-bar">
      <span class="hsb-chip" :class="linkChipClass">
        <span class="hsb-dot"></span>{{ linkChipLabel }}
      </span>

      <span v-if="oscListen === 'degraded'" class="hsb-chip warn" title="Hub OSC portunu dinleyemiyor — cihaz verisi gelmeyebilir">
        <span class="hsb-dot"></span>OSC DİNLEME SORUNLU
      </span>

      <span
        class="hsb-chip"
        :class="totalCount === 0 ? '' : (allUp ? 'ok' : 'warn')"
        title="Bağlı cihaz / kayıtlı cihaz"
      >
        <span class="hsb-dot"></span>CİHAZ {{ upCount }}/{{ totalCount }}
      </span>

      <button
        v-if="collisionCount > 0"
        class="hsb-chip warn button"
        type="button"
        title="Klonlanmış kimlik çakışması olan karta git"
        @click="scrollToFirstCollision"
      >
        ⚠ {{ collisionCount }} KİMLİK ÇAKIŞMASI
      </button>

      <span class="hsb-spacer"></span>
      <span class="hsb-label">Cosmic Live</span>
    </div>

    <div v-if="!isConnected" class="hub-link-banner" role="alert">
      <span class="hlb-dot"></span>
      <span>HUB BAĞLANTISI KOPTU</span>
      <span class="hlb-sub">
        veriler {{ frozenSeconds }} sn önce donduruldu · yeniden bağlanıyor…
      </span>
    </div>
  </div>
</template>
