/** Must divide backend `MAX_HEIGHT` used for diversity histogram bins. */
export const DIVERSITY_HEIGHT_BIN_OPTIONS = [1, 2, 5, 10] as const;

export const DEFAULT_DIVERSITY_HEIGHT_BIN_M = 5;

/** Fallback (m) for transect heatmap y-axis when API omits `heatmap_max_height`. Matches backend `HEATMAP_MAX_HEIGHT`. */
export const DEFAULT_HEATMAP_MAX_HEIGHT_M = 50;

/** Upper bound for transect energy (%) color scale; values above map to max color. */
export const HEATMAP_COLORMAP_MAX = 5;
