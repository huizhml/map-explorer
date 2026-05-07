import React from 'react';
import { Sidebar } from '../components/Sidebar';
import { PALETTES, type PaletteName } from '../constants/palettes';
import GeoTIFF from 'ol/source/GeoTIFF';
import WebGLTile from 'ol/layer/WebGLTile';
import VectorLayer from 'ol/layer/Vector';
import VectorImageLayer from 'ol/layer/VectorImage';
import VectorSource from 'ol/source/Vector';
import Cluster from 'ol/source/Cluster';
import { Style, Fill, Stroke, Circle as CircleStyle, Text as TextStyle } from 'ol/style';
import { transformExtent, fromLonLat } from 'ol/proj';
import OLFeature from 'ol/Feature';
import OLPoint from 'ol/geom/Point';
import OLLineString from 'ol/geom/LineString';
import OLPolygon from 'ol/geom/Polygon';

import { unByKey } from 'ol/Observable';
import { deserialize } from 'flatgeobuf/lib/mjs/ol';
import { useMapStore, type FgbInfo, type StyleOptions } from '../stores/mapStore';
import { parseUploadedFile } from '../utils/parseUploadedFile';
import { API_BASE_URL, apiUrl } from '../utils/apiBase';
import { getDiversityBandRange } from '../constants/layerRanges';
import { listSavedFeatures, deleteSavedFeature, type SavedFeature } from '../services/savedFeaturesApi';
import { defaultFigureFilenameStem } from '../utils/figureFilenameStem';

const max = 500;
const MIN_CLUSTER_SIZE = 20;
const LARGE_POINT_DATASET_SIZE = 100000;
const CLUSTER_MAX_ZOOM = 6;

