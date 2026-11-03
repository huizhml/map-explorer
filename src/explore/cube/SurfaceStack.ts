import * as THREE from 'three';
import { NODATA, type Cube } from './cubeData';

/**
 * "RH surfaces": every tenth RH (RH10 … RH100) drawn as a height surface
 * over the window, z = that level's height above ground, one colour per level.
 * The sheets are see-through, so the lower levels show under the canopy, and
 * the cutaway box clips them; along the cut faces each level is also drawn as
 * a line in its colour, so a cut reads as a transect of the RH.
 *
 * Index space as in CubeScene: x = column, y = row from the south edge, z in
 * metres (1 unit = 1 m, the Energy mode's 0–50 m axis).
 *
 * The surface passes through the pixel corners, each the mean of the pixels
 * around it; a pixel without data leaves a hole. Tooltips read the pixel's own
 * value, not the smoothed corner.
 */

export const SURFACE_RH = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
/** matplotlib turbo, sampled 0.08–0.92: ordered low (blue) to high (red), no pale middle to vanish on white. */
export const SURFACE_COLOURS = [
  '#424bb5', '#458afc', '#22c5e2', '#27eea4', '#7dff56',
  '#c1f334', '#f2c93a', '#fd8d27', '#e7490c', '#b71d02',
];
/** Lifts each level a little over the one below, so levels that coincide (bare ground: all ~0 m) do not flicker. */
const LIFT_M = 0.05;

export type SurfaceHit = {
  entryAxis: 'x' | 'y' | 'z';
  hit: { rh: number; ix: number; iy: number; value: number } | null;
};

type Layer = {
  rh: number;
  colour: string;
  /** Pixel heights in metres, [iy * n + ix], NaN = no data. */
  pix: Float32Array;
  /** Corner heights as drawn (lifted, floored at 0), [j * (n + 1) + i], NaN = no pixel around. */
  corner: Float32Array;
  /** Mean drawn height, for ordering the sheets by distance from the camera. */
  meanZ: number;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
};

function heights(cube: Cube, rh: number): Float32Array {
  const n = cube.meta.size;
  const out = new Float32Array(n * n);
  const off = (rh - cube.meta.rh_first) * n * n;
  for (let row = 0; row < n; row++) {
    const iy = n - 1 - row;
    for (let col = 0; col < n; col++) {
      const v = cube.raw[off + row * n + col];
      out[iy * n + col] = v === NODATA ? NaN : v * cube.meta.scale;
    }
  }
  return out;
}

function corners(pix: Float32Array, n: number, lift: number): Float32Array {
  const m = n + 1;
  const out = new Float32Array(m * m);
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      let s = 0;
      let k = 0;
      for (const [x, y] of [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]]) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const v = pix[y * n + x];
        if (Number.isNaN(v)) continue;
        s += v;
        k++;
      }
      out[j * m + i] = k ? Math.max(0, s / k) + lift : NaN;
    }
  return out;
}

export class SurfaceStack {
  readonly group = new THREE.Group();
  private layers: Layer[] = [];
  private n: number;
  /** Kept box: x <= x1, y >= y0, z0 <= z <= z1 (index space), and the same planes in world space for the materials. */
  private box = { x1: 0, y0: 0, z0: 0, z1: 0 };
  private clipWorld = [new THREE.Plane(), new THREE.Plane(), new THREE.Plane(), new THREE.Plane()];

  constructor(cube: Cube, opacity: number, hidden: ReadonlySet<number>) {
    const n = (this.n = cube.meta.size);
    const m = n + 1;
    // One shared grid of corner positions per level; z filled per level.
    const xy = new Float32Array(m * m * 2);
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        xy[(j * m + i) * 2] = i;
        xy[(j * m + i) * 2 + 1] = j;
      }

