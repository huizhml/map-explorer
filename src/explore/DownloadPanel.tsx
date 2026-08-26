import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Fill, Stroke, Style, Text } from 'ol/style';
import { useMapStore } from '../stores/mapStore';
import { apiUrl } from '../utils/apiBase';

/**
 * Getting the data out, at the two granularities it is actually published in.
 *
 * The store is organised as a global ~1 km overview per RH level plus one 10 m
 * COG per MGRS tile, so those are the two things offered here — no third,
 * invented granularity. In particular there is no clip-to-my-view download:
 * that would mean a windowed read and a re-encode on the backend, and 100 MB
 * responses through a process that currently costs nothing to run. A COG served
 * over range requests is already subsettable with one gdal_translate, which is
 * what the note at the foot says.
 *
 * Bytes come straight from the object store. It sends
 * `Access-Control-Allow-Origin: *` and supports ranges, so the browser fetches
 * the files itself and none of this traffic touches the backend.
 */

/** The layout of the published files, from GET /predictions/download-info. */
type DownloadInfo = {
  available: boolean;
  base_url: string;
  tile_url_template: string;
  mosaic_url_template: string;
  q_index: number;
  rh_min: number;
  rh_max: number;
  repository_url: string;
};

/**
 * Below this the auto-loader does not fetch 10 m tiles either, so the map is
 * showing the overview — and the visible-tile list would be thousands long.
 * Kept in step with MIN_ZOOM in useAutoLoadVSM.
 */
const TILE_ZOOM = 8;

/**
 * The grid stays drawn much further out than that, because picking a tile and
 * loading one are different acts: at zoom 6 you can see which tile covers the
 * region you care about and click it, even though the map is still showing the
 * overview. Only the *labels* wait for TILE_ZOOM — below it a tile is a few
 * pixels across, so the names could not fit anyway, and measuring a thousand
 * strings to discard them all is the expensive way to draw nothing.
 */
const GRID_ZOOM = 5;

/**
 * Above this many files, hand over a script instead of buttons. Each file is
 * 100-170 MB, so a dozen buttons is a dozen chances to lose track of what is
 * still running; past a handful people want something they can queue.
 */
const MAX_DIRECT_FILES = 6;

/**
 * And above this, stop listing at all. A hemisphere's worth of URLs is not a
 * download, it is a mirror of the repository — which the repository itself is
 * better at. The panel says when it has stopped, rather than truncating quietly.
 */
const MAX_SCRIPT_FILES = 400;

/** Only a first guess, used before the panel has been measured once. */
const FLYOUT_WIDTH = 320;

/**
 * How the Sentinel-2 grid is drawn while tiles are being chosen.
 *
 * Two instances, reused and re-labelled per feature rather than built per
 * feature: the style function runs for every tile on every frame of a pan, and
 * allocating a Style, a Fill, a Stroke and a Text each time is work done sixty
 * times a second for a result that only ever takes two forms.
 *
 * The name is the whole point of showing the grid — an outline says "there is a
 * tile here", and what the reader needs is "this one is 32VNH". White on a dark
 * halo so it survives both the satellite basemap and the prediction colours.
 * `overflow: false` drops a label that will not fit inside its tile, which is
 * what keeps low zooms from turning into a wall of text.
 *
 * One colour for both states, and the fill is what carries the selection: the
 * grid has to be legible before anything is chosen, and a translucent white
 * outline disappeared into the satellite basemap it was drawn over. Selected is
 * a thicker line of the same green plus a wash — a wash rather than a solid,
 * because the prediction underneath is what the reader is deciding about, and
 * hiding it to show that it is selected would defeat the point.
 */
function gridStyle(selected: boolean) {
  return new Style({
    stroke: new Stroke({ color: '#10796a', width: selected ? 2 : 1 }),
    fill: new Fill({ color: selected ? 'rgba(16,121,106,0.28)' : 'rgba(0,0,0,0)' }),
    text: new Text({
      font: '600 11px system-ui, sans-serif',
      overflow: false,
      fill: new Fill({ color: '#fff' }),
      stroke: new Stroke({ color: 'rgba(0,0,0,0.75)', width: 3 }),
    }),
  });
}
const GRID_ON = gridStyle(true);
const GRID_OFF = gridStyle(false);

type Target = { url: string; name: string; label: string };

