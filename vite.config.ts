import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { rmSync } from 'node:fs'
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

/**
 * The story is still being written, and a reviewer who stumbles onto half-
 * drafted chapters draws conclusions from them. So it is left out of the build
 * unless PUBLISH_STORY=1 says otherwise.
 *
 * Opt *in* rather than opt out, deliberately: a forgotten variable then keeps
 * the draft private instead of publishing it. `npm run dev` is unaffected —
 * the dev server serves index.html whatever the build inputs are, so writing
 * the story locally works exactly as before.
 */
const publishStory = process.env.PUBLISH_STORY === '1'

/**
 * Leaving index.html out of the build stops the story rendering, but Vite
 * copies all of public/ verbatim — so public/story/'s chapter frames would
 * still sit at /story/*.webp for anyone who guessed the URL. Remove them.
 *
 * Safe against the review build, which writes dist/review afterwards and
 * carries its own copy of hero.webp.
 */
function stripUnpublishedStoryArt(): Plugin {
  let outDir = ''
  return {
    name: 'strip-unpublished-story-art',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      if (publishStory) return
      rmSync(resolve(outDir, 'story'), { recursive: true, force: true })
    },
  }
}

export default defineConfig({
  plugins: [react(), stripUnpublishedStoryArt()],
  define: {
    // False here, true in vite.config.review.ts — the one flag that tells the
    // shared components which of the two builds they are in.
    __REVIEW__: 'false',
    // Whether './index.html' is a page that exists, so nothing links to a 404.
    __STORY__: JSON.stringify(publishStory),
  },
  build: {
    rollupOptions: {
      input: {
        ...(publishStory ? { story: resolve(__dirname, 'index.html') } : {}),
        // explore.html is deliberately absent.
        //
        // It is built by vite.config.review.ts instead, from review/, and lands
        // at the same path. Building it here as well published the same app
        // twice: two ~400 KB bundles of one source file, differing only in the
        // __REVIEW__ flag — and the copy from *this* config had it false, so
        // its footer carried no way back to the title page. A reviewer who
        // arrived there was in a dead end.
        //
        // The file at the repo root stays, because `npm run dev` serves it: the
        // dev server resolves HTML from the project root regardless of what the
        // build inputs say.
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
