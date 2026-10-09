import type {
  ExpressionSpecification,
  GeoJSONSource,
  LayerSpecification,
  Map as MlMap,
  PointLike,
} from 'maplibre-gl';
import { addStyleLayer, moveStyleLayers, removeStyleLayer, uniqueId, type MapLayer } from './layers';
import { featuresBBox, type BBox } from './proj';

/**
 * A vector layer whose look is decided per feature, in JavaScript — the
 * OpenLayers model of a VectorLayer with a style function, on MapLibre.
 *
 * MapLibre styles features with expressions evaluated on the GPU side, which is
 * fast but cannot call back into app code. The app's styles are app code:
 * conditional colours read off feature properties, a hover state, a label from
 * a field. So the style is evaluated here, once per feature whenever the data
 * or the style changes, and the result is written into the properties of the
 * copy handed to MapLibre (`_s_*`), which a fixed set of style layers then
 * reads with `['get', ...]`. Drawing stays MapLibre's; only the decision is
 * ours.
 *
 * Coordinates are longitude/latitude, as GeoJSON has them.
 */

export type FeatureStyle = {
  /** Polygon fill. */
  fill?: string;
  /** Line, and polygon outline. */
  stroke?: string;
  strokeWidth?: number;
  dashed?: boolean;
  /** A wider line drawn under the stroke, for legibility over any background. */
  casing?: { color: string; width: number };
  /** Points. */
  circle?: { radius: number; fill?: string; stroke?: string; strokeWidth?: number };
  text?: {
    value: string;
    size?: number;
    color?: string;
    halo?: string;
    haloWidth?: number;
    bold?: boolean;
  };
};

// Properties are whatever the data file carried — `any`, as OpenLayers'
// `feature.get()` was, rather than a cast at every read.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppFeature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, any>> & { id: number };

export type StyleFn = (feature: AppFeature, zoom: number) => FeatureStyle | null | undefined;
export type StyleLike = FeatureStyle | StyleFn | null;

export type ClusterOptions = { radius: number; maxZoom: number };

export type VectorLayerOptions = {
  style?: StyleLike;
  zIndex?: number;
  visible?: boolean;
  opacity?: number;
  /** Re-run a style function when the zoom changes — for styles that depend on it. */
  restyleOnZoom?: boolean;
  cluster?: ClusterOptions | null;
  /**
   * Fewer points than this are drawn as themselves rather than as a cluster.
   * Fixed for the layer's life: MapLibre can switch clustering on and off, but
   * not change this.
   */
  clusterMinPoints?: number;
};

export type Hit =
  | { kind: 'feature'; feature: AppFeature }
  | { kind: 'cluster'; clusterId: number; count: number; lngLat: [number, number] };

const S = '_s_';
const POLY: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
const POINT: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]];
const NOT_CLUSTER: ExpressionSpecification = ['!', ['has', 'point_count']];
const get = (k: string): ExpressionSpecification => ['get', `${S}${k}`];

/** The style layers every VectorLayer draws with, bottom first. */
const STYLE_LAYER_KINDS = ['fill', 'casing', 'line', 'dash', 'circle', 'text', 'cluster', 'cluster-count'];

let nextFeatureId = 1;

export class VectorLayer implements MapLayer {
  readonly kind = 'vector' as const;
  readonly id = uniqueId('vector');
  private map: MlMap | null = null;
  private features: AppFeature[] = [];
  private style: StyleLike;
  private overrides = new Map<number, FeatureStyle | null>();
  private visible: boolean;
  private opacity: number;
  private parentVisible = true;
  private parentOpacity = 1;
  private z: number;
  private restyleOnZoom: boolean;
  private cluster: ClusterOptions | null;
  private clusterMinPoints: number;
  private pending = false;
  private props: Record<string, unknown> = {};

  constructor(opts: VectorLayerOptions = {}) {
    this.style = opts.style ?? null;
    this.visible = opts.visible ?? true;
    this.opacity = opts.opacity ?? 1;
    this.z = opts.zIndex ?? 0;
    this.restyleOnZoom = opts.restyleOnZoom ?? false;
    this.cluster = opts.cluster ?? null;
    this.clusterMinPoints = opts.clusterMinPoints ?? 2;
  }

  /** Free-form tags on the layer, as OpenLayers' `layer.set/get`. */
  set(key: string, value: unknown): void {
    this.props[key] = value;
  }

