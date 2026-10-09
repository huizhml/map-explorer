/**
 * The two projections the app actually uses, without a projection library.
 *
 * MapLibre works in longitude/latitude throughout, so on the map side nothing
 * needs converting any more. What is left is the backend, which still takes
 * and returns some extents in EPSG:3857 (`extent_3857`), and code that measures
 * in metres. Both are spherical Web Mercator, which is a closed formula.
 */

export type LonLat = [number, number];
/** [west, south, east, north] in degrees. */
export type BBox = [number, number, number, number];

const R = 6378137;
const MAX_LAT = 85.0511287798;

export function toMercator([lon, lat]: LonLat): [number, number] {
  const φ = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return [(lon * Math.PI * R) / 180, R * Math.log(Math.tan(Math.PI / 4 + φ / 2))];
}

export function fromMercator([x, y]: [number, number]): LonLat {
  return [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)];
}

export function bboxToMercator([w, s, e, n]: BBox): [number, number, number, number] {
  const [x0, y0] = toMercator([w, s]);
  const [x1, y1] = toMercator([e, n]);
  return [x0, y0, x1, y1];
}

export function bboxFromMercator([x0, y0, x1, y1]: [number, number, number, number]): BBox {
  const [w, s] = fromMercator([x0, y0]);
  const [e, n] = fromMercator([x1, y1]);
  return [w, s, e, n];
}

export function isFiniteBBox(b: unknown): b is BBox {
  return Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** Bounding box of any GeoJSON geometry, or null for an empty one. */
export function geometryBBox(geometry: GeoJSON.Geometry | null | undefined): BBox | null {
  if (!geometry) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  type Coords = number[] | Coords[];
  const walk = (c: Coords) => {
    if (typeof c[0] === 'number') {
      const [x, y] = c as number[];
      if (x < w) w = x; if (x > e) e = x;
      if (y < s) s = y; if (y > n) n = y;
    } else for (const cc of c as Coords[]) walk(cc);
  };
  if (geometry.type === 'GeometryCollection') {
    for (const g of geometry.geometries) {
      const b = geometryBBox(g);
      if (b) { w = Math.min(w, b[0]); s = Math.min(s, b[1]); e = Math.max(e, b[2]); n = Math.max(n, b[3]); }
    }
  } else {
    walk(geometry.coordinates as Coords);
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

export function featuresBBox(features: GeoJSON.Feature[]): BBox | null {
  let out: BBox | null = null;
  for (const f of features) {
    const b = geometryBBox(f.geometry);
    if (!b) continue;
    out = out ? [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.max(out[2], b[2]), Math.max(out[3], b[3])] : b;
  }
  return out;
}

/** Whether a point is inside a (Multi)Polygon — even-odd rule, holes included. */
export function pointInGeometry([x, y]: LonLat, geometry: GeoJSON.Geometry | null | undefined): boolean {
  if (!geometry) return false;
  const inRing = (ring: GeoJSON.Position[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const inPolygon = (rings: GeoJSON.Position[][]) => rings.reduce((acc, r) => (inRing(r) ? !acc : acc), false);
  if (geometry.type === 'Polygon') return inPolygon(geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some(inPolygon);
  return false;
}
