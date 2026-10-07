// Spike: can the browser read the native 10 m COGs directly, across UTM zones,
// and composite them into one Web Mercator view?
//
// Two adjacent MGRS tiles straddling the zone 20 / zone 21 boundary in the
// Amazon (lon -59.5, lat -7.7). If OL's DataTile reprojection works, the seam
// between them should be invisible. Throwaway — delete when the question is
// answered.
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import GeoTIFF from 'ol/source/GeoTIFF.js';
import WebGLTileLayer from 'ol/layer/WebGLTile.js';
import { fromLonLat } from 'ol/proj.js';

const BASE = 'https://data.source.coop/geoai-ucph/gvsm/2020';
const TILES = ['20MRS', '21MTM'];
const SEAM = [-59.503, -7.725];
const ZOOM = Number(new URLSearchParams(location.search).get('z') ?? 11);

// What a viewport actually costs the reviewer: every range request the browser
// makes to source.coop, and the bytes over the wire.
let reqs = 0;
let bytes = 0;
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    if (!e.name.includes('source.coop')) continue;
    reqs++;
    bytes += e.transferSize || e.encodedBodySize || 0;
  }
  render();
}).observe({ type: 'resource', buffered: true });

const el = document.getElementById('status');
const log = [];
const t0 = performance.now();
let loading = 0;
let loaded = 0;
let errors = 0;
let firstPaint = null;

const secs = () => ((performance.now() - t0) / 1000).toFixed(1);

function render() {
  el.textContent = [
    `zoom:${ZOOM}  tiles:${loaded}  errors:${errors}`,
    `range-requests:${reqs}  over the wire:${(bytes / 1048576).toFixed(2)} MB`,
    ...log.slice(-14),
  ].join('\n');
}
function note(msg) {
  log.push(`${secs()}s ${msg}`);
  render();
}

// Heights are int16 with nodata 32767. Keep raw values (normalize: false) and
// drop nodata in the colour expression rather than relying on an alpha band.
const ramp = [
  'interpolate', ['linear'], ['band', 1],
  0, [8, 8, 30, 1],
  80, [120, 28, 109, 1],
  180, [227, 87, 62, 1],
  300, [251, 200, 90, 1],
  450, [252, 255, 190, 1],
];
// Reprojected tiles are padded with 0 outside the source footprint, and 0 is a
// legitimate colour in the ramp — so pad and nodata both have to be masked out,
// otherwise the padding paints an opaque band over the neighbouring tile.
const style = {
  color: [
    'case',
    ['any', ['<=', ['band', 1], 0], ['>', ['band', 1], 900]],
    [0, 0, 0, 0],
    ramp,
  ],
};

const layers = TILES.map((name) => {
  const source = new GeoTIFF({
    sources: [{ url: `${BASE}/${name}/RH98_Q1.tif` }],
    normalize: false,
    interpolate: false,
    convertToRGB: false,
  });

  source.on('tileloadstart', () => { loading++; render(); });
  source.on('tileloadend', () => {
    loading--;
    loaded++;
    if (!firstPaint) firstPaint = secs();
    render();
  });
  source.on('tileloaderror', () => { loading--; errors++; note(`${name} TILE ERROR`); });

  source.getView()
    .then((v) => {
      const code = v.projection?.getCode?.() ?? v.projection;
      note(`${name} header ok  proj=${code}`);
    })
    .catch((e) => { errors++; note(`${name} header FAILED: ${e.message}`); });

  return new WebGLTileLayer({ source, style });
});

new Map({
  target: 'map',
  layers,
  view: new View({
    projection: 'EPSG:3857',
    center: fromLonLat(SEAM),
    zoom: ZOOM,
  }),
});

note(`view EPSG:3857, seam at ${SEAM.join(', ')}`);
window.addEventListener('error', (e) => { errors++; note(`JS ERROR: ${e.message}`); });
window.addEventListener('unhandledrejection', (e) => {
  errors++;
  note(`REJECTED: ${e.reason?.message ?? e.reason}`);
});