  get<T = unknown>(key: string): T | undefined {
    return this.props[key] as T | undefined;
  }

  // ------------------------------------------------------------- features --

  /** Takes plain GeoJSON; each feature gets an id that the layer keys it by. */
  setFeatures(features: GeoJSON.Feature[]): AppFeature[] {
    this.features = features.map(withId);
    this.overrides.clear();
    this.schedule();
    return this.features;
  }

  addFeature(feature: GeoJSON.Feature): AppFeature {
    const f = withId(feature);
    this.features.push(f);
    this.schedule();
    return f;
  }

  addFeatures(features: GeoJSON.Feature[]): AppFeature[] {
    const added = features.map(withId);
    this.features.push(...added);
    this.schedule();
    return added;
  }

  removeFeature(feature: AppFeature | number): void {
    const id = typeof feature === 'number' ? feature : feature.id;
    this.features = this.features.filter((f) => f.id !== id);
    this.overrides.delete(id);
    this.schedule();
  }

  clear(): void {
    this.features = [];
    this.overrides.clear();
    this.schedule();
  }

  getFeatures(): AppFeature[] {
    return this.features;
  }

  getFeatureById(id: number): AppFeature | undefined {
    return this.features.find((f) => f.id === id);
  }

  /** Change one feature's properties in place and redraw. */
  updateProperties(feature: AppFeature, props: Record<string, unknown>): void {
    Object.assign(feature.properties, props);
    this.schedule();
  }

  /** Features whose bbox meets `bbox` — OpenLayers' getFeaturesInExtent. */
  getFeaturesInBBox([w, s, e, n]: BBox): AppFeature[] {
    return this.features.filter((f) => {
      const b = featuresBBox([f]);
      return b !== null && b[0] <= e && b[2] >= w && b[1] <= n && b[3] >= s;
    });
  }

  // ---------------------------------------------------------------- style --

  setStyle(style: StyleLike): void {
    this.style = style;
    this.schedule();
  }

  /** One feature drawn differently — a hover or selection. undefined restores the layer style. */
  setFeatureStyle(feature: AppFeature | number, style: FeatureStyle | null | undefined): void {
    const id = typeof feature === 'number' ? feature : feature.id;
    if (style === undefined) this.overrides.delete(id);
    else this.overrides.set(id, style);
    this.schedule();
  }

  setCluster(cluster: ClusterOptions | null): void {
    this.cluster = cluster;
    if (!this.map) return;
    this.map.getSource<GeoJSONSource>(this.id)?.setClusterOptions({
      cluster: !!cluster,
      ...(cluster ? { clusterRadius: cluster.radius, clusterMaxZoom: cluster.maxZoom } : {}),
    });
  }

  isClustered(): boolean {
    return this.cluster !== null;
  }

  // ------------------------------------------------------------ rendering --

