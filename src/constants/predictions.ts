/** Default rescale max by RH index for prediction visualization. Fallback 500. */

/** Single quantiles: 5%, median, 95%. Ranges: 95%-5%, 95%-50%, 50%-5%. */
export type VsmQChoice =
  | '5%'
  | 'median'
  | '95%'
  | '95%-5%'
  | '95%-50%'
  | '50%-5%';

export type VsmLayerEntry = {
  year: 2020 | 2024;
  rhIndex: number;
  qChoice: VsmQChoice;
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
    default:
      return String(qChoice);
  }
}

export function getVsmLayerId(entry: VsmLayerEntry): string {
  const qLabel = getQLabelForId(entry.qChoice);
  return `prediction-global-RH${entry.rhIndex}-${qLabel}-${entry.year}`;
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
    default:
      return 1;
  }
}

export const DEFAULT_RESCALE_MAX_BY_RH: Record<number, number> = {
  25: 120,
};

const FALLBACK_RESCALE_MAX = 500;

export function getDefaultRescaleForRh(rhIndex: number): { min: number; max: number } {
  return {
    min: 0,
    max: DEFAULT_RESCALE_MAX_BY_RH[rhIndex] ?? FALLBACK_RESCALE_MAX,
  };
}
