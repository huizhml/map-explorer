import type { Layer } from '../components/LayerControl';
import type { MapLayer } from '../map/layers';
import type { LayerManager } from './LayerManager';
import { getLayerDisplayName, getLayerLegend, type LayerLegend } from './layerLegend';

export type TransectMapTileSource = { url: string; tile_size: number; max_zoom: number };

/** A map raster layer the transect figure can draw as its own panel. */
export type TransectLayerCandidate = {
  id: string;
  name: string;
  visible: boolean;
  sources: TransectMapTileSource[];
  legend: LayerLegend | null;
};

type LonLatBox = [number, number, number, number]; // west, south, east, north

/** The backend fetches these itself, so a site-relative URL needs an origin. */
function absoluteTemplate(url: string): string {
  // Not `new URL()`: it would percent-encode the {z}/{x}/{y} braces.
  return url.startsWith('/') ? `${window.location.origin}${url}` : url;
}

function intersects(a: LonLatBox, b: LonLatBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/**
 * Raster tile sources under a map layer, bottom first, skipping hidden
 * children and ones whose bounds miss `box` (e.g. the global VSM layer's
 * per-MGRS-tile layers away from the transect).
 */
function collectSources(layer: MapLayer, box: LonLatBox, out: TransectMapTileSource[]): void {
  if (layer.kind === 'raster') {
    const r = layer as MapLayer & {
      getUrl(): string;
      getTileSize(): number;
      getMaxTileZoom(): number | undefined;
    };
    const b = layer.getBounds();
    if (b && !intersects(b as LonLatBox, box)) return;
    out.push({ url: absoluteTemplate(r.getUrl()), tile_size: r.getTileSize(), max_zoom: r.getMaxTileZoom() ?? 18 });
  } else if (layer.kind === 'group') {
    const g = layer as MapLayer & { getLayers(): MapLayer[] };
    for (const child of g.getLayers()) {
      if (child.getVisible()) collectSources(child, box, out);
    }
  }
}

/**
 * Raster layers on the map that cover the transect (`box`, lon/lat with the
 * satellite buffer), in layer-panel order. Vector layers are skipped.
 */
export function getTransectLayerCandidates(
  layers: Layer[],
  layerManager: LayerManager | null,
  box: LonLatBox,
): TransectLayerCandidate[] {
  if (!layerManager) return [];
  const out: TransectLayerCandidate[] = [];
  for (const layer of layers) {
    if (layer.type === 'vector' || layer.type === 'fgb') continue;
    const managed = layerManager.getLayer(layer.id);
    if (!managed) continue;
    const sources: TransectMapTileSource[] = [];
    collectSources(managed.layer, box, sources);
    if (sources.length === 0) continue;
    out.push({
      id: layer.id,
      name: getLayerDisplayName(layer),
      visible: layer.visible,
      sources,
      legend: getLayerLegend(layer),
    });
  }
  return out;
}
