import { Feature } from 'ol';
import { Point } from 'ol/geom';
import type { Geometry } from 'ol/geom';
import OlGeoJSON from 'ol/format/GeoJSON';
import { deserialize } from 'flatgeobuf/lib/mjs/ol';

export interface ParseResult {
  features: Feature<Geometry>[];
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

  const features: Feature<Geometry>[] = [];
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

    const feature = new Feature({ geometry: new Point([lon, lat]).transform('EPSG:4326', 'EPSG:3857') });
    feature.setProperties(props);
    features.push(feature);
  }

  return { features, name: fileName };
}

function parseGeoJson(text: string, fileName: string): ParseResult {
  try {
    const format = new OlGeoJSON();
    const features = format.readFeatures(text, {
      dataProjection: 'EPSG:4326',
      featureProjection: 'EPSG:3857',
    }) as Feature<Geometry>[];
    return { features, name: fileName };
  } catch (e: any) {
    return { features: [], name: fileName, error: `Invalid GeoJSON: ${e.message}` };
  }
}

async function parseFgb(buffer: ArrayBuffer, fileName: string): Promise<ParseResult> {
  try {
    const features: Feature<Geometry>[] = [];
    const iter = deserialize(new Uint8Array(buffer), undefined, undefined, false, {}, false, 'EPSG:4326', 'EPSG:3857');
    for await (const feature of iter) {
      features.push(feature as Feature<Geometry>);
    }
    return { features, name: fileName };
  } catch (e: any) {
    return { features: [], name: fileName, error: `Invalid FlatGeobuf: ${e.message}` };
  }
}

function geojsonToOlFeatures(geojson: any): Feature<Geometry>[] {
  const format = new OlGeoJSON();
  return format.readFeatures(geojson, {
    dataProjection: 'EPSG:4326',
    featureProjection: 'EPSG:3857',
  }) as Feature<Geometry>[];
}

async function parseShapefile(buffer: ArrayBuffer, fileName: string): Promise<ParseResult> {
  try {
    const shp = await import('shpjs');
    const geojson = await shp.default(buffer);
    let features: Feature<Geometry>[];
    if (Array.isArray(geojson)) {
      features = geojson.flatMap((fc) => geojsonToOlFeatures(fc as any));
    } else {
      features = geojsonToOlFeatures(geojson as any);
    }
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
