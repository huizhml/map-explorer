#!/usr/bin/env node
/**
 * Publish curated showcase sites to the public frontend, in one command.
 *
 *   npm run sites:publish -- --tags showcase
 *   npm run sites:publish -- --tags showcase --api http://localhost:8006
 *   npm run sites:publish -- --ids 12,15,19 --no-commit
 *
 * Fetches the bundle straight from the internal backend's export endpoint,
 * unpacks it into public/sites/, and commits. No browser download, no manual
 * unzip — the only prerequisite is that this machine can reach the backend that
 * holds the database (the same one the app talks to).
 *
 * The result is committed rather than uploaded to object storage on purpose:
 * the published set then travels with the code, so a reviewer sees exactly what
 * was in the repository at that commit and it cannot change under them. The
 * cost is one commit per curation change; see deploy/docker/README.md for the
 * mutable-bucket alternative if that trade is wrong for you.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const API = (flag('api', process.env.API || 'http://localhost:8006')).replace(/\/+$/, '');
const tags = flag('tags', 'showcase');
const ids = flag('ids', '');
const doCommit = !has('no-commit');
const doPush = !has('no-push') && doCommit;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(repoRoot, 'public', 'sites');

const query = new URLSearchParams();
if (tags) query.set('tags', tags);
if (ids) query.set('ids', ids);

const url = `${API}/saved-features/export?${query}`;
console.log(`▸ fetching ${url}`);

const resp = await fetch(url).catch((err) => {
  console.error(`\nCannot reach ${API}.`);
  console.error('This must run somewhere that can see the backend holding the database');
  console.error('(pass --api, or set API=). Original error:', err.message);
  process.exit(1);
});
if (!resp.ok) {
  console.error(`Export failed: HTTP ${resp.status} ${await resp.text().catch(() => '')}`.slice(0, 400));
  process.exit(1);
}

const count = Number(resp.headers.get('x-site-count') ?? '0');
if (count === 0) {
  console.error(`\nNo sites matched (tags=${tags || '—'}, ids=${ids || '—'}).`);
  console.error('Tag the features you want to publish in the app, then re-run.');
  process.exit(1);
}

const zipPath = resolve(tmpdir(), `sites-bundle-${process.pid}.zip`);
writeFileSync(zipPath, Buffer.from(await resp.arrayBuffer()));

// Replace wholesale, so untagging a feature in the app actually removes it.
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
execFileSync('unzip', ['-q', '-o', zipPath, '-d', target], { stdio: 'inherit' });
rmSync(zipPath, { force: true });

const manifest = JSON.parse(readFileSync(resolve(target, 'sites.json'), 'utf8'));
console.log(`\n▸ ${manifest.count} site(s) → public/sites/`);
for (const site of manifest.sites ?? []) {
  console.log(`   · ${site.name ?? '(unnamed)'} — ${site.images?.length ?? 0} image(s)`);
}
if (manifest.missing_images?.length) {
  console.warn(`\n   ${manifest.missing_images.length} referenced image(s) missing on the server`);
}

if (!doCommit) {
  console.log('\n--no-commit: leaving the working tree dirty.');
  process.exit(0);
}

const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8' });
git('add', 'public/sites');
if (!git('diff', '--cached', '--name-only').trim()) {
  console.log('\nNothing changed — already published.');
  process.exit(0);
}
git('commit', '-m', `chore: publish ${manifest.count} showcase site(s) [tags: ${tags || 'all'}]`);
console.log(`\n▸ committed ${git('rev-parse', '--short', 'HEAD').trim()}`);

if (doPush) {
  git('push');
  console.log('▸ pushed — Pages will rebuild in a couple of minutes');
} else {
  console.log('--no-push: commit made but not pushed.');
}
