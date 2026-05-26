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
};
