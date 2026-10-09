import { useCallback } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import { RasterLayer } from '../map/layers';
import { VectorLayer } from '../map/vector';
import { isFiniteBBox, type BBox } from '../map/proj';
import { useMapStore } from '../stores/mapStore';
import { getDefaultRescaleForRh, getDefaultRescaleAndColormap, type IntervalQChoice } from '../constants/predictions';
import {
  CANOPY_RATIO_RANGE,
  DIVERSITY_INDICES_BAND_NAMES,
  DIVERSITY_INDICES_DEFAULT_BAND,
  getDiversityBandColormap,
  getDiversityBandRange,
  getDiversityRgbRanges,
  getProfileEntropyRange,
} from '../constants/layerRanges';
import { deserialize } from 'flatgeobuf/lib/mjs/geojson';
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

/**
 * Where a COG is, in longitude/latitude.
 *
 * TiTiler's `/cog/info` gives bounds in the file's own CRS — the 10 m tiles are
 * in their UTM zone — so its GeoJSON form is used, which is already WGS84.
 */
async function fetchCogBounds(url: string): Promise<{ bbox: BBox; isAntimeridian: boolean }> {
  const resp = await fetch(apiUrl(`/cog/info.geojson?url=${encodeURIComponent(url)}`));
  if (!resp.ok) throw new Error(`Failed to get COG info: ${await resp.text()}`);
  const info = await resp.json();
  const bbox = info.bbox;
  if (!isFiniteBBox(bbox)) throw new Error('Bounds not available');
  // A tile straddling the antimeridian comes back spanning the world; ~9° is
  // the 1,000 km the OpenLayers version used as its threshold.
  return { bbox, isAntimeridian: bbox[2] - bbox[0] > 9 };
}

