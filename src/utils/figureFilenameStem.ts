import { transformExtent } from 'ol/proj';

/** Mirrors backend `_sanitize_name` in auxiliary.save_figures. */
export function sanitizeFigureFilenameStem(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return cleaned || 'layer';
}

/**
 * Default export base name: first word of layer title + location tag + rest of title,
 * then sanitized — matches backend `_with_location_after_tile` + `_sanitize_name`.
 */
export function defaultFigureFilenameStem(
  extent3857: [number, number, number, number],
  layerName: string,
): string {
  const wgs = transformExtent(extent3857, 'EPSG:3857', 'EPSG:4326');
  const centerLon = (wgs[0] + wgs[2]) / 2;
  const centerLat = (wgs[1] + wgs[3]) / 2;
  const locTag = `${centerLat.toFixed(4)}_${centerLon.toFixed(4)}`.replace(/-/g, 'm');
  const parts = layerName.trim().split(/\s+/);
  let baseName: string;
  if (parts.length === 0) {
    baseName = locTag;
  } else if (parts.length === 1) {
    baseName = `${parts[0]} ${locTag}`;
  } else {
    baseName = `${parts[0]} ${locTag} ${parts.slice(1).join(' ')}`;
  }
  return sanitizeFigureFilenameStem(baseName);
}
