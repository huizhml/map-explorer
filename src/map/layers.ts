import type { LayerSpecification, Map as MlMap, RasterTileSource } from 'maplibre-gl';
import type { BBox } from './proj';

/**
 * Map layers for the full app, on MapLibre.
 *
 * OpenLayers layers were objects with a zIndex, visibility and opacity, added
 * to the map in any order. MapLibre has a single ordered list of style layers
 * and no zIndex, and one of "our" layers is often several style layers (a fill,
 * a line, a label). This module keeps the OpenLayers model on top of that:
 *
 *   - every style layer is inserted through `addStyleLayer` with a z, which
 *     places it under the first layer with a higher one — so the zIndex values
 *     the app already uses (500 for Sentinel-2, 600 for predictions, 10000 for
 *     the highlight) keep their meaning;
 *   - a `MapLayer` owns its style layers and source, and is what LayerManager
 *     and the rest of the app hold.
 *
 * Layers added without going through here (the basemap, in the base style) sit
 * below everything, which is where they belong.
 */

const zOrders = new WeakMap<MlMap, Map<string, number>>();

function zOf(map: MlMap): Map<string, number> {
  let z = zOrders.get(map);
  if (!z) {
    z = new Map();
    zOrders.set(map, z);
  }
  return z;
}

/** The first style layer drawn above z, excluding `skip` — the `beforeId` for inserting at z. */
function beforeIdFor(map: MlMap, z: number, skip?: Set<string>): string | undefined {
  const order = zOf(map);
  for (const l of map.getStyle().layers) {
    if (skip?.has(l.id)) continue;
    const lz = order.get(l.id);
    if (lz !== undefined && lz > z) return l.id;
  }
  return undefined;
}

export function addStyleLayer(map: MlMap, spec: LayerSpecification, z: number): void {
  map.addLayer(spec, beforeIdFor(map, z));
  zOf(map).set(spec.id, z);
}

export function removeStyleLayer(map: MlMap, id: string): void {
  zOf(map).delete(id);
  if (map.style && map.getLayer(id)) map.removeLayer(id);
}

/** Move a set of style layers, keeping their order among themselves, to z. */
export function moveStyleLayers(map: MlMap, ids: string[], z: number): void {
  const present = ids.filter((id) => map.getLayer(id));
  const before = beforeIdFor(map, z, new Set(present));
  for (const id of present) {
    map.moveLayer(id, before);
    zOf(map).set(id, z);
  }
}

let counter = 0;
export function uniqueId(prefix: string): string {
  return `${prefix}-${++counter}`;
}

/** What LayerManager holds, and what every app layer on the map is. */
export interface MapLayer {
  readonly kind: 'raster' | 'vector' | 'group';
  getVisible(): boolean;
  setVisible(visible: boolean): void;
  getOpacity(): number;
  setOpacity(opacity: number): void;
  getZIndex(): number;
  setZIndex(z: number): void;
  /** Where the layer's data is, for "zoom to layer". */
  getBounds(): BBox | null;
  /** Add to a map. A layer is on at most one map, once. */
  attach(map: MlMap): void;
  /** Remove from its map; safe to call when not attached, or after the map is gone. */
  detach(): void;
  isAttached(): boolean;
}

export type RasterLayerOptions = {
  /** XYZ template, with {z}/{x}/{y}. */
  url: string;
  tileSize?: number;
  /** Tile zoom levels the server has — overzoomed above. */
  minTileZoom?: number;
  maxTileZoom?: number;
  /** Map zoom range the layer is drawn in. */
  minZoom?: number;
  maxZoom?: number;
  /** Requests are limited to this box. */
  bounds?: BBox;
  opacity?: number;
  visible?: boolean;
  zIndex?: number;
  attribution?: string;
};

/** An XYZ tile layer — what every OpenLayers TileLayer + XYZ in the app becomes. */
export class RasterLayer implements MapLayer {
  readonly kind = 'raster' as const;
  readonly id = uniqueId('raster');
  private map: MlMap | null = null;
  private opts: RasterLayerOptions;
  private visible: boolean;
  private opacity: number;
  private z: number;
  /** Multiplied into the opacity, for a group's own opacity. */
  private parentOpacity = 1;
  private parentVisible = true;

  constructor(opts: RasterLayerOptions) {
    this.opts = { ...opts };
    this.visible = opts.visible ?? true;
    this.opacity = opts.opacity ?? 1;
    this.z = opts.zIndex ?? 0;
  }

  attach(map: MlMap): void {
    if (this.map) return;
    this.map = map;
    const o = this.opts;
    map.addSource(this.id, {
      type: 'raster',
      tiles: [o.url],
      tileSize: o.tileSize ?? 256,
      ...(o.minTileZoom !== undefined ? { minzoom: o.minTileZoom } : {}),
      ...(o.maxTileZoom !== undefined ? { maxzoom: o.maxTileZoom } : {}),
      ...(o.bounds ? { bounds: o.bounds } : {}),
      ...(o.attribution ? { attribution: o.attribution } : {}),
    });
    addStyleLayer(
      map,
      {
        id: this.id,
        type: 'raster',
        source: this.id,
        ...(o.minZoom !== undefined ? { minzoom: o.minZoom } : {}),
        ...(o.maxZoom !== undefined ? { maxzoom: o.maxZoom } : {}),
        layout: { visibility: this.effectiveVisible() ? 'visible' : 'none' },
        paint: { 'raster-opacity': this.opacity * this.parentOpacity, 'raster-fade-duration': 0 },
      },
      this.z,
    );
  }

  detach(): void {
    const map = this.map;
    this.map = null;
    if (!map?.style) return;
    removeStyleLayer(map, this.id);
    if (map.getSource(this.id)) map.removeSource(this.id);
  }

