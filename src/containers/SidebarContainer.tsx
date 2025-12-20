import React, { useState } from 'react';
import { Sidebar, PALETTES, type PaletteName } from '../components/Sidebar';
import GeoTIFF from 'ol/source/GeoTIFF';
import WebGLTile from 'ol/layer/WebGLTile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Style, Fill, Stroke, Circle as CircleStyle } from 'ol/style';
import type { Map, WebGLTileLayer } from '../components/Map';
import { transformExtent } from 'ol/proj';
import { bbox as bboxStrategy } from 'ol/loadingstrategy';
import { deserialize } from 'flatgeobuf/lib/mjs/ol';

const max = 500;

function createColorRamp(colors: string[]) {
  const stops = colors.map((color, i) => [i / (colors.length - 1) * max, color]).flat();
  return ['interpolate', ['linear'], ['band', 1], ...stops];
}

interface SidebarContainerProps {
  map: Map | null;
  cogLayer: WebGLTileLayer | null;
  setCogLayer: React.Dispatch<React.SetStateAction<WebGLTileLayer | null>>;
  fgbLayer: VectorLayer<VectorSource> | null;
  setFgbLayer: React.Dispatch<React.SetStateAction<VectorLayer<VectorSource> | null>>;
  setFgbInfo: React.Dispatch<React.SetStateAction<any>>;
  setFgbStyleOptions: React.Dispatch<React.SetStateAction<any>>;
  setConditionalStyles: React.Dispatch<React.SetStateAction<any[]>>;
  setEnableConditionalRendering: React.Dispatch<React.SetStateAction<boolean>>;
}

interface FgbInfo {
  type: string;
  featureCount: number;
  geometryTypes: string[];
  properties: string[];
  sampleProperties: Record<string, any>;
}

interface StyleOptions {
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  pointRadius: number;
  opacity: number;
  zIndex: number;
}

interface ConditionalStyle {
  property: string;
  operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains' | 'starts_with';
  value: string | number;
  style: Partial<StyleOptions>;
}

