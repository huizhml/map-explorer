import { useEffect, useRef, useState } from 'react';
import LayerGroup from 'ol/layer/Group';
import XYZ from 'ol/source/XYZ';
import TileLayer from 'ol/layer/Tile';
import { transformExtent } from 'ol/proj';
import { useMapStore } from '../stores/mapStore';
import {
  getDefaultRescaleAndColormap,
  getVsmLayerId,
  getQIndexForApi,
  getIntervalQIndexes,
  isIntervalQChoice,
  type VsmLayerEntry,
} from '../constants/predictions';
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

  /**
   * Tear everything down when the map goes away — and only then.
   *
   * This used to live in the cleanup of the effect below, which also depends on
   * `addedVsmLayers`. So adding or removing one RH ran it: every layer already
   * on the map was removed and its in-flight tile loads cancelled, and the
   * effect body then rebuilt all of them from nothing, re-requesting the mosaic
   * URL and every visible tile. On screen that is the current layer vanishing
   * to bare basemap and coming back seconds later alongside the new one.
   *
   * The body's own diffing — skip what is already there, remove what is no
   * longer wanted — was correct all along, but could never fire, because this
   * cleanup had just emptied the map it diffs against.
   *
   * Reads the LayerManager from the store at teardown time rather than closing
   * over it: this effect does not re-run when the manager is created, so a
   * captured one would be the null from the first render.
   */
  useEffect(() => {
    if (!map) return;
    return () => {
      const mgr = useMapStore.getState().layerManager;
      for (const [id, state] of globalLayersRef.current.entries()) {
        state.cancelled = true;
        const t = debounceTimersRef.current.get(id);
        if (t) { clearTimeout(t); debounceTimersRef.current.delete(id); }
        if (mgr?.getLayer(id)) mgr.removeLayer(id);
        if (map.getLayers().getArray().includes(state.outerGroup)) map.removeLayer(state.outerGroup);
      }
      globalLayersRef.current.clear();
      debounceTimersRef.current.clear();
      updateLayersList();
    };
  }, [map, fgbLayer, updateLayersList]);

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
        const versionSuffix = entry.year === 2020 ? ` · ${entry.version}` : '';
        const layerName = `Global (RH${entry.rhIndex} ${entry.qChoice}, ${entry.year}${versionSuffix})`;
        mgr.addLayer(layerId, layerName, 'prediction', outerGroup as any, {
          tileName: 'Global', rhIndex: entry.rhIndex, qIndex: getQIndexForApi(entry.qChoice),
          year: entry.year, version: entry.version,
          rescaleMin: rc.min, rescaleMax: rc.max, colormap: rc.colormap, isAutoLoadGroup: true,
        });
        updateLayersList();
      }

      (async () => {
        try {
          const versionParam = `&version=${encodeURIComponent(entry.version)}`;
          const fetchMosaic = (q: number | string) =>
            fetch(apiUrl(`/predictions/mosaic-url?year=${entry.year}&rh_index=${entry.rhIndex}&q_index=${encodeURIComponent(String(q))}${versionParam}`))
              .then((r) => r.json());

          const isInterval = isIntervalQChoice(entry.qChoice);
          let mosaicUrlHigh: string | null = null;
          let mosaicUrlLow: string | null = null;

          if (isInterval) {
            const { high, low } = getIntervalQIndexes(entry.qChoice as Exclude<typeof entry.qChoice, 'skewness' | '5%' | 'median' | '95%'>);
            const [dh, dl] = await Promise.all([fetchMosaic(high), fetchMosaic(low)]);
            if (dh?.success && dh.url) mosaicUrlHigh = dh.url;
            if (dl?.success && dl.url) mosaicUrlLow = dl.url;
          } else {
            const d = await fetchMosaic(getQIndexForApi(entry.qChoice));
            if (d?.success && d.url) mosaicUrlHigh = d.url;
          }

          const s = globalLayersRef.current.get(layerId);
          if (!s || s.cancelled) return;

          // Surface the underlying COG path(s) on the managed-layer metadata so
          // this auto-loaded layer shows up in the "Layers To Save" panel. For
          // intervals, both high and low single-Q paths are needed — the save
          // endpoint subtracts them server-side via /predictions/interval-tile.
          const managed = useMapStore.getState().layerManager?.getLayer(layerId);
          if (managed?.metadata && mosaicUrlHigh && (!isInterval || mosaicUrlLow)) {
            managed.metadata.url = mosaicUrlHigh;
            if (isInterval && mosaicUrlLow) managed.metadata.urlLow = mosaicUrlLow;
            updateLayersList();
          }

          // Mosaic display layer (low-zoom overview). Intervals stitch two
          // single-Q mosaics on the fly via /predictions/interval-tile.
          if (!mosaicUrlHigh) return;
          const rc = getDefaultRescaleAndColormap(entry.rhIndex, entry.qChoice);
          const mosaicTileUrl = isInterval && mosaicUrlLow
            ? apiUrl(`/predictions/interval-tile/WebMercatorQuad/{z}/{x}/{y}?url_high=${encodeURIComponent(mosaicUrlHigh)}&url_low=${encodeURIComponent(mosaicUrlLow)}&rescale=${rc.min},${rc.max}&colormap_name=${encodeURIComponent(rc.colormap)}`)
            : apiUrl(`/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(mosaicUrlHigh)}&expression=b1*(b1<32767)&nodata=-9999&return_mask=true&rescale=${rc.min},${rc.max}&colormap_name=${encodeURIComponent(rc.colormap)}`);
          const mosaicLayer = new TileLayer({ source: new XYZ({ url: mosaicTileUrl, crossOrigin: 'anonymous', maxZoom: 14 }), zIndex: 599, maxZoom: MIN_ZOOM });
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
      const isInterval = isIntervalQChoice(entry.qChoice);

      // For single-Q: one /predictions/load call returns the COG URL we tile via /cog/tiles.
      // For intervals: load BOTH single-Q files and tile via /predictions/interval-tile,
      // which subtracts (url_high - url_low) on the server.
      const loadSourceUrls = async (tileName: string): Promise<{ urls: string[]; bboxRef: string } | null> => {
        const post = (q: number | string) =>
          fetch(apiUrl('/predictions/load'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year: entry.year, tile_name: tileName, rh_index: entry.rhIndex, q_index: q, version: entry.version }),
          }).then((r) => (r.ok ? r.json() : null));

        if (isInterval) {
          const { high, low } = getIntervalQIndexes(entry.qChoice as Exclude<typeof entry.qChoice, 'skewness' | '5%' | 'median' | '95%'>);
          const [dh, dl] = await Promise.all([post(high), post(low)]);
          if (!dh?.success || !dh.url || !dl?.success || !dl.url) return null;
          return { urls: [dh.url, dl.url], bboxRef: dh.url };
        }
        const data = await post(getQIndexForApi(entry.qChoice));
        if (!data?.success || !data.url) return null;
        return { urls: [data.url], bboxRef: data.url };
      };

      for (let i = 0; i < toLoad.length; i += MAX_CONCURRENT) {
        if (state.cancelled) return;
        await Promise.allSettled(toLoad.slice(i, i + MAX_CONCURRENT).map(async (tileName) => {
          if (state.cancelled) return;
          state.autoLoadingTiles.add(tileName);
          try {
            const loaded = await loadSourceUrls(tileName);
            if (!loaded || state.cancelled) return;

            const infoResp = await fetch(apiUrl(`/cog/info?url=${encodeURIComponent(loaded.bboxRef)}`));
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
            const url = isInterval
              ? apiUrl(`/predictions/interval-tile/WebMercatorQuad/{z}/{x}/{y}?url_high=${encodeURIComponent(loaded.urls[0])}&url_low=${encodeURIComponent(loaded.urls[1])}&rescale=${rMin},${rMax}&colormap_name=${encodeURIComponent(cm)}`)
              : apiUrl(`/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(loaded.urls[0])}&expression=b1*(b1<32767)&nodata=-9999&return_mask=true&rescale=${rMin},${rMax}&colormap_name=${encodeURIComponent(cm)}`);
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

    // Listeners only. The layers themselves outlive a change to
    // `addedVsmLayers` — see the teardown effect above for why that matters.
    return () => {
      map.un('moveend', onMoveEnd);
      map.getView().un('change:resolution', onZoomChange);
    };
  }, [map, fgbLayer, addedVsmLayers, updateLayersList]);

  return { showZoomMessage, globalLayersRef };
}
