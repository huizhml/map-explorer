import { useEffect, useRef } from 'react';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import WebGLTileLayer from 'ol/layer/WebGLTile';
import { fromLonLat } from 'ol/proj';
import OSM from 'ol/source/OSM';

const DEFAULT_CENTER = fromLonLat([0, 0]);
const DEFAULT_ZOOM = 2;

interface MapComponentProps {
  onMapInit: (map: Map) => void;
}

export function MapComponent({ onMapInit }: MapComponentProps) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<Map | null>(null);

  useEffect(() => {
    if (mapInstanceRef.current || !mapRef.current) return;

    const map = new Map({
      target: mapRef.current,
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

  return (
    <div 
      ref={mapRef} 
      style={{
        position: 'absolute',
        top: 0,
        left: '320px',
        right: 0,
        bottom: 0,
      }}
    />
  );
}

export type { Map, WebGLTileLayer }; 