function fillTemplate(
  template: string,
  { year, tile, rh, q }: { year: number; tile?: string; rh: number; q: number },
): string {
  return template
    .replace(/\{year\}/g, String(year))
    .replace(/\{tile\}/g, tile ?? '')
    // The internal layout groups tiles by MGRS zone (`32v-2020/32VNH/…`); the
    // published one does not. Filling it either way costs a line and means one
    // template works against both.
    .replace(/\{zone\}/g, tile ? tile.slice(0, 3).toLowerCase() : '')
    .replace(/\{rh\}/g, String(rh))
    .replace(/\{q\}/g, String(q))
    .replace(/\{version\}/g, 'original');
}

/**
 * What the file should be called once it is on disk.
 *
 * The published names are `RH98_Q1.tif` — unambiguous inside their directory
 * and useless outside it. Downloading six tiles gives six files with the same
 * name, which the browser resolves by appending "(1)", "(2)"; downloading a
 * mosaic and a tile gives two files that look identical and differ by a factor
 * of a hundred in resolution. So every download is renamed to carry what the
 * directory used to say: which product, which year, which tile.
 */
function fileName(kind: 'mosaic' | 'tile', year: number, rh: number, q: number, tile?: string) {
  return kind === 'mosaic'
    ? `vsm_global_mosaic_1km_${year}_RH${rh}_Q${q}.tif`
    : `vsm_10m_${tile}_${year}_RH${rh}_Q${q}.tif`;
}

