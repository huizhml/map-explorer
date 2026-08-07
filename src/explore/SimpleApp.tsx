import { useCallback, useEffect, useState } from 'react';
import type Map from 'ol/Map';
import TileLayer from 'ol/layer/Tile';
import OSM from 'ol/source/OSM';
import XYZ from 'ol/source/XYZ';
import { toLonLat } from 'ol/proj';

import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { deserialize } from 'flatgeobuf/lib/mjs/ol';

import { MapComponent } from '../components/Map';
import { LayerManager } from '../utils/LayerManager';
import { useMapStore } from '../stores/mapStore';
import { API_BASE_URL } from '../utils/apiBase';
import { useAutoLoadVSM } from '../hooks/useAutoLoadVSM';
import { inspectPointAtLonLat, type InspectLayerRow } from '../utils/inspectPoint';
import {
  DEFAULT_VSM_VERSION,
  getVsmLayerId,
  type VsmLayerEntry,
  type VsmQChoice,
} from '../constants/predictions';
import { SimpleControls, type BasemapId } from './SimpleControls';
import { BasemapControl } from './BasemapControl';
import { RhProfileChart, VerticalProfileChart } from './ProfileCharts';
import { fetchVerticalProfile, type VerticalProfileResponse } from '../utils/verticalProfile';
import './explore.css';

const SATELLITE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

type PointReading = {
  lon: number;
  lat: number;
  rows: InspectLayerRow[];
  loading: boolean;
  profile?: VerticalProfileResponse;
  profileLoading: boolean;
  profileError?: string;
};

/**
 * inspectPointAtLonLat stores TiTiler's whole /cog/point response as `value`
 * — `{ coordinates, values, band_names }` — not a bare number. Reading it as a
 * number yields undefined and renders as "no data" over perfectly good pixels.
 *
 * Values are int16 decimetres with 32767 as nodata.
 */
function formatHeight(value: unknown, rhIndex: number): string {
  if (!value || typeof value !== 'object') return 'no data';
  const values = (value as { values?: unknown }).values;
  if (!Array.isArray(values) || values.length === 0) return 'no data';
  const raw = values[0];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw >= 32767) return 'no data';
  return `RH${rhIndex} · ${(raw / 10).toFixed(1)} m`;
}

