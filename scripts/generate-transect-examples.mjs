#!/usr/bin/env node
/**
 * Pre-render the transect figures used in the story.
 *
 *   API=https://map-explorer-api-....run.app node scripts/generate-transect-examples.mjs
 *
 * These are baked rather than rendered on demand for three reasons: a live
 * render is two calls deep (sample the profile along the line, then draw it)
 * and takes tens of seconds; it depends on source.coop, which is slow and
 * occasionally unavailable; and the story should show the transects that make
 * the point, not whichever line a reader happens to drag.
 *
 * Output lands in public/examples/, which Vite copies verbatim into every
 * build, so the story references them as ./examples/<name>.png.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = (process.env.API || '').replace(/\/+$/, '');
if (!API) {
  console.error('Set API=<backend url>');
  process.exit(1);
}

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'examples');

/**
 * Each example is a line of [lon, lat] vertices. Pick lines that cross a
 * structural boundary — the figure is only interesting where the profile
 * changes along it.
 */
const EXAMPLES = [
  {
    name: 'transect-amazon',
    label: 'Deforestation frontier, Mato Grosso, Brazil',
    line: [
      [-59.35, -14.90],
      [-59.20, -15.00],
    ],
    xAxis: 'lon',
  },
  // Add more here. Keep them short (a few km): sample_count is capped by the
  // backend and a very long line washes out the structure you are showing.
];

const YEAR = 2020;
const Q_INDEX = 1;
const VERSION = 'original';

import { renderTransect } from './lib/transect.mjs';

async function build(example) {
  process.stdout.write(`\n▸ ${example.name}\n  `);
  const { png, sampleCount, seconds } = await renderTransect(API, example.line, {
    year: YEAR,
    version: VERSION,
    qIndex: Q_INDEX,
    xAxis: example.xAxis,
    onProgress: (stage) => process.stdout.write(`${stage} … `),
  });
  await mkdir(OUT_DIR, { recursive: true });
  // WebP, not PNG: the figure is 1.5 MB as PNG and 225 KB here, with no
  // visible loss on the plot lines at this quality.
  const outPath = resolve(OUT_DIR, `${example.name}.webp`);
  await writeFile(outPath, png);
  process.stdout.write(
    `${sampleCount} pts, ${(png.length / 1024).toFixed(0)} KB, ${seconds.toFixed(0)}s → public/examples/${example.name}.webp\n`,
  );
}

let failures = 0;
for (const example of EXAMPLES) {
  try {
    await build(example);
  } catch (err) {
    failures += 1;
    process.stderr.write(`  FAILED: ${err.message}\n`);
  }
}

process.stdout.write(`\n${EXAMPLES.length - failures}/${EXAMPLES.length} generated\n`);
process.exit(failures ? 1 : 0);
