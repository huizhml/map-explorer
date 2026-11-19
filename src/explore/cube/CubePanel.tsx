import { useEffect, useRef, useState } from 'react';
import { shiftNote, type Cube, type ZMode } from './cubeData';
import { CubeScene, type Axis, type CameraState, type Display, type Snapshot, type TopMode } from './CubeScene';
import { esriGround, groundCaption, sentinel2Ground, type Ground, type GroundSource } from './groundImagery';
import { INFERNO } from './inferno';
import { withLegend } from './figureLegend';
import { Overview } from './Overview';
import { cssGradient, ENERGY_LUT } from './colormaps';
import { BlockIcon, CollapseIcon, DownloadIcon, ExpandIcon, HelpIcon, ResetViewIcon, SlidersIcon } from '../icons';

/**
 * The 3D datacube of the clicked place, inside the reading card. Loaded with
 * React.lazy: three.js is only downloaded once a cube is on screen.
 */

/** A cube view carried by a shared link (see SimpleApp's share URL). */
export type CubeView = {
  mode: ZMode;
  display: Display;
  cx: number;
  cy: number;
  cz: number;
  cutoff: number;
  /** Carried by a saved page, not by the share link. */
  topMode?: TopMode;
  vmax?: number;
  zStretch?: number;
  /** RH surfaces: sheet opacity, and the levels switched off. */
  opacity?: number;
  hidden?: number[];
  /** RH surfaces: bottom cut, metres. */
  cz0?: number;
};

/** What "Save as page" reads from the live cube. */
export type CubeExportApi = {
  camera: () => CameraState | null;
  /** Both images for the saved page: the one on screen and the other, loaded if need be. */
  grounds: () => Promise<Partial<Record<'s2' | 'esri', Ground>>>;
};

type Props = {
  cube: Cube | null;
  /** Window pixel the pin was dragged to; null = the clicked pixel. */
  probe: { row: number; col: number } | null;
  loading: boolean;
  error?: string;
  ground: GroundSource;
  onGround: (g: GroundSource) => void;
  /** Applied once, to the first cube that arrives (a shared link). */
  initialView?: CubeView | null;
  /** Slice positions, for drawing them on the map and for the share link. */
  onSnapshot?: (s: Snapshot) => void;
  /** Saved page: images already in hand; the Ground choice is limited to these. */
  preloaded?: Partial<Record<GroundSource, Ground>>;
  /** Saved page: open on the camera it was saved with. */
  initialCamera?: CameraState | null;
  exportRef?: React.MutableRefObject<CubeExportApi | null>;
  /**
   * 'card': inside the explorer's reading card (the overview image only when
   * enlarged — the map beside it already shows where the slices are).
   * 'docked': a saved page — view and controls side by side, overview always on.
   */
  layout?: 'card' | 'docked';
  /** The pin moved on an overview image (window pixel, row 0 = north). */
  /** Move the pin to a window pixel. `focus`: picked on the cube itself, so the map should zoom to it. */
  onPick?: (row: number, col: number, opts?: { focus?: boolean }) => void;
  /** More content for the image column (saved page, enlarged card), under the height maps: the profiles. */
  sideExtra?: React.ReactNode;
};

const RH98_SRC = { rh: 98, vmax: 50 };
const RH25_SRC = { rh: 25, vmax: 12 };

