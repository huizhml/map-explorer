/**
 * Coordinates to a place name, via OpenStreetMap's Nominatim.
 *
 * Called straight from the browser rather than proxied through the backend:
 * the public deployment's backend is read-only and the reviewer site is served
 * as static files, so there is nowhere to put a proxy without adding a route
 * that exists only for this. The consequence is that a viewer's clicked
 * coordinates go to openstreetmap.org.
 *
 * Nominatim's usage policy allows at most one request per second and asks that
 * results be cached, both of which are enforced below. Zoom 14 is the
 * village/suburb level — detailed enough to name a place, without the
 * building-level noise that the default returns for a forest transect.
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
const MIN_INTERVAL_MS = 1100;
const ZOOM = 14;

export type Place = {
  /** Full address line, as the provider formats it. */
  address: string;
  /** Most specific populated place found — city, town, village or county. */
  city?: string;
  country?: string;
};

/** ~100 m — finer than the zoom level resolves, so two clicks on one village share an answer. */
function cacheKey(lon: number, lat: number): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

const cache = new Map<string, Place | null>();

// Requests are run one at a time, a second apart. Map clicks arrive far faster
// than that, and a burst is the one thing the usage policy asks callers not to
// send.
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function throttle<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return run();
  });
  queue = result.catch(() => undefined);
  return result;
}

type NominatimAddress = Record<string, string | undefined>;

function pickCity(address: NominatimAddress): string | undefined {
  // In descending order of specificity. Rural sites — which most of these are —
  // often have nothing above `county`, and stopping at `city` would leave them
  // showing a country and nothing else.
  return (
    address.city ??
    address.town ??
    address.village ??
    address.hamlet ??
    address.municipality ??
    address.suburb ??
    address.county ??
    address.state
  );
}

/**
 * Returns null when the point has no place name (open ocean, Antarctica) or the
 * lookup fails. Failures are not cached, so a later click can retry; a genuine
 * "nothing here" is.
 */
export async function reverseGeocode(lon: number, lat: number): Promise<Place | null> {
  const key = cacheKey(lon, lat);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const place = await throttle(async () => {
      // accept-language=en pinned: without it the provider answers in the
      // viewer's browser language, so the same site reads "Brasil" for one
      // reviewer and "Brazil" for another.
      const url =
        `${ENDPOINT}?format=jsonv2&lat=${lat}&lon=${lon}` +
        `&zoom=${ZOOM}&addressdetails=1&accept-language=en`;
      const resp = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data || data.error || !data.display_name) return null;

      const address: NominatimAddress = data.address ?? {};
      return {
        address: String(data.display_name),
        city: pickCity(address),
        country: address.country,
      } satisfies Place;
    });
    cache.set(key, place);
    return place;
  } catch {
    return null;
  }
}

/** "City, Country", falling back to whichever half exists. Empty when neither does. */
export function placeLabel(place: Place): string {
  return [place.city, place.country].filter(Boolean).join(', ');
}
