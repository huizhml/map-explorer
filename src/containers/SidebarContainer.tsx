import React from 'react';
import { Sidebar, PALETTES, type PaletteName } from '../components/Sidebar';
import GeoTIFF from 'ol/source/GeoTIFF';
import WebGLTile from 'ol/layer/WebGLTile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Style, Fill, Stroke, Circle as CircleStyle } from 'ol/style';
import { transformExtent } from 'ol/proj';
import { bbox as bboxStrategy } from 'ol/loadingstrategy';
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

      // Create style function
      const createFgbStyle = (options: StyleOptions, geometryType: string) => {
        return new Style({
          fill: new Fill({
            color: options.fillColor || '#ff000000',
          }),
          stroke: new Stroke({
            color: options.strokeColor || '#000000',
            width: options.strokeWidth || 2,
          }),
          image: geometryType === 'Point' ? new CircleStyle({
            radius: options.pointRadius || 5,
            fill: new Fill({
              color: options.fillColor || '#ff000000',
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

  // Auto-load FlatGeobuf once when map is ready
  React.useEffect(() => {
    if (map && !fgbLayer && !fgbLoading && !hasAutoLoadedFgb && fgbUrl) {
      setHasAutoLoadedFgb(true);
      void handleLoadFGB();
    }
  }, [map, fgbLayer, fgbLoading, hasAutoLoadedFgb, fgbUrl]);

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