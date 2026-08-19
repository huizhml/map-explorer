import { useEffect, useId, useState } from 'react';
import data from './gedi-shot.json';
import { ease, useNarrow, useTween } from './tween';

/**
 * What one GEDI bar actually is, animated as the chapter scrolls. Six beats,
 * all from one real shot in the 21LTD tile:
 *
 *   1. a footprint on the imagery, ringed        one shot, 25 m across
 *   2. its energy-with-height waveform draws in  what it records
 *   3. the waveform turns into the RH profile    a height for every percentile
 *   4. RH98 marked on that curve                 98% of the energy is below here
 *   5. the profile squeezes into a column and flies to the map, as the bar
 *   6. the other 495 appear at the same scale
 *
 * Beat 3 is the conversion the whole map rests on, so it is a movement rather
 * than a cut: the two plots share the height axis, and only the horizontal
 * meaning changes — energy returned *at* a height becomes energy returned
 * *below* it. Every point slides sideways from one reading to the other, which
 * is a claim the reader can watch being made.
 *
 * Colour arrives last, at the bar, and only there. The waveform and the RH
 * profile are measurements of one shot and need no legend; the bar is one of
 * half a million on a map, and its colour is how a reader gets a height back
 * out of it. It is the same ramp the map itself uses, so a bar's top colour is
 * the flat colour the map gives that RH98 — the gradient down its length is a
 * scale for the y axis, not a second measurement.
 *
 * These beats were five pre-rendered stills that cross-faded. Stills show the
 * endpoints of a motion and hide the motion, which here is the entire argument.
 * Scroll still drives the pace, so a reader can hold on a step — the reason the
 * stills were chosen in the first place — and under reduced motion the dials
 * snap to beat ends, which is the old still-by-still behaviour.
 *
 * Geometry (screen coordinates for every shot, and the backdrop's placement)
 * comes from scripts/make-gedi-explainer.py, so nothing here knows about
 * longitude.
 */

const { view, backdrop, palette, hero, shots, count, profileMinM, profileMaxM, rhMaxM } = data;

/** Plot panel: left edge, right edge, top of the axis, ground. */
const PX0 = view.mapW + 54;
const PX1 = view.w - 28;
const PY0 = 60;
const PY1 = view.h - 58;
const SPAN = PY1 - PY0;
const PLOT_W = PX1 - PX0;

/** Width of the collapsed column, and of a bar standing on the map. */
const COLUMN_W = 8;
const MAP_BAR_W = 3;

const FG = '#ebf2f0';
const MUTED = '#96a59e';
const AXIS = '#5a6862';
/** The uncoloured measurement: one shot's own curve carries no scale. */
const NEUTRAL = '#9fb3a6';

const N = hero.profile.length;
/**
 * The axis runs from below the ground, because the measurement does. A GEDI
 * ground return is a peak with width, not a line, and the lowest relative
 * heights sit under the elevation the processor called the ground — RH0 here is
 * -2.4 m. Cutting the axis at zero hid that and made the return look as though
 * it started at the surface.
 */
const RANGE_M = profileMaxM - profileMinM;
/** Height of profile sample i, in metres. */
const sampleM = (i: number) => profileMinM + (i + 0.5) * (RANGE_M / N);
/** Height in metres → y in view units. */
const toY = (m: number) =>
  PY1 - ((Math.max(profileMinM, Math.min(m, profileMaxM)) - profileMinM) / RANGE_M) * SPAN;
/** The ground, which is no longer the bottom of the plot. */
const GROUND_Y = toY(0);
/** Percentile (0-100) → x in view units. */
const toX = (p: number) => PX0 + 0.5 + PLOT_W * (p / 100);

const clampIndex = (i: number) => Math.max(0, Math.min(palette.length - 1, Math.round(i)));
const bucket = (frac: number) => clampIndex(frac * (palette.length - 1));
const colour = (frac: number) => palette[bucket(frac)];

/** Interpolate between two #rrggbb, for a fill that gains its meaning. */
function mix(a: string, b: string, t: number) {
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * Math.max(0, Math.min(1, t)));
  return `rgb(${c(ar, br)} ${c(ag, bg)} ${c(ab, bb)})`;
}

/** Bar length on the map, in view units. Shared by the hero and the other 495. */
const mapBar = (frac: number) => 6 + frac * 62;

/** The column the layers collapse into: the ground up to RH98. */
const PANEL_LEN = GROUND_Y - toY(hero.rh98);
const RH98_INDEX = hero.rhSteps.indexOf(98);

