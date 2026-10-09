import { deserialize } from 'flatgeobuf/lib/mjs/geojson';

/** Features are GeoJSON in longitude/latitude, as the map takes them. */
export interface ParseResult {
  features: GeoJSON.Feature[];
  name: string;
  error?: string;
}

const LAT_ALIASES = ['lat', 'latitude', 'y', 'lat_lowestmode', 'lat_highestreturn'];
const LON_ALIASES = ['lon', 'lng', 'longitude', 'long', 'x', 'lon_lowestmode', 'lon_highestreturn'];

function findColumn(headers: string[], aliases: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = lower.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseCsv(text: string, fileName: string): ParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { features: [], name: fileName, error: 'CSV has no data rows' };

  const delim = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(delim).map((h) => h.trim().replace(/^["']|["']$/g, ''));
  const latIdx = findColumn(headers, LAT_ALIASES);
  const lonIdx = findColumn(headers, LON_ALIASES);
  if (latIdx === -1 || lonIdx === -1) {
    return { features: [], name: fileName, error: `Could not find lat/lon columns. Headers: ${headers.join(', ')}` };
  }

  const features: GeoJSON.Feature[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim).map((c) => c.trim().replace(/^["']|["']$/g, ''));
    const lat = parseFloat(cols[latIdx]);
    const lon = parseFloat(cols[lonIdx]);
    if (!isFinite(lat) || !isFinite(lon)) continue;

    const props: Record<string, any> = {};
    for (let j = 0; j < headers.length; j++) {
      if (j === latIdx || j === lonIdx) continue;
      const val = cols[j];
      const num = Number(val);
      props[headers[j]] = val !== '' && isFinite(num) ? num : val;
    }

    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: props });
  }

  return { features, name: fileName };
}

function parseGeoJson(text: string, fileName: string): ParseResult {
  try {
    return { features: geojsonFeatures(JSON.parse(text)), name: fileName };
  } catch (e: any) {
    return { features: [], name: fileName, error: `Invalid GeoJSON: ${e.message}` };
  }
}

async function parseFgb(buffer: ArrayBuffer, fileName: string): Promise<ParseResult> {
  try {
    const features: GeoJSON.Feature[] = [];
    for await (const feature of deserialize(new Uint8Array(buffer)) as AsyncGenerator<GeoJSON.Feature>) {
      features.push(feature);
    }
    return { features, name: fileName };
  } catch (e: any) {
    return { features: [], name: fileName, error: `Invalid FlatGeobuf: ${e.message}` };
  }
}

/** A FeatureCollection, a single Feature or a bare geometry, as a list of features. */
function geojsonFeatures(geojson: any): GeoJSON.Feature[] {
  if (!geojson || typeof geojson !== 'object') throw new Error('not a GeoJSON object');
  if (geojson.type === 'FeatureCollection') return (geojson.features ?? []).filter((f: any) => f?.geometry);
  if (geojson.type === 'Feature') return geojson.geometry ? [geojson] : [];
  if (typeof geojson.type === 'string' && ('coordinates' in geojson || 'geometries' in geojson)) {
    return [{ type: 'Feature', geometry: geojson, properties: {} }];
  }
  throw new Error(`unexpected type ${String(geojson.type)}`);
}

async function parseShapefile(buffer: ArrayBuffer, fileName: string): Promise<ParseResult> {
  try {
    const shp = await import('shpjs');
    const geojson = await shp.default(buffer);
    const features = Array.isArray(geojson)
      ? geojson.flatMap((fc) => geojsonFeatures(fc))
      : geojsonFeatures(geojson);
    return { features, name: fileName };
  } catch (e: any) {
    return { features: [], name: fileName, error: `Invalid Shapefile: ${e.message}` };
  }
}

export async function parseUploadedFile(file: File): Promise<ParseResult> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const baseName = file.name.replace(/\.[^.]+$/, '');

  if (ext === 'csv' || ext === 'tsv') {
    const text = await file.text();
    return parseCsv(text, baseName);
  }

  if (ext === 'geojson' || ext === 'json') {
    const text = await file.text();
    return parseGeoJson(text, baseName);
  }

  if (ext === 'fgb') {
    const buffer = await file.arrayBuffer();
    return parseFgb(buffer, baseName);
  }

  if (ext === 'shp' || ext === 'dbf' || ext === 'shx' || ext === 'prj') {
    return { features: [], name: baseName, error: 'Shapefiles must be uploaded as a .zip archive containing all component files (.shp, .dbf, .prj, .shx).' };
  }

  if (ext === 'zip') {
    const buffer = await file.arrayBuffer();
    return parseShapefile(buffer, baseName);
  }

  return { features: [], name: baseName, error: `Unsupported file type: .${ext}` };
}
