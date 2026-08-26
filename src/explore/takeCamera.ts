import type Map from 'ol/Map';

/**
 * Stop whatever is currently moving the view, before moving it yourself.
 *
 * Two things make this necessary, and neither is obvious at the call site.
 *
 * OpenLayers does not replace a running animation with a new one. It keeps a
 * list of them, and `updateAnimations_` walks that list *backwards* — so the
 * oldest animation is the one that writes the target centre last, and wins
 * every frame. A `fit` or `animate` started while another is in the air does
 * not blend with it or take over from it: it loses, silently, and the view ends
 * up wherever the earlier one was going.
 *
 * And the page has one animation nobody asked for: RandomSite's opening fly-in,
 * 1.4 s of held global view followed by a 2.8 s flight into a random site. It
 * cancels itself on `pointerdown`/`wheel` over the map, which covers a reader
 * who grabs the map — but every control that moves the view (the search box,
 * the random-site button) lives in an overlay *outside* the viewport, so none
 * of them trip it. RandomSite publishes its cancel on the map object for this
 * function to find; `exCancelIntro` is absent once the flight is over or was
 * never scheduled, which is why the call is optional.
 *
 * Call this immediately before any `view.fit` or `view.animate` that the reader
 * asked for. The symptom it prevents is a move that appears not to have
 * happened — or, worse, one that lands somewhere unrelated.
 */
export function takeCamera(map: Map): void {
  (map.get('exCancelIntro') as (() => void) | undefined)?.();
  map.getView().cancelAnimations();
}
