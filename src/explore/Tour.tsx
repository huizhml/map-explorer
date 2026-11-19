import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { openSite, pickTiles, takeCamera, useExploreMap } from './exploreMap';
import { CloseIcon } from './icons';

/**
 * A guided tour of the explorer that does each step for the reader.
 *
 * One question, one place. The question is what this map adds to a canopy
 * height map; the place is one curated site (HERO_SITE_ID) where it shows:
 * every step reveals more of the same forest — canopy height, then RH25, then
 * the profile along a line, then one pixel in 3D, then the tile to download —
 * and only the last step sends the reader elsewhere.
 *
 * The page's instructions used to be a numbered list in the panel, and most
 * readers skipped it — so the last step, the one that opens the full vertical
 * profile and the cube, was the one least seen. Here each "Next" performs the
 * step (flies in, visits a site, clicks the map) and the card says what just
 * happened and how to do it yourself.
 *
 * Non-blocking: the dim layer and the spotlight take no pointer events, so the
 * map stays usable throughout and the reader can take over at any point.
 *
 * No library: the page is plain CSS with no UI framework (see explore.css), and
 * a spotlight plus a card is less code than adapting a tour package to it.
 */

const SEEN_KEY = 'vsm-explorer-tour-seen';

/** First visit only. Storage can be unavailable (private windows): then never auto-start. */
export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== null;
  } catch {
    return true;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* nothing to remember it in */
  }
}

const SITES_URL = `${import.meta.env.BASE_URL}sites/sites.json`;
/** From the dataset paper's repository (docs/assets/1a_vertical_structure.png), resized to 2400 px so it stays sharp when enlarged. */
const RH_FIGURE = `${import.meta.env.BASE_URL}tour/rh-profile.webp`;

/**
 * The tour's site: random6 in the bundle, a 2.2 km west–east transect in the
 * Spessart, Germany. Chosen from the published transects (2026-11-12) as the
 * clearest "same height, different inside": two stands ~600 m apart, both
 * ~23 m tall (RH98), with RH25 at ~2 m in one and ~10 m in the other (100 m
 * means of the transect samples).
 */
const HERO_SITE_ID = 78;
/**
 * Where the tour clicks: on the transect, 1.88 km along, midway between those
 * two stands (300 m either side). The cube spans 1.28 km, so it holds both.
 */
const HERO_POINT_M = 1885;

/**
 * The two stands the side-view step points at, along the hero transect: the
 * 100 m stretches (the window their numbers are averaged over) centred here.
 */
const HERO_STANDS = [
  { label: 'A', at: 1583, note: 'RH25 ≈ 2 m' },
  { label: 'B', at: 2185, note: 'RH25 ≈ 10 m' },
];

type Stand = { label: string; note: string; i0: number; i1: number; lonlat: [number, number] };
type Hero = { line: [number, number][]; point: [number, number]; samples: number; stands: Stand[] };

