import { createContext, useContext } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import { deserialize } from 'flatgeobuf/lib/mjs/geojson';
import { API_BASE_URL } from '../utils/apiBase';

/**
 * What the explore page's map-side components share: the MapLibre map, and the
 * Sentinel-2 (MGRS) grid.
 *
 * The page used to share these through useMapStore, which is the full app's
 * store and holds OpenLayers objects. The explore page is self-contained, so it
 * gets its own context rather than a second meaning for the same store fields.
 *
 * Zoom levels throughout are MapLibre's, which are OpenLayers' minus one: the
 * same scale is one level lower on a 512 px world than on a 256 px one.
 */

export type GridTile = {
  name: string;
  bbox: [number, number, number, number];
};

export type Grid = {
  tiles: GridTile[];
  /** Upper-cased name → tile. */
  byName: Map<string, GridTile>;
  /** The outlines, for drawing while tiles are being picked to download. */
  geojson: GeoJSON.FeatureCollection;
};

export type ExploreMap = { map: MlMap | null; grid: Grid | null };

export const ExploreMapContext = createContext<ExploreMap>({ map: null, grid: null });

export function useExploreMap(): ExploreMap {
  return useContext(ExploreMapContext);
}

/**
 * The 18,181 tile outlines, from the backend's FlatGeobuf.
 *
 * Tiles that straddle the antimeridian come back with a bbox spanning the whole
 * world. Their outline is kept for drawing, but they are left out of `tiles`:
 * as a raster source's bounds that box would have the tile requested
 * everywhere. Their data is still on the map at low zoom, through the mosaic.
 */
export async function loadGrid(): Promise<Grid> {
  const resp = await fetch(`${API_BASE_URL}/fgb/local`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buffer = new Uint8Array(await resp.arrayBuffer());

  const tiles: GridTile[] = [];
  const byName = new Map<string, GridTile>();
  const features: GeoJSON.Feature[] = [];

  type Coords = number[] | Coords[];
  for await (const f of deserialize(buffer) as AsyncGenerator<GeoJSON.Feature>) {
    const name = f.properties?.Name as string | undefined;
    if (!name || !('coordinates' in f.geometry)) continue;
    features.push({ type: 'Feature', geometry: f.geometry, properties: { Name: name } });

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const walk = (c: Coords) => {
      if (typeof c[0] === 'number') {
        const [x, y] = c as number[];
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      } else for (const cc of c as Coords[]) walk(cc);
    };
    walk(f.geometry.coordinates as Coords);

    const tile: GridTile = { name, bbox: [x0, y0, x1, y1] };
    byName.set(name.toUpperCase(), tile);
    if (x1 - x0 <= 20) tiles.push(tile);
  }

  return { tiles, byName, geojson: { type: 'FeatureCollection', features } };
}

/** The MGRS tiles whose bounding box meets the current view. */
export function tilesInView(map: MlMap, grid: Grid): string[] {
  const b = map.getBounds();
  const [w, s, e, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  return grid.tiles
    .filter((t) => t.bbox[0] <= e && t.bbox[2] >= w && t.bbox[1] <= n && t.bbox[3] >= s)
    .map((t) => t.name);
}

/**
 * Stop whatever is moving the camera, before moving it yourself.
 *
 * MapLibre's own animations replace one another, so unlike OpenLayers there is
 * no queue for a new move to lose to. What is left is RandomSite's opening
 * fly-in, which is a *timer* before it is an animation: started from a control
 * outside the canvas (the search box, the random-site button), a move would
 * otherwise be overtaken when the timer fires. RandomSite registers its cancel
 * here; it is null once the flight is over or was never scheduled.
 */
let cancelIntro: (() => void) | null = null;

export function setIntroCancel(fn: (() => void) | null): void {
  cancelIntro = fn;
}

export function takeCamera(map: MlMap): void {
  cancelIntro?.();
  map.stop();
}

/**
 * Whether a map click belongs to the download flyout's tile picker. Set while
 * the flyout is open, so the page's own click handler — which reads the
 * vertical profile at the point — stands aside.
 */
let selectingTiles = false;

export function setSelectingTiles(on: boolean): void {
  selectingTiles = on;
}

export function isSelectingTiles(): boolean {
  return selectingTiles;
}