export function SidebarContainer({ 
  map, 
  cogLayer, 
  setCogLayer, 
  fgbLayer,
  setFgbLayer,
  setFgbInfo: setFgbInfoProp,
  setFgbStyleOptions: setFgbStyleOptionsProp,
  setConditionalStyles: setConditionalStylesProp,
  setEnableConditionalRendering: setEnableConditionalRenderingProp,
}: SidebarContainerProps) {
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const [opacity, setOpacity] = useState(0.7);
  const [visible, setVisible] = useState(true);
  const [palette, setPalette] = useState<PaletteName>('Viridis');
  const [hasAutoLoadedFgb, setHasAutoLoadedFgb] = React.useState(false);
  
  // FlatGeobuf state
  const [fgbUrl, setFgbUrl] = useState('https://sid.erda.dk/share_redirect/GuGVefn81j/deploy_status.fgb');
  const [fgbLoading, setFgbLoading] = useState(false);
  const [fgbError, setFgbError] = useState<string | null>(null);
  const [fgbInfo, setFgbInfo] = useState<FgbInfo | null>(null);
  const [fgbStyleOptions, setFgbStyleOptions] = useState<StyleOptions>({
    fillColor: '#ff0000', // Red in 6-char hex format (HTML color input compatible)
    strokeColor: '#000000',
    strokeWidth: 2,
    pointRadius: 5,
    opacity: 0.7,
    zIndex: 100
  });
  const [conditionalStyles, setConditionalStyles] = useState<ConditionalStyle[]>([]);
  const [enableConditionalRendering, setEnableConditionalRendering] = useState(false);

  // Sync state to parent
  React.useEffect(() => {
    setFgbInfoProp(fgbInfo);
  }, [fgbInfo, setFgbInfoProp]);
  
  React.useEffect(() => {
    setFgbStyleOptionsProp(fgbStyleOptions);
  }, [fgbStyleOptions, setFgbStyleOptionsProp]);

  React.useEffect(() => {
    setConditionalStylesProp(conditionalStyles);
  }, [conditionalStyles, setConditionalStylesProp]);

  React.useEffect(() => {
    setEnableConditionalRenderingProp(enableConditionalRendering);
  }, [enableConditionalRendering, setEnableConditionalRenderingProp]);

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
        opacity: opacity,
        visible: visible,
        extent: extent,
        style: {
          variables: {
            max: max,
            nodata: 32767,
          },
          color: samples >= 3 ? undefined : createColorRamp(PALETTES[palette])
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

  const handleRemoveLayer = () => {
    if (cogLayer && map) {
      map.removeLayer(cogLayer);
      setCogLayer(null);
      setCurrentFileName(null);
    }
  };

  const handleOpacityChange = (value: number) => {
    setOpacity(value);
    if (cogLayer) {
      cogLayer.setOpacity(value);
    }
  };

  const handleVisibilityChange = (value: boolean) => {
    setVisible(value);
    if (cogLayer) {
      cogLayer.setVisible(value);
    }
  };

  const handlePaletteChange = (value: PaletteName) => {
    setPalette(value);
    if (cogLayer) {
      cogLayer.setStyle({
        variables: {
          max: max,
          nodata: 32767,
        },
        color: createColorRamp(PALETTES[value])
      });
    }
  };

  // FlatGeobuf handlers - handleFGBUrlChange is already defined below

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

      // Create style function
      const createFgbStyle = (options: StyleOptions, geometryType: string) => {
        return new Style({
          fill: new Fill({
            color: options.fillColor || 'rgba(255, 0, 0, 0.4)',
          }),
          stroke: new Stroke({
            color: options.strokeColor || '#000000',
            width: options.strokeWidth || 2,
          }),
          image: geometryType === 'Point' ? new CircleStyle({
            radius: options.pointRadius || 5,
            fill: new Fill({
              color: options.fillColor || 'rgba(255, 0, 0, 0.5)',
            }),
            stroke: new Stroke({
              color: options.strokeColor || '#000000',
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
          return createFgbStyle(fgbStyleOptions, geometryType);
        },
        opacity: fgbStyleOptions.opacity || 0.7,
        zIndex: fgbStyleOptions.zIndex || 100,
      });

      // Add layer to map
      map.addLayer(newVectorLayer);
      console.log(`FlatGeobuf layer added with zIndex: ${fgbStyleOptions.zIndex}`);
      setFgbLayer(newVectorLayer);

      // Try to get extent and info from source (may need to wait for features to load)
      source.once('featuresloadend', () => {
        try {
          const extent = source.getExtent();
          const features = source.getFeatures();
          
          // Extract properties from first few features
          const properties = new Set<string>();
          const geometryTypes = new Set<string>();
          const sampleProperties: Record<string, any> = {};
          
          features.slice(0, 10).forEach(feature => {
            const geom = feature.getGeometry();
            if (geom) {
              geometryTypes.add(geom.getType());
            }
            const props = feature.getProperties();
            Object.keys(props).forEach(key => {
              if (key !== 'geometry') {
                properties.add(key);
                if (!sampleProperties[key]) {
                  sampleProperties[key] = props[key];
                }
              }
            });
          });
          
          const info: FgbInfo = {
            type: 'FeatureCollection',
            featureCount: features.length,
            geometryTypes: Array.from(geometryTypes),
            properties: Array.from(properties),
            sampleProperties: sampleProperties
          };
          
          setFgbInfo(info);
          
          if (extent && extent.length === 4) {
            console.log('FlatGeobuf loaded with extent:', extent);
            // Optionally fit map to extent
            map.getView().fit(extent, { padding: [50, 50, 50, 50] });
          }
        } catch (e) {
          console.debug('Could not get extent from FlatGeobuf source:', e);
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

  const handleFGBStyleChange = (property: keyof StyleOptions, value: any) => {
    // Normalize color values to 6-character hex format (HTML color input compatible)
    let normalizedValue = value;
    if ((property === 'fillColor' || property === 'strokeColor') && typeof value === 'string') {
      // If it's an 8-character hex (with alpha), remove the alpha channel
      if (value.length === 9 && value.startsWith('#')) {
        normalizedValue = value.slice(0, 7); // Keep #rrggbb
      }
      // Ensure it's a valid 6-character hex
      if (value.length === 7 && value.startsWith('#')) {
        normalizedValue = value; // Already correct
      }
    }
    
    const updated = { ...fgbStyleOptions, [property]: normalizedValue };
    setFgbStyleOptions(updated);
    
    // Update the layer's style if it exists
    if (fgbLayer) {
      // Update zIndex if it changed
      if (property === 'zIndex') {
        fgbLayer.setZIndex(updated.zIndex);
      }
      
      // Update opacity if it changed
      if (property === 'opacity') {
        fgbLayer.setOpacity(updated.opacity);
      }
      
      // Update style function
      fgbLayer.setStyle((feature) => {
        const geometry = feature.getGeometry();
        if (!geometry) return undefined;
        const geometryType = geometry.getType();
        
        // Check conditional styles first
        if (enableConditionalRendering && conditionalStyles.length > 0) {
          const properties = feature.getProperties();
          
          for (const conditionalStyle of conditionalStyles) {
            const propertyValue = properties[conditionalStyle.property];
            let matches = false;
            
            switch (conditionalStyle.operator) {
              case 'equals':
                matches = propertyValue === conditionalStyle.value;
                break;
              case 'not_equals':
                matches = propertyValue !== conditionalStyle.value;
                break;
              case 'greater_than':
                matches = Number(propertyValue) > Number(conditionalStyle.value);
                break;
              case 'less_than':
                matches = Number(propertyValue) < Number(conditionalStyle.value);
                break;
              case 'contains':
                matches = String(propertyValue).toLowerCase().includes(String(conditionalStyle.value).toLowerCase());
                break;
              case 'starts_with':
                matches = String(propertyValue).toLowerCase().startsWith(String(conditionalStyle.value).toLowerCase());
                break;
            }
            
            if (matches) {
              // Apply conditional style
              const style = { ...updated, ...conditionalStyle.style };
              return createStyleFromOptions(style, geometryType);
            }
          }
        }
        
        // Default style
        return createStyleFromOptions(updated, geometryType);
      });
    }
  };

  const createStyleFromOptions = (options: StyleOptions, geometryType: string) => {
    const hexToRgba = (hex: string, alpha: number, forceTransparent: boolean = false) => {
      // Handle transparent color - always use alpha 0
      if (hex === 'transparent' || forceTransparent) {
        return 'rgba(0, 0, 0, 0)';
      }
      // Handle both 6-char (#rrggbb) and 8-char (#rrggbbaa) hex formats
      // For 8-char, ignore the alpha channel and use the provided alpha parameter
      const hexClean = hex.length === 9 ? hex.slice(0, 7) : hex; // Remove alpha if present
      const r = parseInt(hexClean.slice(1, 3), 16);
      const g = parseInt(hexClean.slice(3, 5), 16);
      const b = parseInt(hexClean.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    
    // Normalize fill color to 6-char hex format (remove alpha if present)
    const normalizedFillColor = options.fillColor.length === 9 
      ? options.fillColor.slice(0, 7) 
      : options.fillColor;

    const baseStyle: any = {
      fill: new Fill({
        color: hexToRgba(normalizedFillColor, options.opacity, false)
      }),
      stroke: new Stroke({
        color: options.strokeColor,
        width: options.strokeWidth
      })
    };

    if (geometryType === 'Point' || geometryType === 'MultiPoint') {
      baseStyle.image = new CircleStyle({
        radius: options.pointRadius,
        fill: new Fill({
          color: hexToRgba(normalizedFillColor, options.opacity, false)
        }),
        stroke: new Stroke({
          color: options.strokeColor,
          width: options.strokeWidth
        })
      });
    }

    return new Style(baseStyle);
  };

  // Auto-load FlatGeobuf once when map is ready
  React.useEffect(() => {
    if (map && !fgbLayer && !fgbLoading && !hasAutoLoadedFgb && fgbUrl) {
      setHasAutoLoadedFgb(true);
      void handleLoadFGB();
    }
  }, [map, fgbLayer, fgbLoading, hasAutoLoadedFgb, fgbUrl]);

  const handleAddConditionalStyle = () => {
    const newStyle: ConditionalStyle = {
      property: '',
      operator: 'equals',
      value: '',
      style: {
        fillColor: '#00ff00',
        strokeColor: '#000000',
        strokeWidth: 2,
        pointRadius: 5,
        opacity: 0.8
      }
    };
    setConditionalStyles([...conditionalStyles, newStyle]);
  };

  const handleUpdateConditionalStyle = (index: number, field: keyof ConditionalStyle, value: any) => {
    const updated = [...conditionalStyles];
    updated[index] = { ...updated[index], [field]: value };
    setConditionalStyles(updated);
    
    // Update the layer's style function to reflect the new conditional styles
    if (fgbLayer) {
      fgbLayer.setStyle((feature) => {
        const geometry = feature.getGeometry();
        if (!geometry) return undefined;
        const geometryType = geometry.getType();
        
        // Check conditional styles first
        if (enableConditionalRendering && updated.length > 0) {
          const properties = feature.getProperties();
          
          for (const conditionalStyle of updated) {
            const propertyValue = properties[conditionalStyle.property];
            let matches = false;
            
            switch (conditionalStyle.operator) {
              case 'equals':
                matches = propertyValue === conditionalStyle.value;
                break;
              case 'not_equals':
                matches = propertyValue !== conditionalStyle.value;
                break;
              case 'greater_than':
                matches = Number(propertyValue) > Number(conditionalStyle.value);
                break;
              case 'less_than':
                matches = Number(propertyValue) < Number(conditionalStyle.value);
                break;
              case 'contains':
                matches = String(propertyValue).toLowerCase().includes(String(conditionalStyle.value).toLowerCase());
                break;
              case 'starts_with':
                matches = String(propertyValue).toLowerCase().startsWith(String(conditionalStyle.value).toLowerCase());
                break;
            }
            
            if (matches) {
              // Apply conditional style
              const style = { ...fgbStyleOptions, ...conditionalStyle.style };
              return createStyleFromOptions(style, geometryType);
            }
          }
        }
        
        // Default style
        return createStyleFromOptions(fgbStyleOptions, geometryType);
      });
    }
  };

  const handleRemoveConditionalStyle = (index: number) => {
    const updated = conditionalStyles.filter((_, i) => i !== index);
    setConditionalStyles(updated);
    
    // Update the layer's style function to reflect the updated conditional styles
    if (fgbLayer) {
      fgbLayer.setStyle((feature) => {
        const geometry = feature.getGeometry();
        if (!geometry) return undefined;
        const geometryType = geometry.getType();
        
        // Check conditional styles first
        if (enableConditionalRendering && updated.length > 0) {
          const properties = feature.getProperties();
          
          for (const conditionalStyle of updated) {
            const propertyValue = properties[conditionalStyle.property];
            let matches = false;
            
            switch (conditionalStyle.operator) {
              case 'equals':
                matches = propertyValue === conditionalStyle.value;
                break;
              case 'not_equals':
                matches = propertyValue !== conditionalStyle.value;
                break;
              case 'greater_than':
                matches = Number(propertyValue) > Number(conditionalStyle.value);
                break;
              case 'less_than':
                matches = Number(propertyValue) < Number(conditionalStyle.value);
                break;
              case 'contains':
                matches = String(propertyValue).toLowerCase().includes(String(conditionalStyle.value).toLowerCase());
                break;
              case 'starts_with':
                matches = String(propertyValue).toLowerCase().startsWith(String(conditionalStyle.value).toLowerCase());
                break;
            }
            
            if (matches) {
              // Apply conditional style
              const style = { ...fgbStyleOptions, ...conditionalStyle.style };
              return createStyleFromOptions(style, geometryType);
            }
          }
        }
        
        // Default style
        return createStyleFromOptions(fgbStyleOptions, geometryType);
      });
    }
  };

  const handleEnableConditionalRendering = (enabled: boolean) => {
    setEnableConditionalRendering(enabled);
    
    // Update the layer's style function when conditional rendering is toggled
    if (fgbLayer) {
      fgbLayer.setStyle((feature) => {
        const geometry = feature.getGeometry();
        if (!geometry) return undefined;
        const geometryType = geometry.getType();
        
        // Check conditional styles first
        if (enabled && conditionalStyles.length > 0) {
          const properties = feature.getProperties();
          
          for (const conditionalStyle of conditionalStyles) {
            const propertyValue = properties[conditionalStyle.property];
            let matches = false;
            
            switch (conditionalStyle.operator) {
              case 'equals':
                matches = propertyValue === conditionalStyle.value;
                break;
              case 'not_equals':
                matches = propertyValue !== conditionalStyle.value;
                break;
              case 'greater_than':
                matches = Number(propertyValue) > Number(conditionalStyle.value);
                break;
              case 'less_than':
                matches = Number(propertyValue) < Number(conditionalStyle.value);
                break;
              case 'contains':
                matches = String(propertyValue).toLowerCase().includes(String(conditionalStyle.value).toLowerCase());
                break;
              case 'starts_with':
                matches = String(propertyValue).toLowerCase().startsWith(String(conditionalStyle.value).toLowerCase());
                break;
            }
            
            if (matches) {
              // Apply conditional style
              const style = { ...fgbStyleOptions, ...conditionalStyle.style };
              return createStyleFromOptions(style, geometryType);
            }
          }
        }
        
        // Default style
        return createStyleFromOptions(fgbStyleOptions, geometryType);
      });
    }
  };

  return (
    <Sidebar
      onFileChange={handleFileChange}
      currentFileName={currentFileName}
      onRemoveLayer={handleRemoveLayer}
      opacity={opacity}
      onOpacityChange={handleOpacityChange}
      visible={visible}
      onVisibilityChange={handleVisibilityChange}
      palette={palette}
      onPaletteChange={handlePaletteChange}
      fgbUrl={fgbUrl}
      onFGBUrlChange={handleFGBUrlChange}
      onLoadFGB={handleLoadFGB}
      onRemoveFGBLayer={handleRemoveFGBLayer}
      fgbLoading={fgbLoading}
      fgbError={fgbError}
      fgbInfo={fgbInfo}
      fgbStyleOptions={fgbStyleOptions}
      onFGBStyleChange={handleFGBStyleChange}
      conditionalStyles={conditionalStyles}
      enableConditionalRendering={enableConditionalRendering}
      onEnableConditionalRendering={handleEnableConditionalRendering}
      onAddConditionalStyle={handleAddConditionalStyle}
      onUpdateConditionalStyle={handleUpdateConditionalStyle}
      onRemoveConditionalStyle={handleRemoveConditionalStyle}
    />
  );
} 