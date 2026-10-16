import type { Map as MlMap } from 'maplibre-gl';
import { DEFAULT_VSM_VERSION, getDefaultRescaleAndColormap, type VsmQChoice } from '../constants/predictions';
import { apiUrl } from '../utils/apiBase';
import { tilesInView, type Grid, type GridTile } from './exploreMap';
import { TILE_SIZE, TILE_SIZE_PARAM } from '../map/tiles';

/**
 * The RH layers, drawn by MapLibre instead of OpenLayers.
 *
 * Same tiles as useAutoLoadVSM — TiTiler's /cog/tiles over the published COGs —
 * but without the per-tile round trips it makes before a tile can be drawn:
 *
 *   - the COG URL is filled in from /predictions/download-info's template
 *     instead of a POST /predictions/load (a HEAD to source.coop) per tile.
 *     The template is trusted only once the backend has confirmed it: the
 *     first URL is asked of /predictions/load (or /predictions/mosaic-url)
 *     as well, and if the two differ — a deployment serving a year from
 *     local disk still advertises its remote template — every URL is asked
 *     for that way, as before. Same when there is no template at all;
 *   - the bounds come from the MGRS grid already in memory instead of a
 *     /cog/info per tile.
 *
 * So a newly visible MGRS tile costs nothing until MapLibre asks for its first
 * image, and that is why the debounce can drop from 1.5 s to a fraction of it.
 *
 * MapLibre zoom is OpenLayers zoom minus one (512 px world vs 256 px), so the
 * old MIN_ZOOM of 8 is 7 here. Tiles are 512 px (see map/tiles.ts), for which
 * tile zoom and map zoom are the same.
 */

export const MIN_ZOOM = 7;

/**
 * An empty layer in the base style marking the top of the predictions. Every
 * RH is inserted under it, so the overlays added above it — the download grid,
 * the transect line — stay over the data however many RHs are switched on
 * after them.
 */
export const VSM_TOP = 'vsm-top';
/** Zoom the mosaic overview is fetched to; overzoomed above it. */
const MOSAIC_MAX_TILE_ZOOM = MIN_ZOOM;
/** The 10 m COGs have nothing finer to give past this. */
const MAX_TILE_ZOOM = 17;
const DEBOUNCE_MS = 250;

/** COG URL templates from /predictions/download-info; null where it has none. */
export type Templates = { tile: string | null; mosaic: string | null; q: number };

type RhState = {
  rh: number;
  anchor: string;
  /** The overview COG, once known; null when the deployment has none. */
  mosaicUrl: string | null;
  tiles: Set<string>;
  /** Tiles whose layer is on the map — `tiles` also holds ones still resolving. */
  drawn: Set<string>;
  visible: boolean;
  removed: boolean;
};

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function cogTileUrl(cog: string, rh: number, qChoice: VsmQChoice): string {
  const rc = getDefaultRescaleAndColormap(rh, qChoice);
  return apiUrl(
    `/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(cog)}` +
      `&expression=b1*(b1<32767)&nodata=-9999&return_mask=true` +
      `&rescale=${rc.min},${rc.max}&colormap_name=${encodeURIComponent(rc.colormap)}&${TILE_SIZE_PARAM}`,
  );
}

