import { useEffect, useRef } from 'react';
import type Map from 'ol/Map';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Icon, Style } from 'ol/style';
import { fromLonLat } from 'ol/proj';

/**
 * Where the reading card is reading.
 *
 * A click samples one 10 m pixel and opens a card in the corner, and until now
 * nothing on the map said which pixel. That is a long time to hold a position
 * in your head: the profile takes ~20 s to build, the card names a place and
 * prints coordinates, and none of it points anywhere. Panning in the meantime
 * lost the spot for good.
 *
 * Drawn as soon as the click lands, not when the values arrive — it is also the
 * acknowledgement that the click was heard.
 */

/**
 * The pin, as an inline SVG rather than a file.
 *
 * A data URI keeps it out of the asset pipeline, which matters more than it
 * sounds: the review build copies `public/` by hand, minus the chapter
 * artwork, so every image that is a real file is one more thing that has to be
 * on the right side of that filter to exist on the deployed site. A marker
 * that cannot go missing is worth a dozen lines of markup here.
 *
 * Drawn twice: once with a dark casing, once with a white outline. The same
 * trick as the transect line, and for the same reason — this sits over inferno,
 * which runs from near-black to near-white, so a single outline colour
 * disappears somewhere on the ramp. The white disc in the head is what stops
 * the pin reading as a solid blob at a glance.
 */
const PIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="36" viewBox="0 0 26 36">
  <path d="M13 1.6C7.3 1.6 2.9 6 2.9 11.4c0 7.4 10.1 22 10.1 22s10.1-14.6 10.1-22C23.1 6 18.7 1.6 13 1.6Z"
        fill="#10796a" stroke="rgba(0,0,0,0.5)" stroke-width="4" stroke-linejoin="round"/>
  <path d="M13 1.6C7.3 1.6 2.9 6 2.9 11.4c0 7.4 10.1 22 10.1 22s10.1-14.6 10.1-22C23.1 6 18.7 1.6 13 1.6Z"
        fill="#10796a" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>
  <circle cx="13" cy="11.3" r="3.9" fill="#fff"/>
</svg>`;

/**
 * Anchored at the tip, not the centre — the point of a pin is the one pixel it
 * touches, and everything above that is a label for it. Which is also the
 * pin's one cost, worth knowing: the head covers ground north of the reading,
 * so the pixel the card is describing is the one under the tip, not the one
 * behind the disc.
 */
const MARKER_STYLE = new Style({
  image: new Icon({
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(PIN_SVG)}`,
    anchor: [0.5, 1],
    scale: 1,
  }),
});

export function InspectMarker({ map, lon, lat }: { map: Map | null; lon?: number; lat?: number }) {
  const layerRef = useRef<VectorLayer<VectorSource> | null>(null);

  // Above the transect line at 900, which is the only other thing drawn over
  // the predictions: a reading taken *on* a transect must still be findable.
  useEffect(() => {
    if (!map) return;
    const layer = new VectorLayer({ source: new VectorSource(), style: MARKER_STYLE, zIndex: 1000 });
    map.addLayer(layer);
    layerRef.current = layer;
    return () => {
      map.removeLayer(layer);
      layerRef.current = null;
    };
  }, [map]);

  // `map` is in the deps as well as the coordinates: the effect above builds a
  // fresh, empty layer whenever the map changes, and this is what puts the mark
  // back into it.
  useEffect(() => {
    const source = layerRef.current?.getSource();
    if (!source) return;
    source.clear();
    if (lon === undefined || lat === undefined) return;
    source.addFeature(new Feature(new Point(fromLonLat([lon, lat]))));
  }, [map, lon, lat]);

  return null;
}
