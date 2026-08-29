import { ref, onMounted, onBeforeUnmount } from 'vue'

// Subscribes to the helper's /ws/discovery channel and exposes a reactive
// list of OSCQuery services found on the local network.
export function useDiscovery() {
  const services = ref([])
  const connected = ref(false)
  let ws = null
  let retryTimer = null
  // Fix F2-12: unmount used to clear the CURRENT retry timer and close the
  // socket — but close() fires onclose asynchronously, which scheduled a
  // FRESH timer nobody cleared → zombie socket reconnecting forever after
  // the component was gone. `disposed` guards every (re)open path.
  let disposed = false

  function open() {
    if (disposed) return
    ws = new WebSocket(`ws://${location.host}/ws/discovery`)
    ws.onclose = () => {
      connected.value = false
      ws = null
      if (!disposed) retryTimer = setTimeout(open, 1500)
    }
    ws.onopen = () => {
      // The socket may have been disposed while connecting.
      if (disposed) {
        try { ws && ws.close() } catch {}
        return
      }
      connected.value = true
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'services') services.value = msg.services
      } catch {}
    }
  }

  function dispose() {
    disposed = true
    clearTimeout(retryTimer)
    retryTimer = null
    if (ws) {
      const socket = ws
      ws = null
      try { socket.close() } catch {}
    }
    connected.value = false
  }

  onMounted(() => {
    disposed = false
    open()
  })
  onBeforeUnmount(dispose)

  return { services, connected }
}
