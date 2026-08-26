import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { cpSync } from 'node:fs'
import { resolve } from 'node:path'

// The review build: a title page and the map, nothing between them.
//
// Same `src/` as the main build — this is a different set of entry points, not
// a fork. Two pages, mirroring how the main site already splits story from map:
//
//   review/index.html    the story's hero slide alone — what the dataset is
//   review/explore.html  the explore map
//
// What is absent is the deck: no chapters, no ForestPair/GediShot figures, no
// swipe machinery, no dev.html. So the landing page stays cheap, and its only
// story asset is the hero background.
//
// These land at the *root* of the site, so the title page is what a bare URL
// gives you. That is only possible while the story is unpublished, since the
// story wants the same index.html — the guard below makes the clash loud rather
// than letting one silently overwrite the other.
//
// Writing into the main build's directory means this must run second, and must
// not empty what it finds (`emptyOutDir: false`). The main build clears dist/
// first; this adds to it.

const root = resolve(__dirname, 'review')
const outDir = resolve(__dirname, 'dist')
const storyArt = resolve(__dirname, 'public/story')
const heroImage = resolve(storyArt, 'hero.webp')

if (process.env.PUBLISH_STORY === '1') {
  throw new Error(
    'PUBLISH_STORY=1 and the review build both want dist/index.html.\n' +
      'The review landing page occupies the site root while the story is\n' +
      'unpublished. To publish the story, give one of them a different\n' +
      'filename first — this build refuses to guess which.',
  )
}

// `publicDir: false` below, then copy by hand — Vite's publicDir is all or
// nothing, and we want public/ minus the chapter artwork.
//
// Two things must survive the cut. `public/sites/`, because RandomSite fetches
// './sites/sites.json' relative to whatever page it is on; and the hero
// background, the one file under public/story/ the landing page needs. The 40
// chapter frames beside it are dead weight here.
function publicAssetsMinusChapterArt(): Plugin {
  // Read back from the resolved config rather than the `outDir` constant
  // below: `--outDir` on the command line overrides it, and the CI job that
  // publishes to a separate repository does exactly that. Copying to the
  // constant instead put the HTML and JS in one directory and sites.json,
  // hero.webp and vite.svg in another.
  let target = outDir
  return {
    name: 'review-public-assets',
    configResolved(config) {
      target = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      cpSync(resolve(__dirname, 'public'), target, {
        recursive: true,
        // Returning false for a directory skips everything under it, so
        // public/story/ itself has to pass before hero.webp can be considered.
        filter: (src: string) =>
          src === storyArt || !src.startsWith(storyArt) || src === heroImage,
      })
    },
  }
}

export default defineConfig(({ command }) => ({
  root,
  // Hiding the chapter frames is a build-time concern — there is nobody to hide
  // them from on a laptop — and `false` would take hero.webp and sites.json down
  // with them, leaving the dev server a landing page with no background. So the
  // filtered copy below applies to the artifact, and dev serves public/ whole.
  publicDir: command === 'serve' ? resolve(__dirname, 'public') : false,
  plugins: [react(), publicAssetsMinusChapterArt()],
  // The review site never has the story deck — only its own title page — so
  // __STORY__ is false here whatever the main build is doing.
  define: { __REVIEW__: 'true', __STORY__: 'false' },
  // Both pages import from src/, one level above `root`. A build resolves that
  // through the filesystem: rollup is handed each HTML file's own path and
  // follows `../src/...` from there. The dev server never sees that path — the
  // browser resolves `../src/review/main.tsx` against the page URL `/` and asks
  // for `/src/review/main.tsx`, which Vite looks for under root, i.e. in a
  // review/src/ that does not exist. That failed as a blank page with one
  // `Failed to load url` line in the terminal and nothing in the browser.
  //
  // So: point that URL back at the real src/, and allow reads above root.
  resolve: { alias: { '/src': resolve(__dirname, 'src') } },
  server: { fs: { allow: [__dirname] } },
  build: {
    outDir,
    // Never clear: the main build's explore.html, dev.html and assets are
    // already here, and this build adds to them rather than replacing them.
    // (When CI publishes to a separate repository it overrides outDir, and the
    // directory is fresh on every runner, so nothing accumulates there either.)
    emptyOutDir: false,
    rollupOptions: {
      input: {
        landing: resolve(root, 'index.html'),
        explore: resolve(root, 'explore.html'),
      },
    },
  },
}))