type Dials = {
  ring: number;
  /** How far the reticle has closed. Separate from `ring`, which is opacity:
      the circle must not open back up when it dims down in the last beat. */
  focus: number;
  panel: number;
  /** The waveform drawing in from the ground up. */
  curve: number;
  /** The slide from energy-at-a-height to the relative-height profile. */
  rhcurve: number;
  rh98: number;
  collapse: number;
  fly: number;
  others: number;
};

const ZERO: Dials = {
  ring: 0,
  focus: 0,
  panel: 0,
  curve: 0,
  rhcurve: 0,
  rh98: 0,
  collapse: 0,
  fly: 0,
  others: 0,
};

/**
 * Each beat runs until `end` (a fraction of the chapter's scroll) and moves the
 * dials it names; the rest hold. `step` is which dot lights up — the squeeze
 * and the flight are one step for the reader, two beats for the animation.
 */
const BEATS: Array<{
  end: number;
  step: number;
  headline: string;
  caption: string;
  to: Partial<Dials>;
}> = [
  {
    end: 0.14,
    step: 0,
    headline: '',
    caption: 'One GEDI shot. The laser lights a circle 25 m across.',
    to: { ring: 1, focus: 1 },
  },
  {
    end: 0.32,
    step: 1,
    headline: 'Vertical profile',
    caption:
      'What it records is not a number but a waveform: how much energy came back from each height.',
    to: { panel: 1, curve: 1 },
  },
  {
    end: 0.5,
    step: 2,
    headline: 'Relative height profile',
    caption:
      'Add the energy up from the ground and the same measurement becomes a height for every ' +
      'percentile — the relative height profile.',
    to: { rhcurve: 1 },
  },
  {
    end: 0.64,
    step: 3,
    headline: 'Relative height profile',
    caption:
      'RH98 is the height below which 98% of that energy falls — in practice, the top of the canopy.',
    to: { rh98: 1 },
  },
  {
    end: 0.78,
    step: 4,
    headline: '',
    caption:
      'Stand the profile up as a column and colour it by height, and you have one bar of the map.',
    to: { collapse: 1 },
  },
  // Same step, same words: the column detaches and travels to the footprint it
  // was measured at. Splitting it out gives the flight its own dial.
  {
    end: 0.88,
    step: 4,
    headline: '',
    caption:
      'Stand the profile up as a column and colour it by height, and you have one bar of the map.',
    to: { fly: 1, ring: 0.55 },
  },
  {
    end: 1,
    step: 5,
    headline: `${count} shots in this view`,
    caption: `Here are all ${count} in this view — real measurements, but only where the tracks fall.`,
    to: { others: 1, ring: 0.25, panel: 0.55 },
  },
];

/** How many swipes this figure is worth. The deck reads it to lay out its moments. */
export const GEDI_STEPS = 6;

/**
 * Where each step sits on the beat timeline: the end of the last beat that
 * belongs to it, a hair short so `dialsAt` still reports that beat rather than
 * the first frame of the next one.
 */
const STEP_PROGRESS = Array.from({ length: GEDI_STEPS }, (_, k) => {
  const last = BEATS.map((b) => b.step).lastIndexOf(k);
  return Math.min(1, BEATS[last].end - 1e-4);
});

function dialsAt(progress: number, snap: boolean) {
  let from = ZERO;
  let start = 0;
  for (let i = 0; i < BEATS.length; i++) {
    const beat = BEATS[i];
    const to = { ...from, ...beat.to };
    const last = i === BEATS.length - 1;
    if (progress < beat.end || last) {
      const t = snap ? 1 : ease((progress - start) / Math.max(1e-6, beat.end - start));
      const dials = {} as Dials;
      for (const key of Object.keys(ZERO) as Array<keyof Dials>) {
        dials[key] = from[key] + (to[key] - from[key]) * t;
      }
      return { dials, beat };
    }
    from = to;
    start = beat.end;
  }
  // Unreachable: the last beat always returns above.
  return { dials: ZERO, beat: BEATS[BEATS.length - 1] };
}

/**
 * Where sample i sits horizontally: at the energy returned from that height, or
 * at the share of energy returned below it, or between the two mid-slide.
 *
 * The cumulative reading is a lookup into the exported ladder rather than a sum
 * over the samples, so the curve passes exactly through the percentiles the
 * knots are drawn at. Above RH100 there is nothing left to accumulate, so those
 * samples stay where the waveform put them — sweeping them out to 100% would
 * animate a claim about heights the shot never reached.
 */
