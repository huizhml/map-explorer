import type { VerticalProfileResponse } from '../../utils/verticalProfile';
import { NODATA, type Cube, type CubeMeta } from './cubeData';

/**
 * The point profile of any pixel in the cube window, computed in the browser.
 * Mirrors backend/utils.py so a pixel gives the same numbers as
 * /predictions/vertical-profile: profile_curve_points (binning + Savitzky-Golay)
 * and pixel_diversity_indices (FHD / CR). Keep the two in step.
 */

// backend/utils.py
const PROFILE_MIN_HEIGHT = -10;
const PROFILE_MAX_HEIGHT = 50;
const PROFILE_BIN_SIZE = 0.4;
const MAX_HEIGHT_METERS = 150;
const FHD_BIN_M = 5; // VerticalProfileRequest.fhd_interval default

/** RH0..RH100 in metres at one pixel; null = no data or level absent. */
export function columnRh(cube: Cube, row: number, col: number): (number | null)[] {
  const { size, rh_first, rh_last, missing_rh, failed_rh } = cube.meta;
  const out: (number | null)[] = [];
  for (let rh = 0; rh <= 100; rh++) {
    // The cube fills single gaps for display; the profile, like the backend's, does not.
    if (rh < rh_first || rh > rh_last || missing_rh.includes(rh) || failed_rh.includes(rh)) {
      out.push(null);
      continue;
    }
    const v = cube.raw[((rh - rh_first) * size + row) * size + col];
    // v / 10, not v * 0.1: the backend divides, and the bin edges below compare exactly.
    out.push(v === NODATA ? null : v / 10);
  }
  return out;
}

/** scipy.signal.savgol_filter(y, 5, 1), default mode='interp'. */
function savgol5linear(y: number[]): number[] {
  const n = y.length;
  if (n < 5) return y.slice();
  const out = new Array<number>(n);
  for (let i = 2; i < n - 2; i++) out[i] = (y[i - 2] + y[i - 1] + y[i] + y[i + 1] + y[i + 2]) / 5;
  // Edges: least-squares line through the first / last 5 samples, evaluated there.
  const fit = (s: number) => {
    const ys = y.slice(s, s + 5);
    const mean = ys.reduce((a, b) => a + b, 0) / 5;
    const slope = (-2 * ys[0] - ys[1] + ys[3] + 2 * ys[4]) / 10;
    return (x: number) => mean + slope * (x - 2);
  };
  const head = fit(0);
  const tail = fit(n - 5);
  out[0] = head(0);
  out[1] = head(1);
  out[n - 2] = tail(3);
  out[n - 1] = tail(4);
  return out;
}

/** utils.profile_curve_points */
function curvePoints(rhs: (number | null)[]) {
  const rh = rhs.filter((v): v is number => v !== null && Number.isFinite(v));
  if (rh.length < 3) return [];
  const start = PROFILE_MIN_HEIGHT + PROFILE_BIN_SIZE / 2;
  const nBins = Math.ceil((PROFILE_MAX_HEIGHT - start) / PROFILE_BIN_SIZE);
  // As np.arange: the step is (start + step) - start, which differs from 0.4
  // in the last bits, and the bin edges are compared exactly below.
  const step = start + PROFILE_BIN_SIZE - start;
  const centers: number[] = [];
  const amp: number[] = [];
  for (let b = 0; b < nBins; b++) {
    const hc = start + b * step;
    centers.push(hc);
    let a = 0;
    for (let i = 0; i < rh.length - 1; i++) {
      if (hc >= rh[i] && hc < rh[i + 1]) {
        const dh = rh[i + 1] - rh[i];
        a = dh > 0.01 ? 1 / dh : 0;
        break;
      }
    }
    amp.push(a);
  }
  const sum = amp.reduce((x, y) => x + y, 0);
  const pct = amp.map((a) => (a / sum) * 100);
  const smooth = savgol5linear(pct);
  const clean = (v: number) => (Number.isFinite(v) ? v : 0);
  const lo = Math.min(...rh);
  const hi = Math.max(...rh);
  const out: { z: number; value: number; binned: number }[] = [];
  centers.forEach((z, i) => {
    if (z < lo || z > hi) return;
    out.push({ z, value: clean(smooth[i]), binned: clean(pct[i]) });
  });
  return out;
}

