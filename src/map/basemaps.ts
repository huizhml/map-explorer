import type { RasterSourceSpecification } from 'maplibre-gl';

/** Base map tile sources. `{a-c}` subdomains are spelled out: MapLibre takes a list. */
const subdomains = (url: string) => ['a', 'b', 'c'].map((d) => url.replace('{a-c}', d));

export const BASE_MAP_SOURCES: Record<string, { tiles: string[]; attribution: string; maxzoom: number }> = {
  osm: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxzoom: 19,
  },
  esriWorldImagery: {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: '© Esri',
    maxzoom: 19,
  },
  googleSatellite: {
    tiles: [0, 1, 2, 3].map((i) => `https://mt${i}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}`),
    attribution: '© Google',
    maxzoom: 20,
  },
  esriWorldTopo: {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'],
    attribution: '© Esri',
    maxzoom: 19,
  },
  esriTerrain: {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}'],
    attribution: '© Esri',
    maxzoom: 19,
  },
  openTopoMap: {
    tiles: subdomains('https://{a-c}.tile.opentopomap.org/{z}/{x}/{y}.png'),
    attribution: '© OpenTopoMap',
    maxzoom: 17,
  },
  cartoPositron: {
    tiles: subdomains('https://{a-c}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'),
    attribution: '© CARTO',
    maxzoom: 20,
  },
  cartoDarkMatter: {
    tiles: subdomains('https://{a-c}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'),
    attribution: '© CARTO',
    maxzoom: 20,
  },
};

/** The id the base map has in the style; MapComponent creates it as OSM. */
export const BASEMAP_ID = 'basemap';

export function basemapSource(id: string): RasterSourceSpecification {
  const s = BASE_MAP_SOURCES[id] ?? BASE_MAP_SOURCES.osm;
  return { type: 'raster', tileSize: 256, ...s };
}
