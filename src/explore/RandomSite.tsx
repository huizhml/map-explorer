import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeoJSONSource } from 'maplibre-gl';
import { TransectHeatmap, type Transect } from './TransectHeatmap';
import { placeLabel, reverseGeocode, type Place } from '../utils/reverseGeocode';
import { setIntroCancel, takeCamera, useExploreMap } from './exploreMap';

/**
 * "Visit a random site" — jumps to one of the curated sites, draws its transect
 * on the map, and shows the profile measured along it.
 *
 * Reads a static bundle (public/sites/), not the API: the profiles are already
 * stored, so there is nothing to compute and the jump is instant. The bundle is
 * curated in the full app and published with `npm run sites:publish`.
 *
 * Renders nothing when no bundle is present, so the page degrades cleanly
 * before anything has been published.
 */

type Site = {
  id: number;
  name: string | null;
  description: string | null;
  center: [number, number] | null;
  geometry?: { type: string; coordinates: unknown } | null;
  tags: string[];
  images: Array<{ file: string; kind?: string | null; caption?: string | null }>;
  transect?: Transect | null;
};

// Relative so it resolves under the /map-explorer/ Pages base as well as at root.
const BUNDLE_URL = './sites/sites.json';
const IMAGE_BASE = './sites/';

const LINE_SOURCE = 'site-transect';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * `intro` is false when the page was opened on a linked view (`#zoom/lat/lon`):
 * the link is where the reader asked to be, so flying them somewhere random
 * would throw it away.
 */
