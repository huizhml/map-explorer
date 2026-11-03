import { apiUrl } from '../../utils/apiBase';

/**
 * The VSM datacube around one click: RH0..RH100 in a 128 x 128 px (1.28 km)
 * window, read by GET /predictions/cube (backend/cube_window.py).
 *
 * No three.js here: this module is part of the explorer's main bundle, so the
 * cube can be requested on the same click as the profile, while the 3D view
 * itself loads on demand.
 */

export const NODATA = 32767;

export type CubeMeta = {
  tile: string;
  year: number;
  q_index: number;
  lon: number;
  lat: number;
  size: number;
  rh_first: number;
  rh_last: number;
  scale: number;
  res_m: [number, number];
  /** Window CRS (the tile's UTM zone) and bounds in it: left, bottom, right, top. */
  crs: string;
  bounds: [number, number, number, number];
  /** NW, NE, SE, SW corners as [lon, lat]. */
  footprint: [number, number][];
  /** Clicked pixel inside the window; row 0 = north edge. */
  click: { row: number; col: number };
  /** How far the window centre moved from the clicked pixel, and why. */
  shift: { east_m: number; north_m: number; reason: 'block' | 'tile' | null; block_px: [number, number] };
  missing_rh: number[];
  failed_rh: number[];
  interpolated_rh: number[];
};

export type Cube = {
  meta: CubeMeta;
  /** int16 [rh][row][col], decimetres, NODATA = 32767, rh from meta.rh_first. */
  raw: Int16Array;
};

export async function fetchCube(lon: number, lat: number, year: number, signal?: AbortSignal): Promise<Cube> {
  const r = await fetch(apiUrl(`/predictions/cube?lon=${lon}&lat=${lat}&year=${year}`), { signal });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return parseCube(await r.arrayBuffer());
}

/** "VSMC" | uint32 LE header length | JSON header | int16 LE data. */
export function parseCube(buf: ArrayBuffer): Cube {
  const head = new Uint8Array(buf, 0, 8);
  if (String.fromCharCode(...head.subarray(0, 4)) !== 'VSMC') throw new Error('not a VSM cube response');
  const n = new DataView(buf).getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n))) as CubeMeta;
  const levels = meta.rh_last - meta.rh_first + 1;
  const raw = new Int16Array(buf, 8 + n, levels * meta.size * meta.size);
  return { meta, raw };
}

// ------------------------------------------------------------- volumes ----

export type ZMode = 'energy' | 'rh' | 'surfaces';

/**
 * What the 3D view draws. data[(iz * ny + iy) * nx + ix], iy grows northwards
 * (raster row 0 is the north edge, so iy = n - 1 - row).
 */
export type Volume = {
  nx: number;
  ny: number;
  nz: number;
  data: Float32Array;
  /** RH98 per column, metres; Energy mode only (the top face shows it). */
  canopy?: Float32Array;
  vmax: number;
  unit: string;
  cbarTitle: string;
  zName: string;
  zLabel: (iz: number) => string;
  zTop: string;
  zBottom: string;
  fmt: (v: number) => string;
};

function level(cube: Cube, rh: number, row: number, col: number): number {
  const n = cube.meta.size;
  return cube.raw[((rh - cube.meta.rh_first) * n + row) * n + col];
}

function canopyMap(cube: Cube): Float32Array {
  const n = cube.meta.size;
  const out = new Float32Array(n * n);
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++) {
      const v = level(cube, 98, row, col);
      out[(n - 1 - row) * n + col] = v === NODATA ? NaN : v * cube.meta.scale;
    }
  return out;
}

