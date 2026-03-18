import type { LayerManager } from './LayerManager';

export interface InspectLayerRow {
  id: string;
  name: string;
  type: string;
  value?: unknown;
  error?: string;
}

/**
 * Sample visible raster layers (COG URLs in metadata) at lon/lat via backend.
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
    (m) => m.visible && m.metadata && typeof m.metadata.url === 'string' && m.metadata.url.length > 0,
  );

  const results: InspectLayerRow[] = [];

  await Promise.all(
    inspectable.map(async (m) => {
      const cogUrl = m.metadata!.url as string;
      // TiTiler expects /cog/point/{lon},{lat} (single segment), not /lon/lat
      const requestUrl = `http://localhost:8000/cog/point/${lon},${lat}?url=${encodeURIComponent(cogUrl)}`;

      try {
        const resp = await fetch(requestUrl);
        if (!resp.ok) {
          results.push({
            id: m.id,
            name: m.name,
            type: m.type,
            error: `HTTP ${resp.status}`,
          });
          return;
        }
        const data = await resp.json();
        results.push({
          id: m.id,
          name: m.name,
          type: m.type,
          value: data,
        });
      } catch (err) {
        results.push({
          id: m.id,
          name: m.name,
          type: m.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  return results;
}
