import React from 'react';
import { Sidebar, PALETTES, type PaletteName } from '../components/Sidebar';
import GeoTIFF from 'ol/source/GeoTIFF';
import WebGLTile from 'ol/layer/WebGLTile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Style, Fill, Stroke, Circle as CircleStyle } from 'ol/style';
import { transformExtent } from 'ol/proj';
import { bbox as bboxStrategy } from 'ol/loadingstrategy';
import { unByKey } from 'ol/Observable';
import { deserialize } from 'flatgeobuf/lib/mjs/ol';
import { useMapStore, type FgbInfo, type StyleOptions } from '../stores/mapStore';

const max = 500;

function createColorRamp(colors: string[]) {
  const stops = colors.map((color, i) => [i / (colors.length - 1) * max, color]).flat();
  return ['interpolate', ['linear'], ['band', 1], ...stops];
}

export function SidebarContainer() {
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
  const handleLoadFGB = async () => {
    if (!fgbUrl.trim() || !map) return;

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
      let fgbFileUrl = fgbUrl;
      const isCrossOriginUrl = isCrossOrigin(fgbUrl);
      
      if (isCrossOriginUrl) {
        // Use the backend proxy endpoint for FlatGeobuf files
        fgbFileUrl = `http://localhost:8000/fgb/proxy?url=${encodeURIComponent(fgbUrl)}`;
        console.log('Cross-origin FlatGeobuf detected, using proxy:', {
          original: fgbUrl,
          proxy: fgbFileUrl
        });
      } else {
        console.log('Same-origin FlatGeobuf, using direct URL:', fgbFileUrl);
      }

      // Create FlatGeobuf vector source with bbox strategy
      const source = new VectorSource({
        strategy: bboxStrategy,
        loader: async function (extent, _resolution, projection) {
          const sourceInstance = this as VectorSource;
          try {
            // Convert extent array [minX, minY, maxX, maxY] to Rect object
            // Extent is in the map projection (usually EPSG:3857)
            // Transform to EPSG:4326 for FlatGeobuf (which uses WGS84)
            const extent4326 = transformExtent(extent, projection, 'EPSG:4326');
            const rect = {
              minX: extent4326[0],
              minY: extent4326[1],
              maxX: extent4326[2],
              maxY: extent4326[3]
            };
            
            // The deserialize function only downloads bytes needed for the current extent
            // Pass dataProjection='EPSG:4326' and featureProjection=projection code for automatic transformation
            const projectionCode = projection.getCode();
            const iter = deserialize(fgbFileUrl, rect, undefined, false, {}, false, 'EPSG:4326', projectionCode);
            
            for await (const feature of iter) {
              // Features are already transformed by deserialize based on dataProjection and featureProjection
              // addFeature accepts FeatureLike (which includes both Feature and RenderFeature)
              // Type assertion needed because TypeScript doesn't recognize FeatureLike as valid
              sourceInstance.addFeature(feature as any);
            }
          } catch (error) {
            console.error('Error loading FlatGeobuf features:', error);
            setFgbError(`Failed to load features: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      });

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

      // Helper function to convert hex color to rgba format for OpenLayers
      const hexToRgba = (hex: string): string | null => {
        if (!hex) return null;
        // Handle 8-digit hex with alpha (#rrggbbaa)
        if (hex.length === 9 && hex.startsWith('#')) {
          const r = parseInt(hex.substring(1, 3), 16);
          const g = parseInt(hex.substring(3, 5), 16);
          const b = parseInt(hex.substring(5, 7), 16);
          const a = parseInt(hex.substring(7, 9), 16) / 255;
          return `rgba(${r}, ${g}, ${b}, ${a})`;
        }
        // Handle 6-digit hex (add full opacity)
        if (hex.length === 7 && hex.startsWith('#')) {
          const r = parseInt(hex.substring(1, 3), 16);
          const g = parseInt(hex.substring(3, 5), 16);
          const b = parseInt(hex.substring(5, 7), 16);
          return `rgba(${r}, ${g}, ${b}, 1)`;
        }
        return hex; // Return as-is if already in rgba format
      };

      // Create style function
      const createFgbStyle = (options: StyleOptions, geometryType: string) => {
        const fillColor = hexToRgba(options.fillColor || '#ff000000');
        const strokeColor = hexToRgba(options.strokeColor || '#000000');
        
        // If fill is fully transparent, set fill to undefined
        const fill = fillColor && fillColor.includes('rgba') && fillColor.endsWith(', 0)') 
          ? undefined 
          : new Fill({ color: fillColor || 'transparent' });
        
        return new Style({
          fill: fill,
          stroke: new Stroke({
            color: strokeColor || '#000000',
            width: options.strokeWidth || 2,
          }),
          image: geometryType === 'Point' ? new CircleStyle({
            radius: options.pointRadius || 5,
            fill: fill,
            stroke: new Stroke({
              color: strokeColor || '#000000',
              width: options.strokeWidth || 2,
            }),
          }) : undefined,
        });
      };

      // Create vector layer with FlatGeobuf source
      const newVectorLayer = new VectorLayer({
        source: source,
        style: (feature) => {
          const geometry = feature.getGeometry();
          if (!geometry) return undefined;
          const geometryType = geometry.getType();
          const styleOptions = getFeatureStyle(feature);
          return createFgbStyle(styleOptions, geometryType);
        },
        opacity: fgbStyleOptions.opacity || 0.7,
        zIndex: fgbStyleOptions.zIndex || 100,
      });

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
              }
            });
          });
          
          const info: FgbInfo = {
            type: 'FeatureCollection',
            featureCount: features.length,
            geometryTypes: Array.from(geometryTypes),
            properties: Array.from(properties).sort(), // Sort for better UX
            sampleProperties: sampleProperties
          };
          
          // Only log if properties changed or it's the first extraction
          const propertiesChanged = !existingInfo || 
            existingInfo.properties.length !== properties.size ||
            !existingInfo.properties.every(p => properties.has(p));
          
          if (propertiesChanged || !updateExisting) {
            console.log('Extracted FGB info:', info, `(${properties.size} properties found)`);
          }
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

    // Helper function to convert hex color to rgba format for OpenLayers
    const hexToRgba = (hex: string): string | null => {
      if (!hex) return null;
      // Handle 8-digit hex with alpha (#rrggbbaa)
      if (hex.length === 9 && hex.startsWith('#')) {
        const r = parseInt(hex.substring(1, 3), 16);
        const g = parseInt(hex.substring(3, 5), 16);
        const b = parseInt(hex.substring(5, 7), 16);
        const a = parseInt(hex.substring(7, 9), 16) / 255;
        return `rgba(${r}, ${g}, ${b}, ${a})`;
      }
      // Handle 6-digit hex (add full opacity)
      if (hex.length === 7 && hex.startsWith('#')) {
        const r = parseInt(hex.substring(1, 3), 16);
        const g = parseInt(hex.substring(3, 5), 16);
        const b = parseInt(hex.substring(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, 1)`;
      }
      return hex; // Return as-is if already in rgba format
    };

    // Create style function
    const createFgbStyle = (options: StyleOptions, geometryType: string) => {
      const fillColor = hexToRgba(options.fillColor || '#ff000000');
      const strokeColor = hexToRgba(options.strokeColor || '#000000');
      
      // If fill is fully transparent, set fill to undefined
      const fill = fillColor && fillColor.includes('rgba') && fillColor.endsWith(', 0)') 
        ? undefined 
        : new Fill({ color: fillColor || 'transparent' });
      
      return new Style({
        fill: fill,
        stroke: new Stroke({
          color: strokeColor || '#000000',
          width: options.strokeWidth || 2,
        }),
        image: geometryType === 'Point' ? new CircleStyle({
          radius: options.pointRadius || 5,
          fill: fill,
          stroke: new Stroke({
            color: strokeColor || '#000000',
            width: options.strokeWidth || 2,
          }),
        }) : undefined,
      });
    };

    // Update the layer's style function
    fgbLayer.setStyle((feature) => {
      const geometry = feature.getGeometry();
      if (!geometry) return undefined;
      const geometryType = geometry.getType();
      const styleOptions = getFeatureStyle(feature);
      return createFgbStyle(styleOptions, geometryType);
    });

    // Trigger a redraw
    fgbLayer.changed();
  }, [fgbLayer, enableConditionalRendering, conditionalStyles, fgbStyleOptions, map]);

  return (
    <Sidebar
      onFileChange={handleFileChange}
      fgbUrl={fgbUrl}
      onFGBUrlChange={handleFGBUrlChange}
      onLoadFGB={handleLoadFGB}
      onRemoveFGBLayer={handleRemoveFGBLayer}
      fgbLoading={fgbLoading}
      fgbError={fgbError}
    />
  );
} 