import { ref, onMounted, onBeforeUnmount } from 'vue'

// Subscribes to the helper's /ws/discovery channel and exposes a reactive
// list of OSCQuery services found on the local network.
export function useDiscovery() {
  const services = ref([])
  const connected = ref(false)
  let ws = null
  let retryTimer = null

  function open() {
    ws = new WebSocket(`ws://${location.host}/ws/discovery`)
    ws.onopen = () => (connected.value = true)
    ws.onclose = () => {
      connected.value = false
      ws = null
      retryTimer = setTimeout(open, 1500)
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'services') services.value = msg.services
      } catch {}
    }
  }

  onMounted(open)
  onBeforeUnmount(() => {
    clearTimeout(retryTimer)
    if (ws) ws.close()
  })

  return { services, connected }
}
