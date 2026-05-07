import type { Coordinate } from 'ol/coordinate';
import type { Condition } from 'ol/events/condition';
import { primaryAction } from 'ol/events/condition';
import {
  boundingExtent,
  getBottomLeft,
  getBottomRight,
  getTopLeft,
  getTopRight,
} from 'ol/extent';
import LineString from 'ol/geom/LineString';
import Polygon from 'ol/geom/Polygon';
import { createBox, type GeometryFunction } from 'ol/interaction/Draw';
import type Projection from 'ol/proj/Projection';
import { fromUserCoordinate, getUserProjection } from 'ol/proj';

type ShiftRef = { current: boolean };

/**
 * OpenLayers Draw defaults to {@link import('ol/events/condition').noModifierKeys}, which rejects
 * pointer-down/up while Shift is held—so clicks and double-clicks to finish never run.
 * Use this when Shift only affects the geometry function (horizontal segment, square box).
 */
export const primaryPointerAllowShift: Condition = (event) => {
  const e = event.originalEvent as MouseEvent | PointerEvent;
  if (e.altKey || e.metaKey || e.ctrlKey) return false;
  return primaryAction(event);
};

/** Keeps `shiftRef` in sync with Shift for geometry helpers that cannot read key state from events. */
export function bindShiftKeyRef(
  mapEl: HTMLElement | null,
  shiftRef: ShiftRef,
): () => void {
  const sync = (e: KeyboardEvent | PointerEvent | MouseEvent) => {
    shiftRef.current = 'shiftKey' in e && e.shiftKey;
  };
  window.addEventListener('keydown', sync);
  window.addEventListener('keyup', sync);
  mapEl?.addEventListener('pointermove', sync);
  mapEl?.addEventListener('pointerdown', sync);
  return () => {
    window.removeEventListener('keydown', sync);
    window.removeEventListener('keyup', sync);
    mapEl?.removeEventListener('pointermove', sync);
    mapEl?.removeEventListener('pointerdown', sync);
  };
}

/**
 * While Shift is held, constrains each new segment to horizontal (constant Y in map projection).
 */
export function horizontalLineWhenShift(shiftRef: ShiftRef): GeometryFunction {
  return (coordinates, geometry, _projection) => {
    const coords = coordinates as Coordinate[];
    const next = coords.map((c) => [c[0], c[1]] as Coordinate);
    if (shiftRef.current && next.length >= 2) {
      const anchor = next[next.length - 2];
      next[next.length - 1][1] = anchor[1];
    }
    if (geometry) {
      (geometry as LineString).setCoordinates(next);
    } else {
      geometry = new LineString(next);
    }
    return geometry;
  };
}

const boxFromExtent = (
  extent: [number, number, number, number],
  geometry: Polygon | undefined,
  projection: Projection,
): Polygon => {
  const boxCoordinates = [
    [
      getBottomLeft(extent),
      getBottomRight(extent),
      getTopRight(extent),
      getTopLeft(extent),
      getBottomLeft(extent),
    ],
  ];
  if (geometry) {
    geometry.setCoordinates(boxCoordinates);
  } else {
    geometry = new Polygon(boxCoordinates);
  }
  const userProjection = getUserProjection();
  if (userProjection) {
    geometry.transform(projection, userProjection);
  }
  return geometry;
};

/**
 * Like {@link createBox}, but when Shift is held the result is an axis-aligned square
 * (side length = max of width and height of the drag), anchored at the first corner.
 */
export function createSquareWhenShift(shiftRef: ShiftRef): GeometryFunction {
  const baseBox = createBox();
  return (coordinates, geometry, projection) => {
    if (!shiftRef.current || coordinates.length < 2) {
      return baseBox(coordinates, geometry, projection);
    }
    const line = coordinates as Coordinate[];
    const ax = fromUserCoordinate(line[0], projection);
    const bx = fromUserCoordinate(line[line.length - 1], projection);
    const dx = bx[0] - ax[0];
    const dy = bx[1] - ax[1];
    const L = Math.max(Math.abs(dx), Math.abs(dy));
    const sx = dx !== 0 ? Math.sign(dx) : 1;
    const sy = dy !== 0 ? Math.sign(dy) : 1;
    const corner = [ax[0] + sx * L, ax[1] + sy * L] as Coordinate;
    const extent = boundingExtent([ax, corner]) as [number, number, number, number];
    return boxFromExtent(extent, geometry as Polygon | undefined, projection);
  };
}
