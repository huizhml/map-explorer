import { useCallback, useMemo, useRef } from 'react';
import { LayerGroup, RasterLayer, type MapLayer } from '../map/layers';
import { VectorLayer, type AppFeature } from '../map/vector';
import { useMapStore } from '../stores/mapStore';
import { buildDiversityTileUrl, type DiversityBandConfig } from './useLayerLoaders';
import { applySelectiveLoggingDateRange } from '../utils/selectiveLogging';

const MAX_VECTOR_FEATURE_LIST_PREVIEW = 300;

export function useLayerControls(
  updateLayersList: () => void,
  globalLayersRef: React.RefObject<globalThis.Map<string, { cancelled: boolean }>>,
) {
  const {
    map, layerManager, layers,
    setCogLayer, setFgbLayer, setSentinel2Layers, setPredictionLayers,
    removeVsmLayerByLayerId,
  } = useMapStore();

  const highlightFeatureRef = useRef<{ layer: VectorLayer; feature: AppFeature } | null>(null);

  const handleToggleVisibility = useCallback((layerId: string) => {
    if (layerManager?.getLayer(layerId)) { layerManager.toggleVisibility(layerId); updateLayersList(); }
  }, [layerManager, updateLayersList]);

  const handleChangeOpacity = useCallback((layerId: string, opacity: number) => {
    if (layerManager?.getLayer(layerId)) { layerManager.setOpacity(layerId, opacity); updateLayersList(); }
  }, [layerManager, updateLayersList]);

  const handleChangeZIndex = useCallback((layerId: string, zIndex: number) => {
    if (layerManager?.getLayer(layerId)) { layerManager.setZIndex(layerId, zIndex); updateLayersList(); }
  }, [layerManager, updateLayersList]);

  /** Every XYZ layer in a managed layer — itself, or the tiles of a group. */
  const rastersOf = (layer: MapLayer): RasterLayer[] =>
    layer instanceof RasterLayer ? [layer] : layer instanceof LayerGroup ? layer.rasters() : [];

  const applyRescaleToLayer = useCallback((layer: MapLayer, min: number, max: number) => {
    for (const r of rastersOf(layer)) r.setTileParams({ rescale: `${min},${max}` });
  }, []);

  const applyColormapToLayer = useCallback((layer: MapLayer, colormap: string) => {
    for (const r of rastersOf(layer)) r.setTileParams({ colormap_name: colormap || undefined });
  }, []);

  const handleChangePredictionRescale = useCallback((layerId: string, min: number, max: number) => {
    if (!layerManager) return;
    const managed = layerManager.getLayer(layerId);
    if (!managed || managed.type !== 'prediction' || !managed.metadata) return;
    managed.metadata.rescaleMin = min;
    managed.metadata.rescaleMax = max;
    applyRescaleToLayer(managed.layer, min, max);
    updateLayersList();
  }, [layerManager, applyRescaleToLayer, updateLayersList]);

  const handleChangePredictionColormap = useCallback((layerId: string, colormap: string) => {
    if (!layerManager) return;
    const managed = layerManager.getLayer(layerId);
    if (!managed || managed.type !== 'prediction' || !managed.metadata) return;
    managed.metadata.colormap = colormap;
    applyColormapToLayer(managed.layer, colormap);
    updateLayersList();
  }, [layerManager, applyColormapToLayer, updateLayersList]);

  const handleChangeDiversityBandConfig = useCallback((layerId: string, config: Partial<DiversityBandConfig>) => {
    if (!layerManager) return;
    const managed = layerManager.getLayer(layerId);
    if (!managed || !managed.metadata || managed.metadata.layerType !== 'diversity_indices') return;

    const meta = managed.metadata;
    if (config.bandMode !== undefined) meta.bandMode = config.bandMode;
    if (config.selectedBand !== undefined) meta.selectedBand = config.selectedBand;
    if (config.rgbBands !== undefined) meta.rgbBands = config.rgbBands;
    if (config.rescaleMin !== undefined) meta.rescaleMin = config.rescaleMin;
    if (config.rescaleMax !== undefined) meta.rescaleMax = config.rescaleMax;
    if (config.rgbRescales !== undefined) meta.rgbRescales = config.rgbRescales;
    if (config.colormap !== undefined) meta.colormap = config.colormap;
    if (config.gamma !== undefined) meta.gamma = config.gamma;

    const tileUrl = buildDiversityTileUrl(meta.url, {
      bandMode: meta.bandMode,
      selectedBand: meta.selectedBand,
      rgbBands: meta.rgbBands,
      rescaleMin: meta.rescaleMin,
      rescaleMax: meta.rescaleMax,
      rgbRescales: meta.rgbRescales,
      colormap: meta.colormap,
      gamma: meta.gamma,
    });

    if (managed.layer instanceof RasterLayer) managed.layer.setUrl(tileUrl);
    updateLayersList();
  }, [layerManager, updateLayersList]);

  const handleChangeVectorDateRange = useCallback((layerId: string, range: [number, number]) => {
    if (!layerManager) return;
    const managed = layerManager.getLayer(layerId);
    if (!managed || managed.type !== 'vector' || !managed.metadata) return;
    managed.metadata.dateRange = range;
    if (!(managed.layer instanceof VectorLayer)) return;
    managed.metadata.featureCount = applySelectiveLoggingDateRange(managed.layer, range);
    updateLayersList();
  }, [layerManager, updateLayersList]);

  const handleReorderLayers = useCallback((fromIndex: number, toIndex: number) => {
    if (layerManager?.reorderLayers(fromIndex, toIndex)) updateLayersList();
  }, [layerManager, updateLayersList]);

  const handleRemoveLayer = useCallback((layerId: string) => {
    if (!map || !layerManager) return;
    if (layerManager.removeLayer(layerId)) {
      if (layerId === 'cog') setCogLayer(null);
      else if (layerId === 'fgb') setFgbLayer(null);
      else if (layerId.startsWith('sentinel2-')) setSentinel2Layers((prev: any[]) => prev.filter((l: any) => l.id !== layerId));
      else if (layerId.startsWith('prediction-global-')) {
        const state = globalLayersRef.current?.get(layerId);
        if (state) { state.cancelled = true; globalLayersRef.current?.delete(layerId); }
        removeVsmLayerByLayerId(layerId);
      } else if (layerId.startsWith('prediction-')) {
        setPredictionLayers((prev: any[]) => prev.filter((l: any) => l.id !== layerId));
      }
      updateLayersList();
    }
  }, [map, layerManager, updateLayersList]);

  const handleLocateLayer = useCallback((layerId: string) => {
    if (!map || !layerManager || typeof layerManager.getLayerExtent !== 'function') return;
    const extent = layerManager.getLayerExtent(layerId);
    if (extent?.length === 4 && extent.every((v: number) => isFinite(v) && !isNaN(v))) {
      // MapLibre zoom: OpenLayers' 18, less one.
      try { map.fitBounds(extent, { padding: 50, duration: 1000, maxZoom: 17 }); }
      catch { /* ignore */ }
    }
  }, [map, layerManager]);

  const vectorFeatures = useMemo(() => {
    const result: Record<string, { name: string; index: number }[]> = {};
    if (!layerManager) return result;
    for (const managed of layerManager.getLayersByType('vector')) {
      if (managed.metadata?.skipFeatureList) continue;
      if (!(managed.layer instanceof VectorLayer)) continue;
      const features = managed.layer.getFeatures();
      const previewCount = Math.min(features.length, MAX_VECTOR_FEATURE_LIST_PREVIEW);
      const preview = new Array(previewCount);
      for (let i = 0; i < previewCount; i += 1) {
        const feature = features[i];
        preview[i] = {
          name: feature.properties.tileName || feature.properties.name || `Feature ${i}`,
          index: i,
        };
      }
      result[managed.id] = preview;
    }
    return result;
  }, [layerManager, layers]);

  const handleHighlightFeature = useCallback((layerId: string, featureIndex: number | null) => {
    if (!layerManager) return;
    const prev = highlightFeatureRef.current;
    if (prev) { prev.layer.setFeatureStyle(prev.feature, undefined); highlightFeatureRef.current = null; }
    if (featureIndex === null) return;
    const managed = layerManager.getLayer(layerId);
    if (!managed || !(managed.layer instanceof VectorLayer)) return;
    const feature = managed.layer.getFeatures()[featureIndex];
    if (!feature) return;
    managed.layer.setFeatureStyle(feature, {
      text: { value: feature.properties.tileName || '', size: 24, bold: true, color: '#FFFFFF', halo: '#FF0000', haloWidth: 2 },
    });
    highlightFeatureRef.current = { layer: managed.layer, feature };
  }, [layerManager]);

  const handleRemoveFeature = useCallback((layerId: string, featureIndex: number) => {
    if (!layerManager) return;
    const managed = layerManager.getLayer(layerId);
    if (!managed || !(managed.layer instanceof VectorLayer)) return;
    const source = managed.layer;
    const feature = source.getFeatures()[featureIndex];
    if (!feature) return;
    const tileName = feature.properties.tileName;
    source.removeFeature(feature);
    const tiles = useMapStore.getState().selectedTiles;
    useMapStore.getState().setSelectedTiles(tiles.filter((t: string) => t !== tileName));
    const remaining = source.getFeatures().length;
    if (remaining === 0) layerManager.removeLayer(layerId);
    else (managed as any).name = `Selected Tiles (${remaining})`;
    updateLayersList();
  }, [layerManager, updateLayersList]);

  return {
    handleToggleVisibility, handleChangeOpacity, handleChangeZIndex,
    handleChangePredictionRescale, handleChangePredictionColormap, handleChangeDiversityBandConfig,
    handleChangeVectorDateRange,
    handleReorderLayers, handleRemoveLayer,
    handleLocateLayer, vectorFeatures, handleHighlightFeature, handleRemoveFeature,
  };
}
