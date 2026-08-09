import { useCallback, useEffect, useRef, useState } from 'react';
import type Map from 'ol/Map';
import TileLayer from 'ol/layer/Tile';
import OSM from 'ol/source/OSM';
import XYZ from 'ol/source/XYZ';
import { toLonLat } from 'ol/proj';
import View from 'ol/View';

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
import { LayerControl, type ExploreLayer } from './LayerControl';
import { RhProfileChart, VerticalProfileChart } from './ProfileCharts';
import { RandomSite } from './RandomSite';
import { fetchVerticalProfile, type VerticalProfileResponse } from '../utils/verticalProfile';
import './explore.css';

/** EPSG:3857 bounds of the published mosaics: 82.8529°N .. −56.0371°S. */
const DATA_EXTENT_3857 = [-20037508.34, -7565801.1, 20037508.34, 17688947.9];

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
  // setLayers aliased: the local layer list owns that name here.
  const { map, setMap, layerManager, setLayerManager, setLayers: setStoreLayers, addVsmLayer, removeVsmLayerByLayerId } =
    useMapStore();

  // Fixed: only the median quantile is published, so there is nothing to pick.
  const qChoice: VsmQChoice = 'median';

  // A list rather than a single layer, so pinning can hold one in place while
  // the sidebar moves on to another RH.
  const [layers, setLayers] = useState<ExploreLayer[]>([
    { id: 'l0', rhIndex: 98, year: 2020, visible: true, pinned: false, opacity: 1 },
  ]);
  const [activeId, setActiveId] = useState<string | null>('l0');
  const nextId = useRef(1);

  const active = layers.find((l) => l.id === activeId) ?? layers[layers.length - 1] ?? null;
  const rhIndex = active?.rhIndex ?? 98;
  const year = (active?.year ?? 2020) as 2020;

  /**
   * Editing the active layer. A pinned layer is left alone and a new layer is
   * added in front of it — that is what pinning means here.
   */
  const editActive = useCallback((patch: Partial<ExploreLayer>) => {
    setLayers((prev) => {
      const i = prev.findIndex((l) => l.id === activeId);
      if (i < 0) return prev;
      if (!prev[i].pinned) {
        const copy = [...prev];
        copy[i] = { ...copy[i], ...patch };
        return copy;
      }
      const id = `l${nextId.current++}`;
      setActiveId(id);
      return [...prev, { ...prev[i], ...patch, id, pinned: false }];
    });
  }, [activeId]);

  const setRhIndex = useCallback((rh: number) => editActive({ rhIndex: rh }), [editActive]);
  const setYear = useCallback((y: 2020) => editActive({ year: y }), [editActive]);
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
    setStoreLayers(
      mgr.getAllLayers().map((l: any) => ({
        id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
        zIndex: l.zIndex, type: l.type, metadata: l.metadata,
      })),
    );
  }, [setStoreLayers]);

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

  // Keep the viewport inside the data, not inside the world.
  //
  // The mosaic covers 82.85°N to 56.04°S — 63% of the Web Mercator square — so
  // simply flooring the zoom still leaves a blank band along the bottom where
  // there is imagery in the basemap but no prediction. Constraining the view to
  // the data extent instead means the furthest zoom-out is the one where that
  // extent covers the pane, and panning cannot leave it.
  //
  // Map.tsx builds the view without an extent and is shared with the full app,
  // so the view is replaced here rather than changed there.
  useEffect(() => {
    if (!map) return;

    const view = map.getView();
    if (view.get('exploreConstrained')) return;

    const previousCenter = view.getCenter();
    const previousZoom = view.getZoom();

    const constrained = new View({
      // EPSG:3857 bounds of the published mosaics.
      extent: DATA_EXTENT_3857,
      // Default (false) keeps the whole viewport inside the extent rather than
      // just the centre point — that is what removes the empty band.
      constrainOnlyCenter: false,
      // Left at the default (false) deliberately: enabling it would permit the
      // zoom level where the whole extent is visible, which reintroduces the
      // letterboxing this is meant to remove whenever the pane's aspect ratio
      // differs from the data's 1.59:1.
      center: previousCenter ?? [0, 0],
      zoom: previousZoom ?? 2,
    });
    constrained.set('exploreConstrained', true);
    map.setView(constrained);
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

  // Mirror the list into the store, which is what useAutoLoadVSM reads. Diffed
  // rather than cleared and refilled, so untouched layers keep their tiles
  // instead of being torn down and refetched on every change.
  useEffect(() => {
    const wanted = new Map(
      layers.map((l) => {
        const entry: VsmLayerEntry = {
          year: l.year as 2020,
          rhIndex: l.rhIndex,
          qChoice,
          version: DEFAULT_VSM_VERSION,
        };
        return [getVsmLayerId(entry), entry];
      }),
    );
    const present = new Set(
      useMapStore.getState().addedVsmLayers.map((e) => getVsmLayerId(e)),
    );

    for (const id of present) if (!wanted.has(id)) removeVsmLayerByLayerId(id);
    for (const [id, entry] of wanted) if (!present.has(id)) addVsmLayer(entry);
  }, [layers, qChoice, addVsmLayer, removeVsmLayerByLayerId]);

  // Visibility, applied per layer.
  useEffect(() => {
    if (!layerManager) return;
    for (const l of layers) {
      const entry: VsmLayerEntry = {
        year: l.year as 2020,
        rhIndex: l.rhIndex,
        qChoice,
        version: DEFAULT_VSM_VERSION,
      };
      const managed = layerManager.getLayer(getVsmLayerId(entry));
      if (managed?.layer) {
        managed.layer.setVisible(l.visible);
        managed.layer.setOpacity(l.opacity);
      }
    }
  }, [layers, layerManager, qChoice]);

  const toggleVisible = useCallback((id: string) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
  }, []);

  const togglePinned = useCallback((id: string) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, pinned: !l.pinned } : l)));
  }, []);

  const setOpacity = useCallback((id: string, opacity: number) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, opacity } : l)));
  }, []);

  const removeLayer = useCallback((id: string) => {
    setLayers((prev) => {
      const next = prev.filter((l) => l.id !== id);
      // Never leave the sidebar editing a layer that no longer exists.
      if (id === activeId) setActiveId(next.length ? next[next.length - 1].id : null);
      return next;
    });
  }, [activeId]);

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
      />

      <div className="ex-map">
        {/* Wrapper so the "fill the container" sizing rule applies to the
            OpenLayers canvas only. Applied to every direct child, it stretched
            the overlays to full size too. */}
        <div className="ex-map__canvas">
          <MapComponent onMapInit={handleMapInit} />
        </div>

        <LayerControl
          layers={layers}
          activeId={activeId}
          onToggleVisible={toggleVisible}
          onTogglePinned={togglePinned}
          onRemove={removeLayer}
          onOpacity={setOpacity}
        />
        <BasemapControl value={basemap} onChange={setBasemap} />
        <RandomSite map={map} />

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
