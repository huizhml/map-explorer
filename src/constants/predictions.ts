/**
 * Pipeline version of the prediction outputs. Only year==2020 has on-disk
 * versioned tiles — 'original' is the raw model output, 'blended' fills
 * cross-tile seams, 'masked' applies the no-vegetation mask.
 */
export type VsmVersion = 'original' | 'blended' | 'masked';

export const VSM_VERSION_OPTIONS: ReadonlyArray<VsmVersion> = ['original', 'blended', 'masked'];

export const DEFAULT_VSM_VERSION: VsmVersion = 'original';

/** Single quantiles: 5%, median, 95%. Ranges: 95%-5%, 95%-50%, 50%-5%. Skewness. */
export type VsmQChoice =
  | '5%'
  | 'median'
  | '95%'
  | '95%-5%'
  | '95%-50%'
  | '50%-5%'
  | 'skewness';

export type VsmLayerEntry = {
  year: 2020 | 2024;
  rhIndex: number;
  qChoice: VsmQChoice;
  version: VsmVersion;
};

/** Maps qChoice to short label used in layer IDs (Q0, Q1, Q2 or range 0-Q2, 0-Q1, 1-Q2). */
function getQLabelForId(qChoice: VsmQChoice): string {
  switch (qChoice) {
    case '5%':
      return 'Q2';
    case 'median':
      return 'Q1';
    case '95%':
      return 'Q0';
    case '95%-5%':
      return '0-Q2';
    case '95%-50%':
      return '0-Q1';
    case '50%-5%':
      return '1-Q2';
    case 'skewness':
      return 'skewness';
    default:
      return String(qChoice);
  }
}

export function getVsmLayerId(entry: VsmLayerEntry): string {
  const qLabel = getQLabelForId(entry.qChoice);
  const versionSuffix = entry.year === 2020 ? `-${entry.version}` : '';
  return `prediction-global-RH${entry.rhIndex}-${qLabel}-${entry.year}${versionSuffix}`;
}

/** Intervals decompose into (high_q_index, low_q_index) pairs of single-Q
 *  files that get subtracted on the fly by /predictions/interval-tile. */
export type IntervalQChoice = '95%-5%' | '95%-50%' | '50%-5%';

export function isIntervalQChoice(q: VsmQChoice): q is IntervalQChoice {
  return q === '95%-5%' || q === '95%-50%' || q === '50%-5%';
}

export function getIntervalQIndexes(q: IntervalQChoice): { high: number; low: number } {
  switch (q) {
    case '95%-5%':
      return { high: 0, low: 2 };
    case '95%-50%':
      return { high: 0, low: 1 };
    case '50%-5%':
      return { high: 1, low: 2 };
  }
}

/** API q_index: 0, 1, 2 for single quantile; '0-Q2', '0-Q1', '1-Q2' for ranges. */
export function getQIndexForApi(qChoice: VsmQChoice): number | string {
  switch (qChoice) {
    case '5%':
      return 2;
    case 'median':
      return 1;
    case '95%':
      return 0;
    case '95%-5%':
      return '0-Q2';
    case '95%-50%':
      return '0-Q1';
    case '50%-5%':
      return '1-Q2';
    case 'skewness':
      return 'skewness';
    default:
      return 1;
  }
}

/** RH10 and RH25 read on one shared scale.
 *
 *  They sit far below RH98 in absolute terms, and the 500 fallback squeezes
 *  both into the bottom fifth of the colormap, where they stop being
 *  distinguishable from each other. One shared ceiling rather than a value
 *  each, because the two are looked at in comparison: a scale that moved with
 *  the level would make them render alike when the point is that they differ.
 *
 *  RH50 is deliberately absent — it belongs with RH98 on the full 0-500 scale,
 *  since the canopy median runs high enough that 120 clips it. Leaving it out
 *  of the table is what puts it there. */
const LOW_RH_RESCALE_MAX = 120;

export const DEFAULT_RESCALE_MAX_BY_RH: Record<number, number> = {
  10: LOW_RH_RESCALE_MAX,
  25: LOW_RH_RESCALE_MAX,
};

const FALLBACK_RESCALE_MAX = 500;

export function getDefaultRescaleForRh(rhIndex: number): { min: number; max: number } {
  return {
    min: 0,
    max: DEFAULT_RESCALE_MAX_BY_RH[rhIndex] ?? FALLBACK_RESCALE_MAX,
  };
}

/** Per-(rh, interval) max overrides — intervals cluster much higher than the
 *  single-Q range, so the absolute-height defaults clip them too aggressively.
 *  Anything not in this table falls back to getDefaultRescaleForRh. */
const INTERVAL_RESCALE_MAX: Partial<Record<IntervalQChoice, Record<number, number>>> = {
  '95%-5%': { 98: 300, 50: 300, 25: 200, 10: 200 },
};

/** Rescale and colormap for visualization. Skewness (e.g. RH98) uses -40..180 and RdBu.
 *  Intervals (95%-5%, 95%-50%, 50%-5%) default to mako, which reads better than
 *  inferno for difference magnitudes that cluster near zero. */
export function getDefaultRescaleAndColormap(
  rhIndex: number,
  qChoice: VsmQChoice
): { min: number; max: number; colormap: string } {
  if (qChoice === 'skewness' && rhIndex === 98) {
    return { min: -40, max: 180, colormap: 'RdBu' };
  }
  if (isIntervalQChoice(qChoice)) {
    const override = INTERVAL_RESCALE_MAX[qChoice]?.[rhIndex];
    const max = override ?? getDefaultRescaleForRh(rhIndex).max;
    return { min: 0, max, colormap: 'mako' };
  }
  const rescale = getDefaultRescaleForRh(rhIndex);
  return { ...rescale, colormap: 'inferno' };
}