function sampleX(i: number, rhcurve: number) {
  const m = sampleM(i);
  const wave = PX0 + 0.5 + PLOT_W * hero.profile[i];
  let rh = wave;
  if (m <= hero.rh[hero.rh.length - 1]) {
    let k = 0;
    while (k < hero.rh.length - 2 && hero.rh[k + 1] < m) k++;
    const lo = hero.rh[k];
    const hi = hero.rh[k + 1];
    const f = hi - lo < 0.01 ? 0 : Math.max(0, Math.min(1, (m - lo) / (hi - lo)));
    rh = toX(hero.rhSteps[k] + (hero.rhSteps[k + 1] - hero.rhSteps[k]) * f);
  }
  return wave + (rh - wave) * rhcurve;
}

/**
 * A stand of trees behind the plot, on the same height axis.
 *
 * Without it the vertical profile is an unlabelled blob: a reader who has not
 * seen a lidar waveform before has no way to know that the bulge at 25 m is a
 * canopy and the thin tail above it is the few crowns that stick out of it.
 * The GEDI diagrams this borrows from all draw the waveform against the forest
 * for exactly that reason.
 *
 * The heights are not decoration — each tree is drawn to one of this shot's own
 * relative heights, so the tallest reaches RH100 and the short ones sit at the
 * understorey percentiles. The silhouette is a picture of the measurement next
 * to it, which is the only reason it is allowed to be there.
 */
const CANOPY = [
  { x: 0.06, p: 25 },
  { x: 0.19, p: 75 },
  { x: 0.35, p: 100 },
  { x: 0.5, p: 50 },
  { x: 0.66, p: 90 },
  { x: 0.82, p: 35 },
  { x: 0.95, p: 65 },
];

/**
 * Crowns are sized off the plot's width rather than the tree's own height, so
 * seven of them read as seven trees. Scaled proportionally they overlapped into
 * a single mass, which says "forest" but not "these are the heights".
 */
function Tree({ x, m }: { x: number; m: number }) {
  const top = toY(m);
  const h = GROUND_Y - top;
  const crownH = h * 0.42;
  // Capped, or the emergent's crown swallows its neighbours and the stand reads
  // as one mass rather than as a set of heights.
  const crownW = Math.min(h * 0.34, PLOT_W * 0.19);
  const cy = top + crownH * 0.46;
  return (
    <g>
      <rect x={x - 1.3} y={cy} width="2.6" height={GROUND_Y - cy} />
      <ellipse cx={x} cy={cy} rx={crownW * 0.5} ry={crownH * 0.5} />
      <ellipse cx={x - crownW * 0.27} cy={cy + crownH * 0.26} rx={crownW * 0.32} ry={crownH * 0.34} />
      <ellipse cx={x + crownW * 0.29} cy={cy + crownH * 0.19} rx={crownW * 0.3} ry={crownH * 0.32} />
    </g>
  );
}

function Canopy({ opacity, clipId }: { opacity: number; clipId: string }) {
  if (opacity <= 0.01) return null;
  return (
    <g opacity={opacity} fill="#132018" clipPath={`url(#${clipId})`} aria-hidden="true">
      <rect x={PX0} y={GROUND_Y - 1} width={PLOT_W + 4} height="1.5" />
      {CANOPY.map((t) => (
        <Tree
          key={t.x}
          x={PX0 + 0.5 + PLOT_W * t.x}
          m={hero.rh[hero.rhSteps.indexOf(t.p)]}
        />
      ))}
    </g>
  );
}

/** The measured curve itself: the waveform sliding into the RH profile. */
function Curve({ dials }: { dials: Dials }) {
  const top = hero.rh[hero.rh.length - 1];
  const line: string[] = [];
  const area: string[] = [`M ${PX0 + 0.5} ${PY1}`];
  for (let i = 0; i < N; i++) {
    const x = sampleX(i, dials.rhcurve).toFixed(1);
    const y = toY(sampleM(i)).toFixed(1);
    area.push(`L ${x} ${y}`);
    if (sampleM(i) <= top) line.push(`${line.length ? 'L' : 'M'} ${x} ${y}`);
  }
  area.push(`L ${PX0 + 0.5} ${toY(profileMaxM)}`, 'Z');

  return (
    <g opacity={1 - dials.collapse}>
      {/* The filled waveform drains as the curve straightens out: area under a
          relative-height curve is not a quantity, so it should not be shaded
          like one. */}
      <path
        d={area.join(' ')}
        fill={NEUTRAL}
        fillOpacity={0.3 * Math.max(0, 1 - dials.rhcurve * 2.4)}
      />
      <path
        d={line.join(' ')}
        fill="none"
        stroke={NEUTRAL}
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </g>
  );
}

