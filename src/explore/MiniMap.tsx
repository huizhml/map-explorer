import { useEffect, useRef, useState } from 'react';
import { Map as MlMap } from 'maplibre-gl';
import { useExploreMap } from './exploreMap';

/**
 * Locator map, bottom-right.
 *
 * Not OpenLayers' OverviewMap control, which was the first attempt (when the
 * page was still on OpenLayers): that one
 * sizes itself so the main map's viewport fills a fixed fraction of the
 * thumbnail, so it zooms in lockstep with the main map. At 1:17,000 in the
 * Congo it showed the same anonymous stretch of forest, one step out — which
 * answers nothing.
 *
 * This stays at one fixed zoom whatever the main map does, so a site jump
 * always lands somewhere recognisable: a country, a coastline, a lake.
 */

/** ~4,500 km across the box at the equator — continent scale. */
const LOCATOR_ZOOM = 2;

/**
 * Below this the main map is already showing a continent or more, so the
 * locator has nothing to add — and its centre marker, floating on a world view
 * before anything has been visited, reads as a site someone has been to.
 */
const SHOW_ABOVE_ZOOM = LOCATOR_ZOOM + 1;

export function MiniMap() {
  const { map } = useExploreMap();
  const ref = useRef<HTMLDivElement | null>(null);
  const [zoomedIn, setZoomedIn] = useState(false);

  useEffect(() => {
    const container = ref.current;
    if (!map || !container) return;

    const mini = new MlMap({
      container,
      style: {
        version: 8,
        sources: {
          osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256 },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: map.getCenter(),
      zoom: LOCATOR_ZOOM,
      // A picture, not a map you can drive: no controls, no interactions. The
      // attribution the OSM tiles need is already on the main map.
      interactive: false,
      attributionControl: false,
    });

    // The centre is followed, never the zoom. `move` rather than `moveend` so
    // the locator keeps up during a fly-to instead of jumping when it ends.
    const sync = () => {
      mini.setCenter(map.getCenter());
      setZoomedIn(map.getZoom() > SHOW_ABOVE_ZOOM);
    };
    sync();
    map.on('move', sync);

    return () => {
      map.off('move', sync);
      mini.remove();
    };
  }, [map]);

  // Faded out rather than unmounted, so the locator map keeps its size and
  // does not have to be rebuilt every time the main map crosses the threshold.
  //
  // The locator is centred on the main map's centre by construction, so the
  // marker is a fixed dot in the middle of the box (see .ex-minimap::after)
  // rather than a feature that would have to be moved to match.
  return (
    <div
      className={zoomedIn ? 'ex-minimap' : 'ex-minimap is-idle'}
      ref={ref}
      aria-hidden="true"
    />
  );
}