    SURFACE_RH.forEach((rh, li) => {
      if (rh < cube.meta.rh_first || rh > cube.meta.rh_last) return;
      const pix = heights(cube, rh);
      const corner = corners(pix, n, li * LIFT_M);
      const pos = new Float32Array(m * m * 3);
      for (let k = 0; k < m * m; k++) {
        pos[k * 3] = xy[k * 2];
        pos[k * 3 + 1] = xy[k * 2 + 1];
        pos[k * 3 + 2] = Number.isNaN(corner[k]) ? 0 : corner[k];
      }
      // Two triangles per pixel with data; the same split as `pick` tests.
      const idx: number[] = [];
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          if (Number.isNaN(pix[j * n + i])) continue;
          const a = j * m + i;
          idx.push(a, a + 1, a + m + 1, a, a + m + 1, a + m);
        }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geom.setIndex(idx);
      geom.computeVertexNormals();
      const colour = SURFACE_COLOURS[li];
      const mesh = new THREE.Mesh(
        geom,
        new THREE.MeshLambertMaterial({
          color: colour,
          transparent: true,
          opacity,
          // Not written to depth, drawn far to near (`sortFor`): each sheet
          // tints the ones behind it instead of hiding them.
          depthWrite: false,
          side: THREE.DoubleSide,
          clippingPlanes: this.clipWorld,
        }),
      );
      mesh.renderOrder = 1 + li;
      mesh.visible = !hidden.has(rh);
      const lines = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        // Transparent only to be drawn with the sheets, after them (renderOrder):
        // otherwise the sheets in front would tint the cut lines away.
        new THREE.LineBasicMaterial({ color: colour, transparent: true }),
      );
      lines.renderOrder = 15;
      lines.visible = mesh.visible;
      this.group.add(mesh, lines);
      let sum = 0;
      let cnt = 0;
      for (const v of corner) {
        if (Number.isNaN(v)) continue;
        sum += v;
        cnt++;
      }
      this.layers.push({ rh, colour, pix, corner, meanZ: cnt ? sum / cnt : 0, mesh, lines });
    });
  }

  /** The kept part of the box, [0, x1] x [y0, n] x [z0, z1]; `toWorld` = the index-space group's matrixWorld. */
  update(x1: number, y0: number, z0: number, z1: number, toWorld: THREE.Matrix4) {
    const b = this.box;
    const moved = b.x1 !== x1 || b.y0 !== y0 || b.z0 !== z0 || b.z1 !== z1;
    this.box = { x1, y0, z0, z1 };
    // Signed distance >= 0 is kept.
    const local = [
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), x1),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -y0),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), z1),
      // The bottom cut: raised, it drops the low levels of bare ground and grass.
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -z0),
    ];
    local.forEach((p, k) => this.clipWorld[k].copy(p).applyMatrix4(toWorld));
    if (moved) for (const l of this.layers) this.cutLines(l);
  }

  /** Each level along the south (y = y0) and east (x = x1) cut faces, between the bottom and top cuts. */
  private cutLines(l: Layer) {
    const { x1, y0, z0, z1 } = this.box;
    const m = this.n + 1;
    const pts: number[] = [];
    const seg = (i0: number, j0: number, i1: number, j1: number) => {
      const a = l.corner[j0 * m + i0];
      const c = l.corner[j1 * m + i1];
      if (Number.isNaN(a) || Number.isNaN(c) || a > z1 || c > z1 || a < z0 || c < z0) return;
      pts.push(i0, j0, a, i1, j1, c);
    };
    for (let i = 0; i < x1; i++) seg(i, y0, i + 1, y0);
    for (let j = y0; j < this.n; j++) seg(x1, j, x1, j + 1);
    l.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    l.lines.geometry.computeBoundingSphere();
  }

  /**
   * Transparent sheets blend correctly only when drawn back to front. They are
   * stacked in height, so the farthest from the camera's height goes first:
   * RH10 first seen from above, RH100 first seen from below.
   */
  sortFor(camZ: number) {
    [...this.layers]
      .sort((a, b) => Math.abs(b.meanZ - camZ) - Math.abs(a.meanZ - camZ))
      .forEach((l, i) => (l.mesh.renderOrder = 1 + i));
  }

  setOpacity(opacity: number) {
    for (const l of this.layers) l.mesh.material.opacity = opacity;
  }

  setHidden(hidden: ReadonlySet<number>) {
    for (const l of this.layers) l.mesh.visible = l.lines.visible = !hidden.has(l.rh);
  }

  /**
   * The first visible surface a ray (index space) meets inside the kept box:
   * walks the pixel columns along the ray, nearest first, and tests the two
   * triangles of each visible level in that column.
   */
  pick(ro: THREE.Vector3, rd: THREE.Vector3): SurfaceHit | null {
    const { x1, y0, z0, z1 } = this.box;
    const n = this.n;
    const lo = [0, y0, z0 - 0.01];
    const hi = [x1, n, z1 + 0.01];
    const o = [ro.x, ro.y, ro.z];
    const d = [rd.x, rd.y, rd.z];
    let tn = -Infinity;
    let tf = Infinity;
    let entry = 2;
    for (let k = 0; k < 3; k++) {
      const a = (lo[k] - o[k]) / d[k];
      const b = (hi[k] - o[k]) / d[k];
      if (Math.min(a, b) > tn) {
        tn = Math.min(a, b);
        entry = k;
      }
      tf = Math.min(tf, Math.max(a, b));
    }
    if (!(tf > Math.max(tn, 0))) return null;
    const entryAxis = (['x', 'y', 'z'] as const)[entry];

    const layers = this.layers.filter((l) => l.mesh.visible);
    const ray = new THREE.Ray(ro, rd);
    const A = new THREE.Vector3();
    const B = new THREE.Vector3();
    const C = new THREE.Vector3();
    const D = new THREE.Vector3();
    const P = new THREE.Vector3();
    const m = n + 1;
    const corner = (l: Layer, i: number, j: number, v: THREE.Vector3) => v.set(i, j, l.corner[j * m + i]);

    // 2D walk over the pixel columns (Amanatides–Woo, x and y only).
    let t = Math.max(tn, 0);
    let ix = Math.min(x1 - 1, Math.max(0, Math.floor(o[0] + d[0] * (t + 1e-6))));
    let iy = Math.min(n - 1, Math.max(y0, Math.floor(o[1] + d[1] * (t + 1e-6))));
    const sx = Math.sign(d[0]);
    const sy = Math.sign(d[1]);
    const dx = Math.abs(1 / d[0]);
    const dy = Math.abs(1 / d[1]);
    let nx = (ix + Math.max(sx, 0) - o[0]) / d[0];
    let ny = (iy + Math.max(sy, 0) - o[1]) / d[1];
    if (!sx) nx = Infinity;
    if (!sy) ny = Infinity;
    for (let step = 0; step < 4 * n && t <= tf; step++) {
      let best: { l: Layer; t: number } | null = null;
      for (const l of layers) {
        if (Number.isNaN(l.pix[iy * n + ix])) continue;
        corner(l, ix, iy, A);
        corner(l, ix + 1, iy, B);
        corner(l, ix + 1, iy + 1, C);
        corner(l, ix, iy + 1, D);
        for (const [p, q, r] of [[A, B, C], [A, C, D]]) {
          if (!ray.intersectTriangle(p, q, r, false, P) || P.z > z1 || P.z < z0) continue;
          const th = P.distanceTo(ro) / rd.length();
          if (th >= Math.max(tn, 0) - 1e-6 && (!best || th < best.t)) best = { l, t: th };
        }
      }
      if (best) return { entryAxis, hit: { rh: best.l.rh, ix, iy, value: best.l.pix[iy * n + ix] } };
      if (nx < ny) {
        ix += sx;
        t = nx;
        nx += dx;
      } else {
        iy += sy;
        t = ny;
        ny += dy;
      }
      if (ix < 0 || ix >= x1 || iy < y0 || iy >= n) break;
    }
    return { entryAxis, hit: null };
  }

  dispose() {
    for (const l of this.layers) {
      l.mesh.geometry.dispose();
      l.mesh.material.dispose();
      l.lines.geometry.dispose();
      l.lines.material.dispose();
    }
    this.layers.length = 0;
  }
}
