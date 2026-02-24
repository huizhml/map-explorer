/** Default rescale max by RH index for prediction visualization. Fallback 500. */

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
