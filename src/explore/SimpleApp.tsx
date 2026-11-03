import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { ProfileMetrics, RhProfileChart, VerticalProfileChart } from './ProfileCharts';
import { RandomSite } from './RandomSite';
import { LocationSearch } from './LocationSearch';
import { LocateMe } from './LocateMe';
import { InspectMarker } from './InspectMarker';
import { CubeFootprint } from './CubeFootprint';
import { fetchCube, type Cube } from './cube/cubeData';
import { columnRh, pixelAt, pixelCentre, profileAt } from './cube/cubeProfile';
import type { Snapshot } from './cube/CubeScene';
import type { CubeExportApi, CubeView } from './cube/CubePanel';
import type { GroundSource } from './cube/groundImagery';
import { CheckIcon, CloseIcon, PageDownloadIcon, ShareIcon } from './icons';
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
 * (dev/) is a separate page and still on OpenLayers.
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
  cube?: Cube;
  cubeLoading: boolean;
  cubeError?: string;
  /** Which click this card belongs to; late answers to an older click are dropped. */
  id: number;
  /** Where the click was: the window is placed around it, so a shared link needs it. */
  clickLon: number;
  clickLat: number;
  /** Set once the pin has been dragged: the window pixel now read from the cube. */
  probe?: { row: number; col: number };
};

/** The selected RH layers' values at a dragged-to pixel, highest RH first, like `rows`. */
function cubeRows(cube: Cube, probe: { row: number; col: number }, rhIndexes: number[]): Row[] {
  const rhs = columnRh(cube, probe.row, probe.col);
  return [...rhIndexes]
    .sort((a, b) => b - a)
    .map((rh) => ({ rh, text: rhs[rh] === null ? `RH${rh} · no data` : `RH${rh} · ${rhs[rh]!.toFixed(1)} m` }));
}

/** The card moved to another pixel of the cube window: everything read from the cube. */
function withProbe(p: PointReading, lon: number, lat: number): PointReading {
  if (!p.cube) return p;
  const { row, col } = pixelAt(p.cube.meta, lon, lat);
  if (p.probe?.row === row && p.probe?.col === col) return p;
  const [plon, plat] = pixelCentre(p.cube.meta, row, col);
  return {
    ...p,
    lon: plon,
    lat: plat,
    probe: { row, col },
    profile: profileAt(p.cube, row, col),
    profileLoading: false,
    profileError: undefined,
  };
}

/**
 * A shared link: `?at=lat,lon` (the click) [&pin=lat,lon] [&cube=mode,display,cx,cy,cz,cutoff,,opacity,bottom]
 * [&ground=s2|esri|off] [&ymax=50], with the map view in the usual #zoom/lat/lon.
 * Read once at load, like INITIAL_VIEW; the query is removed once the card is open.
 */
const SHARED = (() => {
  const q = new URLSearchParams(location.search);
  const pair = (k: string): [number, number] | null => {
    const v = q.get(k)?.split(',').map(Number);
    return v && v.length === 2 && v.every(Number.isFinite) ? [v[0], v[1]] : null;
  };
  const at = pair('at');
  if (!at) return null;
  const c = q.get('cube')?.split(',');
  const n = c?.slice(2, 6).map(Number);
  // mode,display,cx,cy,cz,cutoff[,(unused: was the energy colour ramp)[,RH surface opacity[,RH surface bottom cut]]]
  const opacity = Number(c?.[7]);
  const cz0 = Number(c?.[8]);
  const view: CubeView | null =
    c && n && c.length >= 6 && c.length <= 9 && n.every(Number.isFinite)
      ? {
          mode: c[0] === 'rh' || c[0] === 'surfaces' ? c[0] : 'energy',
          display: c[1] === 'planes' ? 'planes' : 'cut',
          cx: n[0],
          cy: n[1],
          cz: n[2],
          cutoff: n[3],
          ...(opacity > 0 ? { opacity } : {}),
          ...(cz0 > 0 ? { cz0 } : {}),
        }
      : null;
  const g = q.get('ground');
  const ymax = Number(q.get('ymax'));
  return {
    at,
    pin: pair('pin'),
    view,
    ground: (g === 's2' || g === 'esri' || g === 'off' ? g : null) as GroundSource | null,
    ymax: ymax > 0 ? ymax : null,
  };
})();

// three.js only downloads once a card with a cube is open.
const CubePanel = lazy(() => import('./cube/CubePanel'));

/**
 * The metrics and profile charts at the pin: in the card, and in the enlarged
 * cube's image column. The height-axis control sits right above the charts it sets.
 */
