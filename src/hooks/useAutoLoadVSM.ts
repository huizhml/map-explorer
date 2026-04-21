import { useEffect, useRef, useState } from 'react';
import LayerGroup from 'ol/layer/Group';
import XYZ from 'ol/source/XYZ';
import TileLayer from 'ol/layer/Tile';
import { transformExtent } from 'ol/proj';
import { useMapStore } from '../stores/mapStore';
import { getDefaultRescaleAndColormap, getVsmLayerId, getQIndexForApi, type VsmLayerEntry } from '../constants/predictions';
import { apiUrl } from '../utils/apiBase';

const DEBOUNCE_MS = 1500;
const MAX_CONCURRENT = 3;
const MIN_ZOOM = 8;

type GlobalLayerState = {
  outerGroup: LayerGroup;
  group: LayerGroup;
  autoLoadingTiles: Set<string>;
  entry: VsmLayerEntry;
  cancelled: boolean;
};

export function useAutoLoadVSM(updateLayersList: () => void) {
  const { map, fgbLayer, addedVsmLayers } = useMapStore();
  const globalLayersRef = useRef<globalThis.Map<string, GlobalLayerState>>(new globalThis.Map());
  const debounceTimersRef = useRef<globalThis.Map<string, ReturnType<typeof setTimeout>>>(new globalThis.Map());
  const [showZoomMessage, setShowZoomMessage] = useState(false);

  useEffect(() => {
    if (!map || !fgbLayer) {
      setShowZoomMessage(false);
      return;
    }

    const wantedIds = new Set(addedVsmLayers.map((e) => getVsmLayerId(e)));
    const mgr = useMapStore.getState().layerManager;

    for (const [layerId, state] of globalLayersRef.current.entries()) {
      if (wantedIds.has(layerId)) continue;
      state.cancelled = true;
      const t = debounceTimersRef.current.get(layerId);
      if (t) { clearTimeout(t); debounceTimersRef.current.delete(layerId); }
      if (mgr?.getLayer(layerId)) mgr.removeLayer(layerId);
      if (map.getLayers().getArray().includes(state.outerGroup)) map.removeLayer(state.outerGroup);
      globalLayersRef.current.delete(layerId);
    }

    for (const entry of addedVsmLayers) {
      const layerId = getVsmLayerId(entry);
      if (globalLayersRef.current.has(layerId)) continue;

      const group = new LayerGroup({ layers: [], zIndex: 600, minZoom: MIN_ZOOM - 1 });
      const outerGroup = new LayerGroup({ layers: [group], zIndex: 599 });
      map.addLayer(outerGroup);

      const state: GlobalLayerState = { outerGroup, group, autoLoadingTiles: new Set(), entry, cancelled: false };
      globalLayersRef.current.set(layerId, state);

      if (mgr) {
        const rc = getDefaultRescaleAndColormap(entry.rhIndex, entry.qChoice);
        mgr.addLayer(layerId, `Global (RH${entry.rhIndex} ${entry.qChoice}, ${entry.year})`, 'prediction', outerGroup as any, {
          tileName: 'Global', rhIndex: entry.rhIndex, qIndex: getQIndexForApi(entry.qChoice),
          year: entry.year, rescaleMin: rc.min, rescaleMax: rc.max, colormap: rc.colormap, isAutoLoadGroup: true,
        });
        updateLayersList();
      }

      (async () => {
        try {
          const qParam = encodeURIComponent(String(getQIndexForApi(entry.qChoice)));
          const resp = await fetch(apiUrl(`/predictions/mosaic-url?year=${entry.year}&rh_index=${entry.rhIndex}&q_index=${qParam}`));
          const data = await resp.json();
          const s = globalLayersRef.current.get(layerId);
          if (!s || s.cancelled || !data.success) return;
          const rc = getDefaultRescaleAndColormap(entry.rhIndex, entry.qChoice);
          const url = apiUrl(`/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(data.url)}&expression=b1*(b1<32767)&nodata=-9999&return_mask=true&rescale=${rc.min},${rc.max}&colormap_name=${encodeURIComponent(rc.colormap)}`);
          const mosaicLayer = new TileLayer({ source: new XYZ({ url, crossOrigin: 'anonymous', maxZoom: 14 }), zIndex: 599, maxZoom: MIN_ZOOM });
          const st = globalLayersRef.current.get(layerId);
          if (st && !st.cancelled && map.getLayers().getArray().includes(st.outerGroup)) st.outerGroup.getLayers().insertAt(0, mosaicLayer);
        } catch (err) {
          console.warn('[mosaic] Error:', err);
        }
      })();
    }

    const runAutoLoadForLayer = async (layerId: string, state: GlobalLayerState) => {
      if (state.cancelled) return;
      const zoom = map.getView().getZoom();
      if (zoom === undefined || zoom < MIN_ZOOM) return;
      const source = fgbLayer.getSource();
      if (!source) return;
      const mapSize = map.getSize();
      if (!mapSize) return;

      const viewExtent = map.getView().calculateExtent(mapSize);
      const features = source.getFeaturesInExtent(viewExtent);
      const visibleTiles = new Set<string>();
      for (const f of features) { const n = f.get('Name'); if (n) visibleTiles.add(n); }
      if (visibleTiles.size === 0) return;

      const toLoad = [...visibleTiles].filter((t) => !state.autoLoadingTiles.has(t));
      if (toLoad.length === 0) return;

      const { entry } = state;
      const qIdx = getQIndexForApi(entry.qChoice);

      for (let i = 0; i < toLoad.length; i += MAX_CONCURRENT) {
        if (state.cancelled) return;
        await Promise.allSettled(toLoad.slice(i, i + MAX_CONCURRENT).map(async (tileName) => {
          if (state.cancelled) return;
          state.autoLoadingTiles.add(tileName);
          try {
            const resp = await fetch(apiUrl('/predictions/load'), {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ year: entry.year, tile_name: tileName, rh_index: entry.rhIndex, q_index: qIdx }),
            });
            if (!resp.ok) return;
            const data = await resp.json();
            if (!data.success || !data.url || state.cancelled) return;

            const infoResp = await fetch(apiUrl(`/cog/info?url=${encodeURIComponent(data.url)}`));
            if (!infoResp.ok) return;
            const info = await infoResp.json();
            const bbox = info.bounds;
            if (!bbox || bbox.length !== 4) return;

            let crs = 'EPSG:4326';
            if (info.crs) { if (typeof info.crs === 'string') crs = info.crs; else if (info.crs.properties?.name) crs = info.crs.properties.name; else if (info.crs.code) crs = `EPSG:${info.crs.code}`; }
            const extent = (crs === 'EPSG:3857' || crs === 'EPSG:900913') ? bbox : transformExtent(bbox, crs, 'EPSG:3857');
            if (!extent.every((v: number) => isFinite(v) && !isNaN(v)) || state.cancelled) return;

            const rc = getDefaultRescaleAndColormap(entry.rhIndex, entry.qChoice);
            const globalManaged = useMapStore.getState().layerManager?.getLayer(layerId);
            const rMin = globalManaged?.metadata?.rescaleMin ?? rc.min;
            const rMax = globalManaged?.metadata?.rescaleMax ?? rc.max;
            const cm = globalManaged?.metadata?.colormap ?? rc.colormap;
            const url = apiUrl(`/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(data.url)}&expression=b1*(b1<32767)&nodata=-9999&return_mask=true&rescale=${rMin},${rMax}&colormap_name=${encodeURIComponent(cm)}`);
            const opts: any = { source: new XYZ({ url, crossOrigin: 'anonymous', maxZoom: 18, wrapX: true }), minZoom: MIN_ZOOM - 1 };
            if ((extent[2] - extent[0]) <= 1_000_000) opts.extent = extent;
            if (!state.cancelled) state.group.getLayers().push(new TileLayer(opts));
          } catch { /* ignore */ }
        }));
      }
    };

    const onMoveEnd = () => {
      for (const [id, state] of globalLayersRef.current.entries()) {
        const t = debounceTimersRef.current.get(id);
        if (t) clearTimeout(t);
        debounceTimersRef.current.set(id, setTimeout(() => runAutoLoadForLayer(id, state), DEBOUNCE_MS));
      }
    };

    const onZoomChange = () => {
      const zoom = map.getView().getZoom();
      setShowZoomMessage(addedVsmLayers.length > 0 && zoom !== undefined && zoom < MIN_ZOOM);
    };

    onMoveEnd();
    map.on('moveend', onMoveEnd);
    map.getView().on('change:resolution', onZoomChange);

    return () => {
      for (const [id, state] of globalLayersRef.current.entries()) {
        state.cancelled = true;
        const t = debounceTimersRef.current.get(id);
        if (t) { clearTimeout(t); debounceTimersRef.current.delete(id); }
        if (mgr?.getLayer(id)) mgr.removeLayer(id);
        if (map.getLayers().getArray().includes(state.outerGroup)) map.removeLayer(state.outerGroup);
      }
      globalLayersRef.current.clear();
      debounceTimersRef.current.clear();
      map.un('moveend', onMoveEnd);
      map.getView().un('change:resolution', onZoomChange);
      updateLayersList();
    };
  }, [map, fgbLayer, addedVsmLayers, updateLayersList]);

  return { showZoomMessage, globalLayersRef };
}
