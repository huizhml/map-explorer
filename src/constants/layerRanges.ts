export type LayerRange = [number, number];

export const DIVERSITY_INDICES_BAND_NAMES = ['FHD', '1D ENL', '2D ENL', 'CR'] as const;

export const DIVERSITY_INDICES_BAND_RANGES: Record<number, LayerRange> = {
  1: [0, 2],
  2: [1, 7],
  3: [1, 7],
  4: [0.48, 1],
};

export const DIVERSITY_INDICES_DEFAULT_BAND = 1;
export const DIVERSITY_INDICES_DEFAULT_COLORMAP = 'viridis';

export const DIVERSITY_INDICES_BAND_COLORMAPS: Record<number, string> = {
  1: 'viridis',
  2: 'viridis',
  3: 'viridis',
  4: 'rdbu',
};

export const CANOPY_RATIO_RANGE: LayerRange = DIVERSITY_INDICES_BAND_RANGES[4];
export const PROFILE_ENTROPY_FHD_RANGE: LayerRange = DIVERSITY_INDICES_BAND_RANGES[1];
export const PROFILE_ENTROPY_1D_ENL_RANGE: LayerRange = DIVERSITY_INDICES_BAND_RANGES[2];
export const PROFILE_ENTROPY_2D_ENL_RANGE: LayerRange = DIVERSITY_INDICES_BAND_RANGES[3];

export function getDiversityBandRange(band: number): LayerRange {
  return DIVERSITY_INDICES_BAND_RANGES[band] ?? DIVERSITY_INDICES_BAND_RANGES[DIVERSITY_INDICES_DEFAULT_BAND];
}

export function getDiversityRgbRanges(rgbBands: [number, number, number]): [LayerRange, LayerRange, LayerRange] {
  return rgbBands.map((band) => getDiversityBandRange(band)) as [LayerRange, LayerRange, LayerRange];
}

export function getDiversityBandColormap(band: number): string {
  return DIVERSITY_INDICES_BAND_COLORMAPS[band] ?? DIVERSITY_INDICES_DEFAULT_COLORMAP;
}

export function getProfileEntropyRange(metric?: 'entropy' | 'enl1d' | 'enl2d'): LayerRange {
  if (metric === 'enl1d') return PROFILE_ENTROPY_1D_ENL_RANGE;
  if (metric === 'enl2d') return PROFILE_ENTROPY_2D_ENL_RANGE;
  return PROFILE_ENTROPY_FHD_RANGE;
}
