import { Marker, type Map as MlMap } from 'maplibre-gl';

/**
 * The reader's own position, for the "go to my location" buttons on both pages.
 *
 * Asked once per click rather than watched: these are maps you look things up
 * on, not ones you navigate by, so following the reader around would only
 * fight them for the camera.
 */

/** Rejects with a sentence fit to show the reader. */
export function getPosition(): Promise<{ lon: number; lat: number }> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser cannot share its location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lon: coords.longitude, lat: coords.latitude }),
      (err) => reject(new Error(describe(err))),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

function describe(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'Location permission was denied.';
    case err.POSITION_UNAVAILABLE:
      return 'Your location is unavailable.';
    case err.TIMEOUT:
      return 'Finding your location timed out.';
    default:
      return 'Could not find your location.';
  }
}

/**
 * The blue dot. Styled inline rather than by class, so it looks the same on a
 * page whose stylesheet does not know about it. Blue, as every map app draws
 * it, so it is not taken for a reading pin.
 */
export function createPositionMarker(): Marker {
  const el = document.createElement('div');
  Object.assign(el.style, {
    width: '14px',
    height: '14px',
    borderRadius: '999px',
    background: '#1a73e8',
    boxShadow: '0 0 0 3px #fff, 0 1px 4px rgba(0, 0, 0, 0.45)',
    pointerEvents: 'none',
  });
  return new Marker({ element: el });
}

/** Drop the dot and fly there, no further out than `zoom`. */
export function showPosition(map: MlMap, marker: Marker, lon: number, lat: number, zoom: number): void {
  marker.setLngLat([lon, lat]).addTo(map);
  map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom), duration: 900 });
}
