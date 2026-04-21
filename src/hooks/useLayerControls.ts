import { useCallback, useMemo, useRef } from 'react';
import LayerGroup from 'ol/layer/Group';
import { Feature } from 'ol';
import { Geometry } from 'ol/geom';
import { Style, Stroke, Fill, Text as TextStyle } from 'ol/style';
import { useMapStore } from '../stores/mapStore';
import { buildDiversityTileUrl, type DiversityBandConfig } from './useLayerLoaders';

export function useLayerControls(
  updateLayersList: () => void,
  globalLayersRef: React.RefObject<globalThis.Map<string, { cancelled: boolean }>>,
) {
  const {
    map, layerManager, layers,
    setCogLayer, setFgbLayer, setSentinel2Layers, setPredictionLayers,
    removeVsmLayerByLayerId,
  } = useMapStore();

  const highlightFeatureRef = useRef<Feature<Geometry> | null>(null);

  const handleToggleVisibility = useCallback((layerId: string) => {
    if (layerManager?.getLayer(layerId)) { layerManager.toggleVisibility(layerId); updateLayersList(); }
  }, [layerManager, updateLayersList]);

  const handleChangeOpacity = useCallback((layerId: string, opacity: number) => {
    if (layerManager?.getLayer(layerId)) { layerManager.setOpacity(layerId, opacity); updateLayersList(); }
  }, [layerManager, updateLayersList]);

  const handleChangeZIndex = useCallback((layerId: string, zIndex: number) => {
    if (layerManager?.getLayer(layerId)) { layerManager.setZIndex(layerId, zIndex); updateLayersList(); }
  }, [layerManager, updateLayersList]);

  const updateTileSourceQueryParams = (source: any, updates: Record<string, string | undefined>) => {
    if (!source?.getUrls) return;
    const urls = source.getUrls();
    if (!urls?.length) return;
    try {
      const [basePath, qs] = urls[0].split('?');
      const params = new URLSearchParams(qs ?? '');
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === '') {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      source.setUrl(`${basePath}?${params.toString()}`);
      source.refresh?.();
    } catch { /* ignore */ }
  };

  const updateTileSourceRescale = (source: any, min: number, max: number) => {
    updateTileSourceQueryParams(source, { rescale: `${min},${max}` });
  };

  const updateTileSourceColormap = (source: any, colormap: string) => {
    updateTileSourceQueryParams(source, { colormap_name: colormap || undefined });
  };

  const applyRescaleToLayer = useCallback((layer: any, min: number, max: number) => {
    if (!layer) return;
    if (layer instanceof LayerGroup) {
      layer.getLayers().forEach((child: any) => applyRescaleToLayer(child, min, max));
    } else if (layer.getSource) {
      const src = layer.getSource();
      if (src?.getUrls) updateTileSourceRescale(src, min, max);
    }
  }, []);

  const applyColormapToLayer = useCallback((layer: any, colormap: string) => {
    if (!layer) return;
    if (layer instanceof LayerGroup) {
      layer.getLayers().forEach((child: any) => applyColormapToLayer(child, colormap));
    } else if (layer.getSource) {
      const src = layer.getSource();
      if (src?.getUrls) updateTileSourceColormap(src, colormap);
    }
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

    const layer = managed.layer as any;
    const source = layer.getSource?.();
    if (source?.setUrl) {
      source.setUrl(tileUrl);
      source.refresh?.();
    }
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
      try { map.getView().fit(extent, { padding: [50, 50, 50, 50], duration: 1000, maxZoom: 18 }); }
      catch { /* ignore */ }
    }
  }, [map, layerManager]);

  const vectorFeatures = useMemo(() => {
    const result: Record<string, { name: string; index: number }[]> = {};
    if (!layerManager) return result;
    for (const managed of layerManager.getLayersByType('vector')) {
      if (managed.metadata?.skipFeatureList) continue;
      const source = (managed.layer as any).getSource?.();
      if (!source) continue;
      const features = source.getFeatures?.() || [];
      result[managed.id] = features.map((f: any, i: number) => ({ name: f.get('tileName') || f.get('name') || `Feature ${i}`, index: i }));
    }
    return result;
  }, [layerManager, layers]);

  const handleHighlightFeature = useCallback((layerId: string, featureIndex: number | null) => {
    if (!layerManager) return;
    if (highlightFeatureRef.current) { highlightFeatureRef.current.setStyle(undefined); highlightFeatureRef.current = null; }
    if (featureIndex === null) return;
    const managed = layerManager.getLayer(layerId);
    if (!managed) return;
    const features = (managed.layer as any).getSource?.()?.getFeatures?.() || [];
    const feature = features[featureIndex];
    if (!feature) return;
    feature.setStyle(new Style({ text: new TextStyle({ text: feature.get('tileName') || '', font: 'bold 24px sans-serif', fill: new Fill({ color: '#FFFFFF' }), stroke: new Stroke({ color: '#FF0000', width: 4 }), overflow: true }) }));
    highlightFeatureRef.current = feature;
  }, [layerManager]);

  const handleRemoveFeature = useCallback((layerId: string, featureIndex: number) => {
    if (!layerManager) return;
    const managed = layerManager.getLayer(layerId);
    if (!managed) return;
    const source = (managed.layer as any).getSource?.();
    if (!source) return;
    const features = source.getFeatures?.() || [];
    const feature = features[featureIndex];
    if (!feature) return;
    const tileName = feature.get('tileName');
    source.removeFeature(feature);
    const tiles = useMapStore.getState().selectedTiles;
    useMapStore.getState().setSelectedTiles(tiles.filter((t: string) => t !== tileName));
    const remaining = source.getFeatures().length;
    if (remaining === 0) { layerManager.removeLayer(layerId); map?.removeLayer(managed.layer); }
    else (managed as any).name = `Selected Tiles (${remaining})`;
    updateLayersList();
  }, [layerManager, map, updateLayersList]);

  return {
    handleToggleVisibility, handleChangeOpacity, handleChangeZIndex,
    handleChangePredictionRescale, handleChangePredictionColormap, handleChangeDiversityBandConfig,
    handleReorderLayers, handleRemoveLayer,
    handleLocateLayer, vectorFeatures, handleHighlightFeature, handleRemoveFeature,
  };
}
