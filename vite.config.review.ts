import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cpSync } from 'node:fs'
import { resolve } from 'node:path'

// The review build: the explore map on its own, nothing else.
//
// Same `src/` as the main build — this is a different set of entry points, not
// a fork. What changes is that `review/index.html` is the *only* page, so the
// map is what a reviewer lands on rather than something they navigate to, and
// the story is absent: no `index.html` chapter scroller, no `dev.html`, and no
// `public/story/` artwork riding along in the artifact.
//
// It nests inside the main site's output (dist/review/) so one Pages deploy
// publishes both. Build order therefore matters: the main build empties dist/,
// so it has to run first. See `npm run build:review` and .github/workflows.

const root = resolve(__dirname, 'review')
const outDir = resolve(__dirname, 'dist/review')
const story = resolve(__dirname, 'public/story')

// `publicDir: false` below, then copy by hand — Vite's publicDir is all or
// nothing, and we want public/ minus the story artwork. `public/sites/` has to
// come along: RandomSite fetches it from './sites/sites.json', relative to
// whatever page it is on.
const publicAssetsMinusStory = {
  name: 'review-public-assets',
  closeBundle() {
    cpSync(resolve(__dirname, 'public'), outDir, {
      recursive: true,
      filter: (src: string) => src !== story,
    })
  },
}

export default defineConfig({
  root,
  publicDir: false,
  plugins: [react(), publicAssetsMinusStory],
  define: { __REVIEW__: 'true' },
  build: {
    outDir,
    // dist/ sits outside `root`, so Vite wants this said explicitly before it
    // will clear the directory.
    emptyOutDir: true,
  },
})