/**
 * The profile as a stack of layers, one per 5% of the returned energy, which is
 * what squeezes into the bar. Each takes the ramp colour of the height it
 * covers — the only colour in the figure, and the only place a legend is owed.
 */
function Layers({ collapse, opacity }: { collapse: number; opacity: number }) {
  if (opacity <= 0.01) return null;
  return (
    <g opacity={opacity}>
      {hero.rh.slice(0, -1).map((from, j) => {
        const to = hero.rh[j + 1];
        if (to - from < 0.01) return null;
        const x0 = toX(hero.rhSteps[j]) + (PX0 + 0.5 + COLUMN_W - toX(hero.rhSteps[j])) * collapse;
        const x1 =
          toX(hero.rhSteps[j + 1]) + (PX0 + 0.5 + COLUMN_W - toX(hero.rhSteps[j + 1])) * collapse;
        // A bar is a height above ground, so the part of the profile that sits
        // below the ground line lifts onto it as the column forms — visibly
        // dropped rather than silently included.
        const y0 = toY(from) + (toY(Math.max(0, from)) - toY(from)) * collapse;
        const y1 = toY(to) + (toY(Math.max(0, to)) - toY(to)) * collapse;
        return (
          <path
            key={j}
            d={
              `M ${PX0 + 0.5} ${y0.toFixed(1)} L ${x0.toFixed(1)} ${y0.toFixed(1)} ` +
              `L ${x1.toFixed(1)} ${y1.toFixed(1)} L ${PX0 + 0.5} ${y1.toFixed(1)} Z`
            }
            fill={mix(NEUTRAL, colour((from + to) / 2 / rhMaxM), collapse)}
            // Everything above RH98 is what the bar drops; it leaves as the
            // column forms rather than being quietly folded in.
            opacity={j >= RH98_INDEX ? 1 - collapse : 1}
          />
        );
      })}
    </g>
  );
}

/** The panel: axes, the curve, its layers, and the heights read off it. */
function Profile({ dials, clipId }: { dials: Dials; clipId: string }) {
  const y98 = toY(hero.rh98);
  const settled = dials.rhcurve * (1 - dials.collapse);

  return (
    <g opacity={dials.panel}>
      <defs>
        {/* The curve draws in from the ground up rather than fading in: energy
            comes back from the ground first, so the reveal is the measurement's
            own order. */}
        <clipPath id={clipId}>
          <rect
            x={PX0}
            y={PY1 - SPAN * dials.curve}
            width={PLOT_W + 6}
            height={SPAN * dials.curve + 2}
          />
        </clipPath>
        <clipPath id={`${clipId}-plot`}>
          <rect x={PX0} y={PY0 - 10} width={PLOT_W + 4} height={SPAN + 12} />
        </clipPath>
      </defs>

      {/* Behind the axis: it is a backdrop for the height scale, not a series.
          It dims once the horizontal axis stops being energy and becomes a
          percentile, where a position along the ground would mean nothing. */}
      <Canopy opacity={1 - 0.55 * dials.rhcurve} clipId={`${clipId}-plot`} />

      <path d={`M ${PX0} ${PY0} L ${PX0} ${PY1} L ${PX1} ${PY1}`} fill="none" stroke={AXIS} />
      <text x={PX0 - 10} y={PY0 + 4} fill={MUTED} fontSize="12" textAnchor="end">
        {profileMaxM} m
      </text>
      <text x={PX0 - 10} y={GROUND_Y + 4} fill={MUTED} fontSize="12" textAnchor="end">
        0
      </text>
      <text x={PX0 - 10} y={PY1 + 2} fill={MUTED} fontSize="12" textAnchor="end">
        {profileMinM}
      </text>

      {/* The ground, in both plots: it is a height, and the height axis is what
          the two of them share. */}
      <line
        x1={PX0}
        y1={GROUND_Y}
        x2={PX1}
        y2={GROUND_Y}
        stroke={MUTED}
        strokeOpacity="0.5"
        strokeWidth="1"
        strokeDasharray="4 4"
      />
      <text x={PX1} y={GROUND_Y - 5} fill={MUTED} fontSize="11" textAnchor="end">
        ground
      </text>

      {/* One x axis replaced by another, because that is the whole conversion. */}
      <text x={PX0} y={PY1 + 18} fill={MUTED} fontSize="12" opacity={1 - dials.rhcurve}>
        returned energy
      </text>
      <g opacity={settled}>
        {[0, 25, 50, 75, 100].map((p) => (
          <text key={p} x={toX(p)} y={PY1 + 18} fill={MUTED} fontSize="10" textAnchor="middle">
            {p}
          </text>
        ))}
        <text x={PX0} y={PY1 + 34} fill={MUTED} fontSize="12">
          RH0–100
        </text>
      </g>

      <g clipPath={`url(#${clipId})`}>
        <Layers collapse={dials.collapse} opacity={Math.min(1, dials.collapse * 2.5)} />
        <Curve dials={dials} />
      </g>

      {/* The named percentiles, on the curve they are read from. */}
      {[25, 50, 75].map((p) => {
        const m = hero.rh[hero.rhSteps.indexOf(p)];
        return (
          <g key={p} opacity={settled}>
            <circle cx={toX(p)} cy={toY(m)} r="3" fill={FG} />
            <text x={toX(p) + 7} y={toY(m) + 4} fill={FG} fontSize="12">
              RH{p}
            </text>
          </g>
        );
      })}

      {dials.rh98 > 0.02 && (
        <g opacity={dials.rh98}>
          <line
            x1={PX0}
            y1={y98}
            x2={toX(98) * dials.rh98 + PX0 * (1 - dials.rh98)}
            y2={y98}
            stroke={FG}
            strokeWidth="1"
            strokeDasharray="5 5"
          />
          <circle cx={toX(98)} cy={y98} r="3.5" fill={FG} opacity={1 - dials.collapse} />
          {dials.rh98 > 0.5 && (
            <>
              {/* Both labels sit on the line they are about. Saying "below
                  here" from a headline at the top of the panel made the reader
                  work out which "here" was meant. */}
              <text x={PX1} y={y98 - 28} fill={MUTED} fontSize="12" textAnchor="end">
                98% of the energy is below here
              </text>
              <text x={PX1} y={y98 - 10} fill={FG} fontSize="15" textAnchor="end">
                RH98 = {hero.rh98.toFixed(1)} m
              </text>
            </>
          )}
        </g>
      )}
    </g>
  );
}

