// Spike 2: how does client-side COG reading behave when a viewport spans many
// MGRS tiles at once — the real case, not the two-tile toy.
//
// Mirrors useAutoLoadVSM's selection: derive the visible tile names from the
// MGRS grid, then open one COG per (tile, RH). The question is where this
// falls over — WebGL contexts, concurrent range requests, or memory.
//
//   ?z=9&rh=98        one layer, ~12 tiles
//   ?z=9&rh=98,50,25  three layers, ~36 COGs open at once
//
// Throwaway.
import OLMap from 'ol/Map.js';
import View from 'ol/View.js';
import GeoTIFF from 'ol/source/GeoTIFF.js';
import WebGLTileLayer from 'ol/layer/WebGLTile.js';
import VectorSource from 'ol/source/Vector.js';
import { fromLonLat } from 'ol/proj.js';
import { deserialize } from 'flatgeobuf/lib/mjs/ol';

const BASE = 'https://data.source.coop/geoai-ucph/gvsm/2020';
const GRID = '/deploy/data/s2_grid.fgb';

const params = new URLSearchParams(location.search);
const ZOOM = Number(params.get('z') ?? 9);
const RHS = (params.get('rh') ?? '98').split(',').map(Number);
const CENTER = [
  Number(params.get('lon') ?? -59.5),
  Number(params.get('lat') ?? -7.7),
];
const DISPOSE = params.get('dispose') !== '0';
const CYCLES = Number(params.get('cycles') ?? 0);
// OL's per-layer tile cache defaults to 512 textures. That is sized for a map
// with one or two tile layers; here there is one layer per COG, so the budget
// has to be divided across them rather than repeated.
const CACHE = Number(params.get('cache') ?? 512);

const el = document.getElementById('status');
const t0 = performance.now();
const log = [];
let visible = 0;
let opened = 0;
let headerFails = 0;
let tilesLoaded = 0;
let tileErrors = 0;
let peak = 0;
let created = 0;
let disposed = 0;
let cycle = 0;
const heap = [];
const mb = (b) => (b / 1048576).toFixed(0);
function sampleHeap() {
  const m = performance.memory;
  if (m) heap.push(m.usedJSHeapSize);
}

const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
function render() {
  el.textContent = [
    `zoom:${ZOOM}  RH:${RHS.join(',')}`,
    `visible MGRS tiles:${visible}   COG layers open:${opened}  (peak ${peak})`,
    `raster tiles drawn:${tilesLoaded}  tile errors:${tileErrors}  header fails:${headerFails}`,
    `sources created:${created}  disposed:${disposed}  cacheSize/layer:${CACHE}`,
    heap.length
      ? `heap MB  start:${mb(heap[0])}  peak:${mb(Math.max(...heap))}  now:${mb(heap[heap.length - 1])}` +
        `   cycles done:${cycle}/${CYCLES}`
      : `cycles done:${cycle}/${CYCLES}`,
    '',
    ...log.slice(-10),
  ].join('\n');
}
function note(m) {
  log.push(`${secs()}s ${m}`);
  render();
}

const ramp = [
  'interpolate', ['linear'], ['band', 1],
  0, [8, 8, 30, 1], 80, [120, 28, 109, 1], 180, [227, 87, 62, 1],
  300, [251, 200, 90, 1], 450, [252, 255, 190, 1],
];
// Both the reprojection padding (0) and nodata (32767) must be masked, or the
// padding paints an opaque band over the neighbouring tile.
const style = {
  color: [
    'case',
    ['any', ['<=', ['band', 1], 0], ['>', ['band', 1], 900]],
    [0, 0, 0, 0],
    ramp,
  ],
};

const map = new OLMap({
  target: 'map',
  layers: [],
  view: new View({ projection: 'EPSG:3857', center: fromLonLat(CENTER), zoom: ZOOM }),
});

const gridSource = new VectorSource();
const active = new Map();

function sync() {
  const extent = map.getView().calculateExtent(map.getSize());
  const names = new Set();
  gridSource.forEachFeatureInExtent(extent, (f) => {
    const n = f.get('Name');
    if (n) names.add(n);
  });
  visible = names.size;

  const wanted = new Set();
  for (const name of names) {
    for (const rh of RHS) wanted.add(`${rh}|${name}`);
  }

  for (const [key, layer] of active) {
    if (!wanted.has(key)) {
      map.removeLayer(layer);
      // Removing a layer does not free its tile cache, its WebGL textures, or
      // the geotiff.js instance behind the source. Without an explicit dispose
      // those accumulate across every pan and zoom.
      if (DISPOSE) {
        layer.getSource()?.dispose();
        layer.dispose();
        disposed++;
      }
      active.delete(key);
    }
  }

  for (const key of wanted) {
    if (active.has(key)) continue;
    const [rh, name] = key.split('|');
    const feature = gridSource.getFeatures().find((f) => f.get('Name') === name);
    const source = new GeoTIFF({
      sources: [{ url: `${BASE}/${name}/RH${rh}_Q1.tif` }],
      normalize: false,
      interpolate: false,
      convertToRGB: false,
    });
    source.on('tileloadend', () => { tilesLoaded++; render(); });
    source.on('tileloaderror', () => { tileErrors++; render(); });
    source.getView().catch((e) => {
      headerFails++;
      note(`${key} header failed: ${e.message}`);
    });
    const layer = new WebGLTileLayer({
      source,
      style,
      cacheSize: CACHE,
      extent: feature ? feature.getGeometry().getExtent() : undefined,
    });
    map.addLayer(layer);
    active.set(key, layer);
    created++;
  }

  opened = active.size;
  peak = Math.max(peak, opened);
  render();
}

map.on('moveend', sync);
window.addEventListener('error', (e) => note(`JS ERROR: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  note(`REJECTED: ${e.reason?.message ?? e.reason}`),
);

(async () => {
  const buf = await (await fetch(GRID)).arrayBuffer();
  const iter = deserialize(
    new Uint8Array(buf), undefined, undefined, false, {}, false, 'EPSG:4326', 'EPSG:3857',
  );
  let n = 0;
  for await (const f of iter) { gridSource.addFeature(f); n++; }
  note(`grid loaded: ${n} features`);
  sync();
  sampleHeap();

  // Zoom/pan cycling: the thing a reviewer actually does, repeated, to see
  // whether cost accumulates or stays flat.
  const view = map.getView();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < CYCLES; i++) {
    view.setZoom(ZOOM + (i % 2 === 0 ? 2 : 0));
    view.setCenter(fromLonLat([CENTER[0] + (i % 4) * 0.15, CENTER[1] - (i % 3) * 0.15]));
    await wait(1200);
    sync();
    sampleHeap();
    cycle = i + 1;
    render();
  }
  note(CYCLES ? `finished ${CYCLES} zoom/pan cycles` : 'no cycling requested');
})().catch((e) => note(`grid FAILED: ${e.message}`));
