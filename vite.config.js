import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Vite dev server proxies /ws WebSocket connections to the local Node hub,
// so the browser only ever talks to one origin during development.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:7400',
        ws: true,
        changeOrigin: true
      }
    }
  }
})
