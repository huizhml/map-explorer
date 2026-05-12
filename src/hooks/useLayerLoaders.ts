import { useCallback } from 'react';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Style, Stroke, Fill, Circle as CircleStyle } from 'ol/style';
import GeoTIFF from 'ol/source/GeoTIFF';
import WebGLTile from 'ol/layer/WebGLTile';
import XYZ from 'ol/source/XYZ';
import TileLayer from 'ol/layer/Tile';
import { transformExtent } from 'ol/proj';
import { useMapStore } from '../stores/mapStore';
import { getDefaultRescaleForRh } from '../constants/predictions';
import {
  CANOPY_RATIO_RANGE,
  DIVERSITY_INDICES_BAND_NAMES,
  DIVERSITY_INDICES_DEFAULT_BAND,
  DIVERSITY_INDICES_DEFAULT_COLORMAP,
  getDiversityBandRange,
  getDiversityRgbRanges,
  getProfileEntropyRange,
} from '../constants/layerRanges';
import { deserialize } from 'flatgeobuf/lib/mjs/ol';
import { apiUrl } from '../utils/apiBase';

export interface DiversityBandConfig {
  bandMode: 'grayscale' | 'rgb';
  selectedBand?: number;
  rgbBands?: [number, number, number];
  rescaleMin: number;
  rescaleMax: number;
  rgbRescales?: [number, number][];
  colormap?: string;
  gamma?: number;
}

export function buildDiversityTileUrl(cogUrl: string, config: DiversityBandConfig): string {
  const base = apiUrl('/cog/tiles/WebMercatorQuad/{z}/{x}/{y}');
  const params = new URLSearchParams();
  params.set('url', cogUrl);
  params.set('return_mask', 'true');
  // The diversity-indices COG is written with -9999 as nodata (see
  // backend/utils.py NODATA_OUT), but gdal_translate -of COG doesn't always
  // preserve the nodata tag; pass it explicitly so titiler masks those pixels.
  params.set('nodata', '-9999');

  if (config.bandMode === 'grayscale') {
    const band = config.selectedBand ?? 1;
    params.append('bidx', String(band));
    params.set('rescale', `${config.rescaleMin},${config.rescaleMax}`);
    if (config.colormap) {
      params.set('colormap_name', config.colormap);
    }
  } else {
    const [r, g, b] = config.rgbBands ?? [1, 2, 3];
    params.append('bidx', String(r));
    params.append('bidx', String(g));
    params.append('bidx', String(b));
    if (config.rgbRescales && config.rgbRescales.length === 3) {
      for (const [lo, hi] of config.rgbRescales) {
        params.append('rescale', `${lo},${hi}`);
      }
    } else {
      params.append('rescale', `${config.rescaleMin},${config.rescaleMax}`);
      params.append('rescale', `${config.rescaleMin},${config.rescaleMax}`);
      params.append('rescale', `${config.rescaleMin},${config.rescaleMax}`);
    }
  }

  return `${base}?${params.toString()}`;
}

function extractTileName(imageId: string): string {
  const match = imageId.match(/_T([A-Z0-9]{5})_/);
  if (match?.[1]) return match[1];
  const fallback = imageId.match(/T([A-Z0-9]+)/);
  return fallback ? fallback[1] : imageId.substring(0, 20);
}

async function fetchCogExtent(url: string) {
  const infoUrl = apiUrl(`/cog/info?url=${encodeURIComponent(url)}`);
  const resp = await fetch(infoUrl);
  if (!resp.ok) throw new Error(`Failed to get COG info: ${await resp.text()}`);
  const info = await resp.json();
  if (!info.bounds || info.bounds.length !== 4) throw new Error('Bounds not available');

  const bbox = info.bounds;
  let sourceCRS = 'EPSG:4326';
  if (info.crs) {
    if (typeof info.crs === 'string') sourceCRS = info.crs;
    else if (info.crs.properties?.name) sourceCRS = info.crs.properties.name;
    else if (info.crs.code) sourceCRS = `EPSG:${info.crs.code}`;
  }

  let extent: number[];
  if (sourceCRS === 'EPSG:3857' || sourceCRS === 'EPSG:900913') {
    extent = bbox;
  } else {
    extent = transformExtent(bbox, sourceCRS, 'EPSG:3857');
  }
  if (!extent.every((v: number) => isFinite(v) && !isNaN(v))) {
    if (sourceCRS !== 'EPSG:4326') {
      extent = transformExtent(bbox, 'EPSG:4326', 'EPSG:3857');
    }
    if (!extent.every((v: number) => isFinite(v) && !isNaN(v))) {
      throw new Error('Transformed extent invalid');
    }
  }

  const isAntimeridian = (extent[2] - extent[0]) > 1_000_000;
  return { extent, isAntimeridian };
}

