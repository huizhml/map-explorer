import { useEffect } from 'react';
import type { GeoJSONSource } from 'maplibre-gl';
import { useExploreMap } from './exploreMap';
import type { CubeMeta } from './cube/cubeData';
import type { Snapshot } from './cube/CubeScene';

/**
 * Where the 3D cube is, on the map: the 1.28 km window outline, plus the two
 * vertical slices (crossing slices) or the part of the block still shown
 * (cutaway). Stands in for the prototype's overview thumbnail: the real map
 * is a better one.
 */

const SOURCE = 'cube-footprint';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

type Pt = [number, number];

/** u = fraction eastwards from the W edge, v = fraction southwards from the N edge. */
function at(fp: Pt[], u: number, v: number): Pt {
  const [nw, ne, se, sw] = fp;
  const top: Pt = [nw[0] + (ne[0] - nw[0]) * u, nw[1] + (ne[1] - nw[1]) * u];
  const bot: Pt = [sw[0] + (se[0] - sw[0]) * u, sw[1] + (se[1] - sw[1]) * u];
  return [top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v];
}

const line = (coords: Pt[], kind: string): GeoJSON.Feature => ({
  type: 'Feature',
  properties: { kind },
  geometry: { type: 'LineString', coordinates: coords },
});

function features(meta: CubeMeta, s: Snapshot | null): GeoJSON.FeatureCollection {
  const fp = meta.footprint as Pt[];
  const out: GeoJSON.Feature[] = [line([...fp, fp[0]], 'outline')];
  if (s) {
    if (s.display === 'planes') {
      const u = (s.cx + 0.5) / s.nx;
      const v = (s.ny - 1 - s.cy + 0.5) / s.ny;
      out.push(line([at(fp, u, 0), at(fp, u, 1)], 'slice'));
      out.push(line([at(fp, 0, v), at(fp, 1, v)], 'slice'));
    } else {
      // Kept block: x in [0, cx+1], y (from the south) in [cy, ny].
      const u = (s.cx + 1) / s.nx;
      const v = (s.ny - s.cy) / s.ny;
      if (u < 1 || v < 1) out.push(line([at(fp, 0, 0), at(fp, u, 0), at(fp, u, v), at(fp, 0, v), at(fp, 0, 0)], 'slice'));
    }
  }
  return { type: 'FeatureCollection', features: out };
}

export function CubeFootprint({ meta, snapshot }: { meta?: CubeMeta | null; snapshot: Snapshot | null }) {
  const { map } = useExploreMap();

  useEffect(() => {
    if (!map) return;
    map.addSource(SOURCE, { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: `${SOURCE}-casing`, type: 'line', source: SOURCE,
      paint: { 'line-color': 'rgba(0,0,0,0.55)', 'line-width': 4 },
    });
    map.addLayer({
      id: SOURCE, type: 'line', source: SOURCE,
      paint: {
        'line-color': ['match', ['get', 'kind'], 'slice', '#b7adff', '#ffffff'],
        'line-width': ['match', ['get', 'kind'], 'slice', 1.5, 2],
      },
    });
    return () => {
      if (!map.style) return;
      map.removeLayer(SOURCE);
      map.removeLayer(`${SOURCE}-casing`);
      map.removeSource(SOURCE);
    };
  }, [map]);

  useEffect(() => {
    map?.getSource<GeoJSONSource>(SOURCE)?.setData(meta ? features(meta, snapshot) : EMPTY);
  }, [map, meta, snapshot]);

  return null;
}
