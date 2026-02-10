import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 9030,
    watch: {
      // Use polling so Vite detects SFTP file changes (no inotify events)
      usePolling: true,
      interval: 1000,
    },
  },
})
