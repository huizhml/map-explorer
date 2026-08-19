import { COLORMAP_GRADIENTS } from '../constants/colormaps';
import {
  getDefaultRescaleAndColormap,
  type VsmQChoice,
} from '../constants/predictions';
import type { ExploreLayer } from './LayerControl';

/**
 * The rasters are int16 decimetres — the same units formatHeight divides down
 * in SimpleApp — while the rescale bounds are in those raw units. The scale
 * bar is read by people, so it is labelled in metres.
 */
const DECIMETRES_TO_M = 0.1;

export type ColorRamp = {
  key: string;
  colormap: string;
  /** Raw rescale bounds, as sent to titiler. */
  min: number;
  max: number;
  /** Every visible layer drawn with this ramp, highest RH first. */
  rhIndexes: number[];
};

/**
 * One ramp per distinct (colormap, min, max). The explore page only publishes
 * the median quantile, so the colormap is always inferno — but the range is
 * not shared: RH25 tops out at 120 where the rest top out at 500, and drawing
 * one bar for both would misread the shorter layer by a factor of four.
 *
 * Hidden layers are left out: the bar describes what is on the map.
 */
export function buildRamps(layers: ExploreLayer[], qChoice: VsmQChoice): ColorRamp[] {
  const byKey = new Map<string, ColorRamp>();

  for (const layer of layers) {
    if (!layer.visible) continue;
    const { min, max, colormap } = getDefaultRescaleAndColormap(layer.rhIndex, qChoice);
    const key = `${colormap}|${min}|${max}`;
    const existing = byKey.get(key);
    if (existing) existing.rhIndexes.push(layer.rhIndex);
    else byKey.set(key, { key, colormap, min, max, rhIndexes: [layer.rhIndex] });
  }

  const ramps = [...byKey.values()];
  for (const ramp of ramps) ramp.rhIndexes.sort((a, b) => b - a);
  // Tallest range first, so the bars do not reorder as layers come and go.
  return ramps.sort((a, b) => b.max - a.max);
}

function gradient(colormap: string): string {
  // Grey fallback rather than nothing: an unrecognised colormap should still
  // show the range it maps to.
  const stops = COLORMAP_GRADIENTS[colormap.toLowerCase()] ?? ['#222', '#bbb', '#fff'];
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function metres(raw: number): string {
  const m = raw * DECIMETRES_TO_M;
  return Number.isInteger(m) ? String(m) : m.toFixed(1);
}

/**
 * Horizontal colour scale for the layers currently drawn. Horizontal because it
 * lives in the layer card, which is far wider than it is tall.
 */
export function Colorbar({ ramps }: { ramps: ColorRamp[] }) {
  if (!ramps.length) return null;

  return (
    <div className="ex-colorbar">
      {ramps.map((ramp) => (
        <div key={ramp.key} className="ex-colorbar__item">
          <div className="ex-colorbar__caption">
            {/* Naming the layers only matters when a second ramp exists to tell
                them apart from. */}
            {ramps.length > 1
              ? ramp.rhIndexes.map((rh) => `RH${rh}`).join(', ')
              : 'Height'}
            <span className="ex-colorbar__unit"> · m</span>
          </div>
          <div
            className="ex-colorbar__ramp"
            style={{ background: gradient(ramp.colormap) }}
            role="img"
            aria-label={`${ramp.colormap} colour scale, ${metres(ramp.min)} to ${metres(ramp.max)} metres`}
          />
          <div className="ex-colorbar__ticks">
            <span>{metres(ramp.min)}</span>
            <span>{metres((ramp.min + ramp.max) / 2)}</span>
            <span>{metres(ramp.max)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