/**
 * One vertical ramp per colour bucket, so every bar on the map is shaded by
 * height exactly as the hero's layers are. Bucket i runs from the ground to
 * that bar's own top, which is why a bar's top colour is the flat colour the
 * map gives its RH98.
 */
function Ramps({ prefix }: { prefix: string }) {
  return (
    <defs>
      {palette.map((_, b) => {
        const stops = Math.max(2, Math.min(b + 1, 6));
        return (
          <linearGradient key={b} id={`${prefix}${b}`} x1="0" y1="1" x2="0" y2="0">
            {Array.from({ length: stops }, (_, k) => {
              const f = k / (stops - 1);
              return <stop key={k} offset={f} stopColor={palette[clampIndex(b * f)]} />;
            })}
          </linearGradient>
        );
      })}
    </defs>
  );
}

/**
 * `step` is which of the six beats the reader has swiped to; `scrub` is how far
 * a drag has carried it towards the next one (or the previous, when negative).
 */
/**
 * Where the figure sits inside a full-bleed slide. Its own composition runs
 * left to right — imagery, then the plot — so on a full-bleed slide the prose
 * column would land on the map. The whole thing is placed in the right two
 * thirds instead, and the empty left third is where the type goes.
 */
const STAGE_W = 1200;
const STAGE_H = 640;
const STAGE_X = 470;
const STAGE_SCALE = Math.min((STAGE_W - STAGE_X - 20) / 760, STAGE_H / 506);
const STAGE_Y = (STAGE_H - 506 * STAGE_SCALE) / 2;