export default function SimpleApp() {
  const { map, setMap, layerManager, setLayerManager, setLayers, addVsmLayer, removeVsmLayerByLayerId } =
    useMapStore();

  const [rhIndex, setRhIndex] = useState(98);
  const [year, setYear] = useState<2020>(2020);
  const [qChoice, setQChoice] = useState<VsmQChoice>('median');
  const [visible, setVisible] = useState(true);
  const [basemap, setBasemap] = useState<BasemapId>('osm');
  const [reading, setReading] = useState<PointReading | null>(null);
  const [gridReady, setGridReady] = useState(false);
  const [gridError, setGridError] = useState(false);

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

  // Stop the world shrinking inside the viewport.
  //
  // Map.tsx is shared with the full app and sets no minZoom; that app gets away
  // with it because its sidebar leaves a narrower map pane. Here the pane is
  // wide enough that zoom 2 leaves the globe floating in empty space.
  //
  // The floor depends on the viewport, so it cannot be a constant: in EPSG:3857
  // the world is 256 px at zoom 0, so it fills a pane of W×H once zoom reaches
  // log2(max(W, H) / 256). Recomputed on resize.
  useEffect(() => {
    if (!map) return;

    const applyMinZoom = () => {
      const size = map.getSize();
      if (!size || !size[0] || !size[1]) return;
      const view = map.getView();
      const minZoom = Math.log2(Math.max(size[0], size[1]) / 256);
      view.setMinZoom(minZoom);
      const current = view.getZoom();
      if (current !== undefined && current < minZoom) view.setZoom(minZoom);
    };

    applyMinZoom();
    const observer = new ResizeObserver(applyMinZoom);
    const target = map.getTargetElement();
    if (target) observer.observe(target);
    return () => observer.disconnect();
  }, [map]);

  // The MGRS grid is not decoration here — useAutoLoadVSM reads the visible
  // tile names out of it (`getFeaturesInExtent` → `Name`) and returns early
  // when the set is empty. Without it nothing is ever requested above the
  // mosaic's zoom threshold, and the map just stays empty.
  //
  // Kept invisible: 18,181 tile outlines would be noise, and feature lookup
  // does not care about visibility.
  useEffect(() => {
    if (!map || useMapStore.getState().fgbLayer) return;
    let cancelled = false;

    (async () => {
      try {
        const resp = await fetch(`${API_BASE_URL}/fgb/local`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buffer = new Uint8Array(await resp.arrayBuffer());
        if (cancelled) return;

        const source = new VectorSource();
        const iter = deserialize(buffer, undefined, undefined, false, {}, false, 'EPSG:4326', 'EPSG:3857');
        for await (const feature of iter) source.addFeature(feature as any);
        if (cancelled) return;

        const layer = new VectorLayer({ source, visible: false, zIndex: 1 });
        map.addLayer(layer);
        useMapStore.getState().setFgbLayer(layer);
        setGridReady(true);
      } catch (err) {
        console.error('[explore] MGRS grid failed to load — no tiles will render', err);
        setGridError(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [map]);

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
      setReading({ lon, lat, rows: [], loading: true, profileLoading: true });

      // Two requests with very different costs, so they are issued separately
      // and rendered as they land: the pixel read is one COG open, while the
      // profile opens 101 of them and takes ~20 s. Waiting on both would make
      // the fast one feel as slow as the slow one.
      inspectPointAtLonLat(useMapStore.getState().layerManager, lon, lat).then((rows) =>
        setReading((prev) => (prev && prev.lon === lon && prev.lat === lat ? { ...prev, rows, loading: false } : prev)),
      );

      fetchVerticalProfile(lon, lat, year)
        .then((profile) =>
          setReading((prev) =>
            prev && prev.lon === lon && prev.lat === lat
              ? {
                  ...prev,
                  profileLoading: false,
                  profile: profile.success ? profile : undefined,
                  profileError: profile.success ? undefined : (profile.error ?? 'Profile unavailable'),
                }
              : prev,
          ),
        )
        .catch((err) =>
          setReading((prev) =>
            prev && prev.lon === lon && prev.lat === lat
              ? { ...prev, profileLoading: false, profileError: String(err) }
              : prev,
          ),
        );
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
      />

      <div className="ex-map">
        {/* Wrapper so the "fill the container" sizing rule applies to the
            OpenLayers canvas only. Applied to every direct child, it stretched
            the overlays to full size too. */}
        <div className="ex-map__canvas">
          <MapComponent onMapInit={handleMapInit} />
        </div>

        <BasemapControl value={basemap} onChange={setBasemap} />

        {/* The grid gates every tile request, so its state is worth surfacing
            rather than leaving the user staring at an empty map. */}
        {!gridReady && !gridError && (
          <div className="ex-status">Loading tile index…</div>
        )}
        {gridError && (
          <div className="ex-status ex-status--error">
            Tile index unavailable — layers cannot load
          </div>
        )}

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
                reading.rows.map((row) => (
                  <div key={row.id}>
                    {row.error ? `Error: ${row.error}` : formatHeight(row.value, rhIndex)}
                  </div>
                ))
              )}
            </div>

            <div className="ex-profile">
              {reading.profileLoading && (
                <p className="ex-profile__note">
                  Building profile… reads 101 layers, ~20 s
                </p>
              )}
              {reading.profileError && <p className="ex-profile__note">{reading.profileError}</p>}

              {reading.profile?.profile && reading.profile.profile.length > 0 && (
                <>
                  <div className="ex-profile__charts">
                    <figure>
                      <figcaption>RH profile</figcaption>
                      <RhProfileChart profile={reading.profile.profile} />
                    </figure>
                    {reading.profile.vertical_profile_curve &&
                      reading.profile.vertical_profile_curve.length > 1 && (
                        <figure>
                          <figcaption>Vertical profile</figcaption>
                          <VerticalProfileChart curve={reading.profile.vertical_profile_curve} />
                        </figure>
                      )}
                  </div>

                  <dl className="ex-profile__metrics">
                    {reading.profile.fhd != null && (
                      <div>
                        <dt title="Foliage height diversity">FHD</dt>
                        <dd>{reading.profile.fhd.toFixed(2)}</dd>
                      </div>
                    )}
                    {reading.profile.cr != null && (
                      <div>
                        <dt title="Canopy ratio">CR</dt>
                        <dd>{reading.profile.cr.toFixed(2)}</dd>
                      </div>
                    )}
                    {reading.profile.tile_name && (
                      <div>
                        <dt>Tile</dt>
                        <dd>{reading.profile.tile_name}</dd>
                      </div>
                    )}
                  </dl>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