  /** Coalesce changes made in one tick into one setData. */
  private schedule(): void {
    if (!this.map || this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      this.render();
    });
  }

  private render(): void {
    const src = this.map?.getSource<GeoJSONSource>(this.id);
    if (!src) return;
    src.setData(this.toData());
  }

  private toData(): GeoJSON.FeatureCollection {
    const zoom = this.map?.getZoom() ?? 0;
    const out: GeoJSON.Feature[] = [];
    for (const f of this.features) {
      const style = this.overrides.has(f.id)
        ? this.overrides.get(f.id)
        : typeof this.style === 'function'
          ? this.style(f, zoom)
          : this.style;
      if (!style) continue;
      // Only what drawing needs. The feature's own properties stay here, read
      // back through `_fid`: copying them would ship every attribute to the
      // worker on each redraw — for GEDI shots, a whole RH profile per point,
      // on every click that highlights one.
      out.push({ type: 'Feature', id: f.id, geometry: f.geometry, properties: { ...flatten(style), _fid: f.id } });
    }
    return { type: 'FeatureCollection', features: out };
  }

  private styleLayerIds(): string[] {
    return STYLE_LAYER_KINDS.map((k) => `${this.id}-${k}`);
  }

  private onZoom = () => this.schedule();

  attach(map: MlMap): void {
    if (this.map) return;
    this.map = map;
    map.addSource(this.id, {
      type: 'geojson',
      data: this.toData(),
      cluster: !!this.cluster,
      clusterMinPoints: this.clusterMinPoints,
      ...(this.cluster ? { clusterRadius: this.cluster.radius, clusterMaxZoom: this.cluster.maxZoom } : {}),
    });

    const vis = this.effectiveVisible() ? 'visible' : 'none';
    const o = this.opacity * this.parentOpacity;
    const id = this.id;
    const specs: LayerSpecification[] = [
      {
        id: `${id}-fill`, type: 'fill', source: id,
        filter: ['all', POLY, ['has', `${S}fill`]],
        layout: { visibility: vis },
        paint: { 'fill-color': get('fill'), 'fill-opacity': o },
      },
      {
        id: `${id}-casing`, type: 'line', source: id,
        filter: ['all', ['!', POINT], ['has', `${S}cc`]],
        layout: { visibility: vis, 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': get('cc'), 'line-width': get('cw'), 'line-opacity': o },
      },
      {
        id: `${id}-line`, type: 'line', source: id,
        filter: ['all', ['!', POINT], ['has', `${S}stroke`], ['!', ['to-boolean', get('dash')]]],
        layout: { visibility: vis, 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': get('stroke'), 'line-width': get('sw'), 'line-opacity': o },
      },
      {
        id: `${id}-dash`, type: 'line', source: id,
        filter: ['all', ['!', POINT], ['has', `${S}stroke`], ['to-boolean', get('dash')]],
        layout: { visibility: vis },
        paint: { 'line-color': get('stroke'), 'line-width': get('sw'), 'line-opacity': o, 'line-dasharray': [2.5, 1.5] },
      },
      {
        id: `${id}-circle`, type: 'circle', source: id,
        filter: ['all', POINT, NOT_CLUSTER, ['has', `${S}cr`]],
        layout: { visibility: vis },
        paint: {
          'circle-radius': get('cr'),
          'circle-color': ['coalesce', get('cf'), 'rgba(0,0,0,0)'],
          'circle-stroke-color': ['coalesce', get('cs'), 'rgba(0,0,0,0)'],
          'circle-stroke-width': ['coalesce', get('csw'), 0],
          'circle-opacity': o,
          'circle-stroke-opacity': o,
        },
      },
      {
        id: `${id}-text`, type: 'symbol', source: id,
        filter: ['all', NOT_CLUSTER, ['has', `${S}tx`]],
        layout: {
          visibility: vis,
          'text-field': get('tx'),
          'text-size': get('ts'),
          'text-font': ['case', ['to-boolean', get('tb')], ['literal', ['Noto Sans Bold']], ['literal', ['Noto Sans Regular']]],
          'text-allow-overlap': true,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': get('tc'),
          'text-halo-color': get('th'),
          'text-halo-width': get('thw'),
          'text-opacity': o,
        },
      },
      {
        id: `${id}-cluster`, type: 'circle', source: id,
        filter: ['has', 'point_count'],
        layout: { visibility: vis },
        paint: {
          'circle-radius': ['max', 8, ['min', 20, ['+', 8, ['log2', ['get', 'point_count']]]]],
          'circle-color': 'rgba(33, 150, 243, 0.75)',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
          'circle-opacity': o,
          'circle-stroke-opacity': o,
        },
      },
      {
        id: `${id}-cluster-count`, type: 'symbol', source: id,
        filter: ['has', 'point_count'],
        layout: {
          visibility: vis,
          'text-field': ['to-string', ['get', 'point_count']],
          'text-size': 12,
          'text-font': ['literal', ['Noto Sans Bold']],
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.45)', 'text-halo-width': 1, 'text-opacity': o },
      },
    ];
    for (const spec of specs) addStyleLayer(map, spec, this.z);
    if (this.restyleOnZoom) map.on('zoomend', this.onZoom);
  }

  detach(): void {
    const map = this.map;
    this.map = null;
    if (!map) return;
    map.off('zoomend', this.onZoom);
    if (!map.style) return;
    for (const id of this.styleLayerIds()) removeStyleLayer(map, id);
    if (map.getSource(this.id)) map.removeSource(this.id);
  }

  isAttached(): boolean {
    return this.map !== null;
  }

  // --------------------------------------------------------- hit testing --

  /** The style layers this one draws with — for queryRenderedFeatures. */
  renderedLayerIds(): string[] {
    return this.styleLayerIds().filter((id) => this.map?.getLayer(id));
  }

  /**
   * What is drawn at a screen point, topmost first, within `tolerance` px.
   * Returns the layer's own feature objects, not MapLibre's copies.
   */
  hitTest(point: PointLike, tolerance = 0): Hit[] {
    if (!this.map || !this.effectiveVisible()) return [];
    const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
    const box: [PointLike, PointLike] = [[x - tolerance, y - tolerance], [x + tolerance, y + tolerance]];
    const rendered = this.map.queryRenderedFeatures(box, { layers: this.renderedLayerIds() });
    const seen = new Set<string>();
    const hits: Hit[] = [];
    for (const r of rendered) {
      const p = r.properties ?? {};
      if (p.cluster) {
        const key = `c${p.cluster_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const g = r.geometry as GeoJSON.Point;
        hits.push({ kind: 'cluster', clusterId: p.cluster_id, count: p.point_count, lngLat: g.coordinates as [number, number] });
        continue;
      }
      const fid = p._fid as number | undefined;
      if (fid === undefined || seen.has(`f${fid}`)) continue;
      seen.add(`f${fid}`);
      const f = this.getFeatureById(fid);
      if (f) hits.push({ kind: 'feature', feature: f });
    }
    return hits;
  }

  /** The points inside a cluster, for zooming to them. */
  async clusterLeaves(clusterId: number): Promise<GeoJSON.Feature[]> {
    const src = this.map?.getSource<GeoJSONSource>(this.id);
    if (!src) return [];
    return src.getClusterLeaves(clusterId, Infinity, 0);
  }

  // ---------------------------------------------------------- MapLayer --

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
    const map = this.map;
    if (!map) return;
    const v = this.effectiveVisible() ? 'visible' : 'none';
    for (const id of this.renderedLayerIds()) map.setLayoutProperty(id, 'visibility', v);
  }

  private applyOpacity(): void {
    const map = this.map;
    if (!map) return;
    const o = this.opacity * this.parentOpacity;
    const props: Record<string, Parameters<MlMap['setPaintProperty']>[1][]> = {
      fill: ['fill-opacity'],
      casing: ['line-opacity'],
      line: ['line-opacity'],
      dash: ['line-opacity'],
      circle: ['circle-opacity', 'circle-stroke-opacity'],
      text: ['text-opacity'],
      cluster: ['circle-opacity', 'circle-stroke-opacity'],
      'cluster-count': ['text-opacity'],
    };
    for (const [k, names] of Object.entries(props)) {
      const id = `${this.id}-${k}`;
      if (!map.getLayer(id)) continue;
      for (const n of names) map.setPaintProperty(id, n, o);
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
    if (this.map) moveStyleLayers(this.map, this.renderedLayerIds(), z);
  }

  getBounds(): BBox | null {
    return featuresBBox(this.features);
  }
}

function withId(f: GeoJSON.Feature): AppFeature {
  const existing = (f as Partial<AppFeature>).id;
  return {
    type: 'Feature',
    geometry: f.geometry,
    properties: { ...(f.properties ?? {}) },
    id: typeof existing === 'number' && existing > 0 ? existing : nextFeatureId++,
  };
}

function flatten(s: FeatureStyle): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (s.fill) o[`${S}fill`] = s.fill;
  if (s.stroke) {
    o[`${S}stroke`] = s.stroke;
    o[`${S}sw`] = s.strokeWidth ?? 1;
    if (s.dashed) o[`${S}dash`] = true;
  }
  if (s.casing) {
    o[`${S}cc`] = s.casing.color;
    o[`${S}cw`] = s.casing.width;
  }
  if (s.circle) {
    o[`${S}cr`] = s.circle.radius;
    if (s.circle.fill) o[`${S}cf`] = s.circle.fill;
    if (s.circle.stroke) o[`${S}cs`] = s.circle.stroke;
    if (s.circle.strokeWidth) o[`${S}csw`] = s.circle.strokeWidth;
  }
  if (s.text && s.text.value !== '') {
    o[`${S}tx`] = s.text.value;
    o[`${S}ts`] = s.text.size ?? 12;
    o[`${S}tc`] = s.text.color ?? '#000000';
    o[`${S}th`] = s.text.halo ?? 'rgba(0,0,0,0)';
    o[`${S}thw`] = s.text.haloWidth ?? 0;
    if (s.text.bold) o[`${S}tb`] = true;
  }
  return o;
}
