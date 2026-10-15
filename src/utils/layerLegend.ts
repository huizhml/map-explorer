import type { Layer } from '../components/LayerControl';
import { COLORMAP_GRADIENTS } from '../constants/colormaps';
import { DIVERSITY_INDICES_BAND_NAMES } from '../constants/layerRanges';

/**
 * Canopy-height rasters (anything with an RH index) are int16 decimetres, and
 * their rescale bounds are in those raw units; label them in metres. Layers
 * that set `metadata.unit` are already in that unit. Other prediction-typed
 * layers (canopy ratio, entropy, diversity, ALS/LVIS) keep their raw values
 * with no unit.
 */
const DECIMETRES_TO_M = 0.1;

export function getLayerUnit(layer: Layer): { scale: number; unit: string } {
  if (Number.isFinite(Number(layer.metadata?.rhIndex))) return { scale: DECIMETRES_TO_M, unit: 'm' };
  return { scale: 1, unit: String(layer.metadata?.unit ?? '') };
}

/** Earth Engine palette legend, as stored in `metadata.eeLegend`. */
export type EarthEngineLegendSpec = {
  min: number;
  max: number;
  palette: string[];
};

export function eeHexColor(hex: string): string {
  const s = (hex ?? '').trim();
  if (!s) return '#888888';
  return s.startsWith('#') ? s : `#${s}`;
}

/** One label per palette entry: the class value when min..max matches the palette, else "Class n". */
export function eeClassLabels(spec: EarthEngineLegendSpec): string[] {
  const { min, max, palette } = spec;
  if (palette.length === 0) return [];
  if (Number.isInteger(min) && Number.isInteger(max)) {
    const classCount = max - min + 1;
    if (classCount === palette.length) {
      return palette.map((_, i) => String(min + i));
    }
  }
  return palette.map((_, i) => `Class ${i + 1}`);
}

export type LayerLegend =
  | { kind: 'continuous'; colors: string[]; min: number; max: number; unit: string }
  | { kind: 'classes'; items: { color: string; label: string }[] };

function isDiversityRgb(layer: Layer): boolean {
  return layer.metadata?.layerType === 'diversity_indices' && layer.metadata?.bandMode === 'rgb';
}

/**
 * The legend the map shows for this layer (MapColorbarOverlay for colormapped
 * rasters, EarthEngineLegendOverlay for EE palettes), in labelled units, or
 * null when the map shows none (imagery, diversity RGB composites).
 */
export function getLayerLegend(layer: Layer): LayerLegend | null {
  const ee = layer.metadata?.eeLegend as EarthEngineLegendSpec | undefined;
  if (layer.type === 'earthengine' && ee && ee.palette?.length) {
    const labels = eeClassLabels(ee);
    return { kind: 'classes', items: ee.palette.map((c, i) => ({ color: eeHexColor(c), label: labels[i] })) };
  }
  const min = Number(layer.metadata?.rescaleMin);
  const max = Number(layer.metadata?.rescaleMax);
  const colormap = String(layer.metadata?.colormap ?? '').trim();
  if (layer.type !== 'prediction' || isDiversityRgb(layer)) return null;
  if (!colormap || !Number.isFinite(min) || !Number.isFinite(max)) return null;
  const colors = COLORMAP_GRADIENTS[colormap.toLowerCase()];
  if (!colors || colors.length < 2) return null;
  const { scale, unit } = getLayerUnit(layer);
  return { kind: 'continuous', colors, min: min * scale, max: max * scale, unit };
}

/** Layer name plus what a multi-band layer is currently showing (e.g. "· FHD"). */
export function getLayerDisplayName(layer: Layer): string {
  const meta = layer.metadata;
  if (meta?.layerType !== 'diversity_indices') return layer.name;
  const names: readonly string[] = Array.isArray(meta.bandNames) && meta.bandNames.length
    ? meta.bandNames
    : DIVERSITY_INDICES_BAND_NAMES;
  const band = (i: number) => names[i - 1] ?? `B${i}`;
  if (meta.bandMode === 'rgb' && Array.isArray(meta.rgbBands)) {
    return `${layer.name} · RGB (${(meta.rgbBands as number[]).map(band).join(' / ')})`;
  }
  return `${layer.name} · ${band(Number(meta.selectedBand) || 1)}`;
}
