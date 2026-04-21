import type { LayerManager } from './LayerManager';
import { apiUrl } from './apiBase';

export interface InspectLayerRow {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Sample all raster layers (COG URLs in metadata) at lon/lat via backend.
 */
export async function inspectPointAtLonLat(
  layerManager: LayerManager | null,
  lon: number,
  lat: number,
): Promise<InspectLayerRow[]> {
  if (!layerManager) return [];

  layerManager.syncAllProperties();
  const managed = layerManager.getAllLayers();
  const inspectable = managed.filter(
    (m) => m.metadata && typeof m.metadata.url === 'string' && m.metadata.url.length > 0,
  );

  const results: InspectLayerRow[] = [];

  await Promise.all(
    inspectable.map(async (m) => {
      const cogUrl = m.metadata!.url as string;
      // TiTiler expects /cog/point/{lon},{lat} (single segment), not /lon/lat
      const requestUrl = apiUrl(`/cog/point/${lon},${lat}?url=${encodeURIComponent(cogUrl)}`);

      try {
        const resp = await fetch(requestUrl);
        if (!resp.ok) {
          results.push({
            id: m.id,
            name: m.name,
            type: m.type,
            visible: m.visible,
            error: `HTTP ${resp.status}`,
          });
          return;
        }
        const data = await resp.json();
        results.push({
          id: m.id,
          name: m.name,
          type: m.type,
          visible: m.visible,
          value: data,
        });
      } catch (err) {
        results.push({
          id: m.id,
          name: m.name,
          type: m.type,
          visible: m.visible,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  return results;
}
