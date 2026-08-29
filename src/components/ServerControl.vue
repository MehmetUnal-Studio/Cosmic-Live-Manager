<script setup>
import { computed } from 'vue'
import { useServerControl } from '../composables/useServerControl.js'

const { status, busy, start, stop, restart } = useServerControl()

const stateClass = computed(() => String(status.value.state || 'Stopped').toLowerCase())
const portSummary = computed(() => {
  const ports = status.value.ports || {}
  const values = [`HTTP/WS ${ports.http || '—'}`, `OSC UDP ${ports.oscUdp || '—'}`]
  return values.join(' · ')
})
</script>

<template>
  <section class="server-control" aria-label="Manager Bridge controls">
    <div class="server-control-main">
      <div class="server-control-label">Manager Bridge</div>
      <div class="server-control-state" :class="stateClass">
        <span class="server-control-dot"></span>
        {{ status.state }}
      </div>
      <div class="server-control-ports">{{ portSummary }}</div>
    </div>
    <div class="server-control-actions">
      <button class="hub-btn" :disabled="busy || status.state === 'Running'" @click="start">Start</button>
      <button class="hub-btn" :disabled="busy || status.state === 'Stopped'" @click="stop">Stop</button>
      <button class="hub-btn hub-btn-primary" :disabled="busy" @click="restart">Restart</button>
    </div>
    <div v-if="status.error" class="server-control-error">{{ status.error }}</div>
    <div class="server-control-note">Controls the Node Manager/OSCQuery bridge. Ableton and VST instances remain host-owned.</div>
  </section>
</template>
