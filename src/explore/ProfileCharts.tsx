/**
 * The two point plots, drawn as inline SVG.
 *
 * The full app renders these with @mui/x-charts inside SavedFeaturePlots.tsx,
 * but importing that here would pull MUI and a charting library into a page
 * whose entire budget is ~137 KB — several times the weight of everything else
 * on it. Two line charts do not justify that, and hand-drawn SVG also keeps the
 * axes honest (fixed 0 m baseline, real units).
 */

import { useId } from 'react';

type Pt = { x: number; y: number };

const W = 250;
const H = 190;
const PAD = { top: 8, right: 8, bottom: 26, left: 34 };

function scale(points: Pt[], yMax?: number) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  // A fixed top keeps two places comparable; the curve is clipped above it.
  const y1 = yMax !== undefined && yMax > y0 ? yMax : Math.max(...ys);
  // Guard against a flat series collapsing the axis to zero width.
  if (x0 === x1) {
    x0 -= 0.5;
    x1 += 0.5;
  }
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  return {
    x: (v: number) => PAD.left + ((v - x0) / (x1 - x0)) * iw,
    // SVG y grows downward; invert so larger heights sit higher.
    y: (v: number) => PAD.top + ih - ((v - y0) / (y1 - y0 || 1)) * ih,
    domain: { x0, x1, y0, y1 },
  };
}

function LineChart({
  points,
  xLabel,
  yLabel,
  colour = '#10796a',
  /** Draw a horizontal rule at this y value — the ground, for profiles. */
  yRule,
  yMax,
}: {
  points: Pt[];
  xLabel: string;
  yLabel: string;
  colour?: string;
  yRule?: number;
  /** Fixed top of the y axis; data above it are clipped. Unset = fit the data. */
  yMax?: number;
}) {
  const clipId = useId();
  if (points.length < 2) return <div className="ex-chart__empty">Not enough data</div>;

  const s = scale(points, yMax);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${s.x(p.x).toFixed(1)},${s.y(p.y).toFixed(1)}`).join(' ');
  const { x0, x1, y0, y1 } = s.domain;

  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, ''));

  return (
    <svg className="ex-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${yLabel} against ${xLabel}`}>
      {/* frame */}
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} stroke="#cbd6d1" />
      <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} stroke="#cbd6d1" />

      {yRule !== undefined && yRule > y0 && yRule < y1 && (
        <line
          x1={PAD.left}
          y1={s.y(yRule)}
          x2={W - PAD.right}
          y2={s.y(yRule)}
          stroke="#b6c3bd"
          strokeDasharray="3 3"
        />
      )}

      <clipPath id={clipId}>
        <rect x={PAD.left} y={PAD.top} width={W - PAD.left - PAD.right} height={H - PAD.top - PAD.bottom} />
      </clipPath>
      <path d={d} fill="none" stroke={colour} strokeWidth="1.6" strokeLinejoin="round" clipPath={`url(#${clipId})`} />

      {/* axis extremes only — with 101 points, tick clutter hurts more than it helps */}
      <text className="ex-chart__tick" x={PAD.left - 4} y={PAD.top + 6} textAnchor="end">
        {fmt(y1)}
      </text>
      <text className="ex-chart__tick" x={PAD.left - 4} y={H - PAD.bottom} textAnchor="end">
        {fmt(y0)}
      </text>
      <text className="ex-chart__tick" x={PAD.left} y={H - PAD.bottom + 12} textAnchor="start">
        {fmt(x0)}
      </text>
      <text className="ex-chart__tick" x={W - PAD.right} y={H - PAD.bottom + 12} textAnchor="end">
        {fmt(x1)}
      </text>

      <text className="ex-chart__axis" x={(PAD.left + W - PAD.right) / 2} y={H - 3} textAnchor="middle">
        {xLabel}
      </text>
      <text className="ex-chart__axis" transform={`translate(9 ${(PAD.top + H - PAD.bottom) / 2}) rotate(-90)`} textAnchor="middle">
        {yLabel}
      </text>
    </svg>
  );
}

export function RhProfileChart({
  profile,
  yMax,
}: {
  profile: Array<{ rh: number; value: number | null; missing?: boolean }>;
  yMax?: number;
}) {
  const points = profile
    .filter((p) => p.value != null && !p.missing && Number.isFinite(p.value))
    .map((p) => ({ x: p.rh, y: p.value as number }));
  return <LineChart points={points} xLabel="Relative height (RH)" yLabel="Height (m)" yRule={0} yMax={yMax} />;
}

export function VerticalProfileChart({
  curve,
  yMax,
}: {
  curve: Array<{ z: number; value: number; binned?: number }>;
  yMax?: number;
}) {
  // Energy on x, height on y — the conventional orientation for a waveform:
  // it reads as a side view of the canopy.
  const points = curve
    .filter((p) => Number.isFinite(p.value) && Number.isFinite(p.z))
    .map((p) => ({ x: p.value, y: p.z }));
  return <LineChart points={points} xLabel="Energy" yLabel="Height (m)" colour="#7a4bb5" yRule={0} yMax={yMax} />;
}

/**
 * Structure metrics at the pin, shown above the two charts. ENL comes in the
 * backend's two orders: 1D = exp(FHD), 2D = 1 / sum p^2 (both over 5 m bins).
 */
export function ProfileMetrics({
  fhd,
  enl1d,
  enl2d,
  cr,
}: {
  fhd?: number | null;
  enl1d?: number | null;
  enl2d?: number | null;
  cr?: number | null;
}) {
  const items = [
    { k: 'FHD', title: 'Foliage height diversity: Shannon entropy of the RH heights over 5 m bins', v: fhd },
    { k: 'ENL 1D', title: 'Effective number of layers, order 1: exp(FHD)', v: enl1d },
    { k: 'ENL 2D', title: 'Effective number of layers, order 2: 1 / Σp² over 5 m bins', v: enl2d },
    { k: 'CR', title: 'Canopy ratio: (RH98 − RH25) / RH98', v: cr },
  ].filter((m) => m.v != null && Number.isFinite(m.v));
  if (!items.length) return null;
  return (
    <dl className="ex-profile__metrics">
      {items.map((m) => (
        <div key={m.k}>
          <dt title={m.title}>{m.k}</dt>
          <dd>{m.v!.toFixed(2)}</dd>
        </div>
      ))}
    </dl>
  );
}
