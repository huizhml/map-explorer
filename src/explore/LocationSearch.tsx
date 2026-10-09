import { useCallback, useEffect, useRef, useState } from 'react';
import { searchPlace } from '../utils/reverseGeocode';
import { takeCamera, useExploreMap, type GridTile } from './exploreMap';

/**
 * Go to a Sentinel-2 tile, a place, or a pair of coordinates.
 *
 * The full app's TileSearch, brought over to the explore page and given the
 * third input. That one asks the backend (/sentinel2/tile-coordinates,
 * /geolocation/search); none of these three do:
 *
 *   Tile name  The MGRS grid is already loaded. The prediction layers need it
 *              to know which tiles are in view, so all 18,181 tiles are sitting
 *              in memory, indexed by name — a lookup, not a request.
 *              It also gives the tile's real footprint, so the map can frame
 *              the tile rather than guess a zoom around its centre.
 *
 *   Coordinates  The backend call they used was range-checking two numbers.
 *
 *   Place name  Nominatim, the same provider the reading card already uses to
 *               name a clicked point, and through the same throttled queue.
 *
 * Which matters beyond being faster: the reviewer site is static files against
 * a read-only backend, and every route it depends on is a route that has to
 * stay deployed. This control needs nothing that the page is not already using.
 *
 * The three are told apart by shape, in the order they can be recognised —
 * coordinates and tile names are exact patterns, and a place name is whatever
 * is left. So "32TMS" is a tile and "Mali" is a place, without a mode switch
 * for the reader to set first.
 */

/** MGRS 100 km square: zone 1-60, latitude band (I and O unused), then the square. */
const TILE_RE = /^\d{1,2}[C-HJ-NP-X][A-Z]{2}$/i;

/** "55.68, 12.57" and "55.68 12.57" — latitude first, as the full app accepts. */
const COORD_RES = [
  /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/,
  /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/,
];

/**
 * Where a coordinate search lands.
 *
 * The full app uses 17, which is right for a basemap and wrong for this data:
 * the predictions are 10 m and the overview mosaic stops at zoom 14, so 17 is
 * three levels of upsampled blur. 15 (14 in MapLibre's numbering) is as close
 * as the pixels go on being pixels, and matches where RandomSite stops when it
 * frames a transect.
 */
const POINT_ZOOM = 14;

/** Where a place with no bounding box lands — a town, roughly framed. */
const PLACE_ZOOM = 10;

const PADDING = 60;

function parseCoordinates(input: string): { lat: number; lon: number } | null {
  for (const re of COORD_RES) {
    const m = input.match(re);
    if (!m) continue;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  }
  return null;
}