const INFERNO_GRADIENT = cssGradient(INFERNO);
const ENERGY_GRADIENT = cssGradient(ENERGY_LUT);

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  disabledTitle,
}: {
  value: T;
  options: { v: T; text: string; title: string }[];
  onChange: (v: T) => void;
  label: string;
  /** Shown but not usable: keeps its row, so the rows below do not move. */
  disabled?: boolean;
  disabledTitle?: string;
}) {
  return (
    <div
      className={`ex-seg${disabled ? ' is-disabled' : ''}`}
      role="group"
      aria-label={label}
      title={disabled ? disabledTitle : undefined}
    >
      {options.map((o) => (
        <button
          key={o.v}
          className={!disabled && o.v === value ? 'is-on' : ''}
          title={disabled ? undefined : o.title}
          disabled={disabled}
          onClick={() => onChange(o.v)}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ex-field-mini">
      <span className="ex-field-mini__label">{label}</span>
      {children}
    </div>
  );
}

export default function CubePanel({
  cube,
  probe,
  loading,
  error,
  ground,
  onGround,
  initialView,
  onSnapshot,
  preloaded,
  initialCamera,
  exportRef,
  layout = 'card',
  onPick,
  sideExtra,
}: Props) {
  const viewRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<CubeScene | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [vmaxText, setVmaxText] = useState('');
  const [groundInfo, setGroundInfo] = useState<{
    loading: boolean;
    error?: string;
    g?: Ground;
  }>({ loading: false });
  const groundCache = useRef(new Map<string, Ground>());

  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const initialViewRef = useRef(initialView);
  const initialCameraRef = useRef(initialCamera);
  const viewCube = useRef<Cube | null>(null);
  const probeRef = useRef(probe);
  probeRef.current = probe;

  useEffect(() => {
    const canvas = canvasRef.current;
    const tip = tipRef.current;
    const view = viewRef.current;
    if (!canvas || !tip || !view) return;
    const scene = new CubeScene(
      canvas,
      tip,
      (s) => {
        setSnap(s);
        onSnapshotRef.current?.(s);
      },
      {
        // The saved page has the room for a bigger cube.
        homeDistance: layout === 'docked' ? 2.05 : 2.75,
        // Double-click on the cube: move the pin to that column and look at it on the map.
        onPickColumn: (row, col) => onPickRef.current?.(row, col, { focus: true }),
      },
    );
    sceneRef.current = scene;
    const ro = new ResizeObserver(() => scene.resize(view.clientWidth, view.clientHeight));
    ro.observe(view);
    return () => {
      ro.disconnect();
      scene.destroy();
      sceneRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- one scene per panel; layout never changes

  useEffect(() => {
    const scene = sceneRef.current;
    if (!cube || !scene) return;
    scene.setCube(cube);
    // The shared view belongs to the first cube only. Keyed by that cube rather
    // than cleared after use: StrictMode remounts the scene, and the remount
    // must apply it again.
    const v = initialViewRef.current;
    if (v && (viewCube.current === null || viewCube.current === cube)) {
      viewCube.current = cube;
      scene.applyView(v, probeRef.current);
    }
    const cam = initialCameraRef.current;
    if (cam && (viewCube.current === null || viewCube.current === cube)) {
      viewCube.current = cube;
      scene.setCameraState(cam);
    }
  }, [cube]);

  useEffect(() => {
    sceneRef.current?.setProbe(probe);
  }, [probe]);

  /** A ground image for this window: handed in (saved page), cached, or fetched. */
  const preloadedRef = useRef(preloaded);
  preloadedRef.current = preloaded;
  const loadGround = (c: Cube, source: Exclude<GroundSource, 'off'>, signal?: AbortSignal): Promise<Ground> => {
    const pre = preloadedRef.current?.[source];
    if (pre) return Promise.resolve(pre);
    const key = `${c.meta.tile}|${c.meta.bounds.join(',')}|${c.meta.year}|${source}`;
    const hit = groundCache.current.get(key);
    if (hit) return Promise.resolve(hit);
    return (source === 's2' ? sentinel2Ground(c.meta, signal) : esriGround(c.meta)).then((g) => {
      groundCache.current.set(key, g);
      return g;
    });
  };
  const loadGroundRef = useRef(loadGround);
  loadGroundRef.current = loadGround;

  // Ground image under the cube: per window and source, cached for the session.
  useEffect(() => {
    const scene = sceneRef.current;
    scene?.setGround(null);
    if (!cube || ground === 'off') {
      setGroundInfo({ loading: false });
      return;
    }
    let stale = false;
    const abort = new AbortController();
    setGroundInfo({ loading: true });
    loadGroundRef
      .current(cube, ground, abort.signal)
      .then((g) => {
        if (stale) return;
        sceneRef.current?.setGround(g.image);
        setGroundInfo({ loading: false, g });
      })
      .catch((err) => {
        if (!stale)
          setGroundInfo({
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      stale = true;
      abort.abort();
    };
  }, [cube, ground, preloaded]);

  const cubeRef = useRef(cube);
  cubeRef.current = cube;
  useEffect(() => {
    if (!exportRef) return;
    exportRef.current = {
      camera: () => sceneRef.current?.cameraState() ?? null,
      grounds: async () => {
        const c = cubeRef.current;
        const out: Partial<Record<'s2' | 'esri', Ground>> = {};
        if (!c) return out;
        await Promise.all(
          (['s2', 'esri'] as const).map((src) =>
            loadGroundRef.current(c, src).then(
              (g) => void (out[src] = g),
              () => undefined, // a page without that image is still worth saving
            ),
          ),
        );
        return out;
      },
    };
    return () => {
      exportRef.current = null;
    };
  }, [exportRef]);

  useEffect(() => {
    if (snap) setVmaxText(String(snap.vmax));
  }, [snap?.vmax]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // The layout jumps under the pointer, so no pointerleave clears the tip.
    if (tipRef.current) tipRef.current.style.display = 'none';
    if (!expanded) return;
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && setExpanded(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  // How to use and More options open over the cube, so the panel under it
  // stays short. A click outside the cube closes them; clicks on the cube do
  // not, so the view can be turned while a setting is being tried.
  const [pop, setPop] = useState<'help' | 'options' | null>(null);
  useEffect(() => {
    if (!pop) return;
    const close = (ev: PointerEvent) => {
      if (!viewRef.current?.contains(ev.target as Node)) setPop(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [pop]);
  const togglePop = (p: 'help' | 'options') => setPop((cur) => (cur === p ? null : p));

  const docked = layout === 'docked';
  // Saved page and enlarged card share one layout: images | cube | controls.
  // In the card itself the map beside it already shows where the slices are.
  const sideColumn = docked || expanded;
  const sideImages = docked
    ? (['s2', 'esri'] as const).flatMap((src) => (preloaded?.[src] ? [{ src, g: preloaded[src]! }] : []))
    : ground !== 'off' && groundInfo.g
      ? [{ src: ground, g: groundInfo.g }]
      : [];

  const scene = sceneRef.current;
  const meta = cube?.meta;
  const note = meta ? shiftNote(meta) : null;
  const credit =
    ground === 'off'
      ? ''
      : groundInfo.loading
        ? ground === 's2'
          ? 'Finding a cloud-free Sentinel-2 scene…'
          : 'Loading Esri imagery…'
        : groundInfo.error
          ? `Image unavailable: ${groundInfo.error}`
          : groundInfo.g
            ? `${groundInfo.g.credit}${groundInfo.g.note ? ` · ${groundInfo.g.note}` : ''}`
            : '';
  const res = meta?.res_m[0] ?? 10;
  const planes = snap?.display === 'planes';
  const canopyTop = snap?.mode === 'energy' && snap.topMode === 'canopy';
  const surfaces = snap?.mode === 'surfaces';

  const sliders: {
    axis: Axis;
    name: string;
    title: string;
    max: number;
    value: number;
    text: string;
  }[] = snap
    ? [
        {
          axis: 'x',
          name: planes ? 'N–S' : 'East',
          title: planes ? 'X · north–south slice' : 'X · east face',
          max: snap.nx - 1,
          value: snap.cx,
          text: `${((snap.cx + (planes ? 0.5 : 1)) * res).toFixed(0)} m from W`,
        },
        {
          // Left = deep (north), right = whole block, as in the prototype.
          axis: 'y',
          name: planes ? 'E–W' : 'South',
          title: planes ? 'Y · east–west slice' : 'Y · south face',
          max: snap.ny - 1,
          value: snap.ny - 1 - snap.cy,
          text: `${((snap.cy + (planes ? 0.5 : 0)) * res).toFixed(0)} m from S`,
        },
        {
          axis: 'z',
          name: planes ? 'Level' : 'Top',
          title: planes ? 'Z · horizontal slice' : 'Z · top face',
          max: snap.nz - 1,
          value: snap.cz,
          text: `${snap.zLabel}${snap.zInterpolated ? ' (interp.)' : ''}`,
        },
      ]
    : [];

  const gaps = meta ? [...meta.missing_rh, ...meta.failed_rh].filter((rh) => rh > 0) : [];
  const unfilled = meta ? gaps.filter((rh) => !meta.interpolated_rh.includes(rh)) : [];
  const setVmax = () => scene?.setVmax(+vmaxText);

  return (
    <section
      className={`ex-cube${expanded ? ' ex-cube--expanded' : ''}${layout === 'docked' ? ' ex-cube--docked' : ''}`}
      aria-label="3D datacube"
    >
      <div className="ex-sec__head">
        <h3>3D datacube</h3>
        {meta && (
          <span>
            {meta.size} × {meta.size} px · {((meta.size * res) / 1000).toFixed(2)} km · {meta.year}
          </span>
        )}
      </div>

      {sideColumn && cube && (
        <div className="ex-cube__side">
          {sideImages.map(({ src, g }) => (
            <Overview
              key={src}
              src={g.image}
              cube={cube}
              snap={snap}
              probe={probe}
              caption={groundCaption(src, g)}
              title={g.credit}
              className={sideImages.length === 1 ? 'is-wide' : undefined}
              onPick={onPick}
            />
          ))}
          {/* VSM height-map ranges: RH98 0–50 m, RH25 0–12 m. */}
          <Overview
            src={RH98_SRC}
            cube={cube}
            snap={snap}
            probe={probe}
            caption="Canopy height · RH98"
            onPick={onPick}
          />
          <Overview src={RH25_SRC} cube={cube} snap={snap} probe={probe} caption="RH25" onPick={onPick} />
          {sideExtra && <div className="ex-cube__side-extra">{sideExtra}</div>}
        </div>
      )}

      <div className="ex-cube__view" ref={viewRef}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label="3D view of the VSM datacube; drag to rotate, scroll on a slice to move it"
        />
        <div className="ex-cube__tip" ref={tipRef} />
        <div className="ex-cube__tools">
          <button
            title="How to use"
            aria-label="How to use"
            aria-pressed={pop === 'help'}
            className={pop === 'help' ? 'is-on' : undefined}
            onClick={() => togglePop('help')}
          >
            <HelpIcon size={15} />
          </button>
          <button
            title="More options"
            aria-label="More options"
            aria-pressed={pop === 'options'}
            className={pop === 'options' ? 'is-on' : undefined}
            onClick={() => togglePop('options')}
          >
            <SlidersIcon size={15} />
          </button>
          <button
            title={planes ? 'Move the slices back to the pin' : 'Show the whole block'}
            aria-label={planes ? 'Move the slices back to the pin' : 'Show the whole block'}
            onClick={() => scene?.resetCuts()}
          >
            <BlockIcon size={15} />
          </button>
          <button title="Reset view (R)" aria-label="Reset view" onClick={() => scene?.resetView()}>
            <ResetViewIcon size={15} />
          </button>
          <button
            title="Download this view (PNG)"
            aria-label="Download this view as PNG"
            onClick={async () => {
              if (!scene) return;
              const m = cube.meta;
              const a = document.createElement('a');
              const png = scene.snapshot();
              a.href = snap ? await withLegend(png, snap, canvasRef.current?.clientWidth ?? 0) : png;
              // Z axis, then Display and Top slice where they apply (same rules as the option rows).
              const opts: string[] = snap ? [{ energy: 'energy', rh: 'rh', surfaces: 'rh-surfaces' }[snap.mode]] : [];
              if (snap && snap.mode !== 'surfaces') opts.push(snap.display === 'planes' ? 'slices' : 'cutaway');
              if (snap?.mode === 'energy') opts.push(snap.topMode === 'canopy' ? 'top-canopy' : 'top-energy');
              const name = ['vsm-cube-' + m.year, m.lat.toFixed(4), m.lon.toFixed(4), ...opts].join('_');
              a.download = `${name}.png`;
              a.click();
            }}
          >
            <DownloadIcon size={15} />
          </button>
          <button
            title={expanded ? 'Back to the card (Esc)' : 'Enlarge'}
            aria-label={expanded ? 'Back to the card' : 'Enlarge'}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? <CollapseIcon size={15} /> : <ExpandIcon size={15} />}
          </button>
        </div>

        {pop === 'help' && (
          <section className="ex-intro ex-intro--compact ex-cube__float" aria-label="How to use">
            <ol>
              <li>Drag the pin inside the box on the map to read any pixel.</li>
              <li>Double-click a point on the cube to move the pin there and zoom the map to it.</li>
              <li>In the cube: drag to rotate, right-drag to pan, shift+scroll or pinch to zoom.</li>
              <li>Scroll on a slice to move it; in RH surfaces, option/alt + scroll moves the bottom cut.</li>
              <li>Click the cube, then X / Y / Z and the arrow keys.</li>
            </ol>
          </section>
        )}
        {pop === 'options' && snap && (
          <div className="ex-cube__float ex-cube__options">
            {/* Energy only: RH is always drawn opaque (user, 2026-10-30). */}
            {snap.mode === 'energy' && (
              <label className="ex-cube__slider" title="Values at the low end of the colour bar are not drawn">
                <span className="ex-cube__axis">Transparent</span>
                <input
                  type="range"
                  min={0}
                  max={0.5}
                  step={0.01}
                  value={snap.cutoff}
                  onChange={(e) => scene?.setCutoff(+e.target.value)}
                />
                <output>
                  {snap.cutoff === 0 ? 'off' : `below ${+(snap.cutoff * snap.vmax).toFixed(1)} ${snap.unit}`}
                </output>
              </label>
            )}
            <label className="ex-cube__slider" title="Vertical exaggeration of the block">
              <span className="ex-cube__axis">Z stretch</span>
              <input
                type="range"
                min={0.3}
                max={2}
                step={0.05}
                value={snap.zStretch}
                onChange={(e) => scene?.setZStretch(+e.target.value)}
              />
              <output>× {snap.zStretch.toFixed(2)}</output>
            </label>
          </div>
        )}
        {credit && (
          <div className="ex-cube__attr" title={credit}>
            {credit}
          </div>
        )}

        <div className={sideColumn ? 'ex-cube__bottomright' : 'ex-cube__topleft'}>
          {snap && surfaces && (
            <div className="ex-cube__legend">
              <div className="ex-cube__legend-title">RH · click to hide</div>
              <div className="ex-cube__levels">
                {snap.levels.map((l) => (
                  <button
                    key={l.rh}
                    className={l.on ? '' : 'is-off'}
                    aria-pressed={l.on}
                    title={`${l.on ? 'Hide' : 'Show'} the RH${l.rh} surface`}
                    onClick={() => scene?.toggleLevel(l.rh)}
                  >
                    <i style={{ background: l.colour }} />
                    {l.rh}
                  </button>
                ))}
              </div>
            </div>
          )}
          {snap && !surfaces && (
            <div className="ex-cube__legend">
              <div className="ex-cube__legend-title">{snap.cbarTitle}</div>
              <div
                className="ex-cube__cbar-ramp"
                style={{
                  background: snap.mode === 'rh' ? INFERNO_GRADIENT : ENERGY_GRADIENT,
                }}
              >
                {snap.mode === 'energy' && (
                  <div className="ex-cube__cbar-clear" style={{ width: `${snap.cutoff * 100}%` }} />
                )}
              </div>
              <div className="ex-cube__cbar-ticks">
                <span>0</span>
                <span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={vmaxText}
                    title="Colour range maximum"
                    aria-label="Colour range maximum"
                    onChange={(e) => setVmaxText(e.target.value)}
                    onBlur={setVmax}
                    onKeyDown={(e) => e.key === 'Enter' && setVmax()}
                  />
                  {snap.unit}
                </span>
              </div>
              {canopyTop && <div className="ex-cube__legend-note">top slice: RH98, 0–50 m</div>}
            </div>
          )}
        </div>

        {(loading || error || !cube) && (
          <div className="ex-cube__status">
            {loading ? (
              <>
                <span className="ex-spinner" />
                Building the cube… reads RH0–RH100
              </>
            ) : error ? (
              `3D cube unavailable: ${error}`
            ) : (
              ''
            )}
          </div>
        )}
      </div>

      {snap && meta && (
        <div className="ex-cube__controls">
          {/* Switches left, sliders right, four rows each. Nothing appears or
              disappears with the mode (Top slice and Bottom grey out instead),
              so the panel never changes height. Help, More options and the
              image credit sit on the cube. */}
          <div className="ex-cube__panes">
            <div className="ex-cube__rows">
              <Field label="Z axis">
                <Segmented<ZMode>
                  label="Z axis"
                  value={snap.mode}
                  onChange={(v) => scene?.setMode(v)}
                  options={[
                    {
                      v: 'energy',
                      text: 'Energy',
                      title:
                        'z = height above ground in 1 m bins; colour = share of RH1–RH100 that falls in the bin (energy share)',
                    },
                    {
                      v: 'rh',
                      text: 'RH',
                      title: 'Relative height: z = RH (RH1 bottom … RH100 top); colour = height (inferno)',
                    },
                    {
                      v: 'surfaces',
                      text: 'RH surfaces',
                      title: 'one see-through surface per RH (RH10, RH20 … RH100); z = height above ground',
                    },
                  ]}
                />
              </Field>
              {surfaces ? (
                <label className="ex-cube__slider ex-cube__slider--field" title="How see-through the RH surfaces are">
                  <span className="ex-cube__axis">Opacity</span>
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={snap.opacity}
                    aria-label="Surface opacity"
                    onChange={(e) => scene?.setOpacity(+e.target.value)}
                  />
                  <output>{Math.round(snap.opacity * 100)} %</output>
                </label>
              ) : (
                <Field label="Display">
                  <Segmented<Display>
                    label="Display"
                    value={snap.display}
                    onChange={(v) => scene?.setDisplay(v)}
                    options={[
                      {
                        v: 'planes',
                        text: 'Crossing slices',
                        title: 'three slices crossing in an otherwise empty volume',
                      },
                      {
                        v: 'cut',
                        text: 'Cutaway block',
                        title: 'solid block; scrolling peels the faces away',
                      },
                    ]}
                  />
                </Field>
              )}
              <Field label="Top slice">
                <Segmented<TopMode>
                  label="Top slice"
                  disabled={snap.mode !== 'energy'}
                  disabledTitle="Energy mode only"
                  value={snap.topMode}
                  onChange={(v) => scene?.setTopMode(v)}
                  options={[
                    {
                      v: 'slice',
                      text: 'Energy',
                      title: 'energy share in the 1 m bin, like the vertical slices',
                    },
                    {
                      v: 'canopy',
                      text: 'Canopy top',
                      title: 'canopy top height (RH98), cut at the slice height: what you see looking down',
                    },
                  ]}
                />
              </Field>
              <Field label="Ground">
                <Segmented<GroundSource>
                  label="Image under the cube"
                  value={ground}
                  onChange={onGround}
                  options={(
                    [
                      {
                        v: 's2',
                        text: `Sentinel-2 ${meta.year}`,
                        title: 'Cloud-free Sentinel-2 of the VSM year, 10 m',
                      },
                      {
                        v: 'esri',
                        text: 'Esri satellite',
                        title: 'Esri World Imagery, ~1 m; date unknown, usually later',
                      },
                      { v: 'off', text: 'Off', title: 'No image under the cube' },
                    ] as { v: GroundSource; text: string; title: string }[]
                  ).filter((o) => !preloaded || o.v === 'off' || preloaded[o.v])}
                />
              </Field>
            </div>

            <div className="ex-cube__sliders">
              {sliders.map((s) => (
                <label
                  key={s.axis}
                  title={s.title}
                  className={`ex-cube__slider${snap.activeAxis === s.axis ? ' is-active' : ''}`}
                >
                  <span className="ex-cube__axis">
                    <b>{s.axis.toUpperCase()}</b> {s.name}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={s.max}
                    step={1}
                    value={s.value}
                    onChange={(e) => scene?.setCut(s.axis, +e.target.value)}
                  />
                  <output>{s.text}</output>
                </label>
              ))}
              <label
                className={`ex-cube__slider${surfaces ? '' : ' is-disabled'}`}
                title={
                  surfaces
                    ? 'Bottom cut: raise it to drop the low levels (bare ground, grass) and keep the forest. Option/Alt + scroll on the cube moves it too.'
                    : 'RH surfaces only'
                }
              >
                <span className="ex-cube__axis">
                  <b>Z</b> Bottom
                </span>
                <input
                  type="range"
                  min={0}
                  max={snap.nz - 1}
                  step={1}
                  value={surfaces ? snap.cz0 : 0}
                  disabled={!surfaces}
                  onChange={(e) => scene?.setBottom(+e.target.value)}
                />
                <output>{surfaces ? `${snap.cz0} m` : ''}</output>
              </label>
            </div>
          </div>

          {meta.interpolated_rh.length > 0 && (
            <p className="ex-cube__note">
              RH{meta.interpolated_rh.join(', RH')} {meta.interpolated_rh.length > 1 ? 'are' : 'is'} missing in the
              archive for tile {meta.tile}; filled from the RH just below and above.
            </p>
          )}
          {unfilled.length > 0 && (
            <p className="ex-cube__note">
              RH{unfilled.join(', RH')} could not be read and {unfilled.length > 1 ? 'are' : 'is'} shown as no data.
            </p>
          )}
          {note && <p className="ex-cube__shift">{note}</p>}
        </div>
      )}
    </section>
  );
}
