import type { AppFeature, FeatureStyle, StyleFn, VectorLayer } from '../map/vector';

export const SELECTIVE_LOGGING_LAYER_ID = 'selective-logging';
export const SELECTIVE_LOGGING_LAYER_TYPE = 'selective_logging';

// Categories seen so far get fixed colours; anything else takes the next free
// one, so a new category in the spreadsheet still shows up distinctly.
const KNOWN_COLORS: Record<string, string> = {
  "Area that's missing": '#e65100',
  Stump: '#6a1b9a',
};
const FALLBACK_COLORS = ['#00897b', '#c62828', '#1565c0', '#f9a825', '#4e342e', '#ad1457'];

export function selectiveLoggingCategoryColors(categories: string[]): Record<string, string> {
  const colors: Record<string, string> = {};
  let next = 0;
  for (const c of categories) {
    colors[c] = KNOWN_COLORS[c] ?? FALLBACK_COLORS[next++ % FALLBACK_COLORS.length];
  }
  return colors;
}

/**
 * Style that hides features outside the layer's `dateRange` (epoch ms, set with
 * `applySelectiveLoggingDateRange`) and colours the rest by category.
 */
export function makeSelectiveLoggingStyle(layer: VectorLayer, colors: Record<string, string>): StyleFn {
  const cache = new Map<string, FeatureStyle>();
  const styleFor = (category: string) => {
    let s = cache.get(category);
    if (!s) {
      s = { circle: { radius: 5, fill: colors[category] ?? '#757575', stroke: 'rgba(255, 255, 255, 0.9)', strokeWidth: 1 } };
      cache.set(category, s);
    }
    return s;
  };
  return (feature) =>
    isInDateRange(feature, layer.get<[number, number]>('dateRange')) ? styleFor(String(feature.properties.category)) : null;
}

export function isInDateRange(feature: AppFeature, range: [number, number] | undefined): boolean {
  if (!range) return true;
  const ts = feature.properties.reported_ts as number;
  return ts >= range[0] && ts <= range[1];
}

/** Applies a date range to the layer and returns how many features it keeps. */
export function applySelectiveLoggingDateRange(layer: VectorLayer, range: [number, number]): number {
  layer.set('dateRange', range);
  // The style reads the range; setting it again is what re-runs it.
  layer.setStyle(makeSelectiveLoggingStyle(layer, layer.get<Record<string, string>>('categoryColors') ?? {}));
  return layer.getFeatures().reduce((n, f) => n + (isInDateRange(f, range) ? 1 : 0), 0);
}