/** A label drawn over the page for one frame: a band (heatmap) or a point (map). */
type Note = {
  kind: 'band' | 'point';
  label: string;
  note?: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

type Side = 'right' | 'left' | 'top' | 'bottom';

type Step = {
  /** CSS selector to spotlight; none = a card on its own. */
  target?: string;
  side?: Side;
  /** Dim the page around the spotlight (or all of it, without a target). */
  dim?: boolean;
  /** A figure across the top of the card; the card widens to keep it legible. */
  media?: { src: string; alt: string };
  wide?: boolean;
  title: string;
  body: React.ReactNode;
  /** Done on the way in, going forward, once per tour. */
  enter?: () => void | Promise<void>;
  /** Left out when false, e.g. the random-site step without a published site bundle. */
  available?: () => boolean;
  /** A control inside the target to ring as well: the one the step pressed. */
  mark?: () => HTMLElement | null;
  /** Labels over the page, recomputed every frame so they follow what they mark. */
  notes?: () => Note[];
  /** The primary button's label, when "Next" undersells what it does next. */
  next?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** Opens the reading card at a point, as a map click does. */
  readAt: (lon: number, lat: number) => void;
  /** The RHs on the map, newest (drawn on top) last. */
  rhIndexes: number[];
};

const click = (selector: string) => document.querySelector<HTMLElement>(selector)?.click();

export function Tour({ open, onClose, readAt, rhIndexes }: Props) {
  const { map, grid } = useExploreMap();
  // `index` is the step asked for; `shown` the one on the card. They differ
  // only while the card swaps: it fades out, takes the new content and place
  // while invisible, then fades in — rather than animating its size and
  // position from one step's card to the next, which jumped about.
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(0);
  const [phase, setPhase] = useState<'in' | 'out' | 'place'>('in');
  const [busy, setBusy] = useState(false);
  /** The step's figure, enlarged over the page. */
  const [zoomed, setZoomed] = useState(false);
  const entered = useRef(new Set<number>());
  const hero = useRef<Hero | null>(null);
  // Set when the tour opened the download panel, so ending the tour closes it
  // again: left open, it keeps borrowing map clicks to pick tiles.
  const openedFlyout = useRef(false);
  const finish = () => {
    if (openedFlyout.current) document.querySelector<HTMLElement>('.ex-flyout [aria-label="Close"]')?.click();
    openedFlyout.current = false;
    onClose();
  };

  // Same file RandomSite reads, so it is in the browser cache by then.
  useEffect(() => {
    if (!open) return;
    new Image().src = RH_FIGURE;
    fetch(SITES_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        hero.current = heroFrom(m?.sites ?? []);
      })
      .catch(() => {});
  }, [open]);

  const steps: Step[] = [
    {
      dim: true,
      title: 'Beyond canopy top height',
      body: (
        <>
          What does a forest look like inside? Follow one example in Germany to explore what the vertical vegetation
          structure reveals beneath the canopy top.
        </>
      ),
    },
    {
      target: '[data-tour="rh"]',
      side: 'right',
      dim: true,
      wide: true,
      media: {
        src: RH_FIGURE,
        alt: 'Forest structure, its GEDI lidar energy profile, and the RH0–100 curve read from it',
      },
      title: 'How can the vertical structure be measured?',
      body: (
        <>
          GEDI records the laser energy reflected by vegetation and the ground in each footprint.{' '}
          <b>
            RH<i>n</i>
          </b>{' '}
          is the height above ground below which <i>n</i>% of that returned energy has accumulated.
          <ul className="ex-tour__list">
            <li>
              <b>RH98–RH100</b>: approximate canopy top height, comparable to conventional canopy height products.
            </li>
            <li>
              <b>RH50</b>: the height below which half of the returned energy has accumulated.
            </li>
            <li>
              <b>Low RHs (RH0–RH25)</b>: the lower part of the cumulative return, shaped by both vegetation and ground.
            </li>
          </ul>
          Together, RH0 … RH100 make a cumulative vertical profile for each pixel.
          <Showing rhIndexes={rhIndexes} />
        </>
      ),
    },
    {
      title: 'Start with the canopy top height',
      body: (
        <>
          This RH98 map shows a forest in the Spessart, Germany. Brighter colours indicate taller vegetation and darker
          colours indicate shorter vegetation.
        </>
      ),
      // Slow, so the switch from the ~1 km overview to the 10 m map can be seen
      // on the way down. The line drawn is the transect of step 4.
      enter: () => {
        const h = hero.current;
        if (!map || !h) return;
        ensureRh(98);
        map.getSource<GeoJSONSource>('site-transect')?.setData(lineFeature(h.line));
        return flight(map, () =>
          map.fitBounds(bbox(h.line), {
            padding: { top: 220, right: 120, bottom: 120, left: 120 },
            maxZoom: 14,
            duration: 7000,
          }),
        );
      },
    },
    {
      target: '[data-tour="rh"]',
      side: 'right',
      title: 'Look below the canopy',
      body: (
        <>
          Now <b>RH25</b>: the height below which 25% of the return energy has accumulated. Compare its spatial pattern
          with the canopy-height map. Does the same pattern appear lower in the profile? A side view helps explain the
          differences. crowns.
        </>
      ),
      mark: () => rhButton(25),
      enter: () => ensureRh(25),
    },
    {
      target: '.ex-site',
      // Beside the site card, not under it: the map below the card is where
      // the transect is drawn.
      side: 'left',
      title: 'Look from a side view',
      body: (
        <>
          The profile along the line: height up, distance across, colour the share of returned energy in each 1 m bin.
          Towards the east end, two stands ~600 m apart, <b>A</b> and <b>B</b>, are both about 23 m tall, yet a quarter
          of the energy has returned by 2 m above ground in A and by 10 m in B.
        </>
      ),
      enter: () => (map ? flight(map, () => openSite(HERO_SITE_ID)) : undefined),
      notes: () => standNotes(hero.current, map),
    },
    {
      target: '.ex-reading .ex-cube__view',
      side: 'right',
      title: 'From a profile to a 3D view',
      body: (
        <>
          A click on the map visualizes a cube showing a 1.28 × 1.28 km area around the selected point. The charts below
          describe the single 10 m pixel at the pin. Loading may take a few seconds.
          <ul className="ex-tour__list">
            <li>
              <b>Drag</b> to rotate the cube and view it from different angles.
            </li>
            <li>
              <b>Scroll over a slice</b> to move through the cube and reveal its internal structure.
            </li>
            <li>
              <b>Drag the map pin within the outlined area</b> to view profiles for another pixel.
            </li>
          </ul>
          Click <b>?</b> for more controls.
        </>
      ),
      enter: () => {
        const h = hero.current;
        if (!map || !h) return;
        const [lon, lat] = h.point;
        click('.ex-site__close');
        readAt(lon, lat);
        // Keep the pin out from under the card: it sits bottom-left on wide
        // screens and along the bottom on narrow ones.
        const wide = innerWidth >= 900;
        takeCamera(map);
        map.easeTo({
          center: [lon, lat],
          zoom: 14,
          offset: wide ? [Math.min(260, innerWidth * 0.18), 0] : [0, -map.getContainer().clientHeight * 0.25],
          duration: 900,
        });
      },
    },
    // The cube's other views, switched for the reader: each card sets one
    // up and rings the control it pressed, so the reader sees where it lives.
    {
      target: '.ex-reading .ex-cube',
      side: 'right',
      title: 'Explore different views',
      body: (
        <>
          Try <b>RH</b> to inspect relative height values, or <b>RH surfaces</b> to follow individual RH layers across
          the landscape.
        </>
      ),
      mark: () => cubeButton('Z axis', 'RH'),
      enter: () => pressCube('Z axis', 'RH'),
    },
    {
      target: '.ex-reading .ex-cube',
      side: 'right',
      title: 'Slices or a block',
      body: (
        <>
          Under <b>Display</b>, choose <b>Crossing slices</b> to examine intersecting cross-sections, or{' '}
          <b>Cutaway block</b> to look inside while keeping the surrounding structure visible.
        </>
      ),
      mark: () => cubeButton('Display', 'Crossing slices'),
      enter: async () => {
        // Back to Energy (Display is not offered for RH surfaces, should the
        // reader have picked it), then the slices.
        pressCube('Z axis', 'Energy');
        await new Promise((r) => setTimeout(r, 60));
        pressCube('Display', 'Crossing slices');
      },
    },
    {
      target: '.ex-flyout',
      side: 'right',
      title: 'Use the data yourself',
      body: (
        <>
          {/* A stepper, numbered by CSS counters to match the panel's own 1–4. */}
          <ol className="ex-tour__steps">
            <li>Select the RH metrics you need.</li>
            <li>
              Choose <b>10 m tiles</b> for full resolution or <b>~1 km global</b> for worldwide coverage in one file per
              RH metric.
            </li>
            <li>
              For 10 m, click tiles on the map or select <b>All in view</b>.
              <small>The tile covering this forest is already selected.</small>
            </li>
            <li>Download the selected files or copy their URLs.</li>
          </ol>
        </>
      ),
      // The cube card closes so the panel opens over a clear map. Out to zoom
      // 7.5, where an MGRS tile (~110 km) is ~250 px wide: the picked tile and
      // its neighbours, with names (shown from zoom 7), fit in view.
      enter: () => {
        click('.ex-reading__actions [aria-label="Close"]');
        if (!document.querySelector('.ex-flyout')) {
          click('.ex-download-trigger');
          openedFlyout.current = true;
        }
        const h = hero.current;
        const tile = h && grid ? tileAt(grid.tiles, h.point) : null;
        if (tile) pickTiles([tile]);
        if (!map) return;
        return flight(map, () => map.easeTo({ center: h?.point, zoom: 7.5, duration: 2500 }));
      },
    },
    {
      target: '.ex-random',
      side: 'top',
      dim: true,
      title: 'What will you find elsewhere?',
      body: (
        <>
          You've explored this forest from canopy height to its vertical structure. Try the same approach somewhere
          else. Search for a place or choose <b>Visit a random site</b>, then click a location on the map to inspect its
          profiles and surrounding structure.
        </>
      ),
      // Done with the panel: closed, so a map click reads a profile again.
      enter: () => {
        if (openedFlyout.current) click('.ex-flyout [aria-label="Close"]');
        openedFlyout.current = false;
      },
    },
  ];

  const usable = steps.map((s) => !s.available || s.available());
  const order = steps.map((_, i) => i).filter((i) => usable[i]);
  const navPos = Math.max(0, order.indexOf(index));
  const pos = Math.max(0, order.indexOf(shown));
  const step = steps[shown];
  const last = pos === order.length - 1;

  // A fresh tour every time it opens.
  useEffect(() => {
    if (!open) return;
    markSeen();
    entered.current.clear();
    openedFlyout.current = false;
    setIndex(0);
    setShown(0);
    setPhase('in');
  }, [open]);

  const go = async (to: number) => {
    const s = steps[to];
    setIndex(to);
    if (!s.enter || entered.current.has(to)) return;
    entered.current.add(to);
    setBusy(true);
    try {
      await s.enter();
    } finally {
      setBusy(false);
    }
  };

  // Ignored mid-swap, so a double click cannot skip a step unseen.
  const next = () => phase === 'in' && (navPos === order.length - 1 ? finish() : go(order[navPos + 1]));
  const back = () => phase === 'in' && navPos > 0 && setIndex(order[navPos - 1]);

  useEffect(() => {
    if (!open || shown === index) return;
    setPhase('out');
    const t = setTimeout(() => {
      setShown(index);
      setPhase('place');
    }, 160);
    return () => clearTimeout(t);
  }, [open, index, shown]);

  // A couple of frames for the position loop to place the new card, then in.
  useEffect(() => {
    if (phase !== 'place') return;
    const t = setTimeout(() => setPhase('in'), 50);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (!open) return;
    // Escape closes the enlarged figure first, and only then the tour. The
    // figure is a modal <dialog>, which closes itself on Escape.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || zoomed) return;
      onClose();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open, onClose, zoomed]);

  useEffect(() => setZoomed(false), [index, open]);

  // Follow the target: the cards it points at appear, load and resize after
  // the step starts, so its box is re-read every frame while the tour is open.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [markRect, setMarkRect] = useState<DOMRect | null>(null);
  // Steps are rebuilt every render, so `mark` is a new function each time:
  // read through a ref rather than restarting the loop for it.
  const markOf = useRef<Step['mark']>(undefined);
  markOf.current = step.mark;
  const notesOf = useRef<Step['notes']>(undefined);
  notesOf.current = step.notes;
  const [notes, setNotes] = useState<Note[]>([]);
  const [cardPos, setCardPos] = useState<{ left: number; top: number } | null>(null);
  const scrolled = useRef(-1);

  useLayoutEffect(() => {
    if (!open) return;
    let raf = 0;
    const tick = () => {
      const el = step.target ? document.querySelector<HTMLElement>(step.target) : null;
      // Once per step: bring the target into its scrolling container (the
      // panel on a phone, the card for the cube).
      if (el && scrolled.current !== shown) {
        scrolled.current = shown;
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      const r = el?.getBoundingClientRect() ?? null;
      const visible = r && r.width > 0 && r.height > 0 ? r : null;
      setRect((prev) => (same(prev, visible) ? prev : visible));
      const m = markOf.current?.()?.getBoundingClientRect() ?? null;
      const markVisible = m && m.width > 0 && m.height > 0 ? m : null;
      setMarkRect((prev) => (same(prev, markVisible) ? prev : markVisible));
      const n = notesOf.current?.() ?? [];
      setNotes((prev) => (JSON.stringify(prev) === JSON.stringify(n) ? prev : n));
      const card = cardRef.current;
      if (card) {
        // A step without a target and without the dim is about the map
        // (flying in): its card goes to the top of the map, out of the way.
        const mapBox = !visible && !step.dim ? document.querySelector('.ex-map')?.getBoundingClientRect() : undefined;
        const p = mapBox
          ? { left: mapBox.left + (mapBox.width - card.offsetWidth) / 2, top: mapBox.top + MARGIN }
          : place(card.offsetWidth, card.offsetHeight, visible, step.side ?? 'right');
        setCardPos((prev) => (prev && prev.left === p.left && prev.top === p.top ? prev : p));
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [open, shown, step.target, step.side, step.dim]);

  useEffect(() => {
    if (open) primaryRef.current?.focus({ preventScroll: true });
  }, [open, shown]);

  // Next is disabled while the map flies, and a disabled button drops focus to
  // <body>. Once it is enabled again, put a keyboard reader back on it — unless
  // they have since moved focus somewhere of their own.
  useEffect(() => {
    if (!open || busy) return;
    const now = document.activeElement;
    if (!now || now === document.body) primaryRef.current?.focus({ preventScroll: true });
  }, [open, busy]);

  // Ending the tour hands focus back to where it was when the tour began,
  // unless the reader has since put it somewhere else. By the time this runs
  // the card is gone, so focus that was on it has fallen to <body>.
  const returnTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    return () => {
      const back = returnTo.current;
      const now = document.activeElement;
      const lost = !now || now === document.body || !!now.closest('.ex-tour');
      if (back?.isConnected && lost) back.focus({ preventScroll: true });
    };
  }, [open]);

  // The enlarged figure is a native modal dialog: the browser makes the page
  // inert behind it, closes it on Escape and returns focus to the figure's
  // button. Clicking anywhere on it closes it, as the hint says.
  const zoomRef = useRef<HTMLDialogElement | null>(null);
  useLayoutEffect(() => {
    const d = zoomRef.current;
    if (zoomed && d && !d.open) d.showModal();
  }, [zoomed]);

  const titleId = useId();

  if (!open) return null;

  const pad = 6;
  return (
    <>
      {step.dim && !rect && <div className="ex-tour__dim" aria-hidden="true" />}
      {rect && (
        <div
          className={step.dim ? 'ex-tour__spot is-dim' : 'ex-tour__spot'}
          aria-hidden="true"
          style={{
            left: rect.left - pad,
            top: rect.top - pad,
            width: rect.width + 2 * pad,
            height: rect.height + 2 * pad,
          }}
        />
      )}
      {markRect && phase === 'in' && (
        <div
          key={shown}
          className="ex-tour__mark"
          aria-hidden="true"
          style={{
            left: markRect.left - 4,
            top: markRect.top - 4,
            width: markRect.width + 8,
            height: markRect.height + 8,
          }}
        />
      )}
      {phase === 'in' &&
        notes.map((n) =>
          n.kind === 'band' ? (
            <div
              key={`band-${n.label}`}
              className="ex-tour__band"
              aria-hidden="true"
              style={{ left: n.left, top: n.top, width: n.width, height: n.height }}
            >
              <span>
                <b>{n.label}</b> {n.note}
              </span>
            </div>
          ) : (
            <div
              key={`point-${n.label}`}
              className="ex-tour__point"
              aria-hidden="true"
              style={{ left: n.left, top: n.top }}
            >
              <b>{n.label}</b>
            </div>
          ),
        )}
      {zoomed && step.media && (
        <dialog
          ref={zoomRef}
          className="ex-tour__zoom"
          aria-label={step.media.alt}
          onClick={() => zoomRef.current?.close()}
          onClose={() => setZoomed(false)}
        >
          <img src={step.media.src} alt={step.media.alt} />
          <span className="ex-tour__zoom-hint">Click anywhere or press Esc to close</span>
        </dialog>
      )}
      <div
        ref={cardRef}
        className={`ex-tour${step.wide ? ' is-wide' : ''}${phase === 'in' ? '' : ` is-${phase}`}`}
        role="dialog"
        aria-labelledby={titleId}
        style={cardPos ? { left: cardPos.left, top: cardPos.top } : { visibility: 'hidden' }}
      >
        <div className="ex-tour__body">
          <div className="ex-tour__text">
            <div className="ex-tour__top">
              <ol className="ex-tour__dots" aria-label={`Step ${pos + 1} of ${order.length}`}>
                {order.map((i, k) => (
                  <li key={i} className={k === pos ? 'is-on' : k < pos ? 'is-done' : undefined} />
                ))}
              </ol>
              <button
                type="button"
                className="ex-tour__close"
                onClick={finish}
                aria-label="End the tour"
                title="End the tour"
              >
                <CloseIcon size={16} />
              </button>
            </div>
            <h2 id={titleId}>{step.title}</h2>
            {/* Focus stays on the Next button from step to step, so nothing
                announces the new step by itself; this does, in one short line
                rather than the whole card re-read as a live region. */}
            <p className="ex-visually-hidden" role="status">
              {`Step ${pos + 1} of ${order.length}: ${step.title}`}
            </p>
          </div>
          {step.media && (
            <figure className="ex-tour__media">
              <button type="button" onClick={() => setZoomed(true)} title="Enlarge" aria-label="Enlarge the figure">
                <img src={step.media.src} alt={step.media.alt} width={2400} height={814} />
              </button>
            </figure>
          )}
          <div className="ex-tour__text ex-tour__text--desc">
            <div className="ex-tour__desc">{step.body}</div>
          </div>
        </div>
        <div className="ex-tour__bar">
          {pos === 0 ? (
            <button type="button" className="ex-tour__text-btn" onClick={finish}>
              Not now
            </button>
          ) : (
            <button type="button" className="ex-tour__text-btn" onClick={back}>
              Back
            </button>
          )}
          <button type="button" className="ex-tour__next" onClick={next} disabled={busy} ref={primaryRef}>
            {pos === 0 ? 'Start the tour' : last ? 'Done' : (step.next ?? 'Next')}
            {!last && (
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 12h13M13 6l6 6-6 6"
                />
              </svg>
            )}
          </button>
        </div>
      </div>
    </>
  );
}

/** The hero transect's line and the point to click, from the published site bundle. */
type BundleSite = {
  id: number;
  geometry?: { type: string; coordinates: unknown } | null;
  transect?: {
    line_coordinates?: [number, number][] | null;
    samples?: { lon: number; lat: number; distance_m?: number | null }[];
  } | null;
};

function heroFrom(sites: BundleSite[]): Hero | null {
  const site = sites.find((s) => s.id === HERO_SITE_ID);
  const line =
    site?.geometry?.type === 'LineString'
      ? (site.geometry.coordinates as [number, number][])
      : (site?.transect?.line_coordinates ?? null);
  const samples = site?.transect?.samples ?? [];
  if (!line?.length || !samples.length) return null;
  const near = samples.reduce((best, x) =>
    Math.abs((x.distance_m ?? 0) - HERO_POINT_M) < Math.abs((best.distance_m ?? 0) - HERO_POINT_M) ? x : best,
  );
  const nearest = (m: number) =>
    samples.reduce(
      (bi, x, i) => (Math.abs((x.distance_m ?? 0) - m) < Math.abs((samples[bi].distance_m ?? 0) - m) ? i : bi),
      0,
    );
  const stands = HERO_STANDS.map(({ label, at, note }) => {
    const c = nearest(at);
    return {
      label,
      note,
      i0: nearest(at - 50),
      i1: nearest(at + 50),
      lonlat: [samples[c].lon, samples[c].lat] as [number, number],
    };
  });
  return { line, point: [near.lon, near.lat], samples: samples.length, stands };
}

/**
 * The stands as bands on the site card's heatmap — one canvas column per
 * sample, evenly spaced — and as points on the map.
 */
function standNotes(h: Hero | null, map: MlMap | null): Note[] {
  if (!h) return [];
  const out: Note[] = [];
  const canvas = document.querySelector('.ex-site .ex-heat__canvas')?.getBoundingClientRect();
  if (canvas && canvas.width > 0) {
    for (const s of h.stands) {
      const x0 = canvas.left + (s.i0 / h.samples) * canvas.width;
      const x1 = canvas.left + ((s.i1 + 1) / h.samples) * canvas.width;
      out.push({
        kind: 'band',
        label: s.label,
        note: s.note,
        left: x0,
        top: canvas.top,
        width: x1 - x0,
        height: canvas.height,
      });
    }
  }
  if (map) {
    const box = map.getContainer().getBoundingClientRect();
    for (const s of h.stands) {
      const p = map.project(s.lonlat);
      if (p.x < 0 || p.y < 0 || p.x > box.width || p.y > box.height) continue;
      out.push({ kind: 'point', label: s.label, left: box.left + p.x, top: box.top + p.y, width: 0, height: 0 });
    }
  }
  return out;
}

const lineFeature = (line: [number, number][]): GeoJSON.Feature => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: line },
});

