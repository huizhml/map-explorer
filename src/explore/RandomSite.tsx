import { useCallback, useEffect, useState } from 'react';
import type Map from 'ol/Map';
import { fromLonLat } from 'ol/proj';
import { TransectHeatmap, type Transect } from './TransectHeatmap';

/**
 * "Visit a random site" — jumps to one of the curated sites and shows the
 * transect that was rendered for it.
 *
 * Reads a static bundle (public/sites/), not the API: the figures take ~50 s to
 * render and the point of the button is immediacy. The bundle is produced from
 * the saved-features database by the Publish panel in the full app, so the
 * curation still happens where the sites are authored.
 *
 * Renders nothing at all when no bundle is present, so the page degrades
 * cleanly before any sites have been published.
 */

type Site = {
  id: number;
  name: string | null;
  description: string | null;
  center: [number, number] | null;
  tags: string[];
  images: Array<{ file: string; kind?: string | null; caption?: string | null }>;
  /** Stored profile samples — preferred over a rendered image when present. */
  transect?: Transect | null;
};

// Relative so it resolves under the /map-explorer/ Pages base as well as at root.
const BUNDLE_URL = './sites/sites.json';
const IMAGE_BASE = './sites/';

export function RandomSite({ map }: { map: Map | null }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [current, setCurrent] = useState<Site | null>(null);

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

  const visit = useCallback(() => {
    if (!sites?.length || !map) return;
    // Avoid repeating the current site when there is more than one to choose from.
    const pool = sites.length > 1 ? sites.filter((s) => s.id !== current?.id) : sites;
    const site = pool[Math.floor(Math.random() * pool.length)];
    setCurrent(site);
    map.getView().animate({
      center: fromLonLat(site.center as [number, number]),
      zoom: 13,
      duration: 900,
    });
  }, [sites, map, current]);

  if (!sites || sites.length === 0) return null;

  const figure = current?.images?.[0];

  return (
    <>
      <button type="button" className="ex-random" onClick={visit}>
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 3.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Zm-4 9a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Zm8 0a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Z"
          />
        </svg>
        Visit a random site
      </button>

      {current && (
        <div className="ex-site">
          <button className="ex-site__close" onClick={() => setCurrent(null)} aria-label="Close">
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
