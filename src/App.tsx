import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { MapComponent, type Map } from './components/Map';
import { SidebarContainer } from './containers/SidebarContainer';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import { LayerControl, type Layer } from './components/LayerControl';
import { FeaturePopup } from './components/FeaturePopup';
import { TileSearch } from './components/TileSearch';
import { BaseMapSelector } from './components/BaseMapSelector';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import LayerGroup from 'ol/layer/Group';
import { Feature } from 'ol';
import { Geometry, Point, Polygon, LineString, MultiPolygon, MultiLineString } from 'ol/geom';
import { Style, Stroke, Fill, Circle as CircleStyle, Text as TextStyle } from 'ol/style';
import Draw, { createBox } from 'ol/interaction/Draw';
import GeoTIFF from 'ol/source/GeoTIFF';
import WebGLTile from 'ol/layer/WebGLTile';
import { transformExtent, transform } from 'ol/proj';
import { LayerManager } from './utils/LayerManager';
import { useMapStore } from './stores/mapStore';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#1976d2',
    },
  },
});

function App() {
  // Zustand store
  const {
    map,
    setMap,
    cogLayer,
    setCogLayer,
    fgbLayer,
    setFgbLayer,
    layers,
    setLayers,
    popupProperties,
    setPopupProperties,
    popupPosition,
    setPopupPosition,
    popupGeometry,
    setPopupGeometry,
    popupCoordinates,
    setPopupCoordinates,
    highlightLayer,
    setHighlightLayer,
    setSentinel2Layers,
    setPredictionLayers,
    layerManager,
    setLayerManager,
    closePopup,
    activeVSM,
  } = useMapStore();

  // Initialize layer manager
  useEffect(() => {
    if (!layerManager) {
      const manager = new LayerManager(null);
      setLayerManager(manager);
      // If map is already initialized, set it on the manager
      const currentMap = useMapStore.getState().map;
      if (currentMap) {
        manager.setMap(currentMap);
      }
    }
  }, [layerManager, setLayerManager]);

  const handleMapInit = useCallback((mapInstance: Map) => {
    setMap(mapInstance);
    const currentManager = useMapStore.getState().layerManager;
    if (currentManager) {
      currentManager.setMap(mapInstance);
    } else {
      // Create manager if it doesn't exist yet
      const manager = new LayerManager(mapInstance);
      setLayerManager(manager);
    }
  }, [setMap, setLayerManager]);

  // Update layers list when map or layers change - sync with LayerManager
  // This must be defined before handlers that use it
  const updateLayersList = useCallback(() => {
    if (!map || !layerManager) return;

    // Sync all properties from actual layers
    layerManager.syncAllProperties();

    // Get all managed layers and convert to Layer format for UI
    const managedLayers = layerManager.getAllLayers();
    const layersList: Layer[] = managedLayers.map((managed: any) => ({
      id: managed.id,
      name: managed.name,
      visible: managed.visible,
      opacity: managed.opacity,
      zIndex: managed.zIndex,
      type: managed.type,
      metadata: managed.metadata,
    }));

    setLayers(layersList);
  }, [map, layerManager]);

  // Extract MGRS tile name from Sentinel-2 image ID
  // Format: S2A_MSIL2A_20251027T103151_N0511_R108_T33UUB_20251027T120010
  // Tile is the part after "T" before the last processing date
  const extractTileName = (imageId: string): string => {
    // Look for pattern: T followed by digits and letters (MGRS tile format)
    const match = imageId.match(/_T([A-Z0-9]{5})_/);
    if (match && match[1]) {
      return match[1]; // e.g., "33UUB" or "16UDV"
    }
    // Fallback: try to find any T followed by alphanumeric
    const fallbackMatch = imageId.match(/T([A-Z0-9]+)/);
    return fallbackMatch ? fallbackMatch[1] : imageId.substring(0, 20);
  };

  // Handler to load Sentinel-2 image
  const handleLoadSentinel2Image = useCallback(async (image: { id: string; visual_url?: string; bbox?: number[]; datetime?: string; mgrs_tile?: string }, tileName?: string) => {
    if (!map) return;
    console.log('Loading Sentinel-2 image:', image, 'with tile name:', tileName);
    try {
      let imageUrl: string;
      let bbox: number[] | undefined = image.bbox;

      // Always sign the URL - either use cached URL and sign it, or query backend
      if (image.visual_url) {
        // Sign the cached URL
        const signResponse = await fetch('http://localhost:8000/sentinel2/sign-url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url: image.visual_url }),
        });

        if (!signResponse.ok) {
          throw new Error(`Failed to sign URL: ${signResponse.status}`);
        }

        const signData = await signResponse.json();
        if (signData.error) {
          throw new Error(signData.error);
        }

        imageUrl = signData.signed_url || image.visual_url;
      } else {
        // Fallback: query backend if URL not cached (backend will sign it)
        const response = await fetch('http://localhost:8000/sentinel2/load-image', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ item_id: image.id }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        
        if (data.error) {
          throw new Error(data.error);
        }

        imageUrl = data.url;
        if (!bbox && data.bbox) {
          bbox = data.bbox;
        }
      }

      // Create GeoTIFF source
      const geoTiffSource = new GeoTIFF({
        sources: [{
          url: imageUrl,
        }],
        interpolate: true,
      });

      // Create WebGL tile layer
      const newLayer = new WebGLTile({
        source: geoTiffSource,
        opacity: 0.8,
        zIndex: 500, // Higher than FlatGeobuf but lower than highlight
      });

      // Generate unique ID for this layer
      const layerId = `sentinel2-${image.id}-${Date.now()}`;
      
      // Use provided tile name, fallback to image.mgrs_tile or extract from ID
      const finalTileName = tileName || image.mgrs_tile || extractTileName(image.id);
      
      // Store layer with metadata
      const layerMetadata = {
        layer: newLayer,
        id: layerId,
        imageId: image.id,
        tileName: finalTileName,
        datetime: image.datetime,
      };

      // Add to map
      map.addLayer(newLayer);
      setSentinel2Layers((prev: any[]) => [...prev, layerMetadata]);
      
      // Register with LayerManager
      const dateStr = image.datetime ? new Date(image.datetime).toISOString().split('T')[0] : '';
      const layerName = dateStr 
        ? `${finalTileName || 'Unknown'} ${dateStr}`
        : finalTileName || 'Sentinel-2';
      
      // Store bbox in metadata for locating
      const metadata: any = {
        imageId: image.id,
        tileName: finalTileName,
        datetime: image.datetime,
      };
      if (bbox && Array.isArray(bbox) && bbox.length === 4) {
        metadata.bbox = bbox;
      }
      
      if (layerManager) {
        layerManager.addLayer(layerId, layerName, 'sentinel2', newLayer, metadata);
      }

      // Fit view to image extent using bbox
      if (bbox && Array.isArray(bbox) && bbox.length === 4) {
        try {
          // bbox is [minX, minY, maxX, maxY] in WGS84 (EPSG:4326)
          // Transform from EPSG:4326 to EPSG:3857 (Web Mercator)
          const extent = transformExtent(bbox, 'EPSG:4326', 'EPSG:3857');
          map.getView().fit(extent, { padding: [50, 50, 50, 50], duration: 1000 });
        } catch (err) {
          console.warn('Could not fit view to bbox:', err);
        }
      }

    } catch (error) {
      console.error('Error loading Sentinel-2 image:', error);
      alert(`Failed to load Sentinel-2 image: ${error instanceof Error ? error.message : error}`);
    }
  }, [map, layerManager, updateLayersList]);

  // Handler to load prediction COG via TiTiler
  const handleLoadPredictionCOG = useCallback(async (predictionData: {
    url: string;
    tile_name: string;
    rh_index: number;
    q_index: number;
    year: number;
  }, skipZoom = false) => {
    if (!map) return;
    console.log('Loading prediction COG via TiTiler:', predictionData);
    
    try {
      // Get COG info from TiTiler to get bounds (REQUIRED before loading tiles)
      const infoUrl = `http://localhost:8000/cog/info?url=${encodeURIComponent(predictionData.url)}`;
      const infoResponse = await fetch(infoUrl);
      
      if (!infoResponse.ok) {
        const errorText = await infoResponse.text();
        throw new Error(`Failed to get COG info: ${errorText}`);
      }
      
      const infoData = await infoResponse.json();
      console.log('COG info:', infoData);
      
      // Get bounds from info response - REQUIRED
      if (!infoData.bounds || infoData.bounds.length !== 4) {
        throw new Error('COG bounds information not available');
      }
      
      const bbox = infoData.bounds; // [minx, miny, maxx, maxy]
      
      // Get CRS from info response - TiTiler returns bounds in the COG's native CRS
      // Default to EPSG:4326 if not specified
      let sourceCRS = 'EPSG:4326';
      if (infoData.crs) {
        // TiTiler might return CRS as a string like "EPSG:4326" or as an object
        if (typeof infoData.crs === 'string') {
          sourceCRS = infoData.crs;
        } else if (infoData.crs.properties && infoData.crs.properties.name) {
          sourceCRS = infoData.crs.properties.name;
        } else if (infoData.crs.code) {
          sourceCRS = `EPSG:${infoData.crs.code}`;
        }
      }
      
      console.log('COG bounds (native CRS):', bbox, 'CRS:', sourceCRS);
      
      // Validate bounds
      if (!bbox.every((val: number) => isFinite(val) && !isNaN(val))) {
        throw new Error('Invalid bounds: contains NaN or Infinity');
      }
      
      // Transform bounds to Web Mercator (EPSG:3857)
      // TiTiler bounds are always in the COG's native CRS
      let extent: number[];
      try {
        if (sourceCRS === 'EPSG:3857' || sourceCRS === 'EPSG:900913') {
          // Already in Web Mercator
          extent = bbox;
        } else {
          // Transform from source CRS to Web Mercator
          extent = transformExtent(bbox, sourceCRS, 'EPSG:3857');
        }
        
        // Validate transformed extent
        if (!extent.every((val: number) => isFinite(val) && !isNaN(val))) {
          throw new Error('Transformed extent contains invalid values');
        }
        
        // Check if extent is valid (minx < maxx and miny < maxy)
        if (extent[0] >= extent[2] || extent[1] >= extent[3]) {
          throw new Error(`Invalid extent: [${extent.join(', ')}]`);
        }
        
        // Check if extent is reasonable (not too large - Web Mercator max extent is about ±20037508)
        const maxExtent = 20037508.34;
        if (Math.abs(extent[0]) > maxExtent * 2 || Math.abs(extent[2]) > maxExtent * 2 ||
            Math.abs(extent[1]) > maxExtent * 2 || Math.abs(extent[3]) > maxExtent * 2) {
          console.warn('Extent values seem unusually large, but proceeding:', extent);
        }
        
        // Check if extent is too small (less than 1 meter)
        const width = extent[2] - extent[0];
        const height = extent[3] - extent[1];
        if (width < 1 || height < 1) {
          console.warn('Extent is very small, but proceeding:', extent);
        }
        
        console.log('COG bounds (Web Mercator):', extent, 'Width:', width, 'Height:', height);
      } catch (transformError) {
        console.error('Error transforming bounds:', transformError);
        // Fallback: try assuming EPSG:4326 if transformation fails
        if (sourceCRS !== 'EPSG:4326') {
          console.warn('Transformation failed, trying EPSG:4326 as fallback');
          try {
            extent = transformExtent(bbox, 'EPSG:4326', 'EPSG:3857');
            if (!extent.every((val: number) => isFinite(val) && !isNaN(val))) {
              throw new Error('Fallback transformation also failed');
            }
            console.log('COG bounds (Web Mercator, fallback):', extent);
          } catch (fallbackError) {
            throw new Error(`Failed to transform bounds from ${sourceCRS} to EPSG:3857: ${transformError instanceof Error ? transformError.message : transformError}`);
          }
        } else {
          throw transformError;
        }
      }
      
      // Zoom to the COG extent FIRST before adding the layer
      // This prevents TileOutsideBounds errors
      // Only zoom if extent is valid and skipZoom is false
      if (!skipZoom && extent && extent.length === 4 && extent.every((val: number) => isFinite(val))) {
        try {
      await new Promise<void>((resolve) => {
        map.getView().fit(extent, { 
          padding: [50, 50, 50, 50], 
          duration: 1000,
              maxZoom: 18,
          callback: () => resolve()
        });
        // Fallback in case callback doesn't fire
        setTimeout(resolve, 1100);
      });
          console.log('Map view fitted to COG extent');
        } catch (fitError) {
          console.warn('Error fitting map to extent, continuing anyway:', fitError);
        }
      } else if (!skipZoom) {
        console.warn('Skipping map fit - invalid extent');
      }

      // Use server-side transformation (TiTiler) for best overall performance
      // This approach:
      // - Provides faster initial load (smaller pre-rendered tiles)
      // - Lower bandwidth usage (compressed PNG/JPEG)
      // - Works on all devices (no GPU requirements)
      // - Better for static visualizations
      // Trade-off: Changing min/max requires tile reload (but this is acceptable for most use cases)
      
      const tileUrl = `http://localhost:8000/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(predictionData.url)}&expression=b1*(b1<32767)&nodata=-9999&return_mask=true&rescale=0,500&colormap_name=inferno`;
      
      // Create XYZ tile source using TiTiler
      const { default: XYZ } = await import('ol/source/XYZ');
      const { default: TileLayer } = await import('ol/layer/Tile');
      
      const tileSource = new XYZ({
        url: tileUrl,
        crossOrigin: 'anonymous',
        maxZoom: 18,
      });

      // Create tile layer
      const layerOptions: any = {
        source: tileSource,
        opacity: 1,
        zIndex: 600, // Higher than Sentinel-2 layers
      };
      
      // Only add extent constraint if extent is valid
      if (extent && extent.length === 4 && extent.every((val: number) => isFinite(val))) {
        layerOptions.extent = extent;
        console.log('Layer extent set to:', extent);
      } else {
        console.warn('Layer extent not set - tiles may load outside COG bounds');
      }
      
      const newLayer = new TileLayer(layerOptions);
      const useClientSideTransform = false; // Using server-side for better performance

      // Generate unique ID for this layer
      const qLabels = ['95%', 'median', '5%'];
      const layerId = `prediction-${predictionData.tile_name}-RH${predictionData.rh_index}-${qLabels[predictionData.q_index]}-${predictionData.year}-${Date.now()}`;
      
      // Store layer with metadata
      const layerMetadata = {
        layer: newLayer as any, // Type cast to match WebGLTileLayer in state
        id: layerId,
        tileName: predictionData.tile_name,
        rhIndex: predictionData.rh_index,
        qIndex: predictionData.q_index,
        year: predictionData.year,
        url: predictionData.url,
        useClientSideTransform: useClientSideTransform,
      };

      // Add to map AFTER zooming
      map.addLayer(newLayer);
      setPredictionLayers((prev: any[]) => [...prev, layerMetadata]);
      
      // Register with LayerManager
      const qLabelsPred = ['95%', 'median', '5%'];
      const layerName = `${predictionData.tile_name} (${predictionData.year}) RH${predictionData.rh_index} ${qLabelsPred[predictionData.q_index]}`;
      
      // Store extent in metadata for locating
      const metadata: any = {
        tileName: predictionData.tile_name,
        rhIndex: predictionData.rh_index,
        qIndex: predictionData.q_index,
        year: predictionData.year,
        url: predictionData.url,
        rescaleMin: 0,
        rescaleMax: 500,
        useClientSideTransform: useClientSideTransform,
      };
      if (extent && extent.length === 4 && extent.every((val: number) => isFinite(val))) {
        metadata.extent = extent;
      }
      
      if (layerManager) {
        layerManager.addLayer(layerId, layerName, 'prediction', newLayer, metadata);
      }

      // Update layers list to include the new layer
      updateLayersList();

      console.log('Successfully loaded prediction COG layer via TiTiler');
    } catch (error) {
      console.error('Error loading prediction COG:', error);
      alert(`Failed to load prediction COG: ${error instanceof Error ? error.message : error}`);
    }
  }, [map, layerManager, updateLayersList]);

  // Register COG layer with LayerManager when it changes
  useEffect(() => {
    if (!layerManager) return;
    
    if (cogLayer && map) {
      // Get extent from layer if available
      const layerExtent = cogLayer.getExtent();
      const metadata: any = {};
      if (layerExtent && layerExtent.length === 4) {
        metadata.extent = layerExtent;
      }
      layerManager.addLayer('cog', 'GeoTIFF Layer', 'cog', cogLayer, metadata);
      updateLayersList();
    } else if (!cogLayer) {
      layerManager.removeLayer('cog');
      updateLayersList();
    }
  }, [cogLayer, map, layerManager, updateLayersList]);

  // Register FlatGeobuf layer with LayerManager when it changes
  useEffect(() => {
    if (!layerManager) return;
    
    if (fgbLayer && map) {
      // Get extent from source if available
      const metadata: any = {};
      try {
        const source = fgbLayer.getSource();
        if (source && typeof source.getExtent === 'function') {
          const sourceExtent = source.getExtent();
          if (sourceExtent && sourceExtent.length === 4) {
            metadata.extent = sourceExtent;
          }
        }
      } catch (e) {
        // Ignore errors
      }
      layerManager.addLayer('fgb', 'FlatGeobuf Layer', 'fgb', fgbLayer, metadata);
      updateLayersList();
    } else if (!fgbLayer) {
      layerManager.removeLayer('fgb');
      updateLayersList();
    }
  }, [fgbLayer, map, layerManager, updateLayersList]);

  // Update layers list whenever map or layers change
  React.useEffect(() => {
    updateLayersList();
  }, [updateLayersList]);

  // --- Auto-load VSM predictions (single "Global" layer, driven by activeVSM) ---
  const autoLoadingTilesRef = useRef<Set<string>>(new Set());
  const globalPredGroupRef = useRef<LayerGroup | null>(null);
  const globalLayerRegisteredRef = useRef(false);
  const [showZoomMessage, setShowZoomMessage] = useState(false);

  useEffect(() => {
    // When activeVSM is null, hide zoom message and skip
    console.log('[auto-load effect] map=', !!map, 'fgbLayer=', !!fgbLayer, 'activeVSM=', activeVSM);
    if (!map || !fgbLayer || !activeVSM) {
      setShowZoomMessage(false);
      return;
    }

    const AUTO_RH_INDEX = 98;
    const AUTO_Q_INDEX = 1;   // Q1 = median
    const AUTO_YEAR = parseInt(activeVSM); // '2020' | '2024' → number
    const DEBOUNCE_MS = 1500;
    const MAX_CONCURRENT = 3;
    const MIN_ZOOM = 8;
    const GLOBAL_LAYER_ID = `prediction-global-RH98-Q1-${activeVSM}`;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    // --- Clean up previous auto-load group (if switching years) ---
    if (globalPredGroupRef.current) {
      map.removeLayer(globalPredGroupRef.current);
      globalPredGroupRef.current = null;
    }
    // Unregister old global layer from LayerManager (any previous year)
    const mgr = useMapStore.getState().layerManager;
    if (mgr) {
      // Remove any previously registered global prediction layers
      for (const id of ['prediction-global-RH98-Q1-2020', 'prediction-global-RH98-Q1-2024', 'prediction-global-RH98-median-2024']) {
        if (mgr.getLayer(id)) mgr.removeLayer(id);
      }
    }
    globalLayerRegisteredRef.current = false;
    autoLoadingTilesRef.current.clear();

    // Create fresh LayerGroup for per-tile detail – visible at zoom >= MIN_ZOOM
    const group = new LayerGroup({ layers: [], zIndex: 600, minZoom: MIN_ZOOM - 1 });
    map.addLayer(group);
    globalPredGroupRef.current = group;

    // --- Load low-res mosaic layer (visible when zoomed out, below MIN_ZOOM) ---
    let mosaicLayer: any = null;
    (async () => {
      try {
        const mosaicResp = await fetch(
          `http://localhost:8000/predictions/mosaic-url?year=${AUTO_YEAR}&rh_index=${AUTO_RH_INDEX}&q_index=${AUTO_Q_INDEX}`
        );
        const mosaicData = await mosaicResp.json();
        if (cancelled || !mosaicData.success) {
          console.warn('[mosaic] Could not load mosaic:', mosaicData.error);
          return;
        }
        console.log('[mosaic] Loaded mosaic URL:', mosaicData.url);

        const mosaicTileUrl = `http://localhost:8000/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(mosaicData.url)}&expression=b1*(b1<32767)&nodata=-9999&return_mask=true&rescale=0,500&colormap_name=inferno`;

        const { default: XYZSource } = await import('ol/source/XYZ');
        const { default: TileLayerCls } = await import('ol/layer/Tile');

        mosaicLayer = new TileLayerCls({
          source: new XYZSource({
            url: mosaicTileUrl,
            crossOrigin: 'anonymous',
            maxZoom: 14,
          }),
          zIndex: 599, // Just below per-tile detail
          maxZoom: MIN_ZOOM, // Visible only when zoom < MIN_ZOOM (exclusive upper bound)
        });

        if (!cancelled) {
          map.addLayer(mosaicLayer);
          console.log('[mosaic] Added mosaic layer to map (maxZoom:', MIN_ZOOM, ')');
        }
      } catch (err) {
        console.warn('[mosaic] Error loading mosaic layer:', err);
      }
    })();

    const autoLoadVisiblePredictions = async () => {
      if (cancelled) return;

      // --- Zoom gate ---
      const zoom = map.getView().getZoom();
      if (zoom === undefined || zoom < MIN_ZOOM) return;

      const source = fgbLayer.getSource();
      if (!source) return;

      const mapSize = map.getSize();
      if (!mapSize) return;

      const viewExtent = map.getView().calculateExtent(mapSize);
      const features = source.getFeaturesInExtent(viewExtent);

      // Collect unique tile names from visible features
      const visibleTiles = new Set<string>();
      for (const feature of features) {
        const name = feature.get('Name');
        if (name && typeof name === 'string') {
          visibleTiles.add(name);
        }
      }

      if (visibleTiles.size === 0) return;

      // Filter to tiles not yet attempted
      const allTilesToLoad = [...visibleTiles].filter(
        (t) => !autoLoadingTilesRef.current.has(t),
      );

      if (allTilesToLoad.length === 0) return;

      console.log(`[Auto-load] Loading RH98_Q1 (${AUTO_YEAR}) for ${allTilesToLoad.length} visible tiles`);

      const { default: XYZ } = await import('ol/source/XYZ');
      const { default: TileLayer } = await import('ol/layer/Tile');

      for (let i = 0; i < allTilesToLoad.length; i += MAX_CONCURRENT) {
        if (cancelled) return;

        const batch = allTilesToLoad.slice(i, i + MAX_CONCURRENT);

        await Promise.allSettled(
          batch.map(async (tileName) => {
            if (cancelled) return;
            autoLoadingTilesRef.current.add(tileName);

            try {
              // Step 1: Get prediction COG URL (backend handles remote vs local)
              const resp = await fetch('http://localhost:8000/predictions/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  year: AUTO_YEAR,
                  tile_name: tileName,
                  rh_index: AUTO_RH_INDEX,
                  q_index: AUTO_Q_INDEX,
                }),
              });

              if (!resp.ok) return;

              const data = await resp.json();
              if (!data.success || !data.url) return;

              if (cancelled) return;

              // Step 2: Get COG info (bounds / CRS) from TiTiler
              const infoResp = await fetch(
                `http://localhost:8000/cog/info?url=${encodeURIComponent(data.url)}`,
              );
              if (!infoResp.ok) return;

              const infoData = await infoResp.json();
              const bbox = infoData.bounds;
              if (!bbox || bbox.length !== 4) return;

              let sourceCRS = 'EPSG:4326';
              if (infoData.crs) {
                if (typeof infoData.crs === 'string') sourceCRS = infoData.crs;
                else if (infoData.crs.properties?.name) sourceCRS = infoData.crs.properties.name;
                else if (infoData.crs.code) sourceCRS = `EPSG:${infoData.crs.code}`;
              }

              let extent: number[];
              if (sourceCRS === 'EPSG:3857' || sourceCRS === 'EPSG:900913') {
                extent = bbox;
              } else {
                extent = transformExtent(bbox, sourceCRS, 'EPSG:3857');
              }

              if (!extent.every((v: number) => isFinite(v) && !isNaN(v))) return;

              if (cancelled) return;

              // Step 3: Create TileLayer and add to group
              const tileUrl = `http://localhost:8000/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(data.url)}&expression=b1*(b1<32767)&nodata=-9999&return_mask=true&rescale=0,500&colormap_name=inferno`;

              const tileLayer = new TileLayer({
                source: new XYZ({ url: tileUrl, crossOrigin: 'anonymous', maxZoom: 18 }),
                extent,
                minZoom: MIN_ZOOM - 1,
              });

              if (!cancelled) {
                group.getLayers().push(tileLayer);
              }
            } catch (err) {
              console.warn(`[Auto-load] Failed for tile ${tileName}:`, err);
            }
          }),
        );
      }

      // Register the group once in LayerManager
      if (!globalLayerRegisteredRef.current && group.getLayers().getLength() > 0) {
        const mgr = useMapStore.getState().layerManager;
        if (mgr) {
          const layerName = `Global (RH98 Q1 ${AUTO_YEAR})`;
          mgr.addLayer(GLOBAL_LAYER_ID, layerName, 'prediction', group as any, {
            tileName: 'Global',
            rhIndex: AUTO_RH_INDEX,
            qIndex: AUTO_Q_INDEX,
            year: AUTO_YEAR,
            rescaleMin: 0,
            rescaleMax: 500,
            isAutoLoadGroup: true,
          });
          globalLayerRegisteredRef.current = true;
          updateLayersList();
        }
      }
    };

    const onMoveEnd = () => {
      // Visibility is handled by onZoomChange (fires immediately).
      // onMoveEnd only triggers tile loading after pan/zoom animation settles.
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(autoLoadVisiblePredictions, DEBOUNCE_MS);
    };

    // Handle zoom message immediately (not debounced)
    const onZoomChange = () => {
      const zoom = map.getView().getZoom();
      const belowMinZoom = zoom !== undefined && zoom < MIN_ZOOM;
      setShowZoomMessage(belowMinZoom);
    };

    onMoveEnd();
    map.on('moveend', onMoveEnd);
    // change:resolution fires immediately during zoom (wheel, pinch, etc.)
    map.getView().on('change:resolution', onZoomChange);

    return () => {
      cancelled = true;
      map.un('moveend', onMoveEnd);
      map.getView().un('change:resolution', onZoomChange);
      if (debounceTimer) clearTimeout(debounceTimer);
      // Remove mosaic layer on cleanup
      if (mosaicLayer) {
        map.removeLayer(mosaicLayer);
        mosaicLayer = null;
      }
      // Remove group from map on cleanup (when activeVSM changes or component unmounts)
      if (globalPredGroupRef.current) {
        map.removeLayer(globalPredGroupRef.current);
        globalPredGroupRef.current = null;
      }
      // Unregister from LayerManager
      const mgr = useMapStore.getState().layerManager;
      if (mgr && mgr.getLayer(GLOBAL_LAYER_ID)) {
        mgr.removeLayer(GLOBAL_LAYER_ID);
      }
      globalLayerRegisteredRef.current = false;
      autoLoadingTilesRef.current.clear();
      updateLayersList();
    };
  }, [map, fgbLayer, activeVSM, updateLayersList]);

  // --- Drawing tool: "Get Tiles" rectangle draw ---
  const { drawingActive, setDrawingActive, setSelectedTiles } = useMapStore();
  const drawLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const labelLayerRef = useRef<VectorLayer<VectorSource> | null>(null);

  useEffect(() => {
    if (!map) return;

    // Always clean up previous draw interaction and layers
    let drawInteraction: any = null;

    if (!drawingActive) {
      return;
    }

    // Starting a new draw session — remove previous highlight/label layers
    if (drawLayerRef.current) {
      map.removeLayer(drawLayerRef.current);
      drawLayerRef.current = null;
    }
    if (labelLayerRef.current) {
      map.removeLayer(labelLayerRef.current);
      labelLayerRef.current = null;
    }

    // Set up Draw interaction for rectangle selection
    const drawSource = new VectorSource();

    drawInteraction = new Draw({
      source: drawSource,
      type: 'Circle',
      geometryFunction: createBox(),
    });

    map.addInteraction(drawInteraction);

    // Change cursor to crosshair while drawing
    const mapEl = map.getTargetElement();
    if (mapEl) (mapEl as HTMLElement).style.cursor = 'crosshair';

    drawInteraction.on('drawend', (event: any) => {
        const drawnGeometry = event.feature.getGeometry();
        if (!drawnGeometry) return;

        const drawnExtent = drawnGeometry.getExtent();

        // Find FGB features intersecting the drawn rectangle
        const fgbLayerCurrent = useMapStore.getState().fgbLayer;
        if (!fgbLayerCurrent) {
          console.warn('[draw] No FGB layer loaded');
          setDrawingActive(false);
          return;
        }

        const fgbSource = fgbLayerCurrent.getSource();
        if (!fgbSource) return;

        const intersectingFeatures = fgbSource.getFeaturesInExtent(drawnExtent);
        const tileNames: string[] = [];
        const highlightFeatures: Feature<Geometry>[] = [];
        const labelFeatures: Feature<Geometry>[] = [];

        for (const feature of intersectingFeatures) {
          const name = feature.get('Name');
          if (name && typeof name === 'string') {
            tileNames.push(name);

            // Clone feature for highlight
            const cloned = feature.clone();
            highlightFeatures.push(cloned);

            // Create a label point at the center of the feature
            const geom = feature.getGeometry();
            if (geom) {
              const extent = geom.getExtent();
              const centerX = (extent[0] + extent[2]) / 2;
              const centerY = (extent[1] + extent[3]) / 2;
              const labelFeature = new Feature({
                geometry: new Point([centerX, centerY]),
                tileName: name,
              });
              labelFeatures.push(labelFeature);
            }
          }
        }

        tileNames.sort();
        setSelectedTiles(tileNames);

        // Remove previous draw highlight/label layers
        if (drawLayerRef.current) {
          map.removeLayer(drawLayerRef.current);
          drawLayerRef.current = null;
        }
        if (labelLayerRef.current) {
          map.removeLayer(labelLayerRef.current);
          labelLayerRef.current = null;
        }

        // Create label layer with tile names
        const lblSource = new VectorSource({ features: labelFeatures });
        const lblLayer = new VectorLayer({
          source: lblSource,
          style: (feature: any) => {
            return new Style({
              text: new TextStyle({
                text: feature.get('tileName') || '',
                font: 'bold 16px sans-serif',
                fill: new Fill({ color: '#FFD700' }),
                stroke: new Stroke({ color: '#000000', width: 3 }),
                overflow: true,
              }),
            });
          },
          zIndex: 9001,
        });
        map.addLayer(lblLayer);
        labelLayerRef.current = lblLayer;

        // Register with LayerManager
        const mgr = useMapStore.getState().layerManager;
        const labelLayerId = `vector-tiles-${Date.now()}`;
        (lblLayer as any).__vectorLayerId = labelLayerId;
        if (mgr) {
          mgr.addLayer(labelLayerId, `Selected Tiles (${tileNames.length})`, 'vector', lblLayer, {
            featureNames: tileNames,
          });
          updateLayersList();
        }

        // Done drawing — remove interaction
        map.removeInteraction(drawInteraction);
        if (mapEl) (mapEl as HTMLElement).style.cursor = '';
        setDrawingActive(false);

        console.log('[draw] Selected tiles:', tileNames);
    });

    return () => {
      // Cleanup on deactivate
      if (drawInteraction) {
        map.removeInteraction(drawInteraction);
      }
      const mapEl = map.getTargetElement();
      if (mapEl) (mapEl as HTMLElement).style.cursor = '';
    };
  }, [map, drawingActive]);

  // --- Hover highlight + delete button on label features ---
  useEffect(() => {
    if (!map) return;

    // Create overlay element for delete button
    const deleteEl = document.createElement('div');
    deleteEl.innerHTML = '✕';
    deleteEl.style.cssText = `
      background: #ff4444; color: white; border-radius: 50%;
      width: 22px; height: 22px; display: flex; align-items: center;
      justify-content: center; font-size: 14px; font-weight: bold;
      cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,0.4);
      display: none; user-select: none;
    `;

    let overlay: any = null;
    let hoveredFeature: Feature<Geometry> | null = null;
    let hoveredLayerId: string | null = null;

    const setupOverlay = async () => {
      const { default: OlOverlay } = await import('ol/Overlay');

      overlay = new OlOverlay({
        element: deleteEl,
        positioning: 'bottom-left',
        offset: [5, -5],
        stopEvent: true,
      });
      map.addOverlay(overlay);

      deleteEl.style.display = 'none';

      // Delete button click handler
      deleteEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!hoveredFeature || !hoveredLayerId) return;

        const mgr = useMapStore.getState().layerManager;
        if (!mgr) return;

        const managed = mgr.getLayer(hoveredLayerId);
        if (!managed) return;

        const source = (managed.layer as any).getSource?.();
        if (!source) return;

        const tileName = hoveredFeature.get('tileName');
        source.removeFeature(hoveredFeature);

        // Update selectedTiles in store
        const currentTiles = useMapStore.getState().selectedTiles;
        useMapStore.getState().setSelectedTiles(currentTiles.filter((t: string) => t !== tileName));

        // Update layer name or remove if empty
        const remaining = source.getFeatures().length;
        if (remaining === 0) {
          mgr.removeLayer(hoveredLayerId);
          map.removeLayer(managed.layer);
        } else {
          (managed as any).name = `Selected Tiles (${remaining})`;
        }
        updateLayersList();

        // Hide overlay
        deleteEl.style.display = 'none';
        overlay.setPosition(undefined);
        hoveredFeature = null;
        hoveredLayerId = null;
      });

      // Pointermove handler to detect label features
      const onPointerMove = (evt: any) => {
        if (evt.dragging) return;

        const mgr = useMapStore.getState().layerManager;
        if (!mgr) return;

        const vectorLayers = mgr.getLayersByType('vector');
        if (vectorLayers.length === 0) {
          if (hoveredFeature) {
            hoveredFeature.setStyle(undefined);
            hoveredFeature = null;
            hoveredLayerId = null;
            deleteEl.style.display = 'none';
            overlay.setPosition(undefined);
          }
          return;
        }

        // Check if pointer is over any vector layer feature
        let found = false;
        map.forEachFeatureAtPixel(evt.pixel, (feature: any) => {
          if (found) return;

          // Check if this feature belongs to a vector layer
          for (const managed of vectorLayers) {
            const source = (managed.layer as any).getSource?.();
            if (source && source.getFeatures().includes(feature)) {
              found = true;

              if (hoveredFeature !== feature) {
                // Unhighlight previous
                if (hoveredFeature) {
                  hoveredFeature.setStyle(undefined);
                }

                // Highlight new feature
                feature.setStyle(new Style({
                  text: new TextStyle({
                    text: feature.get('tileName') || '',
                    font: 'bold 22px sans-serif',
                    fill: new Fill({ color: '#FFFFFF' }),
                    stroke: new Stroke({ color: '#FF0000', width: 4 }),
                    overflow: true,
                  }),
                }));

                hoveredFeature = feature;
                hoveredLayerId = managed.id;

                // Position delete button at feature coordinate
                const geom = feature.getGeometry();
                if (geom) {
                  const coords = (geom as any).getCoordinates();
                  overlay.setPosition(coords);
                  deleteEl.style.display = 'flex';
                }
              }
              return;
            }
          }
        }, { hitTolerance: 10 });

        if (!found && hoveredFeature) {
          hoveredFeature.setStyle(undefined);
          hoveredFeature = null;
          hoveredLayerId = null;
          deleteEl.style.display = 'none';
          overlay.setPosition(undefined);
        }
      };

      map.on('pointermove', onPointerMove);

      // Store cleanup refs
      (deleteEl as any).__onPointerMove = onPointerMove;
    };

    setupOverlay();

    return () => {
      if (overlay) {
        map.removeOverlay(overlay);
      }
      const onPointerMove = (deleteEl as any).__onPointerMove;
      if (onPointerMove) {
        map.un('pointermove', onPointerMove);
      }
      if (hoveredFeature) {
        hoveredFeature.setStyle(undefined);
      }
      deleteEl.remove();
    };
  }, [map, updateLayersList]);

  // Initialize highlight layer
  useEffect(() => {
    if (!map) return;

    // Create highlight layer
    const highlightSource = new VectorSource();
    const newHighlightLayer = new VectorLayer({
      source: highlightSource,
      style: new Style({
        stroke: new Stroke({
          color: '#ff0000',
          width: 4, // Increased width for better visibility
        }),
        fill: new Fill({
          color: '#ff000000', // More visible semi-transparent red fill
        }),
        image: new CircleStyle({
          radius: 10,
          stroke: new Stroke({
            color: '#ff0000',
            width: 4,
          }),
          fill: new Fill({
            color: 'rgba(255, 0, 0, 0.5)', // More visible fill for points
          }),
        }),
      }),
      zIndex: 10000, // Very high z-index to ensure it's on top
    });
    
    // Ensure the layer is visible
    newHighlightLayer.setVisible(true);

    map.addLayer(newHighlightLayer);
    setHighlightLayer(newHighlightLayer);

    return () => {
      if (newHighlightLayer) {
        map.removeLayer(newHighlightLayer);
      }
    };
  }, [map]);

  // Helper function to create highlight geometry from VectorTile feature
  const createHighlightGeometry = useCallback((geometry: Geometry): Geometry | null => {
    if (!geometry) {
      console.debug('createHighlightGeometry: No geometry provided');
      return null;
    }
    
    try {
      const geomType = geometry.getType();
      console.debug('createHighlightGeometry: Geometry type:', geomType);
      
      // Try to get coordinates using type casting (works for most OpenLayers geometries)
      let coords: any = null;
      
      if (typeof (geometry as any).getCoordinates === 'function') {
        try {
          coords = (geometry as any).getCoordinates();
          console.debug('createHighlightGeometry: Got coordinates:', coords ? 'yes' : 'no');
        } catch (e) {
          console.debug('createHighlightGeometry: Error calling getCoordinates():', e);
        }
      } else {
        console.debug('createHighlightGeometry: getCoordinates() not available');
      }
      
      if (!coords) {
        // Fallback: use extent to create a bounding box highlight
        try {
          const extent = geometry.getExtent();
          console.debug('createHighlightGeometry: Using extent fallback:', extent);
          if (extent && extent.length === 4) {
            // Create a polygon from the extent
            const [minX, minY, maxX, maxY] = extent;
            coords = [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]];
            const extentPolygon = new Polygon(coords);
            console.debug('createHighlightGeometry: Created extent-based polygon');
            return extentPolygon;
          }
        } catch (e) {
          console.debug('createHighlightGeometry: Could not create extent-based highlight:', e);
        }
        return null;
      }
      
      // Create geometry based on type
      let newGeometry: Geometry | null = null;
      if (geomType === 'Polygon') {
        newGeometry = new Polygon(coords as number[][][]);
      } else if (geomType === 'MultiPolygon') {
        newGeometry = new MultiPolygon(coords as number[][][][]);
      } else if (geomType === 'LineString') {
        newGeometry = new LineString(coords as number[][]);
      } else if (geomType === 'MultiLineString') {
        newGeometry = new MultiLineString(coords as number[][][]);
      } else if (geomType === 'Point') {
        newGeometry = new Point(coords as number[]);
      }
      
      if (newGeometry) {
        console.debug('createHighlightGeometry: Successfully created geometry of type:', geomType);
      } else {
        console.debug('createHighlightGeometry: Could not create geometry for type:', geomType);
      }
      
      return newGeometry;
    } catch (error) {
      console.error('createHighlightGeometry: Error creating highlight geometry:', error);
    }
    
    return null;
  }, []);

  // Add click handler for features
  useEffect(() => {
    if (!map || !highlightLayer) {
      console.log('Click handler: map or highlightLayer not available', { map: !!map, highlightLayer: !!highlightLayer });
      return;
    }

    const handleClick = (evt: any) => {
      // Clear previous highlight
      highlightLayer.getSource()?.clear();

      // Check if we clicked on a feature in the FlatGeobuf layer using geometry-based detection
      if (fgbLayer) {
        const coordinate = evt.coordinate; // Already in EPSG:3857
        
        // For VectorLayer (FlatGeobuf), use geometry-based detection
        const source = fgbLayer.getSource();
        if (source) {
          // Get features in viewport and check which one intersects with the coordinate
          const viewExtent = map.getView().calculateExtent(map.getSize());
          const features = source.getFeaturesInExtent(viewExtent);
          let clickedFeature: Feature<Geometry> | null = null;
          
          // Check features in reverse order (top-most first)
          for (let i = features.length - 1; i >= 0; i--) {
            const feature = features[i];
            const geometry = feature.getGeometry();
            if (!geometry) continue;
            
            if (geometry.intersectsCoordinate(coordinate)) {
              clickedFeature = feature as Feature<Geometry>;
              break;
            }
            
            // For Point geometries, check distance
            const geomType = geometry.getType();
            if (geomType === 'Point') {
              const pointGeom = geometry as Point;
              const coords = pointGeom.getCoordinates();
              const dist = Math.sqrt(
                Math.pow(coordinate[0] - coords[0], 2) + 
                Math.pow(coordinate[1] - coords[1], 2)
              );
              // Use a reasonable tolerance for clicking (about 5 meters)
              if (dist < 5) {
                clickedFeature = feature as Feature<Geometry>;
                break;
              }
            }
          }
          
          if (clickedFeature) {
            const properties = clickedFeature.getProperties();
            const geometry = clickedFeature.getGeometry();
            
            // Try to highlight the clicked feature
            if (geometry && highlightLayer) {
              const highlightSource = highlightLayer.getSource();
              if (highlightSource) {
                const newGeometry = createHighlightGeometry(geometry);
                if (newGeometry) {
                  const highlightFeature = new Feature({
                    geometry: newGeometry,
                  });
                  highlightSource.addFeature(highlightFeature);
                } else {
                  console.warn('Click: Could not create highlight geometry');
                }
              } else {
                console.warn('Click: No highlight source available');
              }
            } else {
              console.warn('Click: No geometry or highlight layer');
            }
            
            // Get the click position in pixels
            const pixel = evt.originalEvent;
            const [x, y] = [pixel.offsetX, pixel.offsetY];
            
            // Get geographic coordinates (transform from EPSG:3857 to EPSG:4326)
            const [lon, lat] = transform(coordinate, 'EPSG:3857', 'EPSG:4326');
            
            setPopupProperties(properties);
            setPopupPosition({ x, y });
            setPopupGeometry(geometry || null);
            setPopupCoordinates({ lon, lat });
            return; // Don't clear popup if we clicked on a feature
          }
        }
      }
      
      // If we didn't click on a feature, close the popup
      setPopupProperties(null);
      setPopupPosition(null);
      setPopupGeometry(null);
      setPopupCoordinates(null);
    };

    // Add pointer move handler to change cursor on hover and highlight polygons
    // Throttle hit detection to reduce geometry checks and improve performance
    let lastCheckTime = 0;
    let lastCursorState: string | null = null;
    let lastHoveredFeature: Feature<Geometry> | null = null;
    let pendingCheck: number | null = null;
    const THROTTLE_MS = 300; // Check at most every 300ms (~3 times per second) to minimize performance impact
    
    const handlePointerMove = (evt: any) => {
      if (!fgbLayer) return;
      
      const now = Date.now();
      // Throttle the hit detection to reduce canvas readback operations
      if (now - lastCheckTime < THROTTLE_MS) {
        // Cancel any pending check and schedule a new one for after throttle period
        if (pendingCheck !== null) {
          cancelAnimationFrame(pendingCheck);
        }
        pendingCheck = requestAnimationFrame(() => {
          const currentTime = Date.now();
          if (currentTime - lastCheckTime >= THROTTLE_MS) {
            performHitDetection(evt);
          }
        });
        return; // Skip this check if too soon
      }
      
      performHitDetection(evt);
    };
    
    const performHitDetection = (evt: any) => {
      if (!fgbLayer || !highlightLayer) {
        console.debug('Hit detection: fgbLayer or highlightLayer not available');
        return;
      }
      
      lastCheckTime = Date.now();
      pendingCheck = null;
      
      try {
        // Use geometry-based intersection instead of pixel-based to avoid canvas readback
        const coordinate = evt.coordinate; // Already in EPSG:3857
        
        // For VectorLayer (FlatGeobuf), use geometry-based detection
        const source = fgbLayer.getSource();
        
        if (!source) {
          if (lastCursorState !== '') {
            map.getTargetElement().style.cursor = '';
            lastCursorState = '';
          }
          // Clear highlight if no source
          highlightLayer.getSource()?.clear();
          lastHoveredFeature = null;
          return;
        }
        
        // Check if any feature's geometry intersects with this coordinate
        // This avoids canvas readback operations entirely
        // Use getFeaturesInExtent to limit checks to features near the coordinate
        const viewExtent = map.getView().calculateExtent(map.getSize());
        const features = source.getFeaturesInExtent(viewExtent);
        let hoveredFeature: Feature<Geometry> | null = null;
        
        // Use a small tolerance in map units (approximately 10 meters)
        // EPSG:3857 uses meters as units
        const tolerance = 10; // 10 meters
        
        // Check features in reverse order (top-most first) for better UX
        for (let i = features.length - 1; i >= 0; i--) {
          const feature = features[i];
          const geometry = feature.getGeometry();
          if (!geometry) continue;
          
          // Check if coordinate intersects with geometry
          // For polygons/lines, intersectsCoordinate works well
          if (geometry.intersectsCoordinate(coordinate)) {
            hoveredFeature = feature as Feature<Geometry>;
            break;
          }
          
          // For Point geometries, intersectsCoordinate might not work well
          // So check distance manually
          const geomType = geometry.getType();
          if (geomType === 'Point') {
            const pointGeom = geometry as Point;
            const coords = pointGeom.getCoordinates();
            const dist = Math.sqrt(
              Math.pow(coordinate[0] - coords[0], 2) + 
              Math.pow(coordinate[1] - coords[1], 2)
            );
            if (dist < tolerance) {
              hoveredFeature = feature as Feature<Geometry>;
              break;
            }
          }
        }  
        
        // Update cursor
        const newCursor = hoveredFeature ? 'pointer' : '';
        if (newCursor !== lastCursorState) {
          map.getTargetElement().style.cursor = newCursor;
          lastCursorState = newCursor;
        }
        
        // Update highlight
        const highlightSource = highlightLayer.getSource();
        if (highlightSource) {
          // Use feature reference as identifier (more reliable than ID)
          const currentFeature = hoveredFeature;
          
          // Only update highlight if feature changed
          if (currentFeature !== lastHoveredFeature) {
            highlightSource.clear();
            lastHoveredFeature = currentFeature;
            
                if (hoveredFeature) {
                  const geometry = hoveredFeature.getGeometry();
                  if (geometry) {
                    const newGeometry = createHighlightGeometry(geometry);
                    if (newGeometry) {
                      const highlightFeature = new Feature({
                        geometry: newGeometry,
                      });
                      highlightSource.addFeature(highlightFeature);
                    } 
                }}
          }
        }
      } catch (error) {
        // Silently handle any errors during hit detection
        console.debug('Hit detection error:', error);
      }
    };

    // Handle pointer leave to clear hover highlight
    const handlePointerLeave = () => {
      if (highlightLayer) {
        // Only clear if it's a hover highlight (not a click highlight)
        // We track this by checking if there's a feature in the highlight layer
        // and if the mouse is leaving, clear it
        const highlightSource = highlightLayer.getSource();
        if (highlightSource) {
          // Clear hover highlight when mouse leaves map
          highlightSource.clear();
          lastHoveredFeature = null;
        }
      }
      if (map.getTargetElement()) {
        map.getTargetElement().style.cursor = '';
        lastCursorState = '';
      }
    };

    map.on('click', handleClick);
    map.on('pointermove', handlePointerMove);
    
    // Add mouseleave listener with null check
    const viewport = map.getViewport();
    if (viewport) {
      viewport.addEventListener('mouseleave', handlePointerLeave);
    }

    return () => {
      map.un('click', handleClick);
      map.un('pointermove', handlePointerMove);
      
      // Remove mouseleave listener with null check
      const viewport = map.getViewport();
      if (viewport) {
        viewport.removeEventListener('mouseleave', handlePointerLeave);
      }
      
      if (map.getTargetElement()) {
        map.getTargetElement().style.cursor = '';
      }
      // Clear highlight on cleanup
      if (highlightLayer) {
        highlightLayer.getSource()?.clear();
      }
    };
  }, [map, fgbLayer, highlightLayer, createHighlightGeometry]);
  
  // Debug: Log highlight layer state
  useEffect(() => {
    if (highlightLayer) {
      console.log('Highlight layer state:', {
        visible: highlightLayer.getVisible(),
        zIndex: highlightLayer.getZIndex(),
        sourceFeatures: highlightLayer.getSource()?.getFeatures().length || 0,
      });
    }
  }, [highlightLayer]);

  const handleToggleVisibility = (layerId: string) => {
    // Use LayerManager for unified visibility control
    if (layerManager && layerManager.getLayer(layerId)) {
      layerManager.toggleVisibility(layerId);
      updateLayersList();
    }
  };

  const handleChangeOpacity = (layerId: string, opacity: number) => {
    // Use LayerManager for unified opacity control
    if (layerManager && layerManager.getLayer(layerId)) {
      layerManager.setOpacity(layerId, opacity);
      updateLayersList();
    }
  };

  const handleChangeZIndex = (layerId: string, zIndex: number) => {
    // Use LayerManager for unified z-index control
    if (layerManager && layerManager.getLayer(layerId)) {
      layerManager.setZIndex(layerId, zIndex);
      updateLayersList();
    }
  };

  // Helper: update rescale on a single XYZ tile source
  const updateTileSourceRescale = (source: any, min: number, max: number) => {
    if (!source || !source.getUrls) return;
    const urls = source.getUrls();
    if (!urls || urls.length === 0) return;
    const oldUrl = urls[0];
    try {
      const urlParts = oldUrl.split('?');
      if (urlParts.length === 2) {
        const basePath = urlParts[0];
        const params = new URLSearchParams(urlParts[1]);
        params.set('rescale', `${min},${max}`);
        source.setUrl(`${basePath}?${params.toString()}`);
        if (source.refresh) source.refresh();
      }
    } catch (error) {
      console.error('Error updating prediction rescale URL:', error);
    }
  };

  const handleChangePredictionRescale = (layerId: string, min: number, max: number) => {
    if (!layerManager) return;

    const managedLayer = layerManager.getLayer(layerId);
    if (!managedLayer || managedLayer.type !== 'prediction' || !managedLayer.metadata) return;

    // Update metadata
    managedLayer.metadata.rescaleMin = min;
    managedLayer.metadata.rescaleMax = max;

    const layer = managedLayer.layer as any;

    // If the layer is a LayerGroup (global auto-load group), update all children
    if (layer instanceof LayerGroup) {
      layer.getLayers().forEach((child: any) => {
        const childSource = child.getSource?.();
        updateTileSourceRescale(childSource, min, max);
      });
    } else {
      // Single tile layer
      const source = layer.getSource?.();
      updateTileSourceRescale(source, min, max);
    }

    updateLayersList();
  };

  const handleReorderLayers = (fromIndex: number, toIndex: number) => {
    // Use LayerManager for unified reordering
    if (layerManager && layerManager.reorderLayers(fromIndex, toIndex)) {
      updateLayersList();
    }
  };

  const handleRemoveLayer = (layerId: string) => {
    if (!map || !layerManager) return;

    // Use LayerManager to remove layer
    if (layerManager.removeLayer(layerId)) {
      // Also clean up state if needed
      if (layerId === 'cog') {
        setCogLayer(null);
      } else if (layerId === 'fgb') {
        setFgbLayer(null);
      } else if (layerId.startsWith('sentinel2-')) {
        setSentinel2Layers((prev: any[]) => prev.filter((l: any) => l.id !== layerId));
      } else if (layerId.startsWith('prediction-global-')) {
        // Reset auto-load state and deactivate VSM
        globalPredGroupRef.current = null;
        globalLayerRegisteredRef.current = false;
        autoLoadingTilesRef.current.clear();
        useMapStore.getState().setActiveVSM(null);
      } else if (layerId.startsWith('prediction-')) {
        setPredictionLayers((prev: any[]) => prev.filter((l: any) => l.id !== layerId));
      }
      updateLayersList();
    }
  };

  const handleLocateLayer = (layerId: string) => {
    if (!map || !layerManager) return;

    // Get extent from LayerManager (handles all the logic)
    // Check if method exists (handles hot-reload edge cases)
    if (typeof layerManager.getLayerExtent !== 'function') {
      console.error('getLayerExtent method not available. Please refresh the page to reload the latest code.');
      alert('Layer location feature is not available. Please refresh the page.');
      return;
    }
    
    const extent = layerManager.getLayerExtent(layerId);
    
    if (extent && extent.length === 4) {
      // Validate extent
      if (extent.every((val: number) => isFinite(val) && !isNaN(val))) {
        try {
          map.getView().fit(extent, {
            padding: [50, 50, 50, 50],
            duration: 1000,
            maxZoom: 18,
          });
        } catch (err) {
          console.warn('Error fitting view to layer extent:', err);
        }
      } else {
        console.warn('Invalid extent values:', extent);
      }
    } else {
      console.warn('Layer has no valid extent:', layerId);
    }
  };

  // --- Vector layer feature interaction handlers ---
  const highlightFeatureRef = useRef<Feature<Geometry> | null>(null);

  // Build vectorFeatures map from layers for the LayerControl
  const vectorFeatures = useMemo(() => {
    const result: Record<string, { name: string; index: number }[]> = {};
    if (!layerManager) return result;

    const vectorLayers = layerManager.getLayersByType('vector');
    for (const managed of vectorLayers) {
      const source = (managed.layer as any).getSource?.();
      if (!source) continue;
      const features = source.getFeatures?.() || [];
      result[managed.id] = features.map((f: any, i: number) => ({
        name: f.get('tileName') || f.get('name') || `Feature ${i}`,
        index: i,
      }));
    }
    return result;
  }, [layerManager, layers]); // layers dependency ensures re-compute on changes

  const handleHighlightFeature = useCallback((layerId: string, featureIndex: number | null) => {
    if (!layerManager) return;

    const managed = layerManager.getLayer(layerId);
    if (!managed) return;

    const source = (managed.layer as any).getSource?.();
    if (!source) return;

    // Reset previous highlight
    if (highlightFeatureRef.current) {
      highlightFeatureRef.current.setStyle(undefined); // revert to layer default
      highlightFeatureRef.current = null;
    }

    if (featureIndex === null) return;

    const features = source.getFeatures?.() || [];
    const feature = features[featureIndex];
    if (!feature) return;

    // Set highlighted style: bigger text, white color with red stroke
    feature.setStyle(new Style({
      text: new TextStyle({
        text: feature.get('tileName') || '',
        font: 'bold 24px sans-serif',
        fill: new Fill({ color: '#FFFFFF' }),
        stroke: new Stroke({ color: '#FF0000', width: 4 }),
        overflow: true,
      }),
    }));
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

    // Update selectedTiles in store
    const currentTiles = useMapStore.getState().selectedTiles;
    useMapStore.getState().setSelectedTiles(currentTiles.filter((t: string) => t !== tileName));

    // Update layer name with new count
    const remaining = source.getFeatures().length;
    if (remaining === 0) {
      // Remove entire layer if no features left
      layerManager.removeLayer(layerId);
      if (map) map.removeLayer(managed.layer);
    } else {
      (managed as any).name = `Selected Tiles (${remaining})`;
    }
    updateLayersList();
  }, [layerManager, map, updateLayersList]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
        <SidebarContainer />
        <LayerControl
          layers={layers}
          onToggleVisibility={handleToggleVisibility}
          onChangeOpacity={handleChangeOpacity}
          onChangeZIndex={handleChangeZIndex}
          onReorderLayers={handleReorderLayers}
          onRemoveLayer={handleRemoveLayer}
          onLocateLayer={handleLocateLayer}
          onChangePredictionRescale={handleChangePredictionRescale}
          onHighlightFeature={handleHighlightFeature}
          onRemoveFeature={handleRemoveFeature}
          vectorFeatures={vectorFeatures}
        />
        {/* <GEEContainer map={map} /> */}
        {/* <RHContainer map={map} /> */}
        {/* <XarrayContainer map={map} /> */}
        <MapComponent onMapInit={handleMapInit} />

        {/* Zoom-in message */}
        {showZoomMessage && (
          <div
            style={{
              position: 'absolute',
              top: 75,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 1000,
              backgroundColor: 'rgba(25, 118, 210, 0.9)',
              color: '#fff',
              padding: '6px 20px',
              borderRadius: 20,
              fontSize: '0.85rem',
              fontWeight: 500,
              pointerEvents: 'none',
              boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
              whiteSpace: 'nowrap',
            }}
          >
            Zoom in to see the predictions
          </div>
        )}
        
        {/* Tile Search */}
        <TileSearch map={map} />
        
        {/* Base Map Selector */}
        <BaseMapSelector map={map} />
        
        {/* Feature Popup */}
        <FeaturePopup
          properties={popupProperties}
          position={popupPosition}
          geometry={popupGeometry}
          coordinates={popupCoordinates}
          onLoadSentinel2Image={handleLoadSentinel2Image}
          onLoadPredictionCOG={handleLoadPredictionCOG}
          onClose={closePopup}
        />
      </div>
    </ThemeProvider>
  );
}

export default App;
