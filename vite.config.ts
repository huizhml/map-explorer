import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { extname, resolve } from 'node:path'

// One site under one base, a directory per page rather than one app with routes.
//
//   /vsm/            index.html           title page — what the dataset is
//   /vsm/explorer/   explorer/index.html  the map
//   /vsm/dev/        dev/index.html       full app — the working tool, local only
//   /vsm/story/      story/index.html     narrative deck — drafts, local only
//
// The same URLs locally (`npm run dev`, or launch.sh on hendrix) and published
// at huizhml.github.io/vsm/: CI passes its own --base when the site lands
// elsewhere, so nothing in src/ may assume /vsm/ — public files go through
// import.meta.env.BASE_URL, never a page-relative './'. A page one directory
// down would otherwise ask for explorer/sites/sites.json.
//
// A multi-page build gives each page its own bundle while `src/` stays shared,
// so the title page's first paint is not held hostage by the map's
// dependencies and no router is needed.

/**
 * The story is still being written, and a reviewer who stumbles onto half-
 * drafted chapters draws conclusions from them. So it is left out of the build
 * unless PUBLISH_STORY=1 says otherwise.
 *
 * Opt *in* rather than opt out, deliberately: a forgotten variable then keeps
 * the draft private instead of publishing it. `npm run dev` is unaffected —
 * the dev server serves story/index.html whatever the build inputs are.
 */
const publishStory = process.env.PUBLISH_STORY === '1'

/**
 * Leaving the story out of the build stops it rendering, but Vite copies all
 * of public/ verbatim — so public/story/'s chapter frames would still sit at
 * story/*.webp for anyone who guessed the URL. Remove them, keeping hero.webp:
 * the title page's background is the one story asset that is public.
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
      const art = resolve(outDir, 'story')
      if (!existsSync(art)) return
      for (const name of readdirSync(art)) {
        if (name !== 'hero.webp') rmSync(resolve(art, name), { recursive: true, force: true })
      }
    },
  }
}

/**
 * `/vsm` and `/vsm/explorer` → the same with a trailing slash, as GitHub Pages
 * does for a directory. Vite's dev server does not: it answers the first with
 * a "did you mean" 404 and looks for `explorer.html` for the second.
 */
function directoryTrailingSlash(): Plugin {
  let base = '/'
  let root = ''
  return {
    name: 'directory-trailing-slash',
    apply: 'serve',
    configResolved(config) {
      base = config.base
      root = config.root
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname
        const isDir =
          !path.endsWith('/') &&
          !extname(path) &&
          (path + '/' === base ||
            (path.startsWith(base) && existsSync(resolve(root, path.slice(base.length), 'index.html'))))
        if (!isDir) return next()
        // 302, not 301: browsers cache a permanent redirect indefinitely, and
        // this one is only ever a local convenience.
        res.writeHead(302, { Location: path + '/' + url.search })
        res.end()
      })
    },
  }
}

export default defineConfig({
  base: '/vsm/',
  plugins: [react(), stripUnpublishedStoryArt(), directoryTrailingSlash()],
  build: {
    rollupOptions: {
      input: {
        landing: resolve(__dirname, 'index.html'),
        explorer: resolve(__dirname, 'explorer/index.html'),
        // dev/ is deliberately absent: the full app is for local use only. On
        // the public read-only backend most of it (upload, saving, auxiliary
        // layers) meets 403s and 503s. The dev server serves it regardless.
        ...(publishStory ? { story: resolve(__dirname, 'story/index.html') } : {}),
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