export function LocationSearch() {
  const { map, grid } = useExploreMap();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The place a name resolved to, so the reader can see what was understood. */
  const [found, setFound] = useState<string | null>(null);
  /** Only the newest search may write to the state — Nominatim is queued, so a
   *  second Enter can otherwise be overtaken by the answer to the first. */
  const runRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const lookupTile = useCallback(
    (name: string): GridTile | null => {
      if (!grid) return null;
      // Zone padding is not something a reader should have to guess. The grid
      // may hold 01VCK or 1VCK depending on how it was written, and both are
      // the same tile — so try what was typed, then the other form of it.
      const q = name.toUpperCase();
      const zoneless = q.replace(/^0+/, '');
      const padded = /^\d[A-Z]/.test(q) ? `0${q}` : q;
      return grid.byName.get(q) ?? grid.byName.get(padded) ?? grid.byName.get(zoneless) ?? null;
    },
    [grid],
  );

  const search = useCallback(async () => {
    if (!map) return;
    const q = value.trim();
    if (!q) return;

    const run = ++runRef.current;
    setError(null);
    setFound(null);

    // 1. Coordinates.
    const coords = parseCoordinates(q);
    if (coords) {
      takeCamera(map);
      map.easeTo({ center: [coords.lon, coords.lat], zoom: POINT_ZOOM, duration: 900 });
      return;
    }

    // 2. A tile name, if it is shaped like one. Anything shaped like a tile is
    //    treated as one even when the grid cannot answer: "32ZZZ" is a typo of
    //    a tile name, not a request for a town called 32ZZZ.
    if (TILE_RE.test(q)) {
      // The grid arrives over the network, so a search can genuinely precede
      // it. Saying so is the difference between "wait a moment" and "that tile
      // does not exist", which are not the same advice.
      if (!grid) {
        setError('Tile index still loading — try again in a moment.');
        return;
      }

      const tile = lookupTile(q);
      if (!tile) {
        setError(`No Sentinel-2 tile named ${q.toUpperCase()}.`);
        return;
      }

      takeCamera(map);
      // Frame the whole tile: a tile is ~110 km across, and what you asked for
      // is the tile, not its centre. Landing on it also puts the view past the
      // prediction layers' zoom threshold, so the 10 m data starts arriving.
      map.fitBounds(tile.bbox, { padding: PADDING, duration: 900, maxZoom: 11 });
      return;
    }

    // 3. A place name. The only branch that leaves the browser, so it is the
    //    only one that can be slow — hence the spinner and the guard below.
    setBusy(true);
    const place = await searchPlace(q);
    setBusy(false);
    if (run !== runRef.current) return;

    if (!place) {
      setError(`Nothing found for "${q}".`);
      return;
    }

    takeCamera(map);
    if (place.bbox) {
      // maxZoom, because a bounding box for a village is a few hundred metres
      // and fitting it exactly would put the reader inside a single pixel of
      // prediction. A country's box is left to fit as it is.
      map.fitBounds(place.bbox, { padding: PADDING, duration: 900, maxZoom: POINT_ZOOM });
    } else {
      map.easeTo({ center: [place.lon, place.lat], zoom: PLACE_ZOOM, duration: 900 });
    }
    // What the name was taken to mean. "Springfield" resolving to Illinois is
    // not an error, but it is worth being able to see without panning around.
    setFound(place.address);
  }, [map, value, grid, lookupTile]);

  // Focus on open, so the icon is one click rather than a click and an aim.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = useCallback(() => {
    runRef.current++;
    setOpen(false);
    setValue('');
    setError(null);
    setFound(null);
    setBusy(false);
  }, []);

  if (!open) {
    return (
      <button
        type="button"
        className="ex-search__open"
        onClick={() => setOpen(true)}
        title="Find a place, a tile or coordinates"
        aria-label="Find a place, a tile or coordinates"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M10 4a6 6 0 1 0 3.5 10.9l4.8 4.8 1.4-1.4-4.8-4.8A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
          />
        </svg>
      </button>
    );
  }

  return (
    // Collapsed to an icon by default, because the site card opens top-centre
    // and a field parked here permanently would be half under it. Expanded it
    // overlaps that card's left edge for as long as someone is typing, which is
    // the moment they are not reading it.
    <div className="ex-search" role="search">
      <div className="ex-search__row">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path
            fill="currentColor"
            d="M10 4a6 6 0 1 0 3.5 10.9l4.8 4.8 1.4-1.4-4.8-4.8A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
          />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={value}
          placeholder="Place, MGRS tile, or coordinates"
          aria-label="Place name, tile name or coordinates"
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            setFound(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
            if (e.key === 'Escape') close();
          }}
        />
        <button type="button" onClick={close} aria-label="Close search">
          ×
        </button>
      </div>
      {/* One line, four states. Kept to one so the card does not change height
          under the reader's pointer as it goes from hint to answer.

          The default says the coordinate order — latitude first, as the full
          app takes it and as the reading card prints it, so a pair copied off
          the map goes straight back in. It is the one thing here a reader
          cannot guess, and the other order is just as plausible. */}
      {error ? (
        <p className="ex-search__error">{error}</p>
      ) : busy ? (
        <p className="ex-search__hint">Searching…</p>
      ) : found ? (
        <p className="ex-search__found" title={found}>
          {found}
        </p>
      ) : (
        <p className="ex-search__hint">Coordinates are latitude, longitude.</p>
      )}
    </div>
  );
}
