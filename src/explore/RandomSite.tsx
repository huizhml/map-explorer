import { useCallback, useEffect, useRef, useState } from 'react';
import type Map from 'ol/Map';
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Stroke, Style } from 'ol/style';
import { fromLonLat } from 'ol/proj';
import { TransectHeatmap, type Transect } from './TransectHeatmap';

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

/** Casing over a dark halo, so the line reads over both bright and dark tiles. */
const LINE_STYLE = [
  new Style({ stroke: new Stroke({ color: 'rgba(0,0,0,0.55)', width: 7 }) }),
  new Style({ stroke: new Stroke({ color: '#ff3d7f', width: 3 }) }),
];

export function RandomSite({ map }: { map: Map | null }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [current, setCurrent] = useState<Site | null>(null);
  const layerRef = useRef<VectorLayer<VectorSource> | null>(null);

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

  // One layer reused across visits; zIndex above the prediction tiles.
  useEffect(() => {
    if (!map) return;
    const layer = new VectorLayer({ source: new VectorSource(), style: LINE_STYLE, zIndex: 900 });
    map.addLayer(layer);
    layerRef.current = layer;
    return () => {
      map.removeLayer(layer);
      layerRef.current = null;
    };
  }, [map]);

  const visit = useCallback(() => {
    if (!sites?.length || !map) return;
    // Avoid repeating the current site when there is more than one to choose from.
    const pool = sites.length > 1 ? sites.filter((s) => s.id !== current?.id) : sites;
    const site = pool[Math.floor(Math.random() * pool.length)];
    setCurrent(site);

    const source = layerRef.current?.getSource();
    source?.clear();

    const coords =
      site.geometry?.type === 'LineString'
        ? (site.geometry.coordinates as [number, number][])
        : site.transect?.line_coordinates ?? null;

    if (coords?.length) {
      const line = new LineString(coords.map((c) => fromLonLat(c)));
      source?.addFeature(new Feature(line));
      // Fit the line rather than centring on it, so the whole transect is
      // visible whatever its length — these run from under 1 km to several.
      map.getView().fit(line.getExtent(), {
        padding: [90, 90, 260, 90],
        duration: 900,
        maxZoom: 15,
      });
    } else if (site.center) {
      map.getView().animate({ center: fromLonLat(site.center), zoom: 13, duration: 900 });
    }
  }, [sites, map, current]);

  const close = useCallback(() => {
    setCurrent(null);
    layerRef.current?.getSource()?.clear();
  }, []);

  if (!sites || sites.length === 0) return null;

  const figure = current?.images?.[0];

  return (
    <>
      {/* Bottom-centre: the primary invitation on the page, and clear of the
          basemap control and the scale bar. */}
      <button type="button" className="ex-random" onClick={visit}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 3.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Zm-4 9a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Zm8 0a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Z"
          />
        </svg>
        {current ? 'Next random site' : 'Visit a random site'}
      </button>

      {current && (
        <div className="ex-site">
          <button className="ex-site__close" onClick={close} aria-label="Close">
            ×
          </button>
          <h2>{current.name ?? 'Site'}</h2>
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

          {current.tags.length > 0 && (
            <ul className="ex-site__tags">
              {current.tags.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
