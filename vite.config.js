import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Vite dev server proxies /ws WebSocket connections to the local Node hub,
// so the browser only ever talks to one origin during development.
//
// `host: true` binds the dev server on every network interface (0.0.0.0 +
// IPv6) so the dashboard is reachable from other devices on the LAN —
// tablets, phones, another laptop — at http://<this-machine-LAN-IP>:5173.
// The WS proxy still talks to the helper on 127.0.0.1, which is fine because
// it's the SERVER side of the proxy (same machine). Browsers connect to
// the LAN URL and Vite forwards their WS traffic to the local helper.
export default defineConfig({
  plugins: [vue()],
  server: {
    host: true,
    port: 5173,
    // Print the LAN addresses on startup so you know where to point clients.
    // Vite already does this when `host` is truthy.
    strictPort: true,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:7400',
        ws: true,
        changeOrigin: true
      },
      '/api/manager': {
        target: 'http://127.0.0.1:7399',
        changeOrigin: true
      }
    }
  }
})
