export const PALETTES = {
  Grayscale: ['#000000', '#FFFFFF'],
  Viridis: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],
  Magma: ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'],
  RdYlBu: ['#313695', '#74add1', '#fed976', '#feb24c', '#fd8d3c', '#f03b20'],
  Terrain: ['#333399', '#79b3d4', '#a3e0b2', '#cde49c', '#e7d19a', '#c4a173'],
  Spectral: ['#9e0142', '#f46d43', '#fee08b', '#90ed7d', '#5e4fa2'],
} as const;

export type PaletteName = keyof typeof PALETTES;
