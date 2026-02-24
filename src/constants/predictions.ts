/** Default rescale max by RH index for prediction visualization. Fallback 500. */

export type VsmLayerEntry = {
  year: 2020 | 2024;
  rhIndex: number;
  qChoice: '5%' | 'median' | '95%';
};

export function getVsmLayerId(entry: VsmLayerEntry): string {
  const qLabel = entry.qChoice === 'median' ? 'Q1' : entry.qChoice === '5%' ? 'Q2' : 'Q0';
  return `prediction-global-RH${entry.rhIndex}-${qLabel}-${entry.year}`;
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
