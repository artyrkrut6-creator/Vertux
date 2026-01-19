import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite config: proxy API requests to local backend (PORT 5176)
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:5176',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path
      }
      ,
      // Proxy SSE events endpoint so EventSource('/events') is same-origin to the dev server
      '/events': {
        target: 'http://localhost:5176',
        changeOrigin: true,
        secure: false
      }
    }
  }
})