type Diversity = { fhd: number | null; enl1d: number | null; enl2d: number | null; cr: number | null };
const NO_DIVERSITY: Diversity = { fhd: null, enl1d: null, enl2d: null, cr: null };

/** utils.pixel_diversity_indices: FHD, ENL (1D = exp(FHD), 2D = 1 / sum p^2) and CR. */
function diversity(rhs: (number | null)[]): Diversity {
  const vals = rhs.map((v) => (v === null ? NaN : Math.min(v, MAX_HEIGHT_METERS)));
  const nBins = Math.round(MAX_HEIGHT_METERS / FHD_BIN_M);
  const hist = new Array<number>(nBins).fill(0);
  let total = 0;
  for (const v of vals) {
    if (!Number.isFinite(v) || v < 0) continue;
    // np.histogram: the last bin includes its right edge.
    hist[Math.min(nBins - 1, Math.floor(v / FHD_BIN_M))] += 1;
    total += 1;
  }
  let fhd: number | null = null;
  let enl2d: number | null = null;
  if (total > 0) {
    fhd = 0;
    let sumP2 = 0;
    for (const h of hist) {
      if (!h) continue;
      const p = h / total;
      fhd -= p * Math.log(p);
      sumP2 += p * p;
    }
    enl2d = 1 / sumP2;
  }
  const rh25 = vals[25];
  const rh98 = vals[98];
  const cr = Number.isFinite(rh25) && Number.isFinite(rh98) && rh98 > 0 ? (rh98 - Math.max(rh25, 0)) / rh98 : null;
  return { fhd, enl1d: fhd === null ? null : Math.exp(fhd), enl2d, cr };
}

/** The same shape as /predictions/vertical-profile, for the card's charts. */
export function profileAt(cube: Cube, row: number, col: number): VerticalProfileResponse {
  const rhs = columnRh(cube, row, col);
  const valid = rhs.filter((v) => v !== null).length;
  const div = valid >= 3 ? diversity(rhs) : NO_DIVERSITY;
  return {
    success: true,
    tile_name: cube.meta.tile,
    year: cube.meta.year,
    profile: rhs.map((value, rh) => ({ rh, value, missing: cube.meta.missing_rh.includes(rh) })),
    vertical_profile_curve: valid >= 3 ? curvePoints(rhs) : [],
    ...div,
    profile_y_min: PROFILE_MIN_HEIGHT,
    profile_y_max: PROFILE_MAX_HEIGHT,
  };
}

// ---------------------------------------------------- window <-> lon/lat ----

/**
 * Over 1.28 km the UTM -> lon/lat mapping is affine to far below a pixel, so
 * the window's corners are enough to go both ways without a projection
 * library. u = fraction east from the W edge, v = fraction south from the N edge.
 */
export function pixelAt(meta: CubeMeta, lon: number, lat: number): { row: number; col: number; inside: boolean } {
  const [nw, ne, , sw] = meta.footprint;
  const ax = ne[0] - nw[0], ay = ne[1] - nw[1];
  const bx = sw[0] - nw[0], by = sw[1] - nw[1];
  const dx = lon - nw[0], dy = lat - nw[1];
  const det = ax * by - ay * bx;
  const u = (dx * by - dy * bx) / det;
  const v = (ax * dy - ay * dx) / det;
  const n = meta.size;
  const clamp = (x: number) => Math.max(0, Math.min(n - 1, Math.floor(x * n)));
  return { col: clamp(u), row: clamp(v), inside: u >= 0 && u < 1 && v >= 0 && v < 1 };
}

/** Centre of a window pixel as [lon, lat]. */
export function pixelCentre(meta: CubeMeta, row: number, col: number): [number, number] {
  const [nw, ne, , sw] = meta.footprint;
  const u = (col + 0.5) / meta.size;
  const v = (row + 0.5) / meta.size;
  return [nw[0] + (ne[0] - nw[0]) * u + (sw[0] - nw[0]) * v, nw[1] + (ne[1] - nw[1]) * u + (sw[1] - nw[1]) * v];
}