export default function GediShot({ step, scrub = 0 }: { step: number; scrub?: number }) {
  const here = STEP_PROGRESS[Math.max(0, Math.min(GEDI_STEPS - 1, step))];
  const towards = STEP_PROGRESS[Math.max(0, Math.min(GEDI_STEPS - 1, step + Math.sign(scrub)))];
  const progress = useTween(
    here + (towards - here) * Math.abs(scrub),
    Math.abs(scrub) > 0.001,
  );

  // The figure is on the page twice — once in the sticky column, once inline in
  // the chapter for narrow screens — and both are in the same document. Shared
  // ids would leave whichever copy came second reading the first one's clip,
  // which is animated, so the curve vanished into it. useId's own colons are
  // stripped: they are legal in an id but not in the CSS selector some browsers
  // use to resolve url(#…).
  const uid = useId().replace(/:/g, '');
  const mapId = `story-shot-map-${uid}`;
  const revealId = `story-shot-reveal-${uid}`;
  const rampId = `story-shot-ramp-${uid}-`;

  const [snap, setSnap] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setSnap(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const { dials, beat } = dialsAt(progress, snap);

  // The ring closes in on the footprint like a reticle: 25 m is under a pixel
  // at this extent, so the circle is well above true scale and says the number
  // out loud instead of pretending to be scale.
  const ringR = 4 + 26 * (1 - dials.focus);

  // The flight, as one transform on the collapsed layers: the column's bottom
  // left corner lands on the shot and its height shrinks to the bar's. Moving
  // the stack itself rather than a stand-in means what arrives on the map is
  // literally what was measured.
  const f = ease(dials.fly);
  const sx = 1 + (MAP_BAR_W / COLUMN_W - 1) * f;
  const sy = 1 + (mapBar(hero.frac / 100) / PANEL_LEN - 1) * f;
  const tx = PX0 + 0.5 + (hero.x - MAP_BAR_W / 2 - (PX0 + 0.5)) * f - (PX0 + 0.5) * sx;
  const ty = GROUND_Y + (hero.y - GROUND_Y) * f - GROUND_Y * sy;

  const taken = Math.round(shots.length * dials.others);

  // On a phone the prose moves below the figure, so the empty third is just
  // empty; the view crops to the figure instead.
  const narrow = useNarrow();

  return (
    <figure className="story-shot">
      <div className="story-shot__stack">
        <svg
          viewBox={
            narrow
              ? `${STAGE_X} ${STAGE_Y} ${760 * STAGE_SCALE} ${506 * STAGE_SCALE}`
              : `0 0 ${STAGE_W} ${STAGE_H}`
          }
          role="img"
          aria-label="One GEDI shot: its footprint on the imagery, the waveform it records, the relative height profile that waveform becomes, and the bar it collapses into."
        >
          <defs>
            <clipPath id={mapId}>
              <rect x="0" y="0" width={view.mapW} height={view.h} />
            </clipPath>
          </defs>
          <Ramps prefix={rampId} />

          <g transform={`translate(${STAGE_X} ${STAGE_Y.toFixed(1)}) scale(${STAGE_SCALE.toFixed(4)})`}>
          <g clipPath={`url(#${mapId})`}>
            <image
              href={backdrop.src}
              x={backdrop.x}
              y={backdrop.y}
              width={backdrop.w}
              height={backdrop.h}
              preserveAspectRatio="none"
            />
          </g>

          {/* The other shots, far to near so nearer bars overlap farther ones. */}
          <g clipPath={`url(#${mapId})`}>
            {shots.slice(0, taken).map(([x, y, frac], i) => {
              const len = mapBar(frac / 100);
              return (
                <rect
                  key={i}
                  x={x - 1}
                  y={y - len}
                  width="2"
                  height={len}
                  fill={`url(#${rampId}${bucket(frac / 100)})`}
                  opacity="0.92"
                />
              );
            })}
          </g>

          {dials.ring > 0.02 && (
            <g opacity={Math.min(1, dials.ring * 2)}>
              <circle
                cx={hero.x}
                cy={hero.y}
                r={ringR}
                fill="none"
                stroke={FG}
                strokeWidth="1.6"
              />
              {dials.ring > 0.6 && (
                <text x={hero.x + 12} y={hero.y + 20} fill={FG} fontSize="12">
                  one shot · 25 m footprint
                </text>
              )}
            </g>
          )}

          <Profile dials={dials} clipId={revealId} />

          {dials.collapse > 0.02 && (
            <g transform={`translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${sx} ${sy})`}>
              <Layers collapse={dials.collapse} opacity={1} />
            </g>
          )}

          {beat.headline && (
            <text x={PX0} y={30} fill={FG} fontSize="15" opacity={dials.panel}>
              {beat.headline}
            </text>
          )}
          </g>
        </svg>

        <ol className="story-shot__steps" aria-hidden="true">
          {Array.from({ length: GEDI_STEPS }, (_, i) => (
            <li key={i} className={i === beat.step ? 'is-active' : undefined} />
          ))}
        </ol>
      </div>
      <figcaption>{beat.caption}</figcaption>
    </figure>
  );
}
