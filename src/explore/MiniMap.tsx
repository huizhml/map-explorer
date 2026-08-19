import { useEffect, useRef, useState } from 'react';
import OlMap from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import OSM from 'ol/source/OSM';

/**
 * Locator map, bottom-right.
 *
 * Not OpenLayers' OverviewMap control, which was the first attempt: that one
 * sizes itself so the main map's viewport fills a fixed fraction of the
 * thumbnail, so it zooms in lockstep with the main map. At 1:17,000 in the
 * Congo it showed the same anonymous stretch of forest, one step out — which
 * answers nothing.
 *
 * This stays at one fixed zoom whatever the main map does, so a site jump
 * always lands somewhere recognisable: a country, a coastline, a lake.
 */

/** ~4,500 km across the box at the equator — continent scale. */
const LOCATOR_ZOOM = 3;

/**
 * Below this the main map is already showing a continent or more, so the
 * locator has nothing to add — and its centre marker, floating on a world view
 * before anything has been visited, reads as a site someone has been to.
 */
const SHOW_ABOVE_ZOOM = LOCATOR_ZOOM + 1;

export function MiniMap({ map }: { map: OlMap | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [zoomedIn, setZoomedIn] = useState(false);

  useEffect(() => {
    const target = ref.current;
    if (!map || !target) return;

    const view = new View({ center: [0, 0], zoom: LOCATOR_ZOOM });
    const mini = new OlMap({
      target,
      layers: [new TileLayer({ source: new OSM() })],
      view,
      // A picture, not a map you can drive: no controls, no interactions. The
      // attribution the OSM tiles need is already on the main map.
      controls: [],
      interactions: [],
    });

    // The centre is followed, never the zoom. `change:center` rather than
    // `moveend` so the locator keeps up during the fly-to animation instead of
    // jumping when it ends.
    let bound: View | null = null;
    const sync = () => {
      const centre = map.getView().getCenter();
      if (centre) view.setCenter(centre);
    };
    const syncVisibility = () => {
      const zoom = map.getView().getZoom();
      setZoomedIn(zoom !== undefined && zoom > SHOW_ABOVE_ZOOM);
    };
    const bind = () => {
      const current = map.getView();
      if (bound === current) return;
      bound?.un('change:center', sync);
      bound?.un('change:resolution', syncVisibility);
      bound = current;
      bound.on('change:center', sync);
      bound.on('change:resolution', syncVisibility);
      sync();
      syncVisibility();
    };

    // SimpleApp swaps in a view constrained to the data extent after mount, so
    // the view bound here is not necessarily the one bound at first render.
    bind();
    map.on('change:view', bind);

    return () => {
      map.un('change:view', bind);
      bound?.un('change:center', sync);
      bound?.un('change:resolution', syncVisibility);
      mini.setTarget(undefined);
    };
  }, [map]);

  // Faded out rather than unmounted, so the OpenLayers map keeps its size and
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