function createColorRamp(colors: readonly string[]) {
  const stops = colors.map((color, i) => [i / (colors.length - 1) * max, color]).flat();
  return ['interpolate', ['linear'], ['band', 1], ...stops];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function interpolateHexColor(color1: string, color2: string, t: number): string {
  const c1 = color1.replace('#', '');
  const c2 = color2.replace('#', '');
  const r1 = parseInt(c1.substring(0, 2), 16);
  const g1 = parseInt(c1.substring(2, 4), 16);
  const b1 = parseInt(c1.substring(4, 6), 16);
  const r2 = parseInt(c2.substring(0, 2), 16);
  const g2 = parseInt(c2.substring(2, 4), 16);
  const b2 = parseInt(c2.substring(4, 6), 16);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function colorFromPalette(value: number, min: number, max: number, paletteName: string): string {
  const palette = PALETTES[(paletteName as PaletteName)] ?? PALETTES.Viridis;
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return palette[0];
  if (max <= min) return palette[0];
  const ratio = clamp01((value - min) / (max - min));
  const scaled = ratio * (palette.length - 1);
  const lower = Math.floor(scaled);
  const upper = Math.min(lower + 1, palette.length - 1);
  const localT = scaled - lower;
  return interpolateHexColor(palette[lower], palette[upper], localT);
}

function hexToRgbaColor(hex: string): string | null {
  if (!hex) return null;
  if (hex.length === 9 && hex.startsWith('#')) {
    const r = parseInt(hex.substring(1, 3), 16);
    const g = parseInt(hex.substring(3, 5), 16);
    const b = parseInt(hex.substring(5, 7), 16);
    const a = parseInt(hex.substring(7, 9), 16) / 255;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  if (hex.length === 7 && hex.startsWith('#')) {
    const r = parseInt(hex.substring(1, 3), 16);
    const g = parseInt(hex.substring(3, 5), 16);
    const b = parseInt(hex.substring(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, 1)`;
  }
  return hex;
}

function buildFgbStyleKey(options: StyleOptions, geometryType: string, propertyColor: string | null): string {
  return [
    geometryType,
    options.fillColor || '#ff000000',
    options.strokeColor || '#000000',
    options.strokeWidth || 2,
    options.pointRadius || 5,
    propertyColor || '',
  ].join('|');
}

function getCachedFgbStyle(
  cache: globalThis.Map<string, Style>,
  options: StyleOptions,
  geometryType: string,
  propertyColor: string | null,
): Style {
  const cacheKey = buildFgbStyleKey(options, geometryType, propertyColor);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const fillColor = hexToRgbaColor(options.fillColor || '#ff000000');
  const strokeColor = hexToRgbaColor(options.strokeColor || '#000000');
  const resolvedFillColor = propertyColor ? hexToRgbaColor(propertyColor) : fillColor;
  const resolvedStrokeColor = propertyColor ? hexToRgbaColor(propertyColor) : strokeColor;
  const fill = resolvedFillColor && resolvedFillColor.includes('rgba') && resolvedFillColor.endsWith(', 0)')
    ? undefined
    : new Fill({ color: resolvedFillColor || 'transparent' });

  const style = new Style({
    fill,
    stroke: new Stroke({
      color: resolvedStrokeColor || '#000000',
      width: options.strokeWidth || 2,
    }),
    image: (geometryType === 'Point' || geometryType === 'MultiPoint')
      ? new CircleStyle({
          radius: options.pointRadius || 5,
          fill,
          stroke: new Stroke({
            color: resolvedStrokeColor || '#000000',
            width: options.strokeWidth || 2,
          }),
        })
      : undefined,
  });
  cache.set(cacheKey, style);
  return style;
}

function getCachedClusterStyle(
  cache: globalThis.Map<number, Style>,
  clusterSize: number,
): Style {
  const cached = cache.get(clusterSize);
  if (cached) return cached;
  const style = new Style({
    image: new CircleStyle({
      radius: Math.max(8, Math.min(20, 8 + Math.log2(clusterSize))),
      fill: new Fill({ color: 'rgba(33, 150, 243, 0.75)' }),
      stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
    }),
    text: new TextStyle({
      text: String(clusterSize),
      fill: new Fill({ color: '#ffffff' }),
      stroke: new Stroke({ color: 'rgba(0,0,0,0.45)', width: 2 }),
      font: 'bold 12px sans-serif',
    }),
  });
  cache.set(clusterSize, style);
  return style;
}

export interface FigureLayerOverrides {
  selectedBands: number[];
  colormap?: string;
  rescaleMin?: number;
  rescaleMax?: number;
}

export function SidebarContainer() {
  const [uploadingFile, setUploadingFile] = React.useState(false);
  const [figureFormat, setFigureFormat] = React.useState<'jpg' | 'png' | 'pdf'>('pdf');
  const [figureOutputFolder, setFigureOutputFolder] = React.useState('/maps/projects/dereeco/data/gvs');
  const [figureFilenameStem, setFigureFilenameStem] = React.useState('');
  const lastExtentForStemRef = React.useRef<string | null>(null);
  const [selectedFigureLayerIds, setSelectedFigureLayerIds] = React.useState<string[]>([]);
  const [figureLayerOverrides, setFigureLayerOverrides] = React.useState<Record<string, FigureLayerOverrides>>({});
  const [savingFigures, setSavingFigures] = React.useState(false);
  const [figureSaveMessage, setFigureSaveMessage] = React.useState<string | null>(null);
  const [figureSaveError, setFigureSaveError] = React.useState<string | null>(null);
  const [savingFiguresToDb, setSavingFiguresToDb] = React.useState(false);
  const [figuresToDbMessage, setFiguresToDbMessage] = React.useState<string | null>(null);
  const [figuresToDbError, setFiguresToDbError] = React.useState<string | null>(null);
  const [deletingSavedFeatureId, setDeletingSavedFeatureId] = React.useState<number | null>(null);
  const [savedFeaturesLoading, setSavedFeaturesLoading] = React.useState(false);
  const [savedFeaturesError, setSavedFeaturesError] = React.useState<string | null>(null);
  const highlightLayerRef = React.useRef<VectorLayer<VectorSource> | null>(null);

  // Zustand store
  const {
    map,
    cogLayer,
    setCogLayer,
    cogOpacity,
    cogVisible,
    palette,
    fgbLayer,
    setFgbLayer,
    fgbUrl,
    setFgbUrl,
    fgbLoading,
    setFgbLoading,
    fgbError,
    setFgbError,
    hasAutoLoadedFgb,
    setHasAutoLoadedFgb,
    fgbStyleOptions,
    conditionalStyles,
    enableConditionalRendering,
    fgbInfo: currentFgbInfo,
    setCurrentFileName,
    setFgbInfo,
    layerManager,
    setLayers,
    layers,
  } = useMapStore();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !map) return;

    const url = URL.createObjectURL(file);
    setCurrentFileName(file.name);

    try {
      const tiff = await (await import('geotiff')).fromUrl(url);
      const image = await tiff.getImage();
      const samples = image.getSamplesPerPixel();
      let bands: number[] = [1];
      if (samples >= 3) {
        bands = [1, 2, 3];
      }

      const imageWindow = image.getBoundingBox();
      const geoKeys = image.getGeoKeys();

      let sourceCRS = 'EPSG:4326';
      if (geoKeys?.ProjectedCSTypeGeoKey) {
        sourceCRS = `EPSG:${geoKeys.ProjectedCSTypeGeoKey}`;
      } else if (geoKeys?.GeographicTypeGeoKey) {
        sourceCRS = `EPSG:${geoKeys.GeographicTypeGeoKey}`;
      }

      const extent = transformExtent(
        imageWindow,
        sourceCRS,
        'EPSG:3857'
      );

      const geoTiffSource = new GeoTIFF({
        sources: [
          {
            url,
            bands,
          }
        ],
        interpolate: true,
        normalize: false,
      });

      if (cogLayer) {
        map.removeLayer(cogLayer);
      }

      const layer = new WebGLTile({
        source: geoTiffSource,
        opacity: cogOpacity,
        visible: cogVisible,
        extent: extent,
        style: {
          variables: {
            max: max,
            nodata: 32767,
          },
          color: samples >= 3 ? undefined : createColorRamp(PALETTES[palette as PaletteName])
        }
      });

      map.addLayer(layer);
      setCogLayer(layer);

      map.getView().fit(extent, {
        padding: [50, 50, 50, 50],
        duration: 1000
      });
    } catch (err) {
      console.error('Error loading GeoTIFF:', err);
      alert('Could not read GeoTIFF: ' + (err instanceof Error ? err.message : err));
    }
  };


  // FlatGeobuf handlers
  const handleLoadFGB = async (urlOverride?: string) => {
    const urlToLoad = (urlOverride ?? fgbUrl).trim();
    if (!urlToLoad || !map) return;

    setFgbLoading(true);
    setFgbError(null);

    try {
      // Remove existing FlatGeobuf layer
      if (fgbLayer) {
        map.removeLayer(fgbLayer);
      }

      // Check if URL is cross-origin and use proxy if needed
      const isCrossOrigin = (url: string): boolean => {
        try {
          const urlObj = new URL(url, window.location.href);
          return urlObj.origin !== window.location.origin;
        } catch {
          return true;
        }
      };

      // Use proxy for cross-origin FlatGeobuf files to handle CORS
      // Skip proxy when URL already points to our backend
      let fgbFileUrl = urlToLoad;
      const isBackendUrl = urlToLoad.startsWith(`${API_BASE_URL}/`);
      const isCrossOriginUrl = isCrossOrigin(urlToLoad);
      
      if (isCrossOriginUrl && !isBackendUrl) {
        fgbFileUrl = apiUrl(`/fgb/proxy?url=${encodeURIComponent(urlToLoad)}`);
        console.log('Cross-origin FlatGeobuf detected, using proxy:', {
          original: urlToLoad,
          proxy: fgbFileUrl
        });
      } else {
        console.log('Using direct URL:', fgbFileUrl);
      }

      // Fetch entire file as buffer then deserialize — avoids spatial-index
      // and range-request issues; fine for files up to ~50 MB.
      const source = new VectorSource();
      try {
        const resp = await fetch(fgbFileUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        const buffer = new Uint8Array(await resp.arrayBuffer());
        const iter = deserialize(buffer, undefined, undefined, false, {}, false, 'EPSG:4326', 'EPSG:3857');
        for await (const feature of iter) {
          source.addFeature(feature as any);
        }
        console.log(`Loaded ${source.getFeatures().length} features from FlatGeobuf`);
      } catch (error) {
        console.error('Error loading FlatGeobuf features:', error);
        setFgbError(`Failed to load features: ${error instanceof Error ? error.message : String(error)}`);
      }

      const loadedFeatures = source.getFeatures();
      const pointOnlyDataset = loadedFeatures.length > 0 && loadedFeatures.every((feature) => {
        const geometryType = feature.getGeometry()?.getType();
        return geometryType === 'Point' || geometryType === 'MultiPoint';
      });
      const canClusterDataset = pointOnlyDataset && loadedFeatures.length > 15000;
      const clusterSource = canClusterDataset
        ? new Cluster({
            source,
            distance: 36,
            minDistance: 10,
          })
        : null;
      const initialZoom = map.getView().getZoom() ?? 0;
      const shouldUseClusterAtLoad = Boolean(
        canClusterDataset && fgbStyleOptions.clusterPoints && initialZoom <= CLUSTER_MAX_ZOOM
      );
      const layerSource: VectorSource | Cluster = shouldUseClusterAtLoad && clusterSource
        ? clusterSource
        : source;

      // Helper function to evaluate conditional style
      const evaluateCondition = (feature: any, condition: any): boolean => {
        const properties = feature.getProperties();
        const propValue = properties[condition.property];
        
        if (propValue === undefined || propValue === null) {
          return false;
        }

        const conditionValue = condition.value;
        const operator = condition.operator;

        switch (operator) {
          case 'equals':
            return String(propValue) === String(conditionValue);
          case 'not_equals':
            return String(propValue) !== String(conditionValue);
          case 'greater_than':
            return Number(propValue) > Number(conditionValue);
          case 'less_than':
            return Number(propValue) < Number(conditionValue);
          case 'contains':
            return String(propValue).includes(String(conditionValue));
          case 'starts_with':
            return String(propValue).startsWith(String(conditionValue));
          default:
            return false;
        }
      };

      // Helper function to get style for a feature based on conditions
      const getFeatureStyle = (feature: any): StyleOptions => {
        // If conditional rendering is enabled, check conditions
        if (enableConditionalRendering && conditionalStyles.length > 0) {
          // Check conditions in order - first match wins
          for (const condition of conditionalStyles) {
            if (condition.property) {
              const result = evaluateCondition(feature, condition);
              
              // Handle color gradient (returns color string)
              if (condition.operator === 'color_gradient' && typeof result === 'string') {
                return {
                  ...fgbStyleOptions,
                  fillColor: result,
                  strokeColor: result,
                };
              }
              
              // Handle other conditions (returns boolean)
              if (result === true) {
                // Merge conditional style with default style
                return {
                  ...fgbStyleOptions,
                  ...condition.style,
                };
              }
            }
          }
        }
        // Return default style if no conditions match
        return fgbStyleOptions;
      };

      const getPropertyColor = (feature: any, options: StyleOptions): string | null => {
        if (!options.colorByProperty) return null;
        const rawValue = feature.get(options.colorByProperty);
        if (rawValue === undefined || rawValue === null) return null;
        if (options.colorScaleType === 'discrete') {
          const valueKey = String(rawValue);
          const discreteValues = currentFgbInfo?.discretePropertyValues?.[options.colorByProperty] ?? [];
          const palette = PALETTES[(options.colorPalette as PaletteName)] ?? PALETTES.Viridis;
          const valueIndex = discreteValues.indexOf(valueKey);
          if (valueIndex >= 0) {
            return palette[valueIndex % palette.length];
          }
          let hash = 0;
          for (let i = 0; i < valueKey.length; i += 1) hash = ((hash << 5) - hash) + valueKey.charCodeAt(i);
          return palette[Math.abs(hash) % palette.length];
        }
        const value = Number(rawValue);
        if (!Number.isFinite(value)) return null;
        const numericRange = currentFgbInfo?.numericPropertyRanges?.[options.colorByProperty];
        const min = options.colorRangeMin ?? numericRange?.min;
        const max = options.colorRangeMax ?? numericRange?.max;
        if (min == null || max == null) return null;
        return colorFromPalette(value, min, max, options.colorPalette || 'Viridis');
      };

      const styleCache = new globalThis.Map<string, Style>();
      const clusterStyleCache = new globalThis.Map<number, Style>();

      const useVectorImageLayer = pointOnlyDataset && loadedFeatures.length >= LARGE_POINT_DATASET_SIZE;
      const FgbLayerClass = useVectorImageLayer ? VectorImageLayer : VectorLayer;

      // Create vector layer with FlatGeobuf source
      const newVectorLayer = new FgbLayerClass({
        source: layerSource,
        style: (feature: any) => {
          const clusterMembers = feature.get('features') as any[] | undefined;
          const clusterSize = clusterMembers?.length ?? 0;
          if (clusterSize >= MIN_CLUSTER_SIZE) {
            return getCachedClusterStyle(clusterStyleCache, clusterSize);
          }
          if (clusterMembers && clusterMembers.length >= 1) {
            const originalFeature = clusterMembers[0];
            const geometryType = originalFeature.getGeometry()?.getType() || 'Point';
            const styleOptions = getFeatureStyle(originalFeature);
            return getCachedFgbStyle(styleCache, styleOptions, geometryType, getPropertyColor(originalFeature, styleOptions));
          }
          const geometry = feature.getGeometry();
          if (!geometry) return undefined;
          const geometryType = geometry.getType();
          const styleOptions = getFeatureStyle(feature);
          return getCachedFgbStyle(styleCache, styleOptions, geometryType, getPropertyColor(feature, styleOptions));
        },
        opacity: fgbStyleOptions.opacity || 0.7,
        zIndex: fgbStyleOptions.zIndex || 100,
        ...(useVectorImageLayer ? { imageRatio: 1 } : {}),
      });
      newVectorLayer.set('rawSource', source);
      newVectorLayer.set('clusterSource', clusterSource);
      newVectorLayer.set('isPointOnlyDataset', pointOnlyDataset);
      newVectorLayer.set('canClusterDataset', canClusterDataset);

      // Helper function to extract and set FGB info
      // This function updates the info incrementally as features are loaded
      const extractFgbInfo = (updateExisting = false) => {
        try {
          const features = source.getFeatures();
          
          // Only extract info if we have features
          if (features.length === 0) {
            console.log('No features loaded yet, will retry...');
            return false;
          }
          
          const extent = source.getExtent();
          
          // Get existing properties if updating, otherwise start fresh
          const existingInfo = updateExisting ? currentFgbInfo : null;
          const properties = existingInfo ? new Set<string>(existingInfo.properties || []) : new Set<string>();
          const geometryTypes = existingInfo ? new Set<string>(existingInfo.geometryTypes || []) : new Set<string>();
          const sampleProperties = existingInfo ? { ...existingInfo.sampleProperties } : {};
          const numericPropertyRanges: Record<string, { min: number; max: number }> = {
            ...(existingInfo?.numericPropertyRanges ?? {}),
          };
          const discretePropertyValues: Record<string, Set<string>> = {};
          Object.entries(existingInfo?.discretePropertyValues ?? {}).forEach(([key, values]) => {
            discretePropertyValues[key] = new Set(values);
          });
          
          // Extract properties from ALL features to ensure we get all columns
          // Check all features to get all possible properties
          // This ensures we don't miss any columns that might appear in later features
          features.forEach(feature => {
            const geom = feature.getGeometry();
            if (geom) {
              geometryTypes.add(geom.getType());
            }
            const props = feature.getProperties();
            Object.keys(props).forEach(key => {
              if (key !== 'geometry') {
                properties.add(key);
                // Store first non-null value as sample
                if (!sampleProperties[key] && props[key] !== null && props[key] !== undefined) {
                  sampleProperties[key] = props[key];
                }
                const numericValue = Number(props[key]);
                if (Number.isFinite(numericValue)) {
                  const currentRange = numericPropertyRanges[key];
                  if (!currentRange) {
                    numericPropertyRanges[key] = { min: numericValue, max: numericValue };
                  } else {
                    numericPropertyRanges[key] = {
                      min: Math.min(currentRange.min, numericValue),
                      max: Math.max(currentRange.max, numericValue),
                    };
                  }
                }
                if (!discretePropertyValues[key]) discretePropertyValues[key] = new Set<string>();
                if (discretePropertyValues[key].size < 200) {
                  discretePropertyValues[key].add(String(props[key]));
                }
              }
            });
          });
          
          const info: FgbInfo = {
            type: 'FeatureCollection',
            featureCount: features.length,
            geometryTypes: Array.from(geometryTypes),
            properties: Array.from(properties).sort(), // Sort for better UX
            sampleProperties: sampleProperties,
            numericPropertyRanges,
            discretePropertyValues: Object.fromEntries(
              Object.entries(discretePropertyValues).map(([key, values]) => [key, Array.from(values).sort()]),
            ),
          };
          
          // // Only log if properties changed or it's the first extraction
          // const propertiesChanged = !existingInfo || 
          //   existingInfo.properties.length !== properties.size ||
          //   !existingInfo.properties.every(p => properties.has(p));
          
          // if (propertiesChanged || !updateExisting) {
          //   console.log('Extracted FGB info:', info, `(${properties.size} properties found)`);
          // }
          setFgbInfo(info);
          
          // Only fit to extent on first extraction
          if (extent && extent.length === 4 && !updateExisting) {
            console.log('FlatGeobuf loaded with extent:', extent);
            // Optionally fit map to extent
            map.getView().fit(extent, { padding: [50, 50, 50, 50] });
          }
          
          return true;
        } catch (e) {
          console.error('Error extracting FGB info:', e);
          return false;
        }
      };

      // Add layer to map
      map.addLayer(newVectorLayer);
      console.log(`FlatGeobuf layer added with zIndex: ${fgbStyleOptions.zIndex}`);
      setFgbLayer(newVectorLayer);

      // Try to extract info when features are added
      // With bbox strategy, features load incrementally, so we need to check multiple times
      let infoExtracted = false;
      let lastUpdateTime = 0;
      const UPDATE_THROTTLE_MS = 500; // Throttle updates to once per 500ms
      
      // Listen for when features are added - update info incrementally with throttling
      const onFeatureAdd = () => {
        const now = Date.now();
        // Throttle updates to prevent excessive logging
        if (now - lastUpdateTime < UPDATE_THROTTLE_MS) {
          return;
        }
        lastUpdateTime = now;
        
        // Always update to capture new properties from newly loaded features
        extractFgbInfo(true); // true = update existing info
        if (!infoExtracted) {
          infoExtracted = true;
        }
      };
      
      source.on('addfeature', onFeatureAdd);
      
      // Also try after featuresloadend event
      source.once('featuresloadend', () => {
        extractFgbInfo(true); // Update with any new properties
        if (!infoExtracted) {
          infoExtracted = extractFgbInfo(false); // Initial extraction
        }
      });
      
      // Fallback: try after a short delay in case events don't fire
      setTimeout(() => {
        if (!infoExtracted) {
          infoExtracted = extractFgbInfo(false);
        } else {
          // Still update to catch any properties we might have missed
          extractFgbInfo(true);
        }
      }, 1000);
      
      // Also try when the map view changes (bbox strategy loads features on view change)
      const view = map.getView();
      const viewChangeKey = view.on('change:center', () => {
        if (!infoExtracted) {
          setTimeout(() => {
            infoExtracted = extractFgbInfo();
            if (infoExtracted) {
              // Unlisten once we have info
              unByKey(viewChangeKey);
            }
          }, 500);
        } else {
          // Unlisten once we have info
          unByKey(viewChangeKey);
        }
      });

    } catch (err) {
      console.error('FlatGeobuf loading error:', err);
      setFgbError(err instanceof Error ? err.message : 'Failed to load FlatGeobuf file');
    } finally {
      setFgbLoading(false);
    }
  };

  const handleRemoveFGBLayer = () => {
    if (fgbLayer && map) {
      map.removeLayer(fgbLayer);
      setFgbLayer(null);
      setFgbUrl('');
      setFgbError(null);
    }
  };

  const handleFGBUrlChange = (url: string) => {
    setFgbUrl(url);
    setFgbError(null);
  };

  const handleLoadForestNaturalnessData = React.useCallback(() => {
    const naturalnessUrl = apiUrl('/fgb/naturalness');
    setFgbUrl(naturalnessUrl);
    setHasAutoLoadedFgb(true);
    void handleLoadFGB(naturalnessUrl);
  }, [handleLoadFGB, setFgbUrl, setHasAutoLoadedFgb]);

  // Auto-load FlatGeobuf once when map is ready
  React.useEffect(() => {
    if (map && !fgbLayer && !fgbLoading && !hasAutoLoadedFgb && fgbUrl) {
      setHasAutoLoadedFgb(true);
      void handleLoadFGB();
    }
  }, [map, fgbLayer, fgbLoading, hasAutoLoadedFgb, fgbUrl]);

  // Update layer style when conditional styles or style options change
  React.useEffect(() => {
    if (!fgbLayer || !map) return;
    let zoomKey: any = null;
    const rawSource = fgbLayer.get('rawSource') as VectorSource | undefined;
    const existingClusterSource = fgbLayer.get('clusterSource') as Cluster | null | undefined;
    const isPointOnlyDataset = Boolean(fgbLayer.get('isPointOnlyDataset'));
    const canClusterDataset = Boolean(fgbLayer.get('canClusterDataset')) || (
      !!rawSource && isPointOnlyDataset && rawSource.getFeatures().length > 15000
    );
    if (rawSource && canClusterDataset) {
      const clusterSource = existingClusterSource ?? new Cluster({ source: rawSource, distance: 36, minDistance: 10 });
      if (!existingClusterSource) fgbLayer.set('clusterSource', clusterSource);

      const applyClusterForZoom = () => {
        const currentZoom = map.getView().getZoom() ?? 0;
        const shouldUseCluster = Boolean(fgbStyleOptions.clusterPoints && currentZoom <= CLUSTER_MAX_ZOOM);
        const currentSource = fgbLayer.getSource();
        const currentlyClustered = currentSource instanceof Cluster;
        if (shouldUseCluster && !currentlyClustered) {
          fgbLayer.setSource(clusterSource);
        } else if (!shouldUseCluster && currentlyClustered) {
          fgbLayer.setSource(rawSource);
        }
      };

      applyClusterForZoom();
      zoomKey = map.getView().on('change:resolution', applyClusterForZoom);
    }

    // Helper function to interpolate color from a palette
    const interpolateColorFromPalette = (min: number, max: number, value: number, paletteName: string): string => {
      if (min === max) {
        // Return first color of palette if min === max
        const palette = PALETTES[paletteName as PaletteName] || PALETTES.Viridis;
        return palette[0];
      }
      
      const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));
      const palette = PALETTES[paletteName as PaletteName] || PALETTES.Viridis;
      
      // Find which two colors in the palette to interpolate between
      const colorIndex = ratio * (palette.length - 1);
      const lowerIndex = Math.floor(colorIndex);
      const upperIndex = Math.min(Math.ceil(colorIndex), palette.length - 1);
      const localRatio = colorIndex - lowerIndex;
      
      const color1 = palette[lowerIndex];
      const color2 = palette[upperIndex];
      
      // Parse hex colors
      const hex1 = color1.replace('#', '');
      const hex2 = color2.replace('#', '');
      const r1 = parseInt(hex1.substring(0, 2), 16);
      const g1 = parseInt(hex1.substring(2, 4), 16);
      const b1 = parseInt(hex1.substring(4, 6), 16);
      const r2 = parseInt(hex2.substring(0, 2), 16);
      const g2 = parseInt(hex2.substring(2, 4), 16);
      const b2 = parseInt(hex2.substring(4, 6), 16);
      
      const r = Math.round(r1 + (r2 - r1) * localRatio);
      const g = Math.round(g1 + (g2 - g1) * localRatio);
      const b = Math.round(b1 + (b2 - b1) * localRatio);
      
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    };
    
    // Legacy function for backward compatibility (min/max color interpolation)
    const interpolateColor = (min: number, max: number, value: number, minColor: string, maxColor: string): string => {
      if (min === max) return minColor;
      const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));
      
      // Parse hex colors
      const hex1 = minColor.replace('#', '');
      const hex2 = maxColor.replace('#', '');
      const r1 = parseInt(hex1.substring(0, 2), 16);
      const g1 = parseInt(hex1.substring(2, 4), 16);
      const b1 = parseInt(hex1.substring(4, 6), 16);
      const r2 = parseInt(hex2.substring(0, 2), 16);
      const g2 = parseInt(hex2.substring(2, 4), 16);
      const b2 = parseInt(hex2.substring(4, 6), 16);
      
      const r = Math.round(r1 + (r2 - r1) * ratio);
      const g = Math.round(g1 + (g2 - g1) * ratio);
      const b = Math.round(b1 + (b2 - b1) * ratio);
      
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    };

    // Helper function to evaluate conditional style
    const evaluateCondition = (feature: any, condition: any): boolean | string => {
      const properties = feature.getProperties();
      const propValue = properties[condition.property];
      
      if (propValue === undefined || propValue === null) {
        return false;
      }

      const conditionValue = condition.value;
      const operator = condition.operator;

      switch (operator) {
        case 'equals':
          return String(propValue) === String(conditionValue);
        case 'not_equals':
          return String(propValue) !== String(conditionValue);
        case 'greater_than':
          return Number(propValue) > Number(conditionValue);
        case 'less_than':
          return Number(propValue) < Number(conditionValue);
        case 'between':
          const numValue = Number(propValue);
          const min = Number(conditionValue);
          const max = Number(condition.value2 || conditionValue);
          return numValue >= min && numValue <= max;
        case 'contains':
          return String(propValue).includes(String(conditionValue));
        case 'starts_with':
          return String(propValue).startsWith(String(conditionValue));
        case 'color_gradient':
          // Return the interpolated color instead of boolean
          const numPropValue = Number(propValue);
          if (isNaN(numPropValue)) return false;
          const minVal = condition.minValue ?? 0;
          const maxVal = condition.maxValue ?? 100;
          
          // Use palette if available, otherwise fall back to min/max colors
          if (condition.colorPalette) {
            return interpolateColorFromPalette(minVal, maxVal, numPropValue, condition.colorPalette);
          } else {
            // Legacy support for min/max colors
            const minCol = condition.minColor || '#0000ff';
            const maxCol = condition.maxColor || '#ff0000';
            return interpolateColor(minVal, maxVal, numPropValue, minCol, maxCol);
          }
        default:
          return false;
      }
    };

    // Helper function to get style for a feature based on conditions
    const getFeatureStyle = (feature: any): StyleOptions => {
      // If conditional rendering is enabled, check conditions
      if (enableConditionalRendering && conditionalStyles.length > 0) {
        // Check conditions in order - first match wins
        for (const condition of conditionalStyles) {
          if (condition.property) {
            const result = evaluateCondition(feature, condition);
            
            // Handle color gradient (returns color string)
            if (condition.operator === 'color_gradient' && typeof result === 'string') {
              return {
                ...fgbStyleOptions,
                fillColor: result,
                strokeColor: result,
              };
            }
            
            // Handle other conditions (returns boolean)
            if (result === true) {
              // Merge conditional style with default style
              return {
                ...fgbStyleOptions,
                ...condition.style,
              };
            }
          }
        }
      }
      // Return default style if no conditions match
      return fgbStyleOptions;
    };

    const getPropertyColor = (feature: any, options: StyleOptions): string | null => {
      if (!options.colorByProperty) return null;
      const rawValue = feature.get(options.colorByProperty);
      if (rawValue === undefined || rawValue === null) return null;
      if (options.colorScaleType === 'discrete') {
        const valueKey = String(rawValue);
        const discreteValues = currentFgbInfo?.discretePropertyValues?.[options.colorByProperty] ?? [];
        const palette = PALETTES[(options.colorPalette as PaletteName)] ?? PALETTES.Viridis;
        const valueIndex = discreteValues.indexOf(valueKey);
        if (valueIndex >= 0) {
          return palette[valueIndex % palette.length];
        }
        let hash = 0;
        for (let i = 0; i < valueKey.length; i += 1) hash = ((hash << 5) - hash) + valueKey.charCodeAt(i);
        return palette[Math.abs(hash) % palette.length];
      }
      const value = Number(rawValue);
      if (!Number.isFinite(value)) return null;
      const numericRange = currentFgbInfo?.numericPropertyRanges?.[options.colorByProperty];
      const min = options.colorRangeMin ?? numericRange?.min;
      const max = options.colorRangeMax ?? numericRange?.max;
      if (min == null || max == null) return null;
      return colorFromPalette(value, min, max, options.colorPalette || 'Viridis');
    };

    const styleCache = new globalThis.Map<string, Style>();
    const clusterStyleCache = new globalThis.Map<number, Style>();

    // Update the layer's style function
    fgbLayer.setStyle((feature: any) => {
      const clusterMembers = feature.get('features') as any[] | undefined;
      if (clusterMembers && clusterMembers.length >= MIN_CLUSTER_SIZE) {
        return getCachedClusterStyle(clusterStyleCache, clusterMembers.length);
      }
      if (clusterMembers && clusterMembers.length >= 1) {
        const originalFeature = clusterMembers[0];
        const geometryType = originalFeature.getGeometry()?.getType() || 'Point';
        const styleOptions = getFeatureStyle(originalFeature);
        return getCachedFgbStyle(styleCache, styleOptions, geometryType, getPropertyColor(originalFeature, styleOptions));
      }
      const geometry = feature.getGeometry();
      if (!geometry) return undefined;
      const geometryType = geometry.getType();
      const styleOptions = getFeatureStyle(feature);
      return getCachedFgbStyle(styleCache, styleOptions, geometryType, getPropertyColor(feature, styleOptions));
    });

    // Trigger a redraw
    fgbLayer.changed();
    return () => {
      if (zoomKey) unByKey(zoomKey);
    };
  }, [fgbLayer, enableConditionalRendering, conditionalStyles, fgbStyleOptions, currentFgbInfo, map]);

  const {
    addVsmLayer,
    addedVsmLayers,
    vsmYear,
    setVsmYear,
    vsmRhIndex,
    setVsmRhIndex,
    vsmQChoice,
    setVsmQChoice,
    drawingActive,
    setDrawingActive,
    drawingMode,
    setDrawingMode,
    selectedTiles,
    figureSelectionExtent,
    inspectMode,
    setInspectMode,
    inspectKind,
    setInspectKind,
    savedMapFeatures,
    setSavedMapFeatures,
    addSavedMapFeature,
    removeSavedMapFeature,
  } = useMapStore();

  const handleReloadSavedFeatures = React.useCallback(async () => {
    setSavedFeaturesLoading(true);
    setSavedFeaturesError(null);
    try {
      const features = await listSavedFeatures();
      setSavedMapFeatures(features);
    } catch (err) {
      setSavedFeaturesError(err instanceof Error ? err.message : 'Failed to load saved features');
    } finally {
      setSavedFeaturesLoading(false);
    }
  }, [setSavedMapFeatures]);

  React.useEffect(() => {
    void handleReloadSavedFeatures();
  }, [handleReloadSavedFeatures]);

  const handleJumpToFeature = React.useCallback((feature: SavedFeature) => {
    if (!map) return;

    // Remove previous highlight
    if (highlightLayerRef.current) {
      map.removeLayer(highlightLayerRef.current);
      highlightLayerRef.current = null;
    }

    // Build OL geometry in EPSG:3857
    const coords = feature.geometry.coordinates;
    let olGeom: OLPoint | OLLineString | OLPolygon;
    if (feature.geometry.type === 'Point') {
      olGeom = new OLPoint(fromLonLat(coords as [number, number]));
    } else if (feature.geometry.type === 'LineString') {
      olGeom = new OLLineString((coords as [number, number][]).map((c) => fromLonLat(c)));
    } else {
      olGeom = new OLPolygon([(coords as [number, number][][])[0].map((c) => fromLonLat(c))]);
    }

    const olFeature = new OLFeature({ geometry: olGeom });
    const highlightSource = new VectorSource({ features: [olFeature] });
    const highlightLayer = new VectorLayer({
      source: highlightSource,
      style: new Style({
        image: new CircleStyle({
          radius: 9,
          fill: new Fill({ color: 'rgba(255, 90, 30, 0.9)' }),
          stroke: new Stroke({ color: '#ffffff', width: 2.5 }),
        }),
        stroke: new Stroke({ color: 'rgba(255, 90, 30, 0.9)', width: 3 }),
        fill: new Fill({ color: 'rgba(255, 90, 30, 0.18)' }),
      }),
      zIndex: 9999,
    });

    map.addLayer(highlightLayer);
    highlightLayerRef.current = highlightLayer;

    // Fly to feature
    if (feature.geometry.type === 'Point') {
      map.getView().animate({ center: fromLonLat(coords as [number, number]), zoom: 14, duration: 800 });
    } else {
      map.getView().fit(highlightSource.getExtent(), { padding: [80, 80, 80, 80], duration: 800, maxZoom: 16 });
    }
  }, [map]);

  const handleDeleteSavedFeature = React.useCallback(async (featureId: number) => {
    setDeletingSavedFeatureId(featureId);
    try {
      await deleteSavedFeature(featureId);
      removeSavedMapFeature(featureId);
    } catch (err) {
      console.error('Failed to delete saved feature:', err);
    } finally {
      setDeletingSavedFeatureId(null);
    }
  }, [removeSavedMapFeature]);

  const handleInspectModeChange = (active: boolean) => {
    if (active) {
      setDrawingActive(false);
      setInspectKind('layers');
    }
    setInspectMode(active);
  };

  const handleVerticalProfileClick = () => {
    if (inspectMode && inspectKind === 'vertical_profile') {
      setInspectMode(false);
      return;
    }
    setDrawingActive(false);
    setInspectKind('vertical_profile');
    setInspectMode(true);
  };

  const handleVerticalProfileLineClick = () => {
    if (inspectMode && inspectKind === 'vertical_profile_line') {
      setInspectMode(false);
      return;
    }
    setDrawingActive(false);
    setInspectKind('vertical_profile_line');
    setInspectMode(true);
  };

  const handleAddLayer = () => {
    if (vsmYear !== 2020 && vsmYear !== 2024) return;
    const alreadyAdded = addedVsmLayers.some(
      (e) => e.year === vsmYear && e.rhIndex === vsmRhIndex && e.qChoice === vsmQChoice
    );
    if (alreadyAdded) return;
    addVsmLayer({
      year: vsmYear as 2020 | 2024,
      rhIndex: vsmRhIndex,
      qChoice: vsmQChoice,
    });
  };

  const updateLayersList = React.useCallback(() => {
    if (!map || !layerManager) return;
    layerManager.syncAllProperties();
    const managedLayers = layerManager.getAllLayers();
    setLayers(managedLayers.map((m: any) => ({
      id: m.id, name: m.name, visible: m.visible, opacity: m.opacity,
      zIndex: m.zIndex, type: m.type, metadata: m.metadata,
    })));
  }, [map, layerManager, setLayers]);

  const handleUploadFile = React.useCallback(async (file: File) => {
    if (!map || !layerManager) return;
    setUploadingFile(true);
    try {
      const result = await parseUploadedFile(file);
      if (result.error) {
        alert(result.error);
        return;
      }
      if (result.features.length === 0) {
        alert('No features found in the file.');
        return;
      }

      const source = new VectorSource({ features: result.features });
      const hasPoints = result.features.some(
        (f) => f.getGeometry()?.getType() === 'Point' || f.getGeometry()?.getType() === 'MultiPoint',
      );

      const styleCache = new globalThis.Map<number, Style>();
      const getZoomStyle = (zoom: number) => {
        const rounded = Math.round(zoom);
        let s = styleCache.get(rounded);
        if (s) return s;
        const radius = hasPoints ? Math.max(4000, Math.min(14000, rounded * 80)) : 0;
        const strokeW = Math.max(8, Math.min(16, rounded * 0.6));
        s = new Style({
          stroke: new Stroke({ color: '#1976d2', width: strokeW }),
          fill: new Fill({ color: 'rgba(25, 118, 210, 0.15)' }),
          ...(hasPoints
            ? {
                image: new CircleStyle({
                  radius,
                  fill: new Fill({ color: 'rgba(25, 118, 210, 0.7)' }),
                  stroke: new Stroke({ color: '#fff', width: Math.max(1, strokeW * 0.5) }),
                }),
              }
            : {}),
        });
        styleCache.set(rounded, s);
        return s;
      };

      const layer = new VectorLayer({
        source,
        zIndex: 700,
        style: () => {
          const zoom = map.getView().getZoom() ?? 10;
          return getZoomStyle(zoom);
        },
      });

      const layerId = `upload-${Date.now()}`;
      const layerName = `${result.name} (${result.features.length})`;
      map.addLayer(layer);

      const extent = source.getExtent();
      const metadata: Record<string, any> = { fileName: file.name, featureCount: result.features.length };
      if (extent?.length === 4 && extent.every((v: number) => isFinite(v))) {
        metadata.extent = extent;
        map.getView().fit(extent, { padding: [50, 50, 50, 50], duration: 1000 });
      }

      layerManager.addLayer(layerId, layerName, 'vector', layer, metadata);
      updateLayersList();
    } catch (e: any) {
      console.error('Upload error:', e);
      alert(`Failed to load file: ${e.message}`);
    } finally {
      setUploadingFile(false);
    }
  }, [map, layerManager, updateLayersList]);

  const handleGetTiles = () => {
    const next = !(drawingActive && drawingMode === 'tiles');
    if (next) {
      setInspectMode(false);
      setDrawingMode('tiles');
    }
    setDrawingActive(next);
  };

  const exportableFigureLayers = React.useMemo(() => {
    return layers
      .filter((layer) => {
        if (!layer.metadata?.url) return false;
        return layer.type === 'prediction' || layer.type === 'sentinel2';
      })
      .map((layer) => {
        const meta = layer.metadata ?? {};
        const bandNames: string[] | undefined = Array.isArray(meta.bandNames) ? meta.bandNames : undefined;
        const selectedBand: number | undefined = typeof meta.selectedBand === 'number' ? meta.selectedBand : undefined;
        const rgbBands: number[] | undefined = Array.isArray(meta.rgbBands) ? meta.rgbBands : undefined;
        return {
          id: layer.id,
          name: layer.name,
          layerType: String(layer.type),
          layerSubType: meta.layerType ? String(meta.layerType) : undefined,
          url: String(meta.url),
          colormap: meta.colormap ? String(meta.colormap) : undefined,
          rescaleMin: typeof meta.rescaleMin === 'number' ? meta.rescaleMin : undefined,
          rescaleMax: typeof meta.rescaleMax === 'number' ? meta.rescaleMax : undefined,
          bandNames,
          selectedBand,
          rgbBands,
        };
      });
  }, [layers]);

  const suggestedFigureFilenameStem = React.useMemo(() => {
    if (!figureSelectionExtent) return '';
    const selected = exportableFigureLayers.filter((l) => selectedFigureLayerIds.includes(l.id));
    const first = selected[0];
    if (!first) return '';
    return defaultFigureFilenameStem(
      figureSelectionExtent as [number, number, number, number],
      first.name,
    );
  }, [figureSelectionExtent, exportableFigureLayers, selectedFigureLayerIds]);

  React.useEffect(() => {
    if (!figureSelectionExtent) {
      lastExtentForStemRef.current = null;
      return;
    }
    const selected = exportableFigureLayers.filter((l) => selectedFigureLayerIds.includes(l.id));
    const first = selected[0];
    if (!first) return;
    const suggested = defaultFigureFilenameStem(
      figureSelectionExtent as [number, number, number, number],
      first.name,
    );
    const extKey = figureSelectionExtent.join(',');
    if (extKey !== lastExtentForStemRef.current) {
      lastExtentForStemRef.current = extKey;
      setFigureFilenameStem(suggested);
    }
  }, [figureSelectionExtent, exportableFigureLayers, selectedFigureLayerIds]);

  React.useEffect(() => {
    setSelectedFigureLayerIds((prev) => prev.filter((id) => exportableFigureLayers.some((l) => l.id === id)));
  }, [exportableFigureLayers]);

  // Seed overrides from layer metadata so defaults match the current visualization
  React.useEffect(() => {
    setFigureLayerOverrides((prev) => {
      const next = { ...prev };
      for (const layer of exportableFigureLayers) {
        if (next[layer.id]) continue;
        const defaultBands: number[] = [];
        if (layer.selectedBand != null) {
          defaultBands.push(layer.selectedBand);
        }
        const isDiversity = layer.layerSubType === 'diversity_indices';
        next[layer.id] = {
          selectedBands: defaultBands,
          colormap: layer.colormap,
          // Keep diversity ranges unset initially so per-band defaults (e.g. 2D ENL -> 1..6) can be applied at save time.
          rescaleMin: isDiversity ? undefined : layer.rescaleMin,
          rescaleMax: isDiversity ? undefined : layer.rescaleMax,
        };
      }
      return next;
    });
  }, [exportableFigureLayers]);

  const handleToggleFigureLayer = React.useCallback((layerId: string) => {
    setSelectedFigureLayerIds((prev) => (
      prev.includes(layerId) ? prev.filter((id) => id !== layerId) : [...prev, layerId]
    ));
  }, []);

  const handleUpdateFigureLayerOverride = React.useCallback((layerId: string, patch: Partial<FigureLayerOverrides>) => {
    setFigureLayerOverrides((prev) => ({
      ...prev,
      [layerId]: { ...prev[layerId], ...patch } as FigureLayerOverrides,
    }));
  }, []);

  const handleCreateFiguresDraw = () => {
    const next = !(drawingActive && drawingMode === 'figures');
    if (next) {
      setInspectMode(false);
      setDrawingMode('figures');
      setFigureSaveError(null);
      setFigureSaveMessage(null);
    }
    setDrawingActive(next);
  };

  const handleCreateDbFiguresDraw = () => {
    const next = !(drawingActive && drawingMode === 'figures_db');
    if (next) {
      setInspectMode(false);
      setDrawingMode('figures_db');
      setFiguresToDbError(null);
      setFiguresToDbMessage(null);
    }
    setDrawingActive(next);
  };

  const handleSaveFigures = React.useCallback(async () => {
    setFigureSaveError(null);
    setFigureSaveMessage(null);
    if (!figureSelectionExtent) {
      setFigureSaveError('Draw a rectangle first.');
      return;
    }
    if (!figureOutputFolder.trim()) {
      setFigureSaveError('Please provide an output folder.');
      return;
    }
    const selectedLayers = exportableFigureLayers.filter((layer) => selectedFigureLayerIds.includes(layer.id));
    if (selectedLayers.length === 0) {
      setFigureSaveError('Select at least one layer.');
      return;
    }

    try {
      setSavingFigures(true);
      const resp = await fetch(apiUrl('/auxiliary/save-figures'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extent_3857: figureSelectionExtent,
          output_dir: figureOutputFolder.trim(),
          format: figureFormat,
          ...(figureFilenameStem.trim() ? { filename_stem: figureFilenameStem.trim() } : {}),
          layers: selectedLayers.map((layer) => {
            const ovr = figureLayerOverrides[layer.id];
            const isDiversity = layer.layerSubType === 'diversity_indices';
            const cmap = ovr?.colormap !== undefined ? ovr.colormap : layer.colormap;
            const rmin = ovr?.rescaleMin !== undefined ? ovr.rescaleMin : layer.rescaleMin;
            const rmax = ovr?.rescaleMax !== undefined ? ovr.rescaleMax : layer.rescaleMax;
            const hasBands = ovr?.selectedBands && ovr.selectedBands.length > 0;
            return {
              layer_id: layer.id,
              name: layer.name,
              layer_type: layer.layerType,
              url: layer.url,
              rgb_bands: layer.rgbBands,
              colormap: cmap,
              rescale_min: rmin,
              rescale_max: rmax,
              bands: hasBands
                ? ovr!.selectedBands.map((bi) => ({
                    ...(isDiversity && ovr?.rescaleMin === undefined && ovr?.rescaleMax === undefined
                      ? {
                          rescale_min: getDiversityBandRange(bi)[0],
                          rescale_max: getDiversityBandRange(bi)[1],
                        }
                      : {
                          rescale_min: rmin,
                          rescale_max: rmax,
                        }),
                    band_index: bi,
                    band_name: layer.bandNames?.[bi - 1] ?? `Band ${bi}`,
                    colormap: cmap,
                  }))
                : undefined,
            };
          }),
        }),
      });
      const rawBody = await resp.text();
      let data: any = null;
      try {
        data = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        data = null;
      }

      if (!resp.ok) {
        const fallback = rawBody || `HTTP ${resp.status} ${resp.statusText}`;
        throw new Error(data?.error || fallback);
      }

      if (data?.success === false) {
        const detailedErrors = Array.isArray(data?.errors)
          ? data.errors
              .slice(0, 3)
              .map((e: any) => `${e?.name || e?.layer_id || 'layer'}: ${e?.error || 'unknown error'}`)
              .join(' | ')
          : '';
        const message = data?.error || (detailedErrors ? `No figures were saved. ${detailedErrors}` : 'Failed to save figures.');
        throw new Error(message);
      }
      const count = Array.isArray(data.saved_files) ? data.saved_files.length : 0;
      const failed = Array.isArray(data.errors) ? data.errors.length : 0;
      setFigureSaveMessage(`Saved ${count} figure(s) to ${data.output_dir}${failed ? ` (${failed} failed)` : ''}.`);
    } catch (err: any) {
      setFigureSaveError(err?.message || 'Failed to save figures.');
    } finally {
      setSavingFigures(false);
    }
  }, [
    exportableFigureLayers,
    figureFormat,
    figureLayerOverrides,
    figureFilenameStem,
    figureOutputFolder,
    figureSelectionExtent,
    selectedFigureLayerIds,
  ]);

  const handleSaveFiguresToDb = React.useCallback(async (featureInfo: { name: string; description: string; category: string }) => {
    setFiguresToDbError(null);
    setFiguresToDbMessage(null);
    if (!figureSelectionExtent) {
      setFiguresToDbError('Draw a rectangle first.');
      return;
    }
    const layersToUse = exportableFigureLayers
      .filter((layer) => selectedFigureLayerIds.includes(layer.id) || selectedFigureLayerIds.length === 0);
    if (layersToUse.length === 0) {
      setFiguresToDbError('No exportable layers found for image extraction.');
      return;
    }
    try {
      setSavingFiguresToDb(true);
      const response = await fetch(apiUrl('/saved-features/area-images'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: featureInfo.name,
          description: featureInfo.description || undefined,
          category: featureInfo.category || undefined,
          extent_3857: figureSelectionExtent,
          format: figureFormat === 'jpg' ? 'jpg' : 'png',
          layers: layersToUse.map((layer) => {
            const ovr = figureLayerOverrides[layer.id];
            const isDiversity = layer.layerSubType === 'diversity_indices';
            const cmap = ovr?.colormap !== undefined ? ovr.colormap : layer.colormap;
            const rmin = ovr?.rescaleMin !== undefined ? ovr.rescaleMin : layer.rescaleMin;
            const rmax = ovr?.rescaleMax !== undefined ? ovr.rescaleMax : layer.rescaleMax;
            const hasBands = ovr?.selectedBands && ovr.selectedBands.length > 0;
            return {
              layer_id: layer.id,
              name: layer.name,
              layer_type: layer.layerType,
              url: layer.url,
              rgb_bands: layer.rgbBands,
              colormap: cmap,
              rescale_min: rmin,
              rescale_max: rmax,
              bands: hasBands
                ? ovr!.selectedBands.map((bi) => ({
                    ...(isDiversity && ovr?.rescaleMin === undefined && ovr?.rescaleMax === undefined
                      ? {
                          rescale_min: getDiversityBandRange(bi)[0],
                          rescale_max: getDiversityBandRange(bi)[1],
                        }
                      : {
                          rescale_min: rmin,
                          rescale_max: rmax,
                        }),
                    band_index: bi,
                    band_name: layer.bandNames?.[bi - 1] ?? `Band ${bi}`,
                    colormap: cmap,
                  }))
                : undefined,
            };
          }),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data?.feature) {
        throw new Error(data?.error || `Failed to save area images (${response.status})`);
      }
      addSavedMapFeature(data.feature);
      const imageCount = Array.isArray(data.feature?.plot_data?.image_exports)
        ? data.feature.plot_data.image_exports.length
        : 0;
      setFiguresToDbMessage(`Saved area feature with ${imageCount} image(s) to database.`);
    } catch (err: any) {
      setFiguresToDbError(err?.message || 'Failed to save area images to database.');
    } finally {
      setSavingFiguresToDb(false);
    }
  }, [
    addSavedMapFeature,
    exportableFigureLayers,
    figureFormat,
    figureLayerOverrides,
    figureSelectionExtent,
    selectedFigureLayerIds,
  ]);

  return (
    <Sidebar
      onAddLayer={handleAddLayer}
      addedVsmLayers={addedVsmLayers}
      vsmYear={vsmYear}
      onVsmYearChange={setVsmYear}
      vsmRhIndex={vsmRhIndex}
      onVsmRhIndexChange={setVsmRhIndex}
      vsmQChoice={vsmQChoice}
      onVsmQChoiceChange={setVsmQChoice}
      drawingActive={drawingActive}
      drawingMode={drawingMode}
      onGetTiles={handleGetTiles}
      onCreateFiguresDraw={handleCreateFiguresDraw}
      onCreateDbFiguresDraw={handleCreateDbFiguresDraw}
      onSaveFiguresToDb={handleSaveFiguresToDb}
      savingFiguresToDb={savingFiguresToDb}
      figuresToDbMessage={figuresToDbMessage}
      figuresToDbError={figuresToDbError}
      selectedTiles={selectedTiles}
      figureSelectionReady={!!figureSelectionExtent}
      figureFormat={figureFormat}
      onFigureFormatChange={setFigureFormat}
      figureOutputFolder={figureOutputFolder}
      onFigureOutputFolderChange={setFigureOutputFolder}
      figureFilenameStem={figureFilenameStem}
      onFigureFilenameStemChange={setFigureFilenameStem}
      suggestedFigureFilenameStem={suggestedFigureFilenameStem}
      availableFigureLayers={exportableFigureLayers.map(({ id, name, bandNames, colormap, rescaleMin, rescaleMax, selectedBand }) => ({ id, name, bandNames, defaultColormap: colormap, defaultRescaleMin: rescaleMin, defaultRescaleMax: rescaleMax, defaultSelectedBand: selectedBand }))}
      selectedFigureLayerIds={selectedFigureLayerIds}
      onToggleFigureLayer={handleToggleFigureLayer}
      figureLayerOverrides={figureLayerOverrides}
      onUpdateFigureLayerOverride={handleUpdateFigureLayerOverride}
      onSaveFigures={handleSaveFigures}
      savingFigures={savingFigures}
      figureSaveMessage={figureSaveMessage}
      figureSaveError={figureSaveError}
      inspectMode={inspectMode}
      inspectKind={inspectKind}
      onInspectModeChange={handleInspectModeChange}
      onVerticalProfileClick={handleVerticalProfileClick}
      onVerticalProfileLineClick={handleVerticalProfileLineClick}
      savedMapFeatures={savedMapFeatures}
      savedFeaturesLoading={savedFeaturesLoading}
      savedFeaturesError={savedFeaturesError}
      onReloadSavedFeatures={handleReloadSavedFeatures}
      deletingSavedFeatureId={deletingSavedFeatureId}
      onDeleteSavedFeature={handleDeleteSavedFeature}
      onJumpToFeature={handleJumpToFeature}
      onUploadFile={handleUploadFile}
      uploadingFile={uploadingFile}
      onLoadForestNaturalnessData={handleLoadForestNaturalnessData}
    />
  );
} 
