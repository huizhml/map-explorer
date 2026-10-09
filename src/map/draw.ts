import type { Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { VectorLayer, type FeatureStyle } from './vector';
import type { LonLat } from './proj';

/**
 * Drawing on the map — what the app used OpenLayers' Draw interaction for.
 *
 * Same gestures as before, so nothing has to be relearned:
 *
 *   box         click a corner, move, click the opposite corner. Shift makes it
 *               a square (in screen space, which is Web Mercator's).
 *   LineString  click each vertex, double-click to finish. Shift makes the
 *               segment being drawn horizontal.
 *   Polygon     click each vertex, double-click (or click the first vertex) to
 *               close.
 *   Point       one click.
 *
 * Dragging still pans while a shape is in progress, because MapLibre does not
 * fire `click` at the end of a drag. Double-click zoom and Shift-drag box zoom
 * are switched off for the duration: their gestures mean "finish" and
 * "constrain" here. Escape abandons the shape in progress.
 */

export type DrawType = 'box' | 'LineString' | 'Polygon' | 'Point';

export type DrawOptions = {
  type: DrawType;
  /** How the shape in progress is drawn. */
  sketch?: { line?: FeatureStyle; vertex?: FeatureStyle };
  /** The first vertex is placed. */
  onStart?: () => void;
  /** Geometry in longitude/latitude. The draw stays active; call stop() to end it. */
  onEnd: (geometry: GeoJSON.Polygon | GeoJSON.LineString | GeoJSON.Point) => void;
  /** Shift pressed — square boxes, horizontal segments. Default: on. */
  shiftConstrains?: boolean;
};

export type DrawHandle = { stop: () => void };

const DEFAULT_LINE: FeatureStyle = { stroke: '#1976d2', strokeWidth: 3, dashed: true, fill: 'rgba(25,118,210,0.1)' };
const DEFAULT_VERTEX: FeatureStyle = { circle: { radius: 5, fill: '#1976d2', stroke: '#ffffff', strokeWidth: 2 } };

/** Pixels within which a click on the first vertex closes a polygon. */
const CLOSE_PX = 8;

export function startDraw(map: MlMap, opts: DrawOptions): DrawHandle {
  const shiftOk = opts.shiftConstrains ?? true;
  const lineStyle = opts.sketch?.line ?? DEFAULT_LINE;
  const vertexStyle = opts.sketch?.vertex ?? DEFAULT_VERTEX;

  const sketch = new VectorLayer({
    zIndex: 9600,
    style: (f) => (f.geometry.type === 'Point' ? vertexStyle : lineStyle),
  });
  sketch.attach(map);

  let points: LonLat[] = [];
  let cursor: LonLat | null = null;
  let shift = false;

  const hadDblZoom = map.doubleClickZoom.isEnabled();
  const hadBoxZoom = map.boxZoom.isEnabled();
  map.doubleClickZoom.disable();
  map.boxZoom.disable();
  const canvas = map.getCanvasContainer();
  const prevCursor = canvas.style.cursor;
  canvas.style.cursor = 'crosshair';

  const lngLat = (e: MapMouseEvent): LonLat => [e.lngLat.lng, e.lngLat.lat];

  /** The point being placed, with Shift's constraint applied. */
  const constrained = (p: LonLat): LonLat => {
    if (!shift || !shiftOk || points.length === 0) return p;
    const prev = points[points.length - 1];
    if (opts.type === 'LineString') return [p[0], prev[1]];
    if (opts.type === 'box') {
      const a = map.project(prev);
      const b = map.project(p);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.max(Math.abs(dx), Math.abs(dy));
      const c = map.unproject([a.x + (dx >= 0 ? 1 : -1) * L, a.y + (dy >= 0 ? 1 : -1) * L]);
      return [c.lng, c.lat];
    }
    return p;
  };

  const boxRing = (a: LonLat, b: LonLat): LonLat[] => [a, [b[0], a[1]], b, [a[0], b[1]], a];

  const redraw = () => {
    const fs: GeoJSON.Feature[] = [];
    const live = cursor ? [...points, constrained(cursor)] : points;
    if (opts.type === 'box' && live.length === 2) {
      fs.push(feature({ type: 'Polygon', coordinates: [boxRing(live[0], live[1])] }));
    } else if (opts.type === 'Polygon' && live.length >= 3) {
      fs.push(feature({ type: 'Polygon', coordinates: [[...live, live[0]]] }));
    } else if (live.length >= 2) {
      fs.push(feature({ type: 'LineString', coordinates: live }));
    }
    for (const p of points) fs.push(feature({ type: 'Point', coordinates: p }));
    sketch.setFeatures(fs);
  };

  const reset = () => {
    points = [];
    cursor = null;
    redraw();
  };

  const finish = (geometry: GeoJSON.Polygon | GeoJSON.LineString | GeoJSON.Point) => {
    reset();
    opts.onEnd(geometry);
  };

  const onClick = (e: MapMouseEvent) => {
    shift = e.originalEvent.shiftKey;
    const p = constrained(lngLat(e));

    if (opts.type === 'Point') {
      opts.onStart?.();
      finish({ type: 'Point', coordinates: p });
      return;
    }

    if (opts.type === 'box') {
      if (points.length === 0) {
        points = [p];
        opts.onStart?.();
        redraw();
      } else {
        const a = points[0];
        finish({ type: 'Polygon', coordinates: [boxRing(a, p)] });
      }
      return;
    }

    if (opts.type === 'Polygon' && points.length >= 3) {
      const first = map.project(points[0]);
      const here = map.project(p);
      if (Math.hypot(first.x - here.x, first.y - here.y) <= CLOSE_PX) {
        finish({ type: 'Polygon', coordinates: [[...points, points[0]]] });
        return;
      }
    }

    if (points.length === 0) opts.onStart?.();
    points.push(p);
    redraw();
  };

  const onDblClick = (e: MapMouseEvent) => {
    if (opts.type !== 'LineString' && opts.type !== 'Polygon') return;
    e.preventDefault();
    // The two clicks of a double-click have each added a vertex at the same
    // spot; keep one.
    const pts = dedupeTail(points);
    if (opts.type === 'LineString' && pts.length >= 2) {
      finish({ type: 'LineString', coordinates: pts });
    } else if (opts.type === 'Polygon' && pts.length >= 3) {
      finish({ type: 'Polygon', coordinates: [[...pts, pts[0]]] });
    } else {
      reset();
    }
  };

  const onMove = (e: MapMouseEvent) => {
    shift = e.originalEvent.shiftKey;
    if (points.length === 0) return;
    cursor = lngLat(e);
    redraw();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') reset();
    if (e.key === 'Shift') {
      shift = e.type === 'keydown';
      if (points.length) redraw();
    }
  };

  map.on('click', onClick);
  map.on('dblclick', onDblClick);
  map.on('mousemove', onMove);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);

  return {
    stop: () => {
      map.off('click', onClick);
      map.off('dblclick', onDblClick);
      map.off('mousemove', onMove);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      sketch.detach();
      canvas.style.cursor = prevCursor;
      // Re-enabled on the next tick: the dblclick that finished a line is
      // still being dispatched, and would zoom the map if the handler were
      // back already.
      setTimeout(() => {
        if (!map.style) return;
        if (hadDblZoom) map.doubleClickZoom.enable();
        if (hadBoxZoom) map.boxZoom.enable();
      }, 0);
    },
  };
}

function feature(geometry: GeoJSON.Geometry): GeoJSON.Feature {
  return { type: 'Feature', geometry, properties: {} };
}

function dedupeTail(points: LonLat[]): LonLat[] {
  const out = [...points];
  while (out.length >= 2) {
    const a = out[out.length - 1];
    const b = out[out.length - 2];
    if (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) out.pop();
    else break;
  }
  return out;
}
