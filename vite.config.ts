import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Three entry points rather than one app with routes.
//
//   index.html    story      — narrative intro, must not pay for OpenLayers/MUI
//   explore.html  simple map — what reviewers get
//   dev.html      full app   — the working tool, unchanged
//
// A multi-page build gives each page its own bundle while `src/` stays shared,
// so the story's first paint is not held hostage by the map's dependencies and
// no router is needed. Navigation between them is a real page load, which is
// what we want here anyway: the story→map transition should start from a clean
// map state.
export default defineConfig({
  plugins: [react()],
  // False here, true in vite.config.review.ts — the one flag that tells the
  // shared components which of the two builds they are in.
  define: { __REVIEW__: 'false' },
  build: {
    rollupOptions: {
      input: {
        story: resolve(__dirname, 'index.html'),
        explore: resolve(__dirname, 'explore.html'),
        dev: resolve(__dirname, 'dev.html'),
      },
    },
  },
  server: {
    port: 9030,
    watch: {
      // Use polling so Vite detects SFTP file changes (no inotify events)
      usePolling: true,
      interval: 1000,
    },
  },
})
