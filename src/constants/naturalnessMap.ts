/**
 * Class scheme for the naturalness map (Forest Management Layer, FML v3.2;
 * Lesiv et al. 2022). Pixel values are categorical — these entries drive both
 * the discrete TiTiler colormap used to render the raster and the on-map
 * legend, so the two always stay in sync. Tweak `color` here to restyle both.
 */
export interface NaturalnessClass {
  value: number;
  color: string; // hex
  label: string;
}

export const NATURALNESS_MAP_CLASSES: NaturalnessClass[] = [
  { value: 11, color: '#11611f', label: 'Forest without any signs of management activities, including primary forests' },
  { value: 20, color: '#5fd35f', label: 'Naturally regenerating forest with signs of management, e.g., logging, clear cuts' },
  { value: 31, color: '#2c4fd6', label: 'Planted forest' },
  { value: 32, color: '#f08c1c', label: 'Plantation forest (rotation time up to 15 years)' },
  { value: 40, color: '#ff6ec7', label: 'Oil palm plantations' },
  { value: 53, color: '#f2e205', label: 'Agroforestry' },
];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * TiTiler discrete `colormap` value: maps each class value to an RGBA quad.
 * Pixels whose value isn't a key (e.g. the 0 / no-forest background) render
 * transparent, so no rescale or nodata handling is needed.
 */
export function buildNaturalnessColormapParam(): string {
  const cmap: Record<string, [number, number, number, number]> = {};
  for (const c of NATURALNESS_MAP_CLASSES) {
    const [r, g, b] = hexToRgb(c.color);
    cmap[String(c.value)] = [r, g, b, 255];
  }
  return JSON.stringify(cmap);
}
