<script setup>
import { computed, ref } from 'vue'
import { useServerControl } from '../composables/useServerControl.js'
import { useHub } from '../composables/useHub.js'

const { status, busy, start, stop, restart } = useServerControl()
const { rediscover } = useHub()

// Same brief feedback as the topbar icon — the discovery list usually
// rebuilds in <1 s, the spin just confirms the click registered.
const rediscovering = ref(false)
function onRediscover() {
  rediscover()
  rediscovering.value = true
  setTimeout(() => { rediscovering.value = false }, 600)
}

const stateClass = computed(() => String(status.value.state || 'Stopped').toLowerCase())
const portSummary = computed(() => {
  const ports = status.value.ports || {}
  const values = [`HTTP/WS ${ports.http || '—'}`, `OSC UDP ${ports.oscUdp || '—'}`]
  return values.join(' · ')
})
</script>

<template>
  <section
    class="server-control"
    aria-label="Manager Bridge controls"
    title="Node Manager/OSCQuery köprüsünü kontrol eder. Ableton ve VST instance'ları host'a aittir."
  >
    <div class="server-control-main">
      <div class="server-control-label">Manager Bridge</div>
      <div class="server-control-state" :class="stateClass">
        <span class="server-control-dot"></span>
        {{ status.state }}
      </div>
      <div class="server-control-ports">{{ portSummary }}</div>
    </div>
    <div class="server-control-actions">
      <button
        class="hub-btn"
        :class="{ spinning: rediscovering }"
        title="Rediscover — ağ keşif önbelleğini yeniden kur (cihaz IP/port değiştirdiyse)"
        @click="onRediscover"
      >
        <span class="hub-btn-icon">⟳</span>
        Rediscover
      </button>
      <button class="hub-btn" :disabled="busy || status.state === 'Running'" @click="start">Start</button>
      <button class="hub-btn" :disabled="busy || status.state === 'Stopped'" @click="stop">Stop</button>
      <button class="hub-btn hub-btn-primary" :disabled="busy" @click="restart">Restart</button>
    </div>
    <div v-if="status.error" class="server-control-error">{{ status.error }}</div>
  </section>
</template>
