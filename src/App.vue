<script setup>
import { computed, provide, ref, watch } from 'vue'
import HubDashboard from './components/HubDashboard.vue'
import PerformanceMode from './components/PerformanceMode.vue'
import HubStatusBar from './components/HubStatusBar.vue'

// Two-page app: the OSCQuery dashboard and a Performance Mode canvas.
// We keep this lightweight — no Vue Router, just a `currentPage` ref
// persisted in localStorage so reloads land on the same page.
//
// BOTH pages are kept mounted via v-show (F2-16): the previous mix of
// v-show (Dashboard) + v-if (Performance) meant Performance state was
// destroyed on every tab switch while the hidden Dashboard kept paying
// full reactive costs. Now both persist their state; the Dashboard is
// told when it's hidden (injected `dashboardVisible`) so per-card flash
// timers and other cosmetic reactive work pause while performing.

const PAGE_KEY = 'clm:active-page'
const currentPage = ref(localStorage.getItem(PAGE_KEY) || 'dashboard')
watch(currentPage, (v) => {
  try { localStorage.setItem(PAGE_KEY, v) } catch {}
})

const dashboardVisible = computed(() => currentPage.value === 'dashboard')
provide('dashboardVisible', dashboardVisible)
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

    <!-- Always-visible operator status: hub link, OSC listen health,
         device up/down, identity collisions. Shared by both pages. -->
    <HubStatusBar />

    <div class="app-page" role="tabpanel">
      <HubDashboard v-show="currentPage === 'dashboard'" />
      <PerformanceMode v-show="currentPage === 'performance'" />
    </div>
  </div>
</template>

<style scoped>
.app-root {
  display: flex; flex-direction: column;
  height: 100vh;
  background: var(--hub-bg, #0a0c12);
}
.app-tabs {
  display: flex; gap: 0;
  background: var(--hub-bg, #0a0c12);
  border-bottom: 1px solid var(--hub-border, #1e2430);
  padding: 0 18px;
  flex: 0 0 auto;
}
.app-tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--hub-ink-dim, #5c6577);
  padding: 12px 18px;
  min-height: 44px;
  font: inherit; font-size: 0.82rem; font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer; user-select: none;
  transition: color 0.15s, border-color 0.15s;
}
.app-tab:hover { color: var(--hub-ink, #dfe4ee); }
.app-tab.active {
  color: var(--hub-accent, #5bb8ff);
  border-bottom-color: var(--hub-accent, #5bb8ff);
}
.app-page {
  flex: 1 1 auto;
  overflow: auto;
  min-height: 0;
}
</style>
