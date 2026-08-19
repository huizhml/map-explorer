import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import data from './forest-pair.json';
import { ease, useTween } from './tween';

/**
 * Chapter 1: two places a map from above cannot tell apart.
 *
 * It flies rather than cuts. Both panels start on the same near-hemisphere view
 * of Sentinel-2, fall through nine zoom levels to a few pixels of ground, tilt
 * out of plan into a side view, and only then put trees on it. Arriving that
 * way is the argument: the reader watches the imagery run out, until by the
 * last level there is nothing left to see from above but a handful of green
 * pixels — which is exactly the limit the chapter is about.
 *
 * Both places are real GEDI shots in the 21LTD tile, and "look identical" is
 * something the pair had to pass rather than something this figure asserts:
 * their canopy tops agree to within half a metre and their Sentinel-2 colours
 * to a few counts out of 255. See scripts/make-forest-pair.py for the search.
 *
 * The trees are drawn from each shot's own relative heights — one plant per
 * rung of the ladder, at the size a tree of that height really is — so the
 * closed canopy comes out closed and the layered one comes out layered without
 * anybody choosing that. Their number, spacing and shapes are not counted, and
 * the caption says so.
 */

const { places, shared, pins, splitM, boxM, colourDelta, footprintM, closestM, groundEchoM } =
  data;

/** Design units. The panel is a square of ground with sky above it.
 *
 * The sky is only as deep as the tallest thing measured needs — about 29 m at
 * 9 units to the metre, plus room for the canopy-top label. At 560 a fifth of
 * every panel was empty, which on a wide screen is a fifth of the screen. */
const PANEL_W = 380;
const PANEL_H = 500;
/** The imagery square sits at the bottom; its centre is the ground line. */
const GROUND_Y = PANEL_H - PANEL_W / 2;
/** Units per metre, set by how much ground the closest zoom level shows. */
const PER_M = PANEL_W / closestM;
const toY = (m: number) => GROUND_Y - Math.max(0, m) * PER_M;
const toX = (m: number) => PANEL_W / 2 + (m - footprintM / 2) * PER_M;

/** How far the camera leans over. Past this the ground is a line, not a plane. */
const TILT_DEG = 74;

const FG = '#ebf2f0';
const MUTED = '#96a59e';
const LEAF = '#3f8f5e';
const LEAF_BACK = '#2c6b45';
const TRUNK = '#2b5138';

const WIDEST_M = shared[0].m;