/** Fit the view to a box and resolve when it has arrived (or after the animation's length). */
function fitAndWait(map: MlMap, bbox: BBox): Promise<void> {
  return new Promise<void>((resolve) => {
    // MapLibre zoom: OpenLayers' 18, less one.
    map.fitBounds(bbox, { padding: 50, duration: 1000, maxZoom: 17 });
    map.once('moveend', () => resolve());
    setTimeout(resolve, 1100);
  });
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

      // Rendered by the backend, as every other raster here. OpenLayers read
      // the COG in the browser; MapLibre draws tiles, and TiTiler already makes
      // them from the same signed URL.
      const tileUrl = apiUrl(
        `/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(imageUrl)}` +
          (isVisualAsset ? '&bidx=1&bidx=2&bidx=3' : '&bidx=4&bidx=3&bidx=2&rescale=0,3000') +
          '&return_mask=true',
      );
      const newLayer = new RasterLayer({
        url: tileUrl, maxTileZoom: 18, opacity: 1, zIndex: 500,
        bounds: isFiniteBBox(bbox) ? (bbox as BBox) : undefined,
      });

      const layerId = `sentinel2-${image.id}-${Date.now()}`;
      const finalTile = tileName || image.mgrs_tile || extractTileName(image.id);
      const dateStr = image.datetime ? new Date(image.datetime).toISOString().split('T')[0] : '';
      const layerName = dateStr ? `${finalTile || 'Unknown'} ${dateStr}` : finalTile || 'Sentinel-2';

      setSentinel2Layers((prev: any[]) => [...prev, { layer: newLayer, id: layerId, imageId: image.id, tileName: finalTile, datetime: image.datetime, url: imageUrl }]);

      const metadata: any = { imageId: image.id, tileName: finalTile, datetime: image.datetime, url: imageUrl };
      metadata.rgbBands = isVisualAsset ? [1, 2, 3] : [4, 3, 2];
      metadata.rescaleMin = 0;
      metadata.rescaleMax = isVisualAsset ? 255 : 3000;
      metadata.gamma = 1.0;
      if (bbox?.length === 4) metadata.bbox = bbox;
      layerManager?.addLayer(layerId, layerName, 'sentinel2', newLayer, metadata);
      updateLayersList();

      if (isFiniteBBox(bbox)) {
        try {
          map.fitBounds(bbox, { padding: 50, duration: 1000 });
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
      const { bbox, isAntimeridian } = await fetchCogBounds(predictionData.url);
      if (isAntimeridian) skipZoom = true;

      if (!skipZoom) await fitAndWait(map, bbox);

      const defaultRescale = getDefaultRescaleForRh(predictionData.rh_index);
      const tileUrl = apiUrl(`/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(predictionData.url)}&expression=b1*(b1<32767)&nodata=-9999&return_mask=true&rescale=${defaultRescale.min},${defaultRescale.max}&colormap_name=inferno`);

      const newLayer = new RasterLayer({
        url: tileUrl, maxTileZoom: 18, opacity: 1, zIndex: 600,
        bounds: isAntimeridian ? undefined : bbox,
      });
      const qLabels = ['95%', 'median', '5%'];
      const layerId = `prediction-${predictionData.tile_name}-RH${predictionData.rh_index}-${qLabels[predictionData.q_index]}-${predictionData.year}-${Date.now()}`;
      const layerName = `${predictionData.tile_name} ${predictionData.year} RH${predictionData.rh_index} ${qLabels[predictionData.q_index]}`;

      setPredictionLayers((prev: any[]) => [...prev, { layer: newLayer, id: layerId, tileName: predictionData.tile_name, rhIndex: predictionData.rh_index, qIndex: predictionData.q_index, year: predictionData.year, url: predictionData.url, useClientSideTransform: false }]);

      const metadata: any = { tileName: predictionData.tile_name, rhIndex: predictionData.rh_index, qIndex: predictionData.q_index, year: predictionData.year, url: predictionData.url, rescaleMin: defaultRescale.min, rescaleMax: defaultRescale.max, colormap: 'inferno', useClientSideTransform: false };
      metadata.bbox = bbox;
      layerManager?.addLayer(layerId, layerName, 'prediction', newLayer, metadata);
      updateLayersList();
    } catch (error) {
      console.error('Error loading prediction COG:', error);
      alert(`Failed to load prediction COG: ${error instanceof Error ? error.message : error}`);
    }
  }, [map, layerManager, updateLayersList]);

  const handleLoadPredictionIntervalCOG = useCallback(async (
    data: {
      url_high: string;
      url_low: string;
      tile_name: string;
      rh_index: number;
      qChoice: IntervalQChoice;
      year: number;
    },
    skipZoom = false,
  ) => {
    if (!map) return;
    try {
      // url_high is the bbox reference — both COGs share the same tile extent.
      const { bbox, isAntimeridian } = await fetchCogBounds(data.url_high);
      if (isAntimeridian) skipZoom = true;

      if (!skipZoom) await fitAndWait(map, bbox);

      const defaultRescale = getDefaultRescaleAndColormap(data.rh_index, data.qChoice);
      const colormap = defaultRescale.colormap;
      const tileUrl = apiUrl(
        `/predictions/interval-tile/WebMercatorQuad/{z}/{x}/{y}` +
        `?url_high=${encodeURIComponent(data.url_high)}` +
        `&url_low=${encodeURIComponent(data.url_low)}` +
        `&rescale=${defaultRescale.min},${defaultRescale.max}` +
        `&colormap_name=${encodeURIComponent(colormap)}`,
      );

      const newLayer = new RasterLayer({
        url: tileUrl, maxTileZoom: 18, opacity: 1, zIndex: 600,
        bounds: isAntimeridian ? undefined : bbox,
      });
      const layerId = `prediction-${data.tile_name}-RH${data.rh_index}-${data.qChoice}-${data.year}-${Date.now()}`;
      const layerName = `${data.tile_name} ${data.year} RH${data.rh_index} ${data.qChoice}`;

      setPredictionLayers((prev: any[]) => [...prev, {
        layer: newLayer, id: layerId,
        tileName: data.tile_name, rhIndex: data.rh_index,
        qIndex: data.qChoice, year: data.year,
        url: data.url_high, useClientSideTransform: false,
      }]);

      const metadata: any = {
        tileName: data.tile_name, rhIndex: data.rh_index,
        qIndex: data.qChoice, year: data.year,
        // `url` is what the figure exporter filters on; point it at the high
        // quantile so the layer shows up in "layers to save". The exporter
        // honors `urlLow` to subtract the two on the backend.
        url: data.url_high, urlLow: data.url_low,
        rescaleMin: defaultRescale.min, rescaleMax: defaultRescale.max,
        colormap, useClientSideTransform: false,
      };
      metadata.bbox = bbox;
      layerManager?.addLayer(layerId, layerName, 'prediction', newLayer, metadata);
      updateLayersList();
    } catch (error) {
      console.error('Error loading prediction interval COG:', error);
      alert(`Failed to load prediction interval: ${error instanceof Error ? error.message : error}`);
    }
  }, [map, layerManager, updateLayersList]);

  const handleLoadAuxiliaryLayer = useCallback(async (data: {
    url: string; tile_name: string; layer_type: string;
    metric?: 'entropy' | 'enl1d' | 'enl2d'; bands?: string[];
  }) => {
    if (!map) return;
    try {
      const { bbox, isAntimeridian } = await fetchCogBounds(data.url);

      if (!isAntimeridian) await fitAndWait(map, bbox);

      if (data.layer_type === 'diversity_indices') {
        const bandNames = data.bands ?? [...DIVERSITY_INDICES_BAND_NAMES];
        const defaultBandMode: 'grayscale' | 'rgb' = 'grayscale';
        const defaultBand = DIVERSITY_INDICES_DEFAULT_BAND;
        const [defaultRescaleMin, defaultRescaleMax] = getDiversityBandRange(defaultBand);
        const defaultColormap = getDiversityBandColormap(defaultBand);
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

        const newLayer = new RasterLayer({
          url: tileUrl, maxTileZoom: 18, opacity: 1, zIndex: 600,
          bounds: isAntimeridian ? undefined : bbox,
        });

        const layerId = `auxiliary-diversity_indices-${data.tile_name}-${Date.now()}`;
        const layerName = `${data.tile_name} Diversity`;

        layerManager?.addLayer(layerId, layerName, 'prediction', newLayer, {
          tileName: data.tile_name, url: data.url, layerType: 'diversity_indices',
          bandNames, bandMode: defaultBandMode,
          selectedBand: defaultBand,
          rgbBands: defaultRgbBands,
          rescaleMin: defaultRescaleMin, rescaleMax: defaultRescaleMax,
          rgbRescales: defaultRgbRescales,
          colormap: defaultColormap, gamma: defaultGamma, bbox,
        });
        updateLayersList();
        return;
      }

      const metric = data.metric ?? 'entropy';
      const profileEntropyRange = getProfileEntropyRange(metric);
      const rescaleMap: Record<string, string> = {
        cr: `${CANOPY_RATIO_RANGE[0]},${CANOPY_RATIO_RANGE[1]}`,
        als: '0,50',
        lvis: '0,50',
        profile_entropy: `${profileEntropyRange[0]},${profileEntropyRange[1]}`,
      };
      const rescale = rescaleMap[data.layer_type] ?? '0,5490';
      const [rescaleMin, rescaleMax] = rescale.split(',').map(Number);
      const colormapMap: Record<string, string> = { cr: 'rdbu', als: 'inferno', lvis: 'inferno', profile_entropy: 'greens' };
      const colormap = colormapMap[data.layer_type];
      const colormapParam = colormap ? `&colormap_name=${colormap}` : '';
      // CR and profile_entropy COGs are written with -9999 nodata; ALS/LVIS use 255.
      const nodataValueByType: Record<string, string> = { als: '255', lvis: '255', cr: '-9999', profile_entropy: '-9999' };
      const nodataValue = nodataValueByType[data.layer_type];
      const nodataParam = nodataValue ? `&nodata=${nodataValue}` : '';
      const tileUrl = apiUrl(`/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(data.url)}&return_mask=true&rescale=${rescale}${nodataParam}${colormapParam}`);

      const newLayer = new RasterLayer({
        url: tileUrl, maxTileZoom: 18, opacity: 1, zIndex: 600,
        bounds: isAntimeridian ? undefined : bbox,
      });

      const layerId = `auxiliary-${data.layer_type}-${data.tile_name}-${Date.now()}`;
      const entropyLabel = metric === 'enl1d' ? '1D ENL' : metric === 'enl2d' ? '2D ENL' : 'FHD';
      const layerName = data.layer_type === 'cr' ? `${data.tile_name} Canopy Ratio`
        : data.layer_type === 'profile_entropy' ? `${data.tile_name} ${entropyLabel}`
        : `${data.tile_name} ${data.layer_type.replace('_', ' ')}`;

      layerManager?.addLayer(layerId, layerName, 'prediction', newLayer, {
        tileName: data.tile_name, url: data.url, layerType: data.layer_type,
        metric: data.metric, rescaleMin, rescaleMax, colormap, bbox,
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
        const features: GeoJSON.Feature[] = [];
        for await (const feature of deserialize(data.buffer) as AsyncGenerator<GeoJSON.Feature>) features.push(feature);

        const newLayer = new VectorLayer({
          zIndex: 700,
          style: { circle: { radius: 5, fill: 'rgba(0, 150, 136, 0.55)', stroke: 'rgba(255, 255, 255, 0.85)', strokeWidth: 0.75 } },
        });
        newLayer.setFeatures(features);

        const layerId = `gedi-${data.tile_name}`;
        const layerName = `GEDI ${data.tile_name} (${data.sampled_count}/${data.total_count})`;
        if (layerManager?.getLayer(layerId)) layerManager.removeLayer(layerId);

        const bbox = newLayer.getBounds();
        const metadata: any = {
          tileName: data.tile_name, featureCount: data.sampled_count,
          sampledCount: data.sampled_count, totalCount: data.total_count,
          sampleSize: data.sample_size, skipFeatureList: true,
        };
        if (bbox) metadata.bbox = bbox;
        layerManager?.addLayer(layerId, layerName, 'vector', newLayer, metadata);
        updateLayersList();
      } catch (error) {
        console.error('Error loading GEDI points:', error);
        alert(`Failed to load GEDI points: ${error instanceof Error ? error.message : error}`);
      }
    })();
  }, [map, layerManager, updateLayersList]);

  return { handleLoadSentinel2Image, handleLoadPredictionCOG, handleLoadPredictionIntervalCOG, handleLoadAuxiliaryLayer, handleLoadGEDIPoints };
}
