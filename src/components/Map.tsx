import { useEffect, useRef, useState } from 'react';
import { Map as MlMap, ScaleControl, type Map } from 'maplibre-gl';
import { BASEMAP_ID, basemapSource } from '../map/basemaps';

const DEFAULT_CENTER: [number, number] = [0, 0];
/** MapLibre zoom — OpenLayers' 2, one level lower on a 512 px world. */
const DEFAULT_ZOOM = 1;

interface MapComponentProps {
  onMapInit: (map: Map) => void;
}

interface CopyToast {
  x: number;
  y: number;
  text: string;
}

export function MapComponent({ onMapInit }: MapComponentProps) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<Map | null>(null);
  const [copyToast, setCopyToast] = useState<CopyToast | null>(null);

  useEffect(() => {
    if (mapInstanceRef.current || !mapRef.current) return;

    const map = new MlMap({
      container: mapRef.current,
      style: {
        version: 8,
        // For labels drawn on the canvas (tile names, cluster counts).
        // OpenFreeMap's fonts: free, no key, CORS open.
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sources: { [BASEMAP_ID]: basemapSource('osm') },
        layers: [
          { id: 'blank', type: 'background', paint: { 'background-color': '#ffffff' } },
          { id: BASEMAP_ID, type: 'raster', source: BASEMAP_ID },
        ],
      },
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: { compact: true },
      // Rotation and tilt are not something any tool here uses, and a rotated
      // map breaks the extents the sidebar works with.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new ScaleControl({ unit: 'metric', maxWidth: 120 }), 'bottom-left');

    mapInstanceRef.current = map;
    map.once('load', () => {
      if (mapInstanceRef.current === map) onMapInit(map);
    });

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [onMapInit]);

  useEffect(() => {
    const container = mapRef.current;
    if (!container) return;

    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    const handleContextMenu = async (e: MouseEvent) => {
      const map = mapInstanceRef.current;
      if (!map) return;
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const pixel: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
      const { lng: lon, lat } = map.unproject(pixel);
      const text = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
      let label = `Copied ${text}`;
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.warn('Copy coordinates failed', err);
        label = text;
      }
      setCopyToast({ x: pixel[0], y: pixel[1], text: label });
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => setCopyToast(null), 1500);
    };

    container.addEventListener('contextmenu', handleContextMenu);
    return () => {
      container.removeEventListener('contextmenu', handleContextMenu);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
      {/* The map gets a container of its own: MapLibre manages its children,
          and React should not be adding the toast among them. */}
      <div ref={mapRef} style={{ position: 'absolute', inset: 0 }} />
      {copyToast && (
        <div
          style={{
            position: 'absolute',
            left: copyToast.x + 12,
            top: copyToast.y + 12,
            background: 'rgba(0, 0, 0, 0.78)',
            color: '#fff',
            padding: '4px 8px',
            borderRadius: 4,
            fontSize: 12,
            fontFamily: 'monospace',
            pointerEvents: 'none',
            zIndex: 1000,
            whiteSpace: 'nowrap',
          }}
        >
          {copyToast.text}
        </div>
      )}
    </div>
  );
}

export type { Map };