/** Deterministic, so the drawing is irregular but identical on every render. */
function hash(a: number, b: number) {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Crown size for a tree of this height, in metres. */
const crownM = (m: number) => Math.max(1.2, Math.min(13, m * 0.45));
const crownHeight = (m: number) => Math.min(m * 0.55, 2.5 + m * 0.3);

/** Below this a plant is drawn as a shrub: one blob, no trunk. */
const SHRUB_M = 4;

type Plant = {
  m: number;
  x: number;
  w: number;
  h: number;
  back: boolean;
  lean: number;
  lobes: number;
  shrub: boolean;
};

/**
 * One plant per rung of the ladder, at the size a tree of that height is.
 *
 * There is a second, tempting rule — every rung is 5% of the return, so give
 * every rung the same area of green — and it is the statistically faithful one:
 * a crown's area goes as the square of the tree, so realistic sizes put most of
 * the green in the canopy whatever the profile says. It was tried, and it draws
 * a few hundred overlapping blobs that look nothing like a forest. A picture
 * whose job is to let someone see a forest cannot spend its realism on a
 * statistic, so the sizes are honest and this figure makes no quantitative
 * claim about how the material is distributed. The profile plot in chapter 2
 * makes that claim properly, on the same shot.
 */
function stand(rh: number[], seed: number): Plant[] {
  const drawn = rh.map((m, i) => ({ m, i })).filter(({ m }) => m > groundEchoM);
  // A slot each, shuffled: in ladder order the stand ramps from ankle-high on
  // one side to the emergents on the other, which is a hillside, not a forest.
  const slots = drawn
    .map((_, n) => n)
    .sort((a, b) => hash(seed * 31, a) - hash(seed * 31, b));
  const slot = footprintM / drawn.length;

  return drawn.map(({ m, i }, n) => {
    const r = (k: number) => hash(seed * 89 + i, k);
    const w = crownM(m) * (0.82 + r(1) * 0.36);
    // The outer lobes reach further than half the nominal crown, so clamping on
    // w / 2 would let the biggest crowns hang off the footprint.
    const reach = Math.min(w * 0.76, footprintM / 2);
    return {
      m,
      x: Math.max(
        reach,
        Math.min(footprintM - reach, slot * (slots.indexOf(n) + 0.5) + (r(2) - 0.5) * slot),
      ),
      w,
      h: Math.min(crownHeight(m) * (0.9 + r(6) * 0.4), m * 0.62),
      back: r(3) > 0.5,
      lean: (r(4) - 0.5) * 0.9,
      lobes: r(5) > 0.5 ? 4 : 3,
      shrub: m < SHRUB_M,
    };
  });
}

const STANDS = places.map((place, p) => stand(place.rh, p + 1));

function Stand({ plants, grow }: { plants: Plant[]; grow: number }) {
  if (grow <= 0.01) return null;
  // Tallest first, so the short ones in front overlap them.
  const order = [...plants].sort((a, b) => b.m - a.m);
  return (
    <g>
      {order.map((t, k) => {
        // Each rises on its own, tallest first, so the canopy assembles from the
        // top down rather than inflating as one block.
        const e = ease(Math.max(0, Math.min(1, grow * 1.7 - (1 - t.m / 30) * 0.7)));
        if (e <= 0) return null;
        const cw = t.w * e * PER_M;
        const ch = t.h * e * PER_M;
        const cy = toY(t.m * e) + ch / 2;
        const cx = toX(t.x + t.lean);
        if (t.shrub) {
          return (
            <ellipse
              key={k}
              cx={cx}
              cy={cy}
              rx={cw / 2}
              ry={ch / 2}
              fill={t.back ? LEAF_BACK : LEAF}
            />
          );
        }
        return (
          <g key={k}>
            <path
              d={
                `M ${toX(t.x) - 1.4} ${GROUND_Y} L ${toX(t.x) + 1.4} ${GROUND_Y} ` +
                `L ${cx + 0.9} ${cy} L ${cx - 0.9} ${cy} Z`
              }
              fill={TRUNK}
            />
            {Array.from({ length: t.lobes }, (_, j) => {
              const side = j === 0 ? 0 : (j % 2 ? -1 : 1) * (0.2 + hash(k, j) * 0.16);
              return (
                <ellipse
                  key={j}
                  cx={cx + side * cw}
                  cy={cy - (j === 0 ? 0.06 : -0.12 - hash(k, j + 9) * 0.16) * ch}
                  rx={(j === 0 ? 0.5 : 0.3 + hash(k, j + 3) * 0.1) * cw}
                  ry={(j === 0 ? 0.5 : 0.32 + hash(k, j + 6) * 0.12) * ch}
                  fill={t.back ? LEAF_BACK : LEAF}
                />
              );
            })}
          </g>
        );
      })}
    </g>
  );
}

/**
 * Beats: hold on the continent, fall to the width where the two places stop
 * sharing a frame, divide, fall the rest of the way, tilt out of plan, and put
 * trees on it.
 *
 * The divide gets a beat of its own with the flight held still. Folded into the
 * zoom it took about a fifth of an octave out of eighteen — a couple of hundred
 * milliseconds, in the middle of a fall, which is not enough for anyone to see
 * one frame become two.
 */
const STEPS = 6;
const HOLD_MS = [1400, 600, 800, 500, 700, 2600];
const MOVE_MS = [900, 2600, 1500, 2600, 1900, 2300];

const APART_KM = Math.round(
  Math.hypot(pins[1].dx - pins[0].dx, pins[1].dy - pins[0].dy) / 1000,
);

const CAPTIONS = [
  `Two places ${APART_KM} km apart in the same forest, seen the only way a satellite sees them.`,
  `Close enough in to tell them apart: ${APART_KM} km of Mato Grosso, and a pin on each.`,
  'From here on they are two different pictures.',
  `All the way in, both are a few green pixels — ${colourDelta} counts apart out of 255. From ` +
    'above there is nothing left to tell them apart with.',
  `So tip the ground over, and look across the same ${footprintM} m from the side.`,
  'The first carries its canopy in a single layer near the top, on bare trunks. The second has a ' +
    'midstorey and an understorey under the same canopy top.',
];

type Box = { x: number; y: number; w: number; originPct: number };

/**
 * Where each ground square actually is, in pixels.
 *
 * The pull-out has to land the two panels exactly on the two circles drawn on
 * the shared map, and the panels are laid out by flex against a gap in vw. So
 * it is measured rather than derived: layout does not move during the flight —
 * only transforms do — so one read at mount and on resize is enough.
 */
function useGrounds(count: number) {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const [boxes, setBoxes] = useState<Box[]>([]);

  useLayoutEffect(() => {
    const measure = () => {
      const next = refs.current.slice(0, count).map((el) => {
        if (!el) return { x: 0, y: 0, w: 0, originPct: 66 };
        const ground = el.getBoundingClientRect();
        const panel = (el.parentElement as HTMLElement).getBoundingClientRect();
        return {
          x: ground.x + ground.width / 2,
          y: ground.y + ground.height / 2,
          w: ground.width,
          // Scaling has to happen about the ground's centre, not the panel's:
          // the ground square sits at the bottom, under a panel's worth of sky.
          originPct: ((ground.y + ground.height / 2 - panel.y) / panel.height) * 100,
        };
      });
      setBoxes(next);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [count]);

  return { refs, boxes };
}

export default function ForestPair({ active }: { active: boolean }) {
  const [step, setStep] = useState(0);
  // Index 0 is the shared map's ground; 1 and 2 are the pair's.
  const { refs, boxes } = useGrounds(3);

  useEffect(() => {
    if (!active) {
      setStep(0);
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStep(STEPS - 1);
      return;
    }
    setStep(0);
    // A beat is its hold and then its move, in that order: the move belongs to
    // the step it is arriving at, so it is only counted once that step starts.
    let at = HOLD_MS[0];
    const timers = Array.from({ length: STEPS - 1 }, (_, k) => {
      const timer = setTimeout(() => setStep(k + 1), at);
      at += MOVE_MS[k + 1] + HOLD_MS[k + 1];
      return timer;
    });
    return () => timers.forEach(clearTimeout);
  }, [active]);

  const p = useTween(step, false, MOVE_MS[Math.min(step, MOVE_MS.length - 1)]);

  /** Stacked coarse to fine, each fading in as the flight drops past its own
      width, so a finer level simply covers the one under it. Cross-fading
      neighbours instead put a sharp copy over a blurry one at every scale in
      between, and that ghosting is what the zoom used to flicker with. */
  const layers = (stack: typeof shared, currentM: number) =>
    stack.map((level, k) => {
      const opacity =
        k === 0 ? 1 : Math.max(0, Math.min(1, Math.log(level.m / currentM) / Math.log(1.7)));
      if (opacity <= 0.004) return null;
      return (
        <img
          key={level.src}
          src={level.src}
          alt=""
          // Scaled rather than resized: a transform is composited, so the
          // flight does not relayout the panel sixty times a second.
          style={{
            opacity,
            transform: `translate(-50%, -50%) scale(${(level.m / currentM).toFixed(4)})`,
          }}
        />
      );
    });

  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const toSplit = clamp(p);
  /** The two circles drawn on the shared map, before anything pulls out. */
  const marked = clamp(p * 4 - 2.6);
  const split = clamp(p - 1);
  const toGround = clamp(p - 2);
  const tilt = clamp(p - 3);
  const grow = clamp(p - 4);

  // How much ground the panel shows right now: two falls, in log space, with
  // the divide between them. Exponential means every level costs the same
  // amount of flying — a constant *rate* of zoom, which is what reads as
  // smooth. Both dials come out of the tween already eased; easing them a
  // second time here made the middle of a fall several times faster than its
  // ends, which is the lurch this used to have.
  // Two falls with the divide between them. The shared map stops at splitM; the
  // panels start at the width of their own circle and carry on from there, so
  // the circle growing into a frame *is* the next part of the descent.
  const currentM = Math.exp(
    Math.log(WIDEST_M) + (Math.log(splitM) - Math.log(WIDEST_M)) * toSplit,
  );
  const panelM = Math.exp(Math.log(boxM) + (Math.log(closestM) - Math.log(boxM)) * toGround);
  const tiltDeg = TILT_DEG * tilt;
  const ringRx = (footprintM / 2) * PER_M;

  // One map until the two places stop fitting in a frame together, then two.
  // Above the split every crop of one place is a crop of the other, so showing
  // them side by side said they were the same place; a pin each on one map says
  // what is actually true, and the reader watches one dot become two.
  const wide = 1 - split;

  // The two circles on the shared map, and the flight of each panel out of the
  // one it belongs to. At split = 0 a panel is exactly its circle; at 1 it is
  // itself.
  const boxScale = boxM / splitM;
  const pinAt = (pin: (typeof pins)[number]) => {
    const map = boxes[0];
    if (!map) return { x: 0, y: 0 };
    return {
      x: map.x + (pin.dx / currentM) * map.w,
      y: map.y - (pin.dy / currentM) * map.w,
    };
  };
  const pullOut = (n: number) => {
    const panel = boxes[n + 1];
    if (!panel || !boxes[0]) return undefined;
    const from = pinAt(pins[n]);
    const t = ease(split);
    const dx = (from.x - panel.x) * (1 - t);
    const dy = (from.y - panel.y) * (1 - t);
    const scale = 1 + (boxScale - 1) * (1 - t);
    return {
      transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(4)})`,
      transformOrigin: `50% ${panel.originPct.toFixed(2)}%`,
    };
  };

  return (
    <figure className="story-shot story-pair">
      <div className="story-pair__panels">
        {wide > 0.004 && (
          <div className="story-pair__panel story-pair__panel--shared" style={{ opacity: wide }}>
            <div className="story-pair__ground" ref={(el) => void (refs.current[0] = el)}>
              {layers(shared, currentM)}
            </div>
            <svg viewBox={`0 0 ${PANEL_W} ${PANEL_H}`} aria-hidden="true">
              {/* Everything outside the two circles goes down, so what the two
                  panels are about to be is visible before they are it. */}
              <defs>
                <mask id="story-pair-cover">
                  <rect x="0" y="0" width={PANEL_W} height={PANEL_H} fill="white" />
                  {pins.map((pin, k) => (
                    <circle
                      key={k}
                      cx={PANEL_W / 2 + (pin.dx / currentM) * PANEL_W}
                      cy={GROUND_Y - (pin.dy / currentM) * PANEL_W}
                      r={(boxM / 2 / currentM) * PANEL_W}
                      fill="black"
                    />
                  ))}
                </mask>
              </defs>
              <rect
                x="0"
                y={GROUND_Y - PANEL_W / 2}
                width={PANEL_W}
                height={PANEL_W}
                fill="#080b0a"
                opacity={0.62 * marked}
                mask="url(#story-pair-cover)"
              />
              {pins.map((pin, k) => (
                <circle
                  key={k}
                  cx={PANEL_W / 2 + (pin.dx / currentM) * PANEL_W}
                  cy={GROUND_Y - (pin.dy / currentM) * PANEL_W}
                  r={Math.max(4, (boxM / 2 / currentM) * PANEL_W)}
                  fill="none"
                  stroke={FG}
                  strokeWidth="1.6"
                  strokeOpacity={0.5 + 0.5 * marked}
                />
              ))}
            </svg>
          </div>
        )}

        {places.map((place, n) => (
          <div
            className="story-pair__panel"
            key={n}
            style={{ opacity: split > 0.001 || wide < 0.001 ? 1 : 0, ...pullOut(n) }}
          >
            <div
              className="story-pair__ground"
              ref={(el) => void (refs.current[n + 1] = el)}
              // Perspective in proportion to the panel, not a fixed 760px: the
              // panels grew with the screen and a fixed viewing distance meant
              // the near edge of the plane spread 60% wider than its own panel,
              // over the neighbour and off the side of the page.
              style={{
                transform: `perspective(${((boxes[n + 1]?.w ?? 340) * 2.4).toFixed(0)}px) rotateX(${tiltDeg.toFixed(2)}deg)`,
              }}
            >
              {layers(place.zoom, panelM)}
              {/* Distance haze once the plane is tipped, so the far edge reads
                  as far away rather than as the picture stopping. */}
              <div className="story-pair__haze" style={{ opacity: tilt }} />
            </div>

            <svg viewBox={`0 0 ${PANEL_W} ${PANEL_H}`} aria-hidden="true">
              {/* The footprint, flattening into the ground plane as it tips. */}
              <ellipse
                cx={PANEL_W / 2}
                cy={GROUND_Y}
                rx={ringRx}
                ry={ringRx * Math.cos((tiltDeg * Math.PI) / 180)}
                fill="none"
                stroke={FG}
                strokeWidth="1.4"
                opacity={clamp(toGround * 4 - 2.6) * (1 - grow * 0.6)}
              />

              <Stand plants={STANDS[n]} grow={grow} />

              <g opacity={grow}>
                <line
                  x1={20}
                  y1={toY(place.rh98)}
                  x2={PANEL_W - 20}
                  y2={toY(place.rh98)}
                  stroke={FG}
                  strokeOpacity="0.7"
                  strokeWidth="1"
                  strokeDasharray="6 5"
                />
                <text
                  x={PANEL_W - 20}
                  y={toY(place.rh98) - 8}
                  fill={FG}
                  fontSize="15"
                  textAnchor="end"
                >
                  {place.rh98} m
                </text>
              </g>

              <text
                x={PANEL_W / 2}
                y={PANEL_H - 8}
                fill={MUTED}
                fontSize="14"
                textAnchor="middle"
                opacity={grow}
              >
                {n === 0 ? 'one layer, near the top' : 'layers all the way down'}
              </text>
            </svg>
          </div>
        ))}
      </div>

      <figcaption>
        {CAPTIONS[Math.round(p)]}
        {/* Which half of this figure is a measurement, said where the reader is
            rather than in a comment they will never see. */}
        <span className="story-shot__note">
          The Sentinel-2 imagery, the {footprintM} m circle and every height are measured. The trees
          themselves are drawn — their number, spacing and shapes are not counted.
        </span>
      </figcaption>
    </figure>
  );
}
