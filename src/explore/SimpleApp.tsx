import { useCallback, useEffect, useState } from 'react';
import type Map from 'ol/Map';
import TileLayer from 'ol/layer/Tile';
import OSM from 'ol/source/OSM';
import XYZ from 'ol/source/XYZ';
import { toLonLat } from 'ol/proj';

import { MapComponent } from '../components/Map';
import { LayerManager } from '../utils/LayerManager';
import { useMapStore } from '../stores/mapStore';
import { useAutoLoadVSM } from '../hooks/useAutoLoadVSM';
import { inspectPointAtLonLat, type InspectLayerRow } from '../utils/inspectPoint';
import {
  DEFAULT_VSM_VERSION,
  getVsmLayerId,
  type VsmLayerEntry,
  type VsmQChoice,
} from '../constants/predictions';
import { SimpleControls, type BasemapId } from './SimpleControls';
import './explore.css';

const SATELLITE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

type PointReading = { lon: number; lat: number; rows: InspectLayerRow[]; loading: boolean };

export default function SimpleApp() {
  const { map, setMap, layerManager, setLayerManager, setLayers, addVsmLayer, removeVsmLayerByLayerId } =
    useMapStore();

  const [rhIndex, setRhIndex] = useState(98);
  const [year, setYear] = useState<2020>(2020);
  const [qChoice, setQChoice] = useState<VsmQChoice>('median');
  const [visible, setVisible] = useState(true);
  const [basemap, setBasemap] = useState<BasemapId>('osm');
  const [reading, setReading] = useState<PointReading | null>(null);

  // Same wiring App.tsx uses — the auto-loader drives everything off the store,
  // so the simple page gets identical layer behaviour for free.
  const updateLayersList = useCallback(() => {
    const { map: m, layerManager: mgr } = useMapStore.getState();
    if (!m || !mgr) return;
    mgr.syncAllProperties();
    setLayers(
      mgr.getAllLayers().map((l: any) => ({
        id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
        zIndex: l.zIndex, type: l.type, metadata: l.metadata,
      })),
    );
  }, [setLayers]);

  useAutoLoadVSM(updateLayersList);

  const handleMapInit = useCallback(
    (instance: Map) => {
      setMap(instance);
      const mgr = useMapStore.getState().layerManager;
      if (mgr) mgr.setMap(instance);
      else setLayerManager(new LayerManager(instance));
    },
    [setMap, setLayerManager],
  );

  // One VSM layer at a time: swap the store entry whenever the selection
  // changes and let useAutoLoadVSM add/remove the actual OpenLayers layers.
  useEffect(() => {
    const entry: VsmLayerEntry = { year, rhIndex, qChoice, version: DEFAULT_VSM_VERSION };
    const id = getVsmLayerId(entry);
    const previous = useMapStore.getState().addedVsmLayers;
    for (const p of previous) {
      const pid = getVsmLayerId(p);
      if (pid !== id) removeVsmLayerByLayerId(pid);
    }
    if (!previous.some((p) => getVsmLayerId(p) === id)) addVsmLayer(entry);
  }, [year, rhIndex, qChoice, addVsmLayer, removeVsmLayerByLayerId]);

  // Layer visibility.
  useEffect(() => {
    if (!layerManager) return;
    const entry: VsmLayerEntry = { year, rhIndex, qChoice, version: DEFAULT_VSM_VERSION };
    const managed = layerManager.getLayer(getVsmLayerId(entry));
    if (managed?.layer) managed.layer.setVisible(visible);
  }, [visible, layerManager, year, rhIndex, qChoice]);

  // Basemap. Map.tsx puts the base tile layer at index 0.
  useEffect(() => {
    if (!map) return;
    const base = map.getLayers().item(0);
    if (!base) return;
    if (basemap === 'none') {
      base.setVisible(false);
      return;
    }
    base.setVisible(true);
    if (base instanceof TileLayer) {
      base.setSource(basemap === 'osm' ? new OSM() : new XYZ({ url: SATELLITE_URL, crossOrigin: 'anonymous' }));
    }
  }, [basemap, map]);

  // Click to read the value under the cursor.
  useEffect(() => {
    if (!map) return;
    const onClick = async (evt: any) => {
      const [lon, lat] = toLonLat(evt.coordinate);
      setReading({ lon, lat, rows: [], loading: true });
      // Reuses the same sampler the full app uses, so a value read here and a
      // value read there can never disagree.
      const rows = await inspectPointAtLonLat(useMapStore.getState().layerManager, lon, lat);
      setReading({ lon, lat, rows, loading: false });
    };
    map.on('singleclick', onClick);
    return () => map.un('singleclick', onClick);
  }, [map, year, rhIndex, qChoice]);

  return (
    <div className="ex-root">
      <SimpleControls
        rhIndex={rhIndex}
        onRhIndex={setRhIndex}
        year={year}
        onYear={setYear}
        qChoice={qChoice}
        onQChoice={setQChoice}
        visible={visible}
        onVisible={setVisible}
        basemap={basemap}
        onBasemap={setBasemap}
      />

      <div className="ex-map">
        <MapComponent onMapInit={handleMapInit} />

        {reading && (
          <div className="ex-reading">
            <button className="ex-reading__close" onClick={() => setReading(null)} aria-label="Close">
              ×
            </button>
            <div className="ex-reading__coords">
              {reading.lat.toFixed(5)}, {reading.lon.toFixed(5)}
            </div>
            <div className="ex-reading__value">
              {reading.loading ? (
                'Reading…'
              ) : reading.rows.length === 0 ? (
                'No layer to sample'
              ) : (
                reading.rows.map((row) => {
                  // Values are stored in decimetres; report metres.
                  const v = typeof row.value === 'number' ? row.value : null;
                  return (
                    <div key={row.id}>
                      {row.error ? `${row.name}: ${row.error}`
                        : v === null ? `${row.name}: no data`
                        : `RH${rhIndex} · ${(v / 10).toFixed(1)} m`}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
