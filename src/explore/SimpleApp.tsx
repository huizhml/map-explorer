import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Map as MlMap,
  ScaleControl,
  type MapMouseEvent,
  type RasterTileSource,
  type StyleSpecification,
} from 'maplibre-gl';

import { apiUrl } from '../utils/apiBase';
import type { VsmQChoice } from '../constants/predictions';
import { SimpleControls, type BasemapId } from './SimpleControls';
import { BasemapControl } from './BasemapControl';
import { MiniMap } from './MiniMap';
import { LayerControl, type ExploreLayer } from './LayerControl';
import { buildRamps } from './Colorbar';
import { RhProfileChart, VerticalProfileChart } from './ProfileCharts';
import { RandomSite } from './RandomSite';
import { LocationSearch } from './LocationSearch';
import { LocateMe } from './LocateMe';
import { InspectMarker } from './InspectMarker';
import { ExploreMapContext, isSelectingTiles, loadGrid, type Grid } from './exploreMap';
import { VSM_TOP, VsmLayers, type Templates } from './vsmLayers';
import { fetchVerticalProfile, type VerticalProfileResponse } from '../utils/verticalProfile';
import { placeLabel, reverseGeocode, type Place } from '../utils/reverseGeocode';
import './explore.css';

/**
 * The explore page — the reviewer-facing map.
 *
 * Drawn with MapLibre, which renders everything through WebGL: zooming scales
 * the tiles already on the GPU instead of redrawing a canvas every frame, which
 * is what made the OpenLayers version of this page feel heavy. The full app
 * (dev.html) is a separate page and still on OpenLayers.
 *
 * MapLibre zoom levels are OpenLayers' minus one; every zoom constant on this
 * page is in MapLibre's numbering.
 */

/**
 * The published mosaics' extent: 82.8529°N .. 56.0371°S. Just inside ±180° in
 * longitude, because bounds exactly on the antimeridian leave MapLibre's
 * constraint with nothing to centre on.
 */
const DATA_BOUNDS: [[number, number], [number, number]] = [[-179.999, -56.0371], [179.999, 82.8529]];

/**
 * `#zoom/lat/lon` as the page was opened. Read once, here: under StrictMode the
 * first map is built and torn down before the real one, and with `hash: true`
 * it rewrites the URL to its own view on the way — so by the time the second
 * map looks, the link it was opened with is gone.
 */
const INITIAL_VIEW = (() => {
  const [z, lat, lon] = location.hash.slice(1).split('/').map(Number);
  return [z, lat, lon].every(Number.isFinite) ? { zoom: z, center: [lon, lat] as [number, number] } : null;
})();

/** Share of the Web Mercator square, top to bottom, that DATA_BOUNDS covers. */
const DATA_HEIGHT_FRACTION = (() => {
  const y = (lat: number) => (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;
  return y(DATA_BOUNDS[0][1]) - y(DATA_BOUNDS[1][1]);
})();

/**
 * Keep the viewport inside the data, not inside the world.
 *
 * The mosaic covers 63% of the Web Mercator square, so simply flooring the zoom
 * would still leave a blank band along the bottom where there is basemap but no
 * prediction. The floor is instead the furthest zoom-out at which the data
 * extent fills the pane, in both directions, and maxBounds stops panning past
 * it.
 *
 * It is also what keeps MapLibre working: a world narrower than the pane, with
 * world copies off, leaves maxBounds no valid centre and the camera goes NaN.
 */
function fillZoom(width: number, height: number): number {
  return Math.max(Math.log2(width / 512), Math.log2(height / (512 * DATA_HEIGHT_FRACTION))) + 0.01;
}

const BASEMAP_TILES: Record<Exclude<BasemapId, 'none'>, { tiles: string[]; attribution: string }> = {
  osm: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  satellite: {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Imagery © Esri',
  },
};

function baseStyle(): StyleSpecification {
  return {
    version: 8,
    // For the tile names on the download grid — the only text drawn on the
    // canvas. OpenFreeMap's fonts: free, no key, CORS open.
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      basemap: { type: 'raster', tileSize: 256, maxzoom: 19, ...BASEMAP_TILES.osm },
    },
    layers: [
      { id: 'blank', type: 'background', paint: { 'background-color': '#ffffff' } },
      { id: 'basemap', type: 'raster', source: 'basemap' },
      { id: VSM_TOP, type: 'background', layout: { visibility: 'none' } },
    ],
  };
}

type Row = { rh: number; text: string };

type PointReading = {
  lon: number;
  lat: number;
  rows: Row[];
  loading: boolean;
  /** undefined while the lookup is in flight, null when the point has no name. */
  place?: Place | null;
  profile?: VerticalProfileResponse;
  profileLoading: boolean;
  profileError?: string;
};

/**
 * TiTiler's /cog/point answers `{ coordinates, values, band_names }`, not a
 * bare number. Values are int16 decimetres with 32767 as nodata.
 */
