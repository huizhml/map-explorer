import { apiUrl } from '../../utils/apiBase';
import type { CubeMeta } from './cubeData';

/**
 * Imagery for the ground under the 3D cube, warped onto the cube's window
 * (row 0 = north edge, the same frame as the voxels).
 *
 *   s2      Sentinel-2 L2A true colour of the VSM year, cloud-free over the
 *           window, from the backend (/sentinel2/window-image). 10 m.
 *   esri    Esri World Imagery tiles, ~1 m, stitched here — the explorer's
 *           satellite basemap too. Sharper, but undated and usually later than
 *           the VSM year. (Not Google: its tiles may not be used on a public
 *           site without a key.)
 */

export type GroundSource = 's2' | 'esri' | 'off';

export type Ground = {
  image: CanvasImageSource & { width: number; height: number };
  /** Shown next to the image: when and from where. */
  credit: string;
  date?: string;
  note?: string;
};

export async function sentinel2Ground(meta: CubeMeta, signal?: AbortSignal): Promise<Ground> {
  const r = await fetch(
    apiUrl(`/sentinel2/window-image?crs=${encodeURIComponent(meta.crs)}&bounds=${meta.bounds.join(',')}&year=${meta.year}&size=512`),
    { signal },
  );
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.image) throw new Error(body.error ?? `HTTP ${r.status}`);
  const image = await loadImage(body.image);
  const cloudy = body.cloud_fraction > 0 ? ` · ${Math.round(body.cloud_fraction * 100)} % cloud in the window` : '';
  return {
    image,
    date: body.date,
    credit: `Sentinel-2 L2A ${body.date} · Copernicus / ESA, via Microsoft Planetary Computer`,
    note: cloudy ? `No cloud-free scene in ${meta.year}${cloudy}` : undefined,
  };
}

const ESRI = (x: number, y: number, z: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

/** Esri World Imagery at zoom 17 (~1.2 m at the equator), resampled onto the window. */
export async function esriGround(meta: CubeMeta, size = 1024, z = 17): Promise<Ground> {
  const fp = meta.footprint;
  const world = (lon: number, lat: number): [number, number] => {
    const s = Math.sin((lat * Math.PI) / 180);
    const n = 256 * 2 ** z;
    return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  };
  const px = fp.map(([lon, lat]) => world(lon, lat));
  const tx0 = Math.floor(Math.min(...px.map((p) => p[0])) / 256);
  const tx1 = Math.floor(Math.max(...px.map((p) => p[0])) / 256);
  const ty0 = Math.floor(Math.min(...px.map((p) => p[1])) / 256);
  const ty1 = Math.floor(Math.max(...px.map((p) => p[1])) / 256);

  const mosaic = document.createElement('canvas');
  mosaic.width = (tx1 - tx0 + 1) * 256;
  mosaic.height = (ty1 - ty0 + 1) * 256;
  const mctx = mosaic.getContext('2d', { willReadFrequently: true })!;
  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      jobs.push(loadImage(ESRI(tx, ty, z)).then((img) => mctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256)));
  await Promise.all(jobs);
  const src = mctx.getImageData(0, 0, mosaic.width, mosaic.height).data;

  // Each output pixel -> lon/lat (bilinear over the window corners) -> tile pixel.
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const octx = out.getContext('2d')!;
  const img = octx.createImageData(size, size);
  const [nw, ne, se, sw] = fp;
  for (let j = 0; j < size; j++) {
    const v = (j + 0.5) / size;
    const l0 = [nw[0] + (sw[0] - nw[0]) * v, nw[1] + (sw[1] - nw[1]) * v];
    const l1 = [ne[0] + (se[0] - ne[0]) * v, ne[1] + (se[1] - ne[1]) * v];
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size;
      const [wx, wy] = world(l0[0] + (l1[0] - l0[0]) * u, l0[1] + (l1[1] - l0[1]) * u);
      const sx = Math.min(mosaic.width - 1, Math.max(0, Math.floor(wx - tx0 * 256)));
      const sy = Math.min(mosaic.height - 1, Math.max(0, Math.floor(wy - ty0 * 256)));
      const s = (sy * mosaic.width + sx) * 4;
      const o = (j * size + i) * 4;
      img.data[o] = src[s];
      img.data[o + 1] = src[s + 1];
      img.data[o + 2] = src[s + 2];
      img.data[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return {
    image: out,
    credit:
      'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community · date unknown, usually later than the VSM year',
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src.slice(0, 60)}`));
    img.src = src;
  });
}

/** Under each overview image: what it is. Esri's lack of a date is in its credit line. */
export function groundCaption(source: GroundSource, g: Ground): string {
  return source === 's2' ? `Sentinel-2 · ${g.date ?? ''}` : 'Esri World Imagery · ~1 m';
}
