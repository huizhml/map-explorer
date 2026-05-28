import { useEffect, useRef, useState } from 'react';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import WebGLTileLayer from 'ol/layer/WebGLTile';
import { fromLonLat, toLonLat } from 'ol/proj';
import OSM from 'ol/source/OSM';
import ScaleLine from 'ol/control/ScaleLine';
import { defaults as defaultControls } from 'ol/control/defaults';

const DEFAULT_CENTER = fromLonLat([0, 0]);
const DEFAULT_ZOOM = 2;

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

    const map = new Map({
      target: mapRef.current,
      controls: defaultControls().extend([
        new ScaleLine({
          units: 'metric',
          bar: true,
          steps: 4,
          text: true,
          minWidth: 120,
        }),
      ]),
      layers: [
        // Base layer should be a regular TileLayer
        new TileLayer({
          source: new OSM(),
        }),
      ],
      view: new View({
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
      }),
    });

    mapInstanceRef.current = map;
    onMapInit(map);

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.setTarget(undefined);
        mapInstanceRef.current = null;
      }
    };
  }, [onMapInit]);

  useEffect(() => {
    const container = mapRef.current;
    const map = mapInstanceRef.current;
    if (!container || !map) return;

    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    const handleContextMenu = async (e: MouseEvent) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const pixel: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
      const coord = map.getCoordinateFromPixel(pixel);
      if (!coord) return;
      const [lon, lat] = toLonLat(coord);
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
    <div
      ref={mapRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      }}
    >
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

export type { Map, WebGLTileLayer }; 