/** z = RH1 (bottom) .. RH100 (top); colour = height of that RH. */
export function rhVolume(cube: Cube): Volume {
  const n = cube.meta.size;
  const nz = 100;
  const data = new Float32Array(nz * n * n);
  for (let iz = 0; iz < nz; iz++)
    for (let row = 0; row < n; row++) {
      const iy = n - 1 - row;
      for (let col = 0; col < n; col++) {
        const v = level(cube, iz + 1, row, col);
        data[(iz * n + iy) * n + col] = v === NODATA ? NaN : v * cube.meta.scale;
      }
    }
  return {
    nx: n,
    ny: n,
    nz,
    data,
    vmax: 50,
    unit: 'm',
    cbarTitle: 'height',
    zName: 'Relative height',
    zLabel: (iz) => `RH${iz + 1}`,
    zTop: 'RH100',
    zBottom: 'RH1',
    fmt: (v) => `${v.toFixed(1)} m`,
  };
}

/**
 * z = height above ground in 1 m bins (0-50 m); colour = share of the RH1..RH100
 * levels that fall in the bin, i.e. the energy share. Same maths as the backend's
 * pixel_hist(interval=1, min_height=0, max_height=50): RH <= 0 is dropped and
 * anything above 50 m goes into the top bin. One RH = 1 %.
 */
export function energyVolume(cube: Cube): Volume {
  const n = cube.meta.size;
  const nz = 50;
  const data = new Float32Array(nz * n * n);
  for (let row = 0; row < n; row++) {
    const iy = n - 1 - row;
    for (let col = 0; col < n; col++) {
      let valid = false;
      for (let rh = 1; rh <= 100; rh++) {
        const v = level(cube, rh, row, col);
        if (v === NODATA) continue;
        valid = true;
        const h = v * cube.meta.scale;
        if (h <= 0) continue;
        const b = Math.min(nz - 1, Math.floor(h));
        data[(b * n + iy) * n + col] += 1;
      }
      if (!valid) for (let b = 0; b < nz; b++) data[(b * n + iy) * n + col] = NaN;
    }
  }
  return {
    nx: n,
    ny: n,
    nz,
    data,
    canopy: canopyMap(cube),
    vmax: 12,
    unit: '%',
    cbarTitle: 'energy share per 1 m bin',
    zName: 'Height',
    zLabel: (iz) => `${iz}–${iz + 1} m`,
    zTop: '50 m',
    zBottom: '0 m',
    fmt: (v) => `${v.toFixed(0)} %`,
  };
}

/**
 * RH surfaces: the same 0–50 m height axis as Energy, but drawn as one surface
 * per RH (SurfaceStack.ts), so there is no voxel data.
 */
export function surfaceVolume(cube: Cube): Volume {
  const n = cube.meta.size;
  return {
    nx: n,
    ny: n,
    nz: 50,
    data: new Float32Array(0),
    vmax: 50,
    unit: 'm',
    cbarTitle: 'RH',
    zName: 'Height',
    zLabel: (iz) => `${iz + 1} m`,
    zTop: '50 m',
    zBottom: '0 m',
    fmt: (v) => `${v.toFixed(1)} m`,
  };
}

/** Plain-language note when the window is not centred on the click. */
/** Why the window is off-centre: one line, and the reason behind it (shown on request). */
export function shiftNote(meta: CubeMeta): string | null {
  const { east_m, north_m, reason, block_px } = meta.shift;
  if (!reason) return null;
  const parts: string[] = [];
  if (east_m) parts.push(`${Math.abs(east_m).toFixed(0)} m ${east_m > 0 ? 'east' : 'west'}`);
  if (north_m) parts.push(`${Math.abs(north_m).toFixed(0)} m ${north_m > 0 ? 'north' : 'south'}`);
  const moved = `Window moved ${parts.join(' and ')}`;
  const offCentre = 'so the clicked point (green line) is off-centre.';
  if (reason === 'tile') return `${moved} to stay inside Sentinel-2 tile ${meta.tile}, ${offCentre}`;
  const km = ((block_px[0] * meta.res_m[0]) / 1000).toFixed(2);
  // The data are stored in blocks: one block per RH instead of 2–4 when the window crosses an edge.
  return `${moved} to stay inside one ${km} km data block (one read per RH instead of 2–4), ${offCentre}`;
}