function ProfileBody({
  profile,
  yMax,
  yMaxControl,
}: {
  profile: VerticalProfileResponse;
  yMax: number;
  yMaxControl?: React.ReactNode;
}) {
  return (
    <>
      <div className="ex-profile__bar">
        <ProfileMetrics {...profile} />
        {yMaxControl}
      </div>
      <div className="ex-profile__charts">
        <figure>
          <figcaption>RH profile</figcaption>
          <RhProfileChart profile={profile.profile!} yMax={yMax} />
        </figure>
        {profile.vertical_profile_curve && profile.vertical_profile_curve.length > 1 && (
          <figure>
            <figcaption>Vertical profile</figcaption>
            <VerticalProfileChart curve={profile.vertical_profile_curve} yMax={yMax} />
          </figure>
        )}
      </div>
    </>
  );
}

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
  const [cubeSnap, setCubeSnap] = useState<Snapshot | null>(null);
  // Both profile charts share one fixed height axis, 50 m by default (the VSM
  // height-map range), so two places can be compared at a glance. Kept as the
  // typed text; an empty or invalid entry falls back to 50 m.
  const [yMaxText, setYMaxText] = useState(String(SHARED?.ymax ?? 50));
  // Sentinel-2 of the VSM year by default: the only image dated like the data.
  const [ground, setGround] = useState<GroundSource>(SHARED?.ground ?? 's2');
  const [share, setShare] = useState<{ url: string; copied: boolean } | null>(null);
  const cubeExport = useRef<CubeExportApi | null>(null);
  const [saving, setSaving] = useState<'idle' | 'busy' | string>('idle');
  const readAtRef = useRef<((lon: number, lat: number, pin?: [number, number] | null) => void) | null>(null);
  const sharedId = useRef<number | null>(null);
  const profileYMax = Number(yMaxText) > 0 ? Number(yMaxText) : 50;
  const yMaxControl = (
    <label className="ex-profile__ymax" title="Top of the height axis of both charts">
      <span>Height max</span>
      <span>
        <input type="number" min={1} step={5} value={yMaxText} onChange={(e) => setYMaxText(e.target.value)} />m
      </span>
    </label>
  );
  const cubeAbort = useRef<AbortController | null>(null);
  const clickId = useRef(0);

  /**
   * The pin dragged inside the cube window: read that pixel's profile from the
   * cube already in the browser — no request, so it follows the pointer. The
   * pin snaps to the pixel centre through lon/lat.
   */
  const onPinDrag = useCallback((lon: number, lat: number) => {
    setReading((p) => (p ? withProbe(p, lon, lat) : p));
  }, []);

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
    /** Open the card at a point; `pin` (lat, lon) moves it inside the cube once loaded (shared links). */
    const readAt = (lon: number, lat: number, pin?: [number, number] | null) => {
      // By click, not by coordinates: dragging the pin moves lon/lat, and the
      // requests still in flight belong to the same card.
      const id = ++clickId.current;
      const same = (p: PointReading | null): p is PointReading => !!p && p.id === id;
      setReading({
        id, lon, lat, clickLon: lon, clickLat: lat, rows: [], loading: true, profileLoading: true, cubeLoading: true,
      });
      setCubeSnap(null);
      setShare(null);

      // Four requests with very different costs, so they are issued separately
      // and rendered as they land: the pixel read is one COG open per RH, the
      // place name goes to a host rate-limited to one a second, and the
      // profile opens 101 COGs and takes ~5-20 s. The cube is sent at the same
      // time as the profile on purpose: the backend reads one 128 px window of
      // all 101 levels for both, once.
      cubeAbort.current?.abort();
      const abort = (cubeAbort.current = new AbortController());
      fetchCube(lon, lat, year, abort.signal)
        .then((cube) =>
          setReading((p) => {
            if (!same(p)) return p;
            const next = { ...p, cube, cubeLoading: false };
            return pin ? withProbe(next, pin[1], pin[0]) : next;
          }),
        )
        .catch((err) => {
          if (abort.signal.aborted) return;
          setReading((p) => (same(p) ? { ...p, cubeLoading: false, cubeError: err instanceof Error ? err.message : String(err) } : p));
        });
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
            // Once the pin was dragged the card shows that pixel, computed from the cube.
            same(p) && !p.probe
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
          setReading((p) => (same(p) && !p.probe ? { ...p, profileLoading: false, profileError: String(err) } : p)),
        );
      return id;
    };
    readAtRef.current = (lon, lat, pin) => {
      sharedId.current = pin === undefined ? null : readAt(lon, lat, pin);
    };

    const onClick = (e: MapMouseEvent) => {
      // The download flyout borrows the click while it is open, to pick
      // Sentinel-2 tiles. Reading a profile at the same point would open a card
      // over the map the reader is trying to select on.
      if (isSelectingTiles()) return;
      readAt(e.lngLat.lng, e.lngLat.lat);
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [map, year]);

  // A shared link opens its card once the layers can be read. The query is then
  // dropped, so a reload or a later click does not bring the shared point back.
  const sharedOpened = useRef(false);
  useEffect(() => {
    if (!vsmReady || !SHARED || sharedOpened.current || !readAtRef.current) return;
    sharedOpened.current = true;
    readAtRef.current(SHARED.at[1], SHARED.at[0], SHARED.pin);
    history.replaceState(null, '', location.pathname + location.hash);
  }, [vsmReady]);

  /** A link that reopens this card: the click, the pin, the cube view, the map view. */
  const shareUrl = useCallback((): string | null => {
    if (!reading) return null;
    const f = (v: number) => v.toFixed(7);
    let q = `at=${f(reading.clickLat)},${f(reading.clickLon)}`;
    if (reading.probe) q += `&pin=${f(reading.lat)},${f(reading.lon)}`;
    if (cubeSnap) {
      q += `&cube=${cubeSnap.mode},${cubeSnap.display},${cubeSnap.cx},${cubeSnap.cy},${cubeSnap.cz},${cubeSnap.cutoff},,${cubeSnap.opacity},${cubeSnap.cz0}`;
    }
    q += `&ground=${ground}&ymax=${profileYMax}`;
    const c = map?.getCenter();
    const hash = map && c ? `#${map.getZoom().toFixed(2)}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}` : location.hash;
    return `${location.origin}${location.pathname}?${q}${hash}`;
  }, [reading, cubeSnap, ground, profileYMax, map]);

  const onShare = useCallback(async () => {
    const url = shareUrl();
    if (!url) return;
    // Phones get the system share sheet; elsewhere the link goes to the clipboard.
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: 'Vertical vegetation structure', url });
        return;
      } catch {
        /* dismissed: fall through to the copy */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setShare({ url, copied: true });
    } catch {
      setShare({ url, copied: false });
    }
  }, [shareUrl]);

  /** One HTML file with the cube, image, profile and viewer: opens instantly, offline. */
  const onSavePage = useCallback(async () => {
    if (!reading?.cube) return;
    setSaving('busy');
    try {
      const { exportCubePage } = await import('./cube/exportPage');
      const grounds = (await cubeExport.current?.grounds()) ?? {};
      await exportCubePage({
        cube: reading.cube,
        place: reading.place ? placeLabel(reading.place) : null,
        lon: reading.lon,
        lat: reading.lat,
        probe: reading.probe ?? null,
        view: cubeSnap
          ? {
              mode: cubeSnap.mode,
              display: cubeSnap.display,
              cx: cubeSnap.cx,
              cy: cubeSnap.cy,
              cz: cubeSnap.cz,
              cutoff: cubeSnap.cutoff,
              topMode: cubeSnap.topMode,
              vmax: cubeSnap.vmax,
              zStretch: cubeSnap.zStretch,
              opacity: cubeSnap.opacity,
              hidden: cubeSnap.levels.filter((l) => !l.on).map((l) => l.rh),
              cz0: cubeSnap.cz0,
            }
          : null,
        camera: cubeExport.current?.camera() ?? null,
        grounds,
        groundChoice: ground,
        ymax: profileYMax,
        rhIndexes,
        explorerUrl: shareUrl(),
      });
      setSaving('idle');
    } catch (err) {
      console.error('[explore] save as page failed', err);
      setSaving(err instanceof Error ? err.message : String(err));
    }
  }, [reading, cubeSnap, ground, profileYMax, rhIndexes, shareUrl]);

  useEffect(() => {
    if (!share?.copied) return;
    const t = setTimeout(() => setShare(null), 4000);
    return () => clearTimeout(t);
  }, [share]);

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
          <InspectMarker lon={reading?.lon} lat={reading?.lat} onDrag={reading?.cube ? onPinDrag : undefined} />
          <CubeFootprint meta={reading?.cube?.meta} snapshot={cubeSnap} />
          <MiniMap />
          <RandomSite intro={!INITIAL_VIEW} />

          {/* The grid gates every tile request, so its state is worth surfacing
              rather than leaving the user staring at an empty map. */}
          {!grid && !setupError && <div className="ex-status">Loading tile index…</div>}
          {setupError && (
            <div className="ex-status ex-status--error">Tile index unavailable — layers cannot load</div>
          )}

          {reading && (
            <div className="ex-reading ex-reading--cube">
              <header className="ex-reading__head">
                {/* Place above coordinates: "Alto Paraíso, Brazil" answers where
                    this is, and the numbers are what you copy afterwards. */}
                <div className="ex-reading__where">
                  <div className="ex-reading__place" title={reading.place?.address}>
                    {reading.place ? placeLabel(reading.place) : reading.place === null ? 'Unnamed place' : '…'}
                  </div>
                  <div className="ex-reading__coords">
                    {reading.lat.toFixed(5)}, {reading.lon.toFixed(5)}
                    {(reading.cube?.meta.tile ?? reading.profile?.tile_name) &&
                      ` · tile ${reading.cube?.meta.tile ?? reading.profile?.tile_name}`}
                    {reading.probe && <span className="ex-reading__moved"> · pin moved</span>}
                  </div>
                </div>
                <div className="ex-reading__actions">
                  <button
                    className="ex-icon-btn"
                    onClick={onSavePage}
                    disabled={!reading.cube || saving === 'busy'}
                    title={
                      reading.cube
                        ? 'Save as a page: one HTML file that opens instantly, offline, with this cube and profile'
                        : 'Available once the cube has loaded'
                    }
                    aria-label="Save as a page"
                  >
                    {saving === 'busy' ? <span className="ex-spinner ex-spinner--solo" /> : <PageDownloadIcon />}
                  </button>
                  <button
                    className="ex-icon-btn"
                    onClick={onShare}
                    title="Copy a link to this place and view"
                    aria-label="Share a link to this view"
                  >
                    <ShareIcon />
                  </button>
                  <button
                    className="ex-icon-btn"
                    onClick={() => {
                      cubeAbort.current?.abort();
                      setReading(null);
                      setCubeSnap(null);
                      setShare(null);
                    }}
                    title="Close"
                    aria-label="Close"
                  >
                    <CloseIcon />
                  </button>
                </div>
              </header>

              {saving !== 'idle' && saving !== 'busy' && (
                <div className="ex-share" role="alert">
                  Could not save the page: {saving}
                </div>
              )}
              {share && (
                <div className={`ex-share${share.copied ? ' is-copied' : ''}`} role="status">
                  {share.copied ? (
                    <span className="ex-share__msg">
                      <CheckIcon size={14} /> Link copied — it reopens this place, the pin and the cube view.
                    </span>
                  ) : (
                    <span className="ex-share__msg">Copy this link:</span>
                  )}
                  <input
                    readOnly
                    value={share.url}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label="Link to this view"
                  />
                </div>
              )}

              <div className="ex-reading__values">
                {/* Once the cube is in, its pixel is the reading: the same 10 m tile,
                    and it follows the pin. Before that, the per-layer point reads. */}
                {(reading.cube
                  ? cubeRows(reading.cube, reading.probe ?? reading.cube.meta.click, rhIndexes)
                  : reading.rows
                ).map((row) => (
                  <span key={row.rh} className="ex-chip">
                    {row.text}
                  </span>
                ))}
                {!reading.cube && reading.loading && <span className="ex-chip ex-chip--muted">Reading…</span>}
                {!reading.cube && !reading.loading && reading.rows.length === 0 && (
                  <span className="ex-chip ex-chip--muted">No layer to sample</span>
                )}
              </div>

              <Suspense fallback={<div className="ex-cube ex-cube--placeholder">Loading 3D view…</div>}>
                <CubePanel
                  cube={reading.cube ?? null}
                  probe={reading.probe ?? null}
                  loading={reading.cubeLoading}
                  error={reading.cubeError}
                  ground={ground}
                  onGround={setGround}
                  initialView={reading.id === sharedId.current ? SHARED?.view : null}
                  onSnapshot={setCubeSnap}
                  exportRef={cubeExport}
                  sideExtra={
                    reading.profile?.profile && reading.profile.profile.length > 0 ? (
                      <section className="ex-static__profile" aria-label="Profile at the pin">
                        <ProfileBody profile={reading.profile} yMax={profileYMax} yMaxControl={yMaxControl} />
                      </section>
                    ) : null
                  }
                  onPick={(row, col, opts) => {
                    if (!reading.cube) return;
                    const [lon, lat] = pixelCentre(reading.cube.meta, row, col);
                    onPinDrag(lon, lat);
                    // Picked on the cube: zoom the map in on that pixel (10 m pixels ~8 px wide at z17).
                    if (opts?.focus && map) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 17) });
                  }}
                />
              </Suspense>

              <section className="ex-profile" aria-label="Profile at the pin">
                <div className="ex-sec__head">
                  <h3>Profile at the pin</h3>
                </div>
                {reading.profileLoading && (
                  <p className="ex-profile__note">
                    <span className="ex-spinner" /> Building the profile… reads RH0–RH100, this may take a while.
                  </p>
                )}
                {reading.profileError && <p className="ex-profile__note">{reading.profileError}</p>}

                {reading.profile?.profile && reading.profile.profile.length > 0 && (
                  <ProfileBody profile={reading.profile} yMax={profileYMax} yMaxControl={yMaxControl} />
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </ExploreMapContext.Provider>
  );
}
