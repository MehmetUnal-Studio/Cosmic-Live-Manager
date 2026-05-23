<script setup>
import { ref, watch } from 'vue'
import HubDashboard from './components/HubDashboard.vue'
import PerformanceMode from './components/PerformanceMode.vue'

// Two-page app: the OSCQuery dashboard and a Performance Mode canvas.
// We keep this lightweight — no Vue Router, just a `currentPage` ref
// persisted in localStorage so reloads land on the same page.

const PAGE_KEY = 'clm:active-page'
const currentPage = ref(localStorage.getItem(PAGE_KEY) || 'dashboard')
watch(currentPage, (v) => {
  try { localStorage.setItem(PAGE_KEY, v) } catch {}
})
</script>

<template>
  <div class="app-root">
    <nav class="app-tabs" role="tablist">
      <button
        class="app-tab"
        :class="{ active: currentPage === 'dashboard' }"
        @click="currentPage = 'dashboard'"
        role="tab"
        :aria-selected="currentPage === 'dashboard'"
      >Dashboard</button>
      <button
        class="app-tab"
        :class="{ active: currentPage === 'performance' }"
        @click="currentPage = 'performance'"
        role="tab"
        :aria-selected="currentPage === 'performance'"
      >Performance Mode</button>
    </nav>

    <div class="app-page" role="tabpanel">
      <HubDashboard v-show="currentPage === 'dashboard'" />
      <PerformanceMode v-if="currentPage === 'performance'" />
    </div>
  </div>
</template>

<style scoped>
.app-root {
  display: flex; flex-direction: column;
  height: 100vh;
}
.app-tabs {
  display: flex; gap: 0;
  background: var(--hub-bg, #0a0a0a);
  border-bottom: 1px solid var(--hub-border, #2a2a2a);
  padding: 0 18px;
  flex: 0 0 auto;
}
.app-tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--hub-ink-dim, #777);
  padding: 12px 18px;
  font: inherit; font-size: 0.82rem; font-weight: 500;
  letter-spacing: 0.04em;
  cursor: pointer; user-select: none;
  transition: color 0.15s, border-color 0.15s;
}
.app-tab:hover { color: var(--hub-ink, #ddd); }
.app-tab.active {
  color: var(--hub-cyan, #06b6d4);
  border-bottom-color: var(--hub-cyan, #06b6d4);
}
.app-page {
  flex: 1 1 auto;
  overflow: auto;
  min-height: 0;
}
</style>