  isAttached(): boolean {
    return this.map !== null;
  }

  getVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.applyVisibility();
  }

  /** @internal — LayerGroup */
  setParentState(visible: boolean, opacity: number): void {
    this.parentVisible = visible;
    this.parentOpacity = opacity;
    this.applyVisibility();
    this.applyOpacity();
  }

  private effectiveVisible(): boolean {
    return this.visible && this.parentVisible;
  }

  private applyVisibility(): void {
    if (this.map?.getLayer(this.id)) {
      this.map.setLayoutProperty(this.id, 'visibility', this.effectiveVisible() ? 'visible' : 'none');
    }
  }

  private applyOpacity(): void {
    if (this.map?.getLayer(this.id)) {
      this.map.setPaintProperty(this.id, 'raster-opacity', this.opacity * this.parentOpacity);
    }
  }

  getOpacity(): number {
    return this.opacity;
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.applyOpacity();
  }

  getZIndex(): number {
    return this.z;
  }

  setZIndex(z: number): void {
    this.z = z;
    if (this.map) moveStyleLayers(this.map, [this.id], z);
  }

  getBounds(): BBox | null {
    return this.opts.bounds ?? null;
  }

  getUrl(): string {
    return this.opts.url;
  }

  getTileSize(): number {
    return this.opts.tileSize ?? 256;
  }

  /** Highest zoom the tile server has (undefined → no limit set). */
  getMaxTileZoom(): number | undefined {
    return this.opts.maxTileZoom;
  }

  /** Swap the tile template and refetch — a colormap or rescale change. */
  setUrl(url: string): void {
    this.opts.url = url;
    this.map?.getSource<RasterTileSource>(this.id)?.setTiles([url]);
  }

  /** Set (or, with undefined/'', remove) query parameters on the tile URL. */
  setTileParams(updates: Record<string, string | undefined>): void {
    const [base, qs] = this.opts.url.split('?');
    const params = new URLSearchParams(qs ?? '');
    for (const [k, v] of Object.entries(updates)) {
      if (v === undefined || v === '') params.delete(k);
      else params.set(k, v);
    }
    // URLSearchParams encodes the template's braces; the tile URL needs them.
    this.setUrl(`${base}?${params.toString().replace(/%7B/g, '{').replace(/%7D/g, '}')}`);
  }
}

/**
 * Several layers that are shown, hidden, faded and stacked as one — the
 * OpenLayers LayerGroup. Children are kept in drawing order, bottom first, and
 * all drawn at the group's z.
 */
export class LayerGroup implements MapLayer {
  readonly kind = 'group' as const;
  private map: MlMap | null = null;
  private children: MapLayer[] = [];
  private visible = true;
  private opacity = 1;
  private parentVisible = true;
  private parentOpacity = 1;
  private z: number;

  constructor(opts: { zIndex?: number; layers?: MapLayer[] } = {}) {
    this.z = opts.zIndex ?? 0;
    for (const l of opts.layers ?? []) this.add(l);
  }

  getLayers(): MapLayer[] {
    return [...this.children];
  }

  /** Append on top, or with `bottom`, under everything already in the group. */
  add(layer: MapLayer, { bottom = false }: { bottom?: boolean } = {}): void {
    if (bottom) this.children.unshift(layer);
    else this.children.push(layer);
    // Not yet on the map, setting z only records it.
    if (!layer.isAttached()) layer.setZIndex(this.z);
    this.pushState(layer);
    if (this.map) {
      layer.attach(this.map);
      // Attached at the group's z, which lands it on top of its siblings;
      // a bottom child is then moved back under them.
      if (bottom) this.reorder();
    }
  }

  remove(layer: MapLayer): void {
    const i = this.children.indexOf(layer);
    if (i < 0) return;
    this.children.splice(i, 1);
    layer.detach();
  }

  /** Moving each child to the top of the group's z, in order, leaves them in order. */
  private reorder(): void {
    for (const c of this.children) c.setZIndex(this.z);
  }

  private pushState(layer: MapLayer): void {
    const withParent = layer as MapLayer & { setParentState?: (v: boolean, o: number) => void };
    withParent.setParentState?.(this.visible && this.parentVisible, this.opacity * this.parentOpacity);
  }

  attach(map: MlMap): void {
    if (this.map) return;
    this.map = map;
    for (const c of this.children) {
      c.setZIndex(this.z);
      c.attach(map);
    }
  }

  detach(): void {
    for (const c of this.children) c.detach();
    this.map = null;
  }

  isAttached(): boolean {
    return this.map !== null;
  }

  getVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const c of this.children) this.pushState(c);
  }

  /** @internal — a group inside a group. */
  setParentState(visible: boolean, opacity: number): void {
    this.parentVisible = visible;
    this.parentOpacity = opacity;
    for (const c of this.children) this.pushState(c);
  }

  getOpacity(): number {
    return this.opacity;
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    for (const c of this.children) this.pushState(c);
  }

  getZIndex(): number {
    return this.z;
  }

  setZIndex(z: number): void {
    this.z = z;
    // In order, so each child lands on top of the ones moved before it.
    for (const c of this.children) c.setZIndex(z);
  }

  getBounds(): BBox | null {
    let out: BBox | null = null;
    for (const c of this.children) {
      const b = c.getBounds();
      if (!b) continue;
      out = out ? [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.max(out[2], b[2]), Math.max(out[3], b[3])] : b;
    }
    return out;
  }

  /** Every raster layer in the group, however deep. */
  rasters(): RasterLayer[] {
    return this.children.flatMap((c) =>
      c instanceof RasterLayer ? [c] : c instanceof LayerGroup ? c.rasters() : [],
    );
  }
}