export function RandomSite({ intro = true }: { intro?: boolean }) {
  const { map } = useExploreMap();
  const [sites, setSites] = useState<Site[] | null>(null);
  // The visits made so far, and where in them we are. Random means a site is
  // gone for good once it is replaced, so the trail has to be kept to be able
  // to step back to it.
  const [visited, setVisited] = useState<Site[]>([]);
  const [pos, setPos] = useState(-1);
  const current = pos >= 0 ? visited[pos] ?? null : null;
  // undefined while the lookup is in flight, null when the point has no name.
  const [place, setPlace] = useState<Place | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch(BUNDLE_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (cancelled) return;
        const list = (m?.sites ?? []).filter((s: Site) => s.center);
        setSites(list.length ? list : []);
      })
      .catch(() => !cancelled && setSites([]));
    return () => {
      cancelled = true;
    };
  }, []);

  // One source reused across visits. Added without a `beforeId`, so above the
  // predictions. Casing over a dark halo, so the line reads over both bright
  // and dark tiles.
  useEffect(() => {
    if (!map) return;
    map.addSource(LINE_SOURCE, { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: `${LINE_SOURCE}-casing`, type: 'line', source: LINE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': 'rgba(0,0,0,0.55)', 'line-width': 7 },
    });
    map.addLayer({
      id: LINE_SOURCE, type: 'line', source: LINE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ff3d7f', 'line-width': 3 },
    });
    return () => {
      // The map may already be gone when the page unmounts.
      if (!map.style) return;
      map.removeLayer(LINE_SOURCE);
      map.removeLayer(`${LINE_SOURCE}-casing`);
      map.removeSource(LINE_SOURCE);
    };
  }, [map]);

  /** Draw a site's transect and move the view to it. Shared by forward and back. */
  const show = useCallback(
    (site: Site) => {
      if (!map) return;

      // Before anything else: the opening fly-in, or a previous visit still
      // animating, would otherwise win the view off us. See takeCamera.
      takeCamera(map);

      const source = map.getSource<GeoJSONSource>(LINE_SOURCE);

      const coords =
        site.geometry?.type === 'LineString'
          ? (site.geometry.coordinates as [number, number][])
          : site.transect?.line_coordinates ?? null;

      if (coords?.length) {
        source?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
        // Fit the line rather than centring on it, so the whole transect is
        // visible whatever its length — these run from under 1 km to several.
        const xs = coords.map((c) => c[0]);
        const ys = coords.map((c) => c[1]);
        map.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], {
          padding: { top: 90, right: 90, bottom: 260, left: 90 },
          duration: 900,
          maxZoom: 14,
        });
      } else {
        source?.setData(EMPTY);
        if (site.center) map.easeTo({ center: site.center, zoom: 12, duration: 900 });
      }
    },
    [map],
  );

  const visit = useCallback(() => {
    if (!sites?.length || !map) return;
    // Avoid repeating the current site when there is more than one to choose from.
    const pool = sites.length > 1 ? sites.filter((s) => s.id !== current?.id) : sites;
    const site = pool[Math.floor(Math.random() * pool.length)];
    // Anything stepped back past is dropped, the way browser history behaves —
    // a new random pick is a new branch, not a return to the old one.
    setVisited((prev) => [...prev.slice(0, pos + 1), site]);
    setPos(pos + 1);
    show(site);
  }, [sites, map, current, pos, show]);

  /**
   * The opening move: hold the global view, then fly into one of the curated
   * sites.
   *
   * A page that lands on the whole world shows only the low-zoom mosaic, and a
   * reviewer who does not know to zoom in never sees the 10 m data at all — the
   * 10 m tiles are not fetched below zoom 7. Starting global and *then*
   * moving teaches the gesture instead of skipping it: you see the coverage,
   * then you see what it becomes up close.
   *
   * Camera only — no transect drawn, no card opened. This is a way in, not a
   * tour; "Visit a random site" stays the thing the reader chooses to do.
   */
  const flownRef = useRef(false);
  useEffect(() => {
    if (!intro || !map || !sites?.length || flownRef.current) return;
    const site = sites[Math.floor(Math.random() * sites.length)];
    if (!site.center) return;
    flownRef.current = true;

    // Anyone who has already grabbed the map means it: flying the view out from
    // under them would be the page fighting its reader.
    const viewport = map.getCanvasContainer();
    const cancel = () => {
      clearTimeout(timer);
      viewport.removeEventListener('pointerdown', cancel);
      viewport.removeEventListener('wheel', cancel);
      setIntroCancel(null);
    };
    // Registered so anything else that moves the view can call off the flight
    // first — the controls that do are overlays outside the canvas, so they
    // never trip the listeners above.
    setIntroCancel(cancel);
    const timer = setTimeout(() => {
      cancel();
      // Zoom 9, two past the 10 m tiles' threshold, so they are already
      // loading when the flight lands. Slow enough to read as travel rather
      // than a jump cut.
      map.flyTo({ center: site.center!, zoom: 9, duration: 2800 });
    }, 1400);
    viewport.addEventListener('pointerdown', cancel);
    viewport.addEventListener('wheel', cancel);

    return cancel;
  }, [intro, map, sites]);

  const back = useCallback(() => {
    if (pos <= 0) return;
    setPos(pos - 1);
    show(visited[pos - 1]);
  }, [pos, visited, show]);

  // Where the current site is, in words. The bundled names are internal
  // bookkeeping — random1, random2 — so without this the card cannot say where
  // on Earth it has just jumped to.
  useEffect(() => {
    const centre = current?.center;
    if (!centre) {
      setPlace(null);
      return;
    }
    let cancelled = false;
    setPlace(undefined);
    reverseGeocode(centre[0], centre[1]).then((p) => {
      if (!cancelled) setPlace(p);
    });
    return () => {
      cancelled = true;
    };
  }, [current]);

  const close = useCallback(() => {
    // Closing ends the tour rather than just hiding the card: leaving a trail
    // behind an empty map would put the back arrow on a site nothing is drawn for.
    setVisited([]);
    setPos(-1);
    map?.getSource<GeoJSONSource>(LINE_SOURCE)?.setData(EMPTY);
  }, [map]);

  if (!sites || sites.length === 0) return null;

  const figure = current?.images?.[0];

  return (
    <>
      {/* Bottom-centre: the primary invitation on the page, and clear of the
          basemap control and the scale bar. The back arrow hangs off the left
          of the wrapper rather than sitting in flow beside the button, so the
          call to action stays centred whether or not there is a trail. */}
      <div className="ex-random-bar">
        {pos > 0 && (
          <button
            type="button"
            className="ex-random__back"
            onClick={back}
            title="Back to the previous site"
            aria-label="Back to the previous site"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                fill="currentColor"
                d="M15.4 4.6 13.9 3.2 5.1 12l8.8 8.8 1.5-1.4L8 12l7.4-7.4Z"
              />
            </svg>
          </button>
        )}

        <button type="button" className="ex-random" onClick={visit}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 3.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Zm-4 9a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Zm8 0a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Z"
            />
          </svg>
          {current ? 'Next random site' : 'Visit a random site'}
        </button>
      </div>

      {current && (
        <div className="ex-site">
          <button className="ex-site__close" onClick={close} aria-label="Close">
            ×
          </button>
          {/* The stored names are internal bookkeeping — random1, random2 — so
              the card names what it shows instead. */}
          <h2>Vertical profile</h2>

          {/* The line is kept even while the lookup is in flight, so the card
              does not reflow under the pointer when the name arrives. */}
          <p className="ex-site__place" title={place ? place.address : undefined}>
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 2a7 7 0 0 0-7 7c0 5.1 6.3 12.4 6.6 12.7a.5.5 0 0 0 .8 0C12.7 21.4 19 14.1 19 9a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"
              />
            </svg>
            {place === undefined ? (
              <span className="ex-site__place-wait">Locating…</span>
            ) : (
              <>
                {place && placeLabel(place)}
                {current.center && (
                  <span className="ex-site__coords">
                    {current.center[1].toFixed(4)}, {current.center[0].toFixed(4)}
                  </span>
                )}
              </>
            )}
          </p>

          {current.description && <p className="ex-site__desc">{current.description}</p>}

          {current.transect?.samples?.length ? (
            <TransectHeatmap transect={current.transect} />
          ) : figure ? (
            <figure className="ex-site__figure">
              <img src={`${IMAGE_BASE}${figure.file}`} alt={figure.caption ?? current.name ?? 'Transect'} />
              {figure.caption && <figcaption>{figure.caption}</figcaption>}
            </figure>
          ) : (
            <p className="ex-site__desc">No profile published for this site.</p>
          )}

        </div>
      )}
    </>
  );
}
