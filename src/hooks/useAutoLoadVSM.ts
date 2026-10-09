import { useEffect, useRef, useState } from 'react';
import { LayerGroup, RasterLayer } from '../map/layers';
import { geometryBBox, type BBox } from '../map/proj';
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

const DEBOUNCE_MS = 500;
const MAX_CONCURRENT = 3;
/** MapLibre zoom — OpenLayers' 8, one level lower on a 512 px world. */
const MIN_ZOOM = 7;

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
        state.outerGroup.detach();
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
      state.outerGroup.detach();
      globalLayersRef.current.delete(layerId);
    }

    for (const entry of addedVsmLayers) {
      const layerId = getVsmLayerId(entry);
      if (globalLayersRef.current.has(layerId)) continue;

      // The overview mosaic goes into the outer group, under the 10 m tiles in
      // the inner one; both are drawn at the outer group's z.
      const group = new LayerGroup({ zIndex: 600 });
      const outerGroup = new LayerGroup({ layers: [group], zIndex: 599 });
      outerGroup.attach(map);

      const state: GlobalLayerState = { outerGroup, group, autoLoadingTiles: new Set(), entry, cancelled: false };
      globalLayersRef.current.set(layerId, state);

      if (mgr) {
        const rc = getDefaultRescaleAndColormap(entry.rhIndex, entry.qChoice);
        const versionSuffix = entry.year === 2020 ? ` · ${entry.version}` : '';
        const layerName = `Global (RH${entry.rhIndex} ${entry.qChoice}, ${entry.year}${versionSuffix})`;
        mgr.addLayer(layerId, layerName, 'prediction', outerGroup, {
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
          // Fetched to tile zoom 8 and overzoomed past it: left under the 10 m
          // tiles, it fills the moment between a pan and their arrival rather
          // than showing bare basemap.
          const mosaicLayer = new RasterLayer({ url: mosaicTileUrl, maxTileZoom: MIN_ZOOM + 1 });
          const st = globalLayersRef.current.get(layerId);
          if (st && !st.cancelled && st.outerGroup.isAttached()) st.outerGroup.add(mosaicLayer, { bottom: true });
        } catch (err) {
          console.warn('[mosaic] Error:', err);
        }
      })();
    }

    const runAutoLoadForLayer = async (layerId: string, state: GlobalLayerState) => {
      if (state.cancelled) return;
      if (map.getZoom() < MIN_ZOOM) return;

      const b = map.getBounds();
      const features = fgbLayer.getFeaturesInBBox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      // The tile outline doubles as the layer's bounds: MapLibre then asks for
      // nothing outside it. /cog/info's bounds are in the tile's UTM zone,
      // which would need a projection library to use.
      const tileBounds = new globalThis.Map<string, BBox>();
      const visibleTiles = new Set<string>();
      for (const f of features) {
        const n = f.properties.Name;
        if (!n) continue;
        visibleTiles.add(n);
        const bb = geometryBBox(f.geometry);
        // Antimeridian tiles come back spanning the world; leave them unbounded.
        if (bb && bb[2] - bb[0] <= 20) tileBounds.set(n, bb);
      }
      if (visibleTiles.size === 0) return;

      const toLoad = [...visibleTiles].filter((t) => !state.autoLoadingTiles.has(t));
      if (toLoad.length === 0) return;

      const { entry } = state;
      const isInterval = isIntervalQChoice(entry.qChoice);

      // For single-Q: one /predictions/load call returns the COG URL we tile via /cog/tiles.
      // For intervals: load BOTH single-Q files and tile via /predictions/interval-tile,
      // which subtracts (url_high - url_low) on the server.
      const loadSourceUrls = async (tileName: string): Promise<{ urls: string[] } | null> => {
        const post = (q: number | string) =>
          fetch(apiUrl('/predictions/load'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year: entry.year, tile_name: tileName, rh_index: entry.rhIndex, q_index: q, version: entry.version }),
          }).then((r) => (r.ok ? r.json() : null));

        if (isInterval) {
          const { high, low } = getIntervalQIndexes(entry.qChoice as Exclude<typeof entry.qChoice, 'skewness' | '5%' | 'median' | '95%'>);
          const [dh, dl] = await Promise.all([post(high), post(low)]);
          if (!dh?.success || !dh.url || !dl?.success || !dl.url) return null;
          return { urls: [dh.url, dl.url] };
        }
        const data = await post(getQIndexForApi(entry.qChoice));
        if (!data?.success || !data.url) return null;
        return { urls: [data.url] };
      };

      for (let i = 0; i < toLoad.length; i += MAX_CONCURRENT) {
        if (state.cancelled) return;
        await Promise.allSettled(toLoad.slice(i, i + MAX_CONCURRENT).map(async (tileName) => {
          if (state.cancelled) return;
          state.autoLoadingTiles.add(tileName);
          try {
            const loaded = await loadSourceUrls(tileName);
            if (!loaded || state.cancelled) return;

            if (state.cancelled) return;

            const rc = getDefaultRescaleAndColormap(entry.rhIndex, entry.qChoice);
            const globalManaged = useMapStore.getState().layerManager?.getLayer(layerId);
            const rMin = globalManaged?.metadata?.rescaleMin ?? rc.min;
            const rMax = globalManaged?.metadata?.rescaleMax ?? rc.max;
            const cm = globalManaged?.metadata?.colormap ?? rc.colormap;
            const url = isInterval
              ? apiUrl(`/predictions/interval-tile/WebMercatorQuad/{z}/{x}/{y}?url_high=${encodeURIComponent(loaded.urls[0])}&url_low=${encodeURIComponent(loaded.urls[1])}&rescale=${rMin},${rMax}&colormap_name=${encodeURIComponent(cm)}`)
              : apiUrl(`/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(loaded.urls[0])}&expression=b1*(b1<32767)&nodata=-9999&return_mask=true&rescale=${rMin},${rMax}&colormap_name=${encodeURIComponent(cm)}`);
            const layer = new RasterLayer({
              url, maxTileZoom: 18, minTileZoom: MIN_ZOOM + 1, minZoom: MIN_ZOOM,
              bounds: tileBounds.get(tileName),
            });
            if (!state.cancelled) state.group.add(layer);
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
      setShowZoomMessage(addedVsmLayers.length > 0 && map.getZoom() < MIN_ZOOM);
    };

    onMoveEnd();
    map.on('moveend', onMoveEnd);
    map.on('zoom', onZoomChange);

    // Listeners only. The layers themselves outlive a change to
    // `addedVsmLayers` — see the teardown effect above for why that matters.
    return () => {
      map.off('moveend', onMoveEnd);
      map.off('zoom', onZoomChange);
    };
  }, [map, fgbLayer, addedVsmLayers, updateLayersList]);

  return { showZoomMessage, globalLayersRef };
}