function formatHeight(data: unknown, rh: number): string {
  const values = (data as { values?: unknown } | null)?.values;
  const raw = Array.isArray(values) ? values[0] : undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw >= 32767) return 'no data';
  return `RH${rh} · ${(raw / 10).toFixed(1)} m`;
}

export default function SimpleApp() {
  // Fixed: only the median quantile is published, so there is nothing to pick.
  const qChoice: VsmQChoice = 'median';

  // One layer per selected RH: the sidebar's RH control is a multi-select, so
  // the layer list *is* the selection. Held newest-last, which is the order
  // they are drawn in.
  const [layers, setLayers] = useState<ExploreLayer[]>([{ id: 'l0', rhIndex: 98, visible: true }]);
  const nextId = useRef(1);

  // Only 2020 is published, so the year is shared by every layer rather than
  // being a per-layer property.
  const [year, setYear] = useState<2020>(2020);

  const rhIndexes = useMemo(() => layers.map((l) => l.rhIndex), [layers]);

  /**
   * The RH buttons toggle layers in and out. Turning one off is the only way to
   * remove a layer now that the layer list has no delete button — the two must
   * not disagree about what is on the map.
   */
  const toggleRh = useCallback((rh: number) => {
    setLayers((prev) =>
      prev.some((l) => l.rhIndex === rh)
        ? prev.filter((l) => l.rhIndex !== rh)
        : // Appended, so the RH just switched on is the one drawn on top. Layers
          // are always opaque — blending two height maps produced a colour that
          // is not a height — so it hides the rest of the stack; LayerControl
          // badges it.
          [...prev, { id: `l${nextId.current++}`, rhIndex: rh, visible: true }],
    );
  }, []);

  const toggleVisible = useCallback((id: string) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
  }, []);

  const [basemap, setBasemap] = useState<BasemapId>('osm');
  const [reading, setReading] = useState<PointReading | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<MlMap | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [templates, setTemplates] = useState<Templates | null>(null);
  const [setupError, setSetupError] = useState(false);
  const vsmRef = useRef<VsmLayers | null>(null);
  const [vsmReady, setVsmReady] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const floor = fillZoom(el.clientWidth, el.clientHeight);
    const m = new MlMap({
      container: el,
      style: baseStyle(),
      center: INITIAL_VIEW?.center ?? [0, 20],
      zoom: Math.max(floor, INITIAL_VIEW?.zoom ?? floor),
      minZoom: floor,
      maxBounds: DATA_BOUNDS,
      renderWorldCopies: false,
      // #zoom/lat/lon in the URL, so a view can be linked to.
      hash: true,
      attributionControl: { compact: true },
      // A height map has no use for rotation or tilt, and a rotated one is
      // only a way to get lost.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new ScaleControl({ unit: 'metric', maxWidth: 120 }), 'bottom-left');
    m.on('resize', () => m.setMinZoom(fillZoom(el.clientWidth, el.clientHeight)));
    m.once('load', () => setMap(m));
    return () => {
      setMap(null);
      m.remove();
    };
  }, []);

  // The MGRS grid gates every 10 m tile: the prediction layers read which
  // tiles are in view out of it. And the COG URL templates, which name the
  // file behind each one — optional: without them each URL is asked of the
  // backend instead, so a deployment that has none still draws.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadGrid(),
      fetch(apiUrl('/predictions/download-info'))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([g, info]) => {
        if (cancelled) return;
        setGrid(g);
        setTemplates({
          tile: info?.available && info.tile_url_template ? info.tile_url_template : null,
          mosaic: info?.available && info.mosaic_url_template ? info.mosaic_url_template : null,
          q: info?.q_index ?? 1,
        });
      })
      .catch((err) => {
        console.error('[explore] tile index failed to load — no layers will render', err);
        if (!cancelled) setSetupError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!map || !grid || !templates) return;
    vsmRef.current = new VsmLayers(map, grid, templates, year, qChoice);
    setVsmReady(true);
    return () => {
      // The map may already be gone when the page unmounts.
      if (map.style) vsmRef.current?.destroy();
      vsmRef.current = null;
      setVsmReady(false);
    };
  }, [map, grid, templates, year]);

  // Diffed rather than cleared and refilled, so untouched layers keep their
  // tiles instead of being torn down and refetched on every change.
  useEffect(() => {
    if (vsmReady) vsmRef.current?.sync(layers);
  }, [layers, vsmReady]);

  // Basemap.
  useEffect(() => {
    if (!map) return;
    if (basemap === 'none') {
      map.setLayoutProperty('basemap', 'visibility', 'none');
      return;
    }
    map.setLayoutProperty('basemap', 'visibility', 'visible');
    map.getSource<RasterTileSource>('basemap')?.setTiles(BASEMAP_TILES[basemap].tiles);
  }, [basemap, map]);

  // Click to read the value under the cursor.
  useEffect(() => {
    if (!map) return;
    const onClick = (e: MapMouseEvent) => {
      // The download flyout borrows the click while it is open, to pick
      // Sentinel-2 tiles. Reading a profile at the same point would open a card
      // over the map the reader is trying to select on.
      if (isSelectingTiles()) return;

      const { lng: lon, lat } = e.lngLat;
      const same = (p: PointReading | null): p is PointReading => !!p && p.lon === lon && p.lat === lat;
      setReading({ lon, lat, rows: [], loading: true, profileLoading: true });

      // Three requests with very different costs, so they are issued separately
      // and rendered as they land: the pixel read is one COG open per RH, the
      // place name goes to a host rate-limited to one a second, and the
      // profile opens 101 COGs and takes ~20 s.
      //
      // The pixel is read from the mosaic, the same file at every zoom — or,
      // where there is no mosaic, from the 10 m tile under the point.
      (vsmRef.current?.readUrls(lon, lat) ?? Promise.resolve([])).then((sources) => Promise.all(
        sources.map(async ({ rh, url }): Promise<Row> => {
          if (!url) return { rh, text: 'no data' };
          try {
            const r = await fetch(apiUrl(`/cog/point/${lon},${lat}?url=${encodeURIComponent(url)}`));
            return { rh, text: r.ok ? formatHeight(await r.json(), rh) : `Error: HTTP ${r.status}` };
          } catch (err) {
            return { rh, text: `Error: ${err instanceof Error ? err.message : String(err)}` };
          }
        }),
      )).then((rows) =>
        // Highest RH first, matching the layer list.
        setReading((p) => (same(p) ? { ...p, rows: rows.sort((a, b) => b.rh - a.rh), loading: false } : p)),
      );

      reverseGeocode(lon, lat).then((place) => setReading((p) => (same(p) ? { ...p, place } : p)));

      fetchVerticalProfile(lon, lat, year)
        .then((profile) =>
          setReading((p) =>
            same(p)
              ? {
                  ...p,
                  profileLoading: false,
                  profile: profile.success ? profile : undefined,
                  profileError: profile.success ? undefined : (profile.error ?? 'Profile unavailable'),
                }
              : p,
          ),
        )
        .catch((err) =>
          setReading((p) => (same(p) ? { ...p, profileLoading: false, profileError: String(err) } : p)),
        );
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [map, year]);

  const ramps = useMemo(() => buildRamps(layers, qChoice), [layers, qChoice]);
  const shared = useMemo(() => ({ map, grid }), [map, grid]);

  return (
    <ExploreMapContext.Provider value={shared}>
      <div className="ex-root">
        <SimpleControls rhIndexes={rhIndexes} onToggleRh={toggleRh} year={year} onYear={setYear} />

        <div className="ex-map">
          <div className="ex-map__canvas" ref={containerRef} />

          <LayerControl layers={layers} year={year} ramps={ramps} onToggleVisible={toggleVisible} />
          <BasemapControl value={basemap} onChange={setBasemap} />
          {/* One column, so the search card pushes the locate button down when
              it expands instead of opening over it. */}
          <div className="ex-topleft">
            <LocationSearch />
            <LocateMe />
          </div>
          {/* Renders nothing itself — it owns a marker on the map. Mounted here
              so the mark and the card that explains it come and go together. */}
          <InspectMarker lon={reading?.lon} lat={reading?.lat} />
          <MiniMap />
          <RandomSite intro={!INITIAL_VIEW} />

          {/* The grid gates every tile request, so its state is worth surfacing
              rather than leaving the user staring at an empty map. */}
          {!grid && !setupError && <div className="ex-status">Loading tile index…</div>}
          {setupError && (
            <div className="ex-status ex-status--error">Tile index unavailable — layers cannot load</div>
          )}

          {reading && (
            <div className="ex-reading">
              <button className="ex-reading__close" onClick={() => setReading(null)} aria-label="Close">
                ×
              </button>
              {/* Place above coordinates: "Alto Paraíso, Brazil" answers where
                  this is, and the numbers are what you copy afterwards. */}
              {reading.place && (
                <div className="ex-reading__place" title={reading.place.address}>
                  {placeLabel(reading.place)}
                </div>
              )}
              <div className="ex-reading__coords">
                {reading.lat.toFixed(5)}, {reading.lon.toFixed(5)}
              </div>
              <div className="ex-reading__value">
                {reading.loading
                  ? 'Reading…'
                  : reading.rows.length === 0
                    ? 'No layer to sample'
                    : reading.rows.map((row) => <div key={row.rh}>{row.text}</div>)}
              </div>

              <div className="ex-profile">
                {reading.profileLoading && (
                  <p className="ex-profile__note">Building profile… reads 101 layers, this may take a while.</p>
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
    </ExploreMapContext.Provider>
  );
}
