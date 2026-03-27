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
import { getDefaultRescaleForRh, getDefaultRescaleAndColormap } from '../constants/predictions';
import { deserialize } from 'flatgeobuf/lib/mjs/ol';

function extractTileName(imageId: string): string {
  const match = imageId.match(/_T([A-Z0-9]{5})_/);
  if (match?.[1]) return match[1];
  const fallback = imageId.match(/T([A-Z0-9]+)/);
  return fallback ? fallback[1] : imageId.substring(0, 20);
}

async function fetchCogExtent(url: string) {
  const infoUrl = `http://localhost:8000/cog/info?url=${encodeURIComponent(url)}`;
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

      if (image.visual_url) {
        const signResp = await fetch('http://localhost:8000/sentinel2/sign-url', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: image.visual_url }),
        });
        if (!signResp.ok) throw new Error(`Failed to sign URL: ${signResp.status}`);
        const signData = await signResp.json();
        if (signData.error) throw new Error(signData.error);
        imageUrl = signData.signed_url || image.visual_url;
      } else {
        const resp = await fetch('http://localhost:8000/sentinel2/load-image', {
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
        opacity: 0.8,
        zIndex: 500,
      });

      const layerId = `sentinel2-${image.id}-${Date.now()}`;
      const finalTile = tileName || image.mgrs_tile || extractTileName(image.id);
      const dateStr = image.datetime ? new Date(image.datetime).toISOString().split('T')[0] : '';
      const layerName = dateStr ? `${finalTile || 'Unknown'} ${dateStr}` : finalTile || 'Sentinel-2';

      map.addLayer(newLayer);
      setSentinel2Layers((prev: any[]) => [...prev, { layer: newLayer, id: layerId, imageId: image.id, tileName: finalTile, datetime: image.datetime, url: imageUrl }]);

      const metadata: any = { imageId: image.id, tileName: finalTile, datetime: image.datetime, url: imageUrl };
      if (bbox?.length === 4) metadata.bbox = bbox;
      layerManager?.addLayer(layerId, layerName, 'sentinel2', newLayer, metadata);

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
      const tileUrl = `http://localhost:8000/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(predictionData.url)}&expression=b1*(b1<32767)&nodata=-9999&return_mask=true&rescale=${defaultRescale.min},${defaultRescale.max}&colormap_name=inferno`;

      const layerOpts: any = {
        source: new XYZ({ url: tileUrl, crossOrigin: 'anonymous', maxZoom: 18 }),
        opacity: 1, zIndex: 600,
      };
      if (!isAntimeridian && extent.every((v: number) => isFinite(v))) layerOpts.extent = extent;

      const newLayer = new TileLayer(layerOpts);
      const qLabels = ['95%', 'median', '5%'];
      const layerId = `prediction-${predictionData.tile_name}-RH${predictionData.rh_index}-${qLabels[predictionData.q_index]}-${predictionData.year}-${Date.now()}`;
      const layerName = `${predictionData.tile_name} (${predictionData.year}) RH${predictionData.rh_index} ${qLabels[predictionData.q_index]}`;

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
    url: string; tile_name: string; layer_type: string; metric?: 'entropy' | 'enl1d' | 'enl2d';
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

      const metric = data.metric ?? 'entropy';
      const rescaleMap: Record<string, string> = { cr: '0.3,1.3', als: '0,50', profile_entropy: metric === 'enl1d' ? '1,6' : metric === 'enl2d' ? '1,4' : '0,2.5' };
      const rescale = rescaleMap[data.layer_type] ?? '0,5490';
      const [rescaleMin, rescaleMax] = rescale.split(',').map(Number);
      const colormapMap: Record<string, string> = { cr: 'ylgn_r', als: 'inferno', profile_entropy: 'greens' };
      const colormap = colormapMap[data.layer_type];
      const colormapParam = colormap ? `&colormap_name=${colormap}` : '';
      const nodataParam = data.layer_type === 'als' ? '&nodata=255' : '';
      const tileUrl = `http://localhost:8000/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(data.url)}&return_mask=true&rescale=${rescale}${nodataParam}${colormapParam}`;

      const layerOpts: any = {
        source: new XYZ({ url: tileUrl, crossOrigin: 'anonymous', maxZoom: 18 }),
        opacity: 1, zIndex: 600,
      };
      if (!isAntimeridian) layerOpts.extent = extent;
      const newLayer = new TileLayer(layerOpts);

      const layerId = `auxiliary-${data.layer_type}-${data.tile_name}-${Date.now()}`;
      const entropyLabel = metric === 'enl1d' ? '1D ENL' : metric === 'enl2d' ? '2D ENL' : 'FHD';
      const layerName = data.layer_type === 'cr' ? `Canopy Ratio ${data.tile_name}`
        : data.layer_type === 'profile_entropy' ? `${data.tile_name} (${entropyLabel})`
        : `${data.tile_name} (${data.layer_type.replace('_', ' ')})`;

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