export function useLayerLoaders(updateLayersList: () => void) {
  const { map, layerManager, setSentinel2Layers, setPredictionLayers } = useMapStore();

  const handleLoadSentinel2Image = useCallback(async (
    image: { id: string; visual_url?: string; bbox?: number[]; datetime?: string; mgrs_tile?: string },
    tileName?: string,
  ) => {
    if (!map) return;
    try {
      let imageUrl: string;
      let bbox = image.bbox;
      let isVisualAsset = false;

      if (image.visual_url) {
        isVisualAsset = true;
        const signResp = await fetch(apiUrl('/sentinel2/sign-url'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: image.visual_url }),
        });
        if (!signResp.ok) throw new Error(`Failed to sign URL: ${signResp.status}`);
        const signData = await signResp.json();
        if (signData.error) throw new Error(signData.error);
        imageUrl = signData.signed_url || image.visual_url;
      } else {
        const resp = await fetch(apiUrl('/sentinel2/load-image'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_id: image.id }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        imageUrl = data.url;
        if (!bbox && data.bbox) bbox = data.bbox;
      }

      const newLayer = new WebGLTile({
        source: new GeoTIFF({ sources: [{ url: imageUrl }], interpolate: true }),
        opacity: 1,
        zIndex: 500,
      });

      const layerId = `sentinel2-${image.id}-${Date.now()}`;
      const finalTile = tileName || image.mgrs_tile || extractTileName(image.id);
      const dateStr = image.datetime ? new Date(image.datetime).toISOString().split('T')[0] : '';
      const layerName = dateStr ? `${finalTile || 'Unknown'} ${dateStr}` : finalTile || 'Sentinel-2';

      map.addLayer(newLayer);
      setSentinel2Layers((prev: any[]) => [...prev, { layer: newLayer, id: layerId, imageId: image.id, tileName: finalTile, datetime: image.datetime, url: imageUrl }]);

      const metadata: any = { imageId: image.id, tileName: finalTile, datetime: image.datetime, url: imageUrl };
      metadata.rgbBands = isVisualAsset ? [1, 2, 3] : [4, 3, 2];
      metadata.rescaleMin = 0;
      metadata.rescaleMax = isVisualAsset ? 255 : 3000;
      metadata.gamma = 1.0;
      if (bbox?.length === 4) metadata.bbox = bbox;
      layerManager?.addLayer(layerId, layerName, 'sentinel2', newLayer, metadata);
      updateLayersList();

      if (bbox?.length === 4) {
        try {
          map.getView().fit(transformExtent(bbox, 'EPSG:4326', 'EPSG:3857'), { padding: [50, 50, 50, 50], duration: 1000 });
        } catch { /* ignore */ }
      }
    } catch (error) {
      console.error('Error loading Sentinel-2 image:', error);
      alert(`Failed to load Sentinel-2 image: ${error instanceof Error ? error.message : error}`);
    }
  }, [map, layerManager, updateLayersList]);

  const handleLoadPredictionCOG = useCallback(async (
    predictionData: { url: string; tile_name: string; rh_index: number; q_index: number; year: number },
    skipZoom = false,
  ) => {
    if (!map) return;
    try {
      const { extent, isAntimeridian } = await fetchCogExtent(predictionData.url);
      if (isAntimeridian) skipZoom = true;

      if (!skipZoom && extent.every((v: number) => isFinite(v))) {
        await new Promise<void>((resolve) => {
          map.getView().fit(extent, { padding: [50, 50, 50, 50], duration: 1000, maxZoom: 18, callback: () => resolve() });
          setTimeout(resolve, 1100);
        });
      }

      const defaultRescale = getDefaultRescaleForRh(predictionData.rh_index);
      const tileUrl = apiUrl(`/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(predictionData.url)}&expression=b1*(b1<32767)&nodata=-9999&return_mask=true&rescale=${defaultRescale.min},${defaultRescale.max}&colormap_name=inferno`);

      const layerOpts: any = {
        source: new XYZ({ url: tileUrl, crossOrigin: 'anonymous', maxZoom: 18 }),
        opacity: 1, zIndex: 600,
      };
      if (!isAntimeridian && extent.every((v: number) => isFinite(v))) layerOpts.extent = extent;

      const newLayer = new TileLayer(layerOpts);
      const qLabels = ['95%', 'median', '5%'];
      const layerId = `prediction-${predictionData.tile_name}-RH${predictionData.rh_index}-${qLabels[predictionData.q_index]}-${predictionData.year}-${Date.now()}`;
      const layerName = `${predictionData.tile_name} ${predictionData.year} RH${predictionData.rh_index} ${qLabels[predictionData.q_index]}`;

      map.addLayer(newLayer);
      setPredictionLayers((prev: any[]) => [...prev, { layer: newLayer, id: layerId, tileName: predictionData.tile_name, rhIndex: predictionData.rh_index, qIndex: predictionData.q_index, year: predictionData.year, url: predictionData.url, useClientSideTransform: false }]);

      const metadata: any = { tileName: predictionData.tile_name, rhIndex: predictionData.rh_index, qIndex: predictionData.q_index, year: predictionData.year, url: predictionData.url, rescaleMin: defaultRescale.min, rescaleMax: defaultRescale.max, colormap: 'inferno', useClientSideTransform: false };
      if (extent.every((v: number) => isFinite(v))) metadata.extent = extent;
      layerManager?.addLayer(layerId, layerName, 'prediction', newLayer, metadata);
      updateLayersList();
    } catch (error) {
      console.error('Error loading prediction COG:', error);
      alert(`Failed to load prediction COG: ${error instanceof Error ? error.message : error}`);
    }
  }, [map, layerManager, updateLayersList]);

  const handleLoadAuxiliaryLayer = useCallback(async (data: {
    url: string; tile_name: string; layer_type: string;
    metric?: 'entropy' | 'enl1d' | 'enl2d'; bands?: string[];
  }) => {
    if (!map) return;
    try {
      const { extent, isAntimeridian } = await fetchCogExtent(data.url);

      if (!isAntimeridian && extent.every((v: number) => isFinite(v))) {
        await new Promise<void>((resolve) => {
          map.getView().fit(extent, { padding: [50, 50, 50, 50], duration: 1000, maxZoom: 18, callback: () => resolve() });
          setTimeout(resolve, 1100);
        });
      }

      if (data.layer_type === 'diversity_indices') {
        const bandNames = data.bands ?? [...DIVERSITY_INDICES_BAND_NAMES];
        const defaultBandMode: 'grayscale' | 'rgb' = 'grayscale';
        const defaultBand = DIVERSITY_INDICES_DEFAULT_BAND;
        const [defaultRescaleMin, defaultRescaleMax] = getDiversityBandRange(defaultBand);
        const defaultColormap = DIVERSITY_INDICES_DEFAULT_COLORMAP;
        const defaultGamma = 1.0;
        const defaultRgbBands: [number, number, number] = [1, 2, 3];
        const defaultRgbRescales = getDiversityRgbRanges(defaultRgbBands);

        const tileUrl = buildDiversityTileUrl(data.url, {
          bandMode: defaultBandMode,
          selectedBand: defaultBand,
          rescaleMin: defaultRescaleMin,
          rescaleMax: defaultRescaleMax,
          colormap: defaultColormap,
        });

        const layerOpts: any = {
          source: new XYZ({ url: tileUrl, crossOrigin: 'anonymous', maxZoom: 18 }),
          opacity: 1, zIndex: 600,
        };
        if (!isAntimeridian) layerOpts.extent = extent;
        const newLayer = new TileLayer(layerOpts);

        const layerId = `auxiliary-diversity_indices-${data.tile_name}-${Date.now()}`;
        const layerName = `${data.tile_name} Diversity`;

        map.addLayer(newLayer);
        layerManager?.addLayer(layerId, layerName, 'prediction', newLayer, {
          tileName: data.tile_name, url: data.url, layerType: 'diversity_indices',
          bandNames, bandMode: defaultBandMode,
          selectedBand: defaultBand,
          rgbBands: defaultRgbBands,
          rescaleMin: defaultRescaleMin, rescaleMax: defaultRescaleMax,
          rgbRescales: defaultRgbRescales,
          colormap: defaultColormap, gamma: defaultGamma, extent,
        });
        updateLayersList();
        return;
      }

      const metric = data.metric ?? 'entropy';
      const profileEntropyRange = getProfileEntropyRange(metric);
      const rescaleMap: Record<string, string> = {
        cr: `${CANOPY_RATIO_RANGE[0]},${CANOPY_RATIO_RANGE[1]}`,
        als: '0,50',
        profile_entropy: `${profileEntropyRange[0]},${profileEntropyRange[1]}`,
      };
      const rescale = rescaleMap[data.layer_type] ?? '0,5490';
      const [rescaleMin, rescaleMax] = rescale.split(',').map(Number);
      const colormapMap: Record<string, string> = { cr: 'rdbu', als: 'inferno', profile_entropy: 'greens' };
      const colormap = colormapMap[data.layer_type];
      const colormapParam = colormap ? `&colormap_name=${colormap}` : '';
      // CR and profile_entropy COGs are written with -9999 nodata; ALS uses 255.
      const nodataValueByType: Record<string, string> = { als: '255', cr: '-9999', profile_entropy: '-9999' };
      const nodataValue = nodataValueByType[data.layer_type];
      const nodataParam = nodataValue ? `&nodata=${nodataValue}` : '';
      const tileUrl = apiUrl(`/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(data.url)}&return_mask=true&rescale=${rescale}${nodataParam}${colormapParam}`);

      const layerOpts: any = {
        source: new XYZ({ url: tileUrl, crossOrigin: 'anonymous', maxZoom: 18 }),
        opacity: 1, zIndex: 600,
      };
      if (!isAntimeridian) layerOpts.extent = extent;
      const newLayer = new TileLayer(layerOpts);

      const layerId = `auxiliary-${data.layer_type}-${data.tile_name}-${Date.now()}`;
      const entropyLabel = metric === 'enl1d' ? '1D ENL' : metric === 'enl2d' ? '2D ENL' : 'FHD';
      const layerName = data.layer_type === 'cr' ? `${data.tile_name} Canopy Ratio`
        : data.layer_type === 'profile_entropy' ? `${data.tile_name} ${entropyLabel}`
        : `${data.tile_name} ${data.layer_type.replace('_', ' ')}`;

      map.addLayer(newLayer);
      layerManager?.addLayer(layerId, layerName, 'prediction', newLayer, {
        tileName: data.tile_name, url: data.url, layerType: data.layer_type,
        metric: data.metric, rescaleMin, rescaleMax, colormap, extent,
      });
      updateLayersList();
    } catch (error) {
      console.error('Error loading auxiliary layer:', error);
      alert(`Failed to load auxiliary layer: ${error instanceof Error ? error.message : error}`);
    }
  }, [map, layerManager, updateLayersList]);

  const handleLoadGEDIPoints = useCallback((data: {
    buffer: Uint8Array; tile_name: string; sampled_count: number; total_count: number; sample_size: number;
  }) => {
    if (!map) return;
    (async () => {
      try {
        const source = new VectorSource();
        const iter = deserialize(data.buffer, undefined, undefined, false, {}, false, 'EPSG:4326', 'EPSG:3857');
        for await (const feature of iter) source.addFeature(feature as any);

        const newLayer = new VectorLayer({
          source, zIndex: 700,
          style: new Style({
            image: new CircleStyle({
              radius: 5,
              fill: new Fill({ color: 'rgba(0, 150, 136, 0.55)' }),
              stroke: new Stroke({ color: 'rgba(255, 255, 255, 0.85)', width: 0.75 }),
            }),
          }),
        });

        const layerId = `gedi-${data.tile_name}`;
        const layerName = `GEDI ${data.tile_name} (${data.sampled_count}/${data.total_count})`;
        if (layerManager?.getLayer(layerId)) layerManager.removeLayer(layerId);

        map.addLayer(newLayer);
        const extent = source.getExtent();
        const metadata: any = {
          tileName: data.tile_name, featureCount: data.sampled_count,
          sampledCount: data.sampled_count, totalCount: data.total_count,
          sampleSize: data.sample_size, skipFeatureList: true,
        };
        if (extent?.length === 4 && extent.every((v: number) => isFinite(v))) metadata.extent = extent;
        layerManager?.addLayer(layerId, layerName, 'vector', newLayer, metadata);
        updateLayersList();
      } catch (error) {
        console.error('Error loading GEDI points:', error);
        alert(`Failed to load GEDI points: ${error instanceof Error ? error.message : error}`);
      }
    })();
  }, [map, layerManager, updateLayersList]);

  return { handleLoadSentinel2Image, handleLoadPredictionCOG, handleLoadAuxiliaryLayer, handleLoadGEDIPoints };
}
