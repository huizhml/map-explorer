import { useCallback, useEffect, useRef, useState } from 'react';
import type { Marker } from 'maplibre-gl';
import { takeCamera, useExploreMap } from './exploreMap';
import { createPositionMarker, getPosition, showPosition } from '../utils/geolocate';

/**
 * Go to where the reader is.
 *
 * MapLibre ships a GeolocateControl, but it brings its own button into its own
 * corner container, and the explore page's controls are plain React elements
 * placed by explore.css. This is the part of it the page needs; the full app's
 * search bar has the same button, through the same helpers.
 */

/** Same landing zoom as a coordinate search — as close as the 10 m pixels go. */
const POINT_ZOOM = 14;

/** The mosaics' latitude range; a position outside it has nothing to show. */
const DATA_LAT: [number, number] = [-56.0371, 82.8529];

export function LocateMe() {
  const { map } = useExploreMap();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markerRef = useRef<Marker | null>(null);

  useEffect(() => {
    if (!map) return;
    markerRef.current = createPositionMarker();
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, [map]);

  // The message is a toast, not a state: it says why the click did nothing.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  const locate = useCallback(async () => {
    if (!map || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { lon, lat } = await getPosition();
      // maxBounds would clamp the camera to the data's edge anyway; say so
      // rather than land somewhere that is not where the dot is.
      if (lat < DATA_LAT[0] || lat > DATA_LAT[1]) {
        markerRef.current?.setLngLat([lon, lat]).addTo(map);
        setError('You are outside the area the map covers.');
        return;
      }
      takeCamera(map);
      if (markerRef.current) showPosition(map, markerRef.current, lon, lat, POINT_ZOOM);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [map, busy]);

  return (
    <div className="ex-locate">
      <button
        type="button"
        className={`ex-locate__btn${busy ? ' is-busy' : ''}`}
        onClick={() => void locate()}
        disabled={!map}
        title="Go to my location"
        aria-label="Go to my location"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9 3h-2.07A7 7 0 0 0 13 5.07V3h-2v2.07A7 7 0 0 0 5.07 11H3v2h2.07A7 7 0 0 0 11 18.93V21h2v-2.07A7 7 0 0 0 18.93 13H21v-2Zm-9 6a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z"
          />
        </svg>
      </button>
      {error && (
        <p className="ex-locate__error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