function bbox(line: [number, number][]): [number, number, number, number] {
  const xs = line.map((c) => c[0]);
  const ys = line.map((c) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The MGRS tile the point falls in; where tiles overlap, the one centred nearest it. */
function tileAt(tiles: { name: string; bbox: [number, number, number, number] }[], [lon, lat]: [number, number]) {
  const hits = tiles.filter((t) => t.bbox[0] <= lon && lon <= t.bbox[2] && t.bbox[1] <= lat && lat <= t.bbox[3]);
  const d = (t: (typeof hits)[number]) =>
    Math.hypot((t.bbox[0] + t.bbox[2]) / 2 - lon, (t.bbox[1] + t.bbox[3]) / 2 - lat);
  return hits.sort((a, b) => d(a) - d(b))[0]?.name ?? null;
}

/**
 * Start a camera move and resolve when it lands, so Next stays disabled for
 * the flight. Capped, so a move that never fires `moveend` cannot hang the tour.
 */
function flight(map: MlMap, start: () => unknown, capMs = 9000): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, capMs);
    map.once('moveend', () => {
      clearTimeout(t);
      resolve();
    });
    takeCamera(map);
    start();
  });
}

/** The panel's RH buttons, by label; turning one on is what the reader would do. */
function rhButton(rh: number): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('[data-tour="rh"] [role="checkbox"]')].find(
      (b) => b.textContent?.trim() === `RH${rh}`,
    ) ?? null
  );
}

