/**
 * Flooded-forest layers (Flood_duration_2020/ on hendrix). Each is a single
 * COG served by the backend at /flooded-forest/{key}/path. The colormaps are
 * the QGIS ramps shipped with the data, registered in
 * backend/colormaps_extra.py; their stops are evenly spaced over `rescale`
 * below, so keep the two in sync.
 */
export type FloodedForestLayerKey = 'flood-duration' | 'water-occurrence' | 'dtm';

export interface FloodedForestLayerConfig {
  key: FloodedForestLayerKey;
  label: string;
  colormap: string;
  rescale: [number, number];
  unit: string;
}

export const FLOODED_FOREST_LAYERS: FloodedForestLayerConfig[] = [
  {
    key: 'flood-duration',
    label: 'Flood duration 2020 (forested wetlands)',
    colormap: 'ff_flood_duration',
    rescale: [0, 366],
    unit: 'days',
  },
  {
    // GSWE water occurrence: only water not hidden by vegetation.
    key: 'water-occurrence',
    label: 'Open water occurrence (GSWE)',
    colormap: 'ff_water_occurrence',
    rescale: [0, 100],
    unit: '%',
  },
  {
    key: 'dtm',
    label: 'Terrain model (Brazilian Army)',
    colormap: 'ff_dtm',
    rescale: [31.73, 57.69],
    unit: 'm',
  },
];
