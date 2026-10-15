/**
 * Single source of truth for titiler colormap names used across the UI.
 *
 * The strings are sent verbatim to titiler (tile rendering) and to the
 * backend save-figures endpoint, which maps them to matplotlib names in
 * `_TITILER_TO_MPL_CMAP` (see backend/routes/auxiliary.py). When adding a
 * new colormap here, also add the matplotlib translation there if the
 * matplotlib name differs in case (e.g. `rdgy` → `RdGy`).
 */
export const COLORMAPS = [
  'greens', 'viridis', 'inferno', 'magma', 'plasma', 'cividis', 'mako',
  'ylgn', 'ylgnbu', 'gnbu', 'bugn', 'pubu', 'rdylgn',
  'spectral', 'rdbu', 'rdgy', 'greys', 'blues', 'reds', 'oranges',
  'ylgn_r', 'spectral_r', 'rdbu_r',
  // Flooded-forest ramps, registered in backend/colormaps_extra.py.
  'ff_flood_duration', 'ff_water_occurrence', 'ff_dtm',
] as const;

export type ColormapName = (typeof COLORMAPS)[number];

/**
 * Optional 5-stop gradients for the on-map colorbar legend
 * ({@link MapColorbarOverlay}). Missing entries fall back to a grey ramp,
 * so adding a colormap here is not required for it to appear in the
 * dropdown — just for a nicer-looking legend swatch.
 */
export const COLORMAP_GRADIENTS: Record<string, string[]> = {
  inferno: ['#000004', '#420a68', '#932667', '#dd513a', '#fba40a', '#fcffa4'],
  mako: ['#0b0405', '#382a54', '#395d9c', '#3497a9', '#60ceac', '#def5e5'],
  greens: ['#f7fcf5', '#d9f0d3', '#a6dba0', '#5aae61', '#1b7837', '#00441b'],
  ylgn_r: ['#004529', '#238443', '#78c679', '#c2e699', '#ffffcc'],
  rdbu: ['#67001f', '#d6604d', '#f7f7f7', '#4393c3', '#053061'],
  rdgy: ['#67001f', '#d6604d', '#f7f7f7', '#878787', '#1a1a1a'],
  // Same stops as backend/colormaps_extra.py FLOODED_FOREST_RAMPS.
  ff_flood_duration: ['#f2ead3', '#d6dca0', '#9bc16b', '#4f9a4a', '#1e5b34', '#0b0b0b'],
  ff_water_occurrence: ['rgba(222,235,247,0)', '#9ecae1', '#4292c6', '#2171b5', '#08306b'],
  ff_dtm: ['#2c5aa0', '#4a9fc1', '#7cc7a4', '#b4dd9a', '#e4eb9f', '#f3d58a', '#d9a05b', '#a8693a', '#6b4226'],
};
