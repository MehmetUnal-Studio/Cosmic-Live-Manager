import { onBeforeUnmount, onMounted, ref } from 'vue'

export function useServerControl() {
  const status = ref({
    service: 'Manager Bridge',
    state: 'Stopped',
    ports: { http: 7400, websocket: 7400, oscUdp: 9001 },
    error: null
  })
  const busy = ref(false)
  let timer = null
  let stopped = false

  async function refresh() {
    try {
      const response = await fetch('/api/manager/status', { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      status.value = await response.json()
    } catch (error) {
      status.value = {
        ...status.value,
        state: 'Error',
        error: `Control plane unavailable: ${error.message}`
      }
    }
  }

  async function command(action) {
    if (busy.value) return
    busy.value = true
    if (action === 'restart') status.value = { ...status.value, state: 'Restarting', error: null }
    try {
      const response = await fetch(`/api/manager/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      status.value = await response.json()
    } catch (error) {
      status.value = { ...status.value, state: 'Error', error: error.message }
    } finally {
      busy.value = false
    }
  }

  onMounted(() => {
    stopped = false
    refresh()
    timer = setInterval(() => { if (!stopped) refresh() }, 1000)
  })
  onBeforeUnmount(() => {
    stopped = true
    if (timer) clearInterval(timer)
  })

  return {
    status,
    busy,
    refresh,
    start: () => command('start'),
    stop: () => command('stop'),
    restart: () => command('restart')
  }
}