export function DownloadPanel({ rhIndexes, year }: { rhIndexes: number[]; year: number }) {
  const { map, fgbLayer } = useMapStore();
  const [info, setInfo] = useState<DownloadInfo | null>(null);
  const [tiles, setTiles] = useState<string[]>([]);
  const [zoom, setZoom] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  // Which RH levels to download. Follows the map's selection until the reader
  // opens the picker and changes it — after that it is theirs, because the two
  // questions are different: the map shows what is worth looking at, a download
  // is whatever you need for the analysis you are going to run.
  const [chosen, setChosen] = useState<number[] | null>(null);

  /**
   * Which Sentinel-2 tiles to download. Null means "whatever is under the
   * view", which the "In view" button selects; the default is the empty list.
   *
   * Nothing selected to start with, deliberately. A tile is ~100 MB, so a
   * default of "everything on screen" is a default of several gigabytes, chosen
   * by where the map happened to be rather than by anyone. It also made the
   * grid read wrong: every box filled meant the highlight said nothing, because
   * nothing was ever *not* highlighted.
   *
   * Null is still worth having as a state of its own rather than a snapshot of
   * the visible list: it keeps following the map as it is panned, where a list
   * seeded once would quietly go stale. The first click on a tile turns it into
   * an explicit set, which then survives panning — that is what makes it
   * possible to collect tiles from several places.
   */
  const [picked, setPicked] = useState<string[] | null>([]);

  // The flyout, and where it sits. Position is measured rather than expressed
  // in CSS: the panel is 320 px wide on a desktop and full width on a phone,
  // and `position: fixed` cannot read either without help. Anchoring to the
  // trigger's own rectangle works for both, and for whatever comes next.
  const [open, setOpen] = useState(false);
  /**
   * Pinned flyouts ignore click-outside.
   *
   * Choosing tiles means clicking the map, and clicking the map is the same
   * gesture as dismissing a popup — so the default behaviour closes the panel
   * exactly when it is being used. Rather than guess which clicks count, the
   * pin makes it the reader's call: unpinned it behaves like any popup, pinned
   * it stays until closed. Panning is the case that made this necessary.
   */
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  /**
   * The batch in flight, if any. One at a time and one row at a time: these are
   * 100-170 MB files, and running four at once neither finishes sooner (the
   * link saturates either way) nor lets anyone see what is happening.
   */
  const [batch, setBatch] = useState<{ key: string; done: number; total: number; frac: number } | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/predictions/download-info'))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !cancelled && setInfo(d?.available ? d : null))
      .catch(() => !cancelled && setInfo(null));
    return () => {
      cancelled = true;
    };
  }, []);

  // Anything in flight is abandoned when the panel goes away, so a closed tab
  // does not leave 168 MB accumulating in a detached buffer.
  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * Keep the flyout beside its trigger.
   *
   * Preferred position is immediately to the right, top-aligned — out over the
   * map, which is empty at that edge. It falls back to the left of the sidebar,
   * then to the viewport edge, and is always pulled up far enough to fit; on a
   * phone, where the sidebar is a full-width bar across the top, the first
   * fallback is what puts it back inside the screen.
   *
   * Measured off the *sidebar's* right edge, not the trigger's. The trigger is
   * `align-self: flex-start`, so it is only as wide as its label — a little
   * over 140 px inside a 320 px column — and clearing it left the flyout lying
   * across the right half of the sidebar, over the "Please note" caveats
   * underneath. What the panel has to clear is the column, not the button.
   *
   * Recomputed on scroll and resize rather than only on open: the sidebar
   * scrolls under a fixed panel, and a flyout that stays behind while its
   * button moves away is worse than one that never opened.
   */
  useEffect(() => {
    if (!open) return;

    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      // Falls back to the trigger where there is no sidebar to measure, so the
      // panel still places itself if it is ever mounted somewhere else.
      const host = trigger.closest('.ex-panel')?.getBoundingClientRect() ?? r;
      const w = panelRef.current?.offsetWidth ?? FLYOUT_WIDTH;
      const h = panelRef.current?.offsetHeight ?? 0;
      const M = 8;

      let left = Math.max(r.right, host.right) + 10;
      if (left + w > window.innerWidth - M) left = Math.min(r.left, host.left) - w - 10;
      if (left < M) left = Math.max(M, window.innerWidth - w - M);

      let top = r.top;
      if (top + h > window.innerHeight - M) top = window.innerHeight - h - M;
      setPos({ left, top: Math.max(M, top) });
    };

    place();
    // Capture phase: the sidebar is the element that scrolls, not the window,
    // and a bubbling listener on window never hears it.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
    // Anything that changes the panel's *height* re-places it: the level
    // selection and the tiles under the view.
    //
    // Not the download in flight. A progress percentage does not move the
    // panel, and having it here meant every tick tore down the listeners and
    // forced three layouts — measurably starving the transfer it was reporting
    // on. If a running batch ever changes the layout, re-place it from there
    // rather than by depending on the ticks.
  }, [open, chosen, rhIndexes, tiles]);

  // Escape and click-outside, the two ways every popup is expected to close —
  // except that a pinned one only answers to Escape and its own close button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      // The map is not "outside" while this is open: clicking it picks a tile
      // and dragging it looks for the next one. Treating either as a dismissal
      // would close the panel on the very gesture it exists to support — which
      // is what the pin was asked for, and this fixes it whether pinned or not.
      if (map?.getViewport().contains(t)) return;
      setOpen(false);
    };
    if (!pinned) document.addEventListener('mousedown', onDown);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, pinned, map]);

  // Which MGRS tiles the view covers — the same question, asked the same way,
  // as useAutoLoadVSM asks before fetching them. Recomputed on moveend so the
  // offer always matches what is on screen.
  useEffect(() => {
    if (!map || !fgbLayer) return;

    const recompute = () => {
      const view = map.getView();
      const z = view.getZoom();
      setZoom(z ?? null);

      const size = map.getSize();
      const source = fgbLayer.getSource();
      if (!size || !source || z === undefined || z < TILE_ZOOM) {
        setTiles([]);
        return;
      }
      const names = new Set<string>();
      for (const f of source.getFeaturesInExtent(view.calculateExtent(size))) {
        const n = f.get('Name');
        if (n) names.add(n as string);
      }
      setTiles([...names].sort());
    };

    recompute();
    map.on('moveend', recompute);
    return () => map.un('moveend', recompute);
  }, [map, fgbLayer]);

  // Highest RH first, matching the layer list on the map.
  const rhs = useMemo(
    () => [...(chosen ?? rhIndexes)].sort((a, b) => b - a),
    [chosen, rhIndexes],
  );

  /** The tiles the download is actually about — an explicit pick, or the view. */
  const activeTiles = useMemo(() => picked ?? tiles, [picked, tiles]);
  const activeSet = useMemo(() => new Set(activeTiles), [activeTiles]);

  const toggleTile = useCallback(
    (name: string) =>
      setPicked((prev) => {
        // First toggle promotes the implicit "what is in view" into a real
        // list, so that clicking one tile means "this one", not "this one plus
        // everything that happens to be on screen, minus nothing".
        const base = prev ?? tiles;
        return base.includes(name) ? base.filter((t) => t !== name) : [...base, name].sort();
      }),
    [tiles],
  );

  /**
   * Show the Sentinel-2 grid while the flyout is open, and mark what is picked.
   *
   * The layer already exists and is already loaded — useAutoLoadVSM reads the
   * visible tile names out of it — but it is kept invisible, because 18,181
   * outlines are noise to someone reading a map. They are exactly the right
   * thing to draw while someone is choosing tiles, which is the one moment the
   * grid *is* the subject.
   */
  useEffect(() => {
    if (!fgbLayer) return;
    if (!open || zoom === null || zoom < GRID_ZOOM) {
      fgbLayer.setVisible(false);
      return;
    }

    const labels = zoom >= TILE_ZOOM;
    fgbLayer.setStyle((feature: { get: (key: string) => unknown }) => {
      const name = String(feature.get('Name') ?? '');
      const style = activeSet.has(name) ? GRID_ON : GRID_OFF;
      style.getText()?.setText(labels ? name : '');
      return style;
    });

    // Lift it above the predictions for as long as it is being used.
    //
    // The layer is created at zIndex 1 — above the basemap, below everything
    // else — because its usual job is feature lookup, not drawing. The VSM
    // layers sit at 599/600, so a grid left where it was is painted over by the
    // very data the reader is choosing to download: invisible everywhere the
    // prediction has pixels, which is everywhere worth clicking. 800 clears
    // them and still passes under the transect line (900) and the highlight
    // overlay (1000). Restored on close, so lookup goes back to a layer that
    // draws nothing.
    const previousZ = fgbLayer.getZIndex();
    fgbLayer.setZIndex(800);
    fgbLayer.setVisible(true);

    return () => {
      fgbLayer.setVisible(false);
      fgbLayer.setZIndex(previousZ);
    };
  }, [open, zoom, fgbLayer, activeSet]);

  /**
   * Click the map to pick a tile, while the flyout is open.
   *
   * SimpleApp's own click handler reads the vertical profile at the point, and
   * both would fire. The flag on the map object is how it knows to stand aside
   * — set here, honoured there, and cleared when the flyout closes.
   */
  useEffect(() => {
    if (!open || !map || !fgbLayer) return;
    map.set('exSelectingTiles', true);

    const onClick = (evt: { coordinate: number[] }) => {
      const source = fgbLayer.getSource();
      if (!source) return;
      for (const f of source.getFeaturesAtCoordinate(evt.coordinate)) {
        const name = f.get('Name');
        if (name) {
          toggleTile(name as string);
          break;
        }
      }
    };

    map.on('singleclick', onClick as never);
    return () => {
      map.un('singleclick', onClick as never);
      map.set('exSelectingTiles', false);
    };
  }, [open, map, fgbLayer, toggleTile]);

  const allRhs = useMemo(() => {
    if (!info) return [];
    const out: number[] = [];
    for (let rh = info.rh_max; rh >= info.rh_min; rh--) out.push(rh);
    return out;
  }, [info]);

  const mosaicTargets = useMemo<Target[]>(() => {
    if (!info?.mosaic_url_template) return [];
    return rhs.map((rh) => ({
      url: fillTemplate(info.mosaic_url_template, { year, rh, q: info.q_index }),
      name: fileName('mosaic', year, rh, info.q_index),
      label: `RH${rh}`,
    }));
  }, [info, rhs, year]);

  const tileTargets = useMemo<Target[]>(() => {
    if (!info?.tile_url_template) return [];
    const out: Target[] = [];
    for (const tile of activeTiles) {
      for (const rh of rhs) {
        out.push({
          url: fillTemplate(info.tile_url_template, { year, tile, rh, q: info.q_index }),
          name: fileName('tile', year, rh, info.q_index, tile),
          label: rhs.length > 1 ? `${tile} · RH${rh}` : tile,
        });
      }
    }
    return out;
  }, [info, activeTiles, rhs, year]);

  /**
   * Fetch one file, then save it under our own name.
   *
   * A plain `<a download="…">` cannot do this: the attribute is ignored for
   * cross-origin URLs, so the file would land under the object store's name —
   * `RH98_Q1.tif` for every tile and every mosaic alike. Streaming it through
   * the page is the only way to choose the name, at the cost of holding the
   * file in memory. That cost is why a large selection gets a script instead.
   */
  const saveOne = useCallback(
    async (target: Target, signal: AbortSignal, onProgress: (frac: number) => void) => {
      const resp = await fetch(target.url, { signal });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const total = Number(resp.headers.get('content-length')) || 0;
      const reader = resp.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      // Reported per whole percent, not per chunk.
      //
      // A 109 MB tile arrives in thousands of chunks, and calling back on each
      // one put a React render — and, through the flyout's positioning effect,
      // three forced layouts — between every read. The download loop spent its
      // time laying out the page instead of reading the socket, which turned a
      // ~30 s transfer into minutes. At most 100 updates per file cannot.
      let reported = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== reported) {
            reported = pct;
            onProgress(received / total);
          }
        }
      }

      const href = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: 'image/tiff' }));
      const a = document.createElement('a');
      a.href = href;
      a.download = target.name;
      a.click();
      URL.revokeObjectURL(href);
    },
    [],
  );

  /**
   * One button, however many files it stands for. Clicking it works through the
   * selection in order, so the reader makes one decision instead of one per
   * file — which is the whole point of choosing levels in a picker.
   */
  const run = useCallback(
    async (key: string, targets: Target[]) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setBatch({ key, done: 0, total: targets.length, frac: 0 });

      for (let i = 0; i < targets.length; i++) {
        if (controller.signal.aborted) break;
        try {
          await saveOne(targets[i], controller.signal, (frac) =>
            setBatch((b) => (b && b.key === key ? { ...b, frac } : b)),
          );
        } catch (err) {
          if ((err as Error).name === 'AbortError') break;
          // Renaming is a nicety; getting the file is not. Hand this one to the
          // browser under the store's own name and carry on with the rest —
          // one bad file should not end the batch.
          console.warn('[download] streaming failed, falling back to a direct link', err);
          window.open(targets[i].url, '_blank', 'noopener');
        }
        setBatch((b) => (b && b.key === key ? { ...b, done: i + 1, frac: 0 } : b));
      }

      abortRef.current = null;
      setBatch(null);
    },
    [saveOne],
  );

  // The cap applies to the tile row alone: 101 mosaics is 101 files, but one
  // pan at zoom 8 with every level chosen is tens of thousands, and that is the
  // list worth refusing to write.
  const tilesCapped = tileTargets.length > MAX_SCRIPT_FILES;
  const tileScripted = tilesCapped ? tileTargets.slice(0, MAX_SCRIPT_FILES) : tileTargets;

  /**
   * A shell script rather than a list of URLs.
   *
   * `wget -i urls.txt` would save every one of these as `RH98_Q1.tif` and then
   * `RH98_Q1.tif.1`, `.2`, … — the same collision the browser downloads have,
   * and worse because it is silent. `curl -o` takes the name we want, so the
   * script is what makes a bulk download usable.
   */
  const downloadScript = useCallback(
    (targets: Target[], label: string) => {
      const lines = [
        '#!/bin/sh',
        '# Vertical Vegetation Structure Model — CC BY 4.0',
        '# https://source.coop/geoai-ucph/gvsm',
        `# ${targets.length} files, roughly 100-170 MB each.`,
        'set -e',
        ...targets.map((t) => `curl -L --fail -C - -o "${t.name}" "${t.url}"`),
      ];
      const href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = href;
      a.download = `gvsm_${year}_${label}.sh`;
      a.click();
      URL.revokeObjectURL(href);
    },
    [year],
  );

  const copyUrls = useCallback(
    (targets: Target[]) => {
      navigator.clipboard.writeText(targets.map((t) => t.url).join('\n')).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        },
        () => setCopied(false),
      );
    },
    [],
  );

  // Nothing to offer when the backend serves from local disk, or before it has
  // answered. Rendering an empty "Download" heading would promise otherwise.
  if (!info) return null;

  const summary =
    rhs.length === 0
      ? 'none'
      : rhs.length === allRhs.length
        ? `all ${rhs.length}`
        : rhs.length <= 3
          ? rhs.map((r) => `RH${r}`).join(', ')
          : `${rhs.length} levels`;

  /**
   * One button per row. Below the threshold it fetches the files itself, named;
   * above it, it writes the script that does the same thing outside the browser.
   * Either way the reader clicks once — the selection was already made in the
   * picker, and asking for it again per file is asking twice.
   */
  const targetControls = (targets: Target[], key: string, label: string) => {
    const mine = batch?.key === key ? batch : null;
    const busy = batch !== null;

    if (targets.length <= MAX_DIRECT_FILES) {
      return (
        <div className="ex-download__links">
          <button
            type="button"
            className={mine ? 'ex-download__go is-running' : 'ex-download__go'}
            onClick={() => run(key, targets)}
            disabled={busy}
            title={targets.map((t) => t.name).join('\n')}
          >
            {mine
              ? `${mine.done + 1} of ${mine.total} · ${Math.round(mine.frac * 100)}%`
              : `Download ${targets.length} file${targets.length === 1 ? '' : 's'}`}
          </button>
          {mine && (
            <button type="button" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          )}
        </div>
      );
    }

    return (
      <div className="ex-download__links">
        <button
          type="button"
          className="ex-download__go"
          onClick={() => downloadScript(targets, label)}
        >
          Download script · {targets.length} files
        </button>
        <button type="button" onClick={() => copyUrls(targets)}>
          {copied ? 'Copied' : 'Copy URLs'}
        </button>
      </div>
    );
  };

  return (
    <>
      {/* All the sidebar keeps: one button. Everything the panel used to show
          inline — three rows of controls, a 101-cell grid and four paragraphs
          of notes — was crowding out the controls people came for, for the sake
          of a step most readers take once, at the end. */}
      <button
        ref={triggerRef}
        type="button"
        className={open ? 'ex-download-trigger is-open' : 'ex-download-trigger'}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 3a1 1 0 0 1 1 1v8.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4l2.3 2.3V4a1 1 0 0 1 1-1ZM5 18a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z"
          />
        </svg>
        Download data
      </button>

      {open && (
        <div
          ref={panelRef}
          className="ex-flyout"
          style={{ left: pos.left, top: pos.top }}
          role="dialog"
          aria-label="Download the data"
        >
          <header className="ex-flyout__head">
            <h2>Download</h2>
            {/* Before the close button, in the order they are reached for: pin
                while working, close when done. */}
            <button
              type="button"
              className={pinned ? 'ex-flyout__pin is-on' : 'ex-flyout__pin'}
              onClick={() => setPinned((p) => !p)}
              aria-pressed={pinned}
              aria-label={pinned ? 'Unpin' : 'Pin'}
              title={
                pinned
                  ? 'Pinned — stays open while you pan and click the map'
                  : 'Pin so it stays open while you pan and click the map'
              }
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3Z"
                />
              </svg>
            </button>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </header>

          {/* Its own RH control, not the map's. Every level from 0 to 100 is
              published, and the seven buttons in the sidebar are a viewing
              choice — there is no reason a download should inherit it beyond a
              sensible default. Open on the page rather than behind a second
              disclosure: the flyout has the room the sidebar did not, and a
              dropdown inside a popup is one lid too many. */}
          <div className="ex-download__row">
            <span className="ex-download__label">
              <span className="ex-download__step">
                <span className="ex-download__step-n" aria-hidden="true">
                  1
                </span>
                Choose relative heights
              </span>
              <span className="ex-download__count">{summary}</span>
            </span>
            <div className="ex-download__picker">
              <div className="ex-download__picker-actions">
              <button type="button" onClick={() => setChosen(allRhs)}>
                All {allRhs.length}
              </button>
                <button type="button" onClick={() => setChosen([...rhIndexes])}>
                  On the map
                </button>
                <button type="button" onClick={() => setChosen([])}>
                  None
                </button>
              </div>
              {/* Every level, highest first — RH100 at the top reads as the top
                  of the canopy, which is what it is. */}
              <div className="ex-download__grid" role="group" aria-label="Relative height levels">
                {allRhs.map((rh) => {
                  const on = rhs.includes(rh);
                  return (
                    <button
                      key={rh}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      className={on ? 'is-active' : undefined}
                      onClick={() => setChosen(on ? rhs.filter((r) => r !== rh) : [...rhs, rh])}
                    >
                      {rh}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Both rows below download the levels chosen above, at the two
              granularities the store is published in — so they are one step
              with a choice inside it, not two more steps. Saying so here is
              the whole reason for the numbering: without it the levels read
              as belonging only to the row they sit next to. */}
          <div className="ex-download__group">
            <span className="ex-download__label">
              <span className="ex-download__step">
                <span className="ex-download__step-n" aria-hidden="true">
                  2
                </span>
                Download those RHs
              </span>
            </span>
            <span className="ex-hint">At either resolution — both use the levels above.</span>
            <div className="ex-download__group-body">
              {/* The whole-world file first: it is one click, it always works, and
                  it is the right answer for anyone who does not care about a
                  specific place. The per-tile machinery below is for people who
                  do. */}
              {info.mosaic_url_template && (
                <div className="ex-download__row">
                  <span className="ex-download__label">
                    Global overview, ~1 km
                    {mosaicTargets.length > 0 && (
                      <span className="ex-download__count">
                        {mosaicTargets.length} file{mosaicTargets.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>
                  {mosaicTargets.length === 0 ? (
                    <span className="ex-hint">Choose at least one relative height.</span>
                  ) : (
                    targetControls(mosaicTargets, 'mosaic', 'global_mosaic_1km')
                  )}
                </div>
              )}

              <div className="ex-download__row">
                <span className="ex-download__label">
                  Full resolution, 10 m
                  {tileTargets.length > 0 && (
                    <span className="ex-download__count">
                      {activeTiles.length} tile{activeTiles.length === 1 ? '' : 's'} × {rhs.length}
                    </span>
                  )}
                </span>

                {/* The map is the tile picker; this is only the instruction and the
                    two bulk shortcuts.

                    The list of tile names that used to sit here is gone. It was a
                    second copy of the selection with no advantage over the first:
                    the names mean nothing without the geography, so reading
                    "47QPB" told you neither where it was nor whether it was the one
                    you wanted — you had to look at the map anyway. The count in the
                    label above says how many are chosen, which is the part the list
                    was actually carrying. */}
                <span className="ex-hint">
                  {zoom !== null && zoom < GRID_ZOOM
                    ? 'Zoom in to see the tile grid — the 10 m data is published per Sentinel-2 (MGRS) tile.'
                    : 'Click tiles on the map to choose them.'}
                </span>
                <div className="ex-download__picker-actions">
                  <button type="button" onClick={() => setPicked(null)}>
                    All in view
                  </button>
                  <button type="button" onClick={() => setPicked([])}>
                    None
                  </button>
                </div>

                {/* Nothing to download is the normal starting state now, and the
                    line above already says what to do about it — so the only cases
                    worth their own words are the two the reader cannot act on: no
                    levels chosen, and a view with no data under it. */}
                {rhs.length === 0 ? (
                  <span className="ex-hint">Choose at least one relative height.</span>
                ) : zoom !== null && zoom >= TILE_ZOOM && tiles.length === 0 && activeTiles.length === 0 ? (
                  <span className="ex-hint">No tiles here — the view is off the data.</span>
                ) : tileTargets.length === 0 ? null : (
                  <>
                    {targetControls(tileScripted, 'tiles', 'tiles_10m')}
                    {tileTargets.length > MAX_DIRECT_FILES && (
                      <span className="ex-hint">
                        Roughly 100 MB each.{' '}
                        {tilesCapped &&
                          `Capped at ${MAX_SCRIPT_FILES} of ${tileTargets.length} files — zoom in, choose fewer levels, or take the whole repository instead. `}
                        Run it with <code>sh</code>; it names each file and resumes a broken transfer.
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* The one thing this panel cannot do, and where to go for it. The
              note that used to sit here — that a COG can be subset in place
              with gdal_translate over /vsicurl/ — was the reasoning behind not
              building an area-of-interest download, not something the reader
              needs at the moment of downloading. Anyone who would act on it
              already knows it. */}
          {/* A real address, not the `huzh,nila,igel@di.ku.dk` shorthand: that
              is one address as far as a mail client is concerned, and it does
              not exist. One visible recipient with the others on cc — three
              addresses in a row wrap to three lines here and make the sentence
              hard to read, while a bare "contact us" hides the thing a reader
              may want to copy rather than click.

              No target="_blank": mailto opens a mail client, not a tab. */}
          <span className="ex-hint">
            For everything at once, contact us at{' '}
            <a href="mailto:huzh@di.ku.dk?cc=nila@di.ku.dk,igel@di.ku.dk">{"{huzh,nila,igel}@di.ku.dk"}</a>.
          </span>
        </div>
      )}
    </>
  );
}