export class VsmLayers {
  private byRh = new Map<number, RhState>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onMove = () => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.loadVisible(), DEBOUNCE_MS);
  };

  private map: MlMap;
  private grid: Grid;
  private templates: Templates;
  private year: number;
  private qChoice: VsmQChoice;
  /** Resolved COG URLs, keyed `rh/tile` (or `rh/mosaic`); null where there is no file. */
  private urls = new Map<string, Promise<string | null>>();
  /** Whether each template gives the URL the backend gives; settled on first use. */
  private trust: { tile?: Promise<boolean>; mosaic?: Promise<boolean> } = {};

  constructor(map: MlMap, grid: Grid, templates: Templates, year: number, qChoice: VsmQChoice) {
    this.map = map;
    this.grid = grid;
    this.templates = templates;
    this.year = year;
    this.qChoice = qChoice;
    map.on('moveend', this.onMove);
  }

  /** Bottom to top — the order the explore page keeps its layer list in. */
  sync(wanted: { rhIndex: number; visible: boolean }[]) {
    const want = new Set(wanted.map((w) => w.rhIndex));
    for (const rh of [...this.byRh.keys()]) if (!want.has(rh)) this.remove(rh);

    for (const w of wanted) {
      let s = this.byRh.get(w.rhIndex);
      if (!s) s = this.add(w.rhIndex);
      if (s.visible !== w.visible) {
        s.visible = w.visible;
        for (const id of this.layerIds(s)) {
          if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', w.visible ? 'visible' : 'none');
        }
      }
    }
    this.loadVisible();
  }

  /**
   * The COG each RH is read from at a point: the 10 m tile under the point, or
   * — where there is none — the mosaic. Not the mosaic first: its pixels are
   * 0.01° (~1.1 km), so every click inside one read the same value however
   * much the 10 m map under the cursor varied, and disagreed with the profile,
   * which is read from the tiles.
   */
  async readUrls(lon: number, lat: number): Promise<{ rh: number; url: string | null }[]> {
    const tile = this.grid.tiles.find((t) => lon >= t.bbox[0] && lon <= t.bbox[2] && lat >= t.bbox[1] && lat <= t.bbox[3]);
    return Promise.all(
      [...this.byRh.values()].map(async (s) => ({
        rh: s.rh,
        url: (tile ? await this.tileCog(tile.name, s.rh) : null) ?? (await this.mosaicCog(s.rh)),
      })),
    );
  }

  private async askMosaic(rh: number): Promise<string | null> {
    const r = await fetch(apiUrl(
      `/predictions/mosaic-url?year=${this.year}&rh_index=${rh}&q_index=${this.templates.q}&version=${encodeURIComponent(DEFAULT_VSM_VERSION)}`,
    ));
    const d = r.ok ? await r.json() : null;
    return d?.success && d.url ? (d.url as string) : null;
  }

  private async askTile(tile: string, rh: number): Promise<string | null> {
    const r = await fetch(apiUrl('/predictions/load'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year: this.year, tile_name: tile, rh_index: rh, q_index: this.templates.q, version: DEFAULT_VSM_VERSION }),
    });
    const d = r.ok ? await r.json() : null;
    return d?.success && d.url ? (d.url as string) : null;
  }

  /**
   * A URL from the template if the template has been confirmed, else from the
   * backend. The first call does both and settles which; until it has, later
   * calls wait for it rather than guessing.
   */
  private async viaTemplate(
    kind: 'tile' | 'mosaic',
    fromTemplate: string | null,
    ask: () => Promise<string | null>,
  ): Promise<string | null> {
    if (fromTemplate === null) return ask();
    if (!this.trust[kind]) {
      let asked: Promise<string | null>;
      this.trust[kind] = (asked = ask()).then(
        // No answer to compare against (no file here, say) settles nothing:
        // the next URL asks again.
        (url) => {
          if (url === null) this.trust[kind] = undefined;
          return url === fromTemplate;
        },
        () => {
          this.trust[kind] = undefined;
          return false;
        },
      );
      const trusted = await this.trust[kind];
      return trusted ? fromTemplate : asked;
    }
    return (await this.trust[kind]) ? fromTemplate : ask();
  }

  private mosaicCog(rh: number): Promise<string | null> {
    return this.resolve(`${rh}/mosaic`, () =>
      this.viaTemplate(
        'mosaic',
        this.templates.mosaic ? fill(this.templates.mosaic, { year: this.year, rh, q: this.templates.q }) : null,
        () => this.askMosaic(rh),
      ),
    );
  }

  private tileCog(tile: string, rh: number): Promise<string | null> {
    return this.resolve(`${rh}/${tile}`, () =>
      this.viaTemplate(
        'tile',
        this.templates.tile
          ? fill(this.templates.tile, { year: this.year, tile, zone: tile.slice(0, 3).toLowerCase(), rh, q: this.templates.q })
          : null,
        () => this.askTile(tile, rh),
      ),
    );
  }

  /** Each URL is asked for once; a failed request is not cached, so a later pan retries it. */
  private resolve(key: string, get: () => Promise<string | null>): Promise<string | null> {
    let p = this.urls.get(key);
    if (!p) {
      p = get().catch(() => {
        this.urls.delete(key);
        return null;
      });
      this.urls.set(key, p);
    }
    return p;
  }

  destroy() {
    this.map.off('moveend', this.onMove);
    if (this.timer) clearTimeout(this.timer);
    for (const rh of [...this.byRh.keys()]) this.remove(rh);
  }

  private add(rh: number): RhState {
    // An empty layer marking the top of this RH's slice of the stack. Every
    // layer for the RH is inserted just below it, so a tile loaded later for
    // an older RH still lands under the newer RH rather than on top of it.
    // Added at the top of the predictions, so the RH switched on most recently
    // is drawn over the others.
    const anchor = `vsm-anchor-${rh}`;
    this.map.addLayer({ id: anchor, type: 'background', layout: { visibility: 'none' } }, VSM_TOP);

    const s: RhState = { rh, anchor, mosaicUrl: null, tiles: new Set(), drawn: new Set(), visible: true, removed: false };
    this.byRh.set(rh, s);

    void this.mosaicCog(rh).then((mosaicUrl) => {
      if (!mosaicUrl || s.removed) return;
      s.mosaicUrl = mosaicUrl;
      const src = `vsm-mosaic-${rh}`;
      this.map.addSource(src, {
        type: 'raster',
        tiles: [cogTileUrl(mosaicUrl, rh, this.qChoice)],
        tileSize: TILE_SIZE,
        maxzoom: MOSAIC_MAX_TILE_ZOOM,
      });
      // No layer maxzoom: above the overview's zoom it is overzoomed rather
      // than refetched, and left underneath the 10 m tiles it fills the moment
      // between a pan and their arrival instead of showing bare basemap.
      // Inserted under the RH's 10 m tiles, which may already be drawn.
      const firstTile = [...s.drawn].map((t) => `vsm-${rh}-${t}`).find((id) => this.map.getLayer(id));
      this.map.addLayer(
        {
          id: src, type: 'raster', source: src,
          layout: { visibility: s.visible ? 'visible' : 'none' },
          paint: { 'raster-fade-duration': 0 },
        },
        firstTile ?? anchor,
      );
    });
    return s;
  }

  private remove(rh: number) {
    const s = this.byRh.get(rh);
    if (!s) return;
    s.removed = true;
    for (const id of this.layerIds(s)) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(id)) this.map.removeSource(id);
    }
    if (this.map.getLayer(s.anchor)) this.map.removeLayer(s.anchor);
    this.byRh.delete(rh);
  }

  private layerIds(s: RhState): string[] {
    return [`vsm-mosaic-${s.rh}`, ...[...s.tiles].map((t) => `vsm-${s.rh}-${t}`)];
  }

  private loadVisible() {
    if (this.map.getZoom() < MIN_ZOOM || this.byRh.size === 0) return;
    const visible = tilesInView(this.map, this.grid).map((name) => this.grid.byName.get(name.toUpperCase())!);

    for (const st of this.byRh.values()) {
      for (const t of visible) {
        if (st.tiles.has(t.name)) continue;
        st.tiles.add(t.name);
        void this.tileCog(t.name, st.rh).then((cog) => {
          if (st.removed) return;
          if (!cog) {
            // Not drawn — there is no file, or the request failed. Unmarked so
            // a later pan comes back to it; a failure is then asked again, a
            // missing file is answered from the cache.
            st.tiles.delete(t.name);
            return;
          }
          this.drawTile(st, t, cog);
        });
      }
    }
  }

  private drawTile(st: RhState, t: GridTile, cog: string) {
    const id = `vsm-${st.rh}-${t.name}`;
    if (this.map.getLayer(id)) return;
    st.drawn.add(t.name);
    this.map.addSource(id, {
      type: 'raster',
      tiles: [cogTileUrl(cog, st.rh, this.qChoice)],
      tileSize: TILE_SIZE,
      bounds: t.bbox,
      minzoom: MIN_ZOOM,
      maxzoom: MAX_TILE_ZOOM,
    });
    this.map.addLayer(
      {
        id, type: 'raster', source: id, minzoom: MIN_ZOOM,
        layout: { visibility: st.visible ? 'visible' : 'none' },
        paint: { 'raster-fade-duration': 0 },
      },
      st.anchor,
    );
  }
}
