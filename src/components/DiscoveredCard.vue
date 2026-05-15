<script setup>
import { ref } from 'vue'

const props = defineProps({
  device: { type: Object, required: true } // { name, host, port }
})
const emit = defineEmits(['add'])

const showForm = ref(false)
const nameDraft = ref(props.device.name)

function add() {
  emit('add', {
    host: props.device.host,
    port: props.device.port,
    name: nameDraft.value
  })
}
</script>

<template>
  <div class="discovered-card">
    <div class="discovered-tag">DISCOVERED</div>
    <div class="discovered-name">
      <div class="discovered-pulse"></div>
      <span>{{ device.name }}</span>
    </div>
    <div class="discovered-host">{{ device.host }} : {{ device.port }}</div>
    <input
      v-if="showForm"
      class="discovered-name-input"
      v-model="nameDraft"
      placeholder="Device name…"
      @keydown.enter.prevent="add"
    />
    <div style="display:flex;gap:0.5rem">
      <button v-if="!showForm" class="hub-btn" @click="showForm = true">+ Add</button>
      <button v-else class="hub-btn hub-btn-primary" @click="add">Confirm</button>
    </div>
  </div>
</template>
