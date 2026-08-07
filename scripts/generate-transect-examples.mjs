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

async function postJSON(path, body, { timeoutMs = 600_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`${path} → HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function build(example) {
  process.stdout.write(`\n▸ ${example.name}\n`);

  // 1. Sample the predicted vertical profile along the line. This is the slow
  //    part: it opens one COG per RH level, per sample point.
  process.stdout.write('  sampling profile … ');
  const started = Date.now();
  const sampleResp = await postJSON('/predictions/vertical-profile-line', {
    line_coordinates: example.line,
    year: YEAR,
    version: VERSION,
    q_index: Q_INDEX,
  });
  const sampled = await sampleResp.json();
  if (!sampled.success && sampled.error) throw new Error(`profile: ${sampled.error}`);

  // The per-sample `vertical_profile` field in the response is always null:
  // the profile curves come back in a separate top-level array, indexed by
  // sample index. /transect/figure expects them merged into each sample as
  // `profile`, so do the same join the app does in useMapInteractions.ts —
  // skip it and the figure renders with an empty heatmap panel and no error.
  const matrix = sampled.vertical_profile ?? [];
  const rawSamples = sampled.samples ?? [];
  if (!rawSamples.length) throw new Error('profile returned no samples');

  const samples = rawSamples.map((s) => ({
    lon: s.lon,
    lat: s.lat,
    distance_m: s.distance_m,
    profile: (matrix[s.index] ?? []).map((value, rh) => ({
      rh,
      value,
      missing: value == null,
    })),
    fhd: s.fhd ?? null,
    enl1d: s.enl1d ?? null,
    enl2d: s.enl2d ?? null,
    cr: s.cr ?? null,
  }));

  const withProfile = samples.filter((s) => s.profile.some((p) => p.value != null)).length;
  process.stdout.write(
    `${samples.length} points (${withProfile} with profile data) in ${((Date.now() - started) / 1000).toFixed(0)}s\n`,
  );
  if (withProfile === 0) throw new Error('every sample profile is empty — check the response shape');

  // 2. Render. The figure endpoint takes the samples verbatim — it does no
  //    sampling of its own, which is why step 1 cannot be skipped.
  process.stdout.write('  rendering figure … ');
  const figureResp = await postJSON('/transect/figure', {
    samples,
    x_axis: example.xAxis,
    include_map: true,
    include_heatmap: true,
    // The per-panel provenance badges collide with the colourbar legend at this
    // figure width; the story carries that information in the caption instead.
    show_panel_labels: false,
    dpi: 150,
    fmt: 'png',
  });
  const png = Buffer.from(await figureResp.arrayBuffer());

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, `${example.name}.png`);
  await writeFile(outPath, png);
  process.stdout.write(`${(png.length / 1024).toFixed(0)} KB → public/examples/${example.name}.png\n`);
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