function ensureRh(rh: number) {
  const b = rhButton(rh);
  if (b && b.getAttribute('aria-checked') !== 'true') b.click();
}

/** The cube's segmented controls, found by group and label: pressing one is what the reader would do. */
function cubeButtons(group: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(`.ex-reading [role="group"][aria-label="${group}"] button`)];
}

function cubeButton(group: string, text: string): HTMLButtonElement | null {
  return cubeButtons(group).find((b) => b.textContent?.trim() === text) ?? null;
}

function pressCube(group: string, text: string) {
  cubeButton(group, text)?.click();
}

/** What the map shows now, so the RH step talks about this map rather than RH in general. */
function Showing({ rhIndexes }: { rhIndexes: number[] }) {
  if (rhIndexes.length === 0) return <span className="ex-tour__showing">No RH is on right now.</span>;
  // Newest last is drawn on top, so list it first.
  const shown = [...rhIndexes].reverse();
  return (
    <span className="ex-tour__showing">
      Showing now
      {shown.map((rh, k) => (
        <span key={rh} className="ex-tour__chip">
          RH{rh}
          {k === 0 && shown.length > 1 ? ' · on top' : ''}
        </span>
      ))}
    </span>
  );
}

function same(a: DOMRect | null, b: DOMRect | null) {
  if (!a || !b) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

const GAP = 14;
const MARGIN = 16;

/**
 * Beside the target on the preferred side if it fits, else on any side that
 * does; failing all four (a target filling most of the screen, or a phone),
 * docked at the top or bottom of the viewport, whichever covers less of the
 * target. No target: centred.
 */
function place(w: number, h: number, r: DOMRect | null, pref: Side): { left: number; top: number } {
  const vw = innerWidth;
  const vh = innerHeight;
  const clampX = (x: number) => Math.min(Math.max(x, MARGIN), vw - w - MARGIN);
  const clampY = (y: number) => Math.min(Math.max(y, MARGIN), vh - h - MARGIN);
  if (!r) return { left: clampX((vw - w) / 2), top: clampY((vh - h) / 2) };

  const sides: Side[] = [pref, ...(['right', 'left', 'bottom', 'top'] as Side[]).filter((s) => s !== pref)];
  for (const side of sides) {
    if (side === 'right' && r.right + GAP + w + MARGIN <= vw)
      return { left: r.right + GAP, top: clampY(r.top + r.height / 2 - h / 2) };
    if (side === 'left' && r.left - GAP - w >= MARGIN)
      return { left: r.left - GAP - w, top: clampY(r.top + r.height / 2 - h / 2) };
    if (side === 'bottom' && r.bottom + GAP + h + MARGIN <= vh)
      return { left: clampX(r.left + r.width / 2 - w / 2), top: r.bottom + GAP };
    if (side === 'top' && r.top - GAP - h >= MARGIN)
      return { left: clampX(r.left + r.width / 2 - w / 2), top: r.top - GAP - h };
  }
  const left = clampX((vw - w) / 2);
  const coverTop = Math.max(0, MARGIN + h - r.top);
  const coverBottom = Math.max(0, r.bottom - (vh - h - MARGIN));
  return { left, top: coverTop <= coverBottom ? MARGIN : vh - h - MARGIN };
}
