import { useEffect, useRef } from 'react';

/**
 * The transect heatmap — canopy energy against height, along the line.
 *
 * Drawn on a canvas from the stored samples rather than shown as a rendered
 * PNG. The same ten sites are ~15 MB as figures, which gzip cannot compress
 * further, against 0.17 MB gzipped as JSON; and publishing needs no render
 * step at all, where baking the figures took about a minute per site.
 *
 * One `putImageData` of an N×bins buffer, scaled by CSS, rather than N×bins
 * fill calls — 556 × 50 is 27,800 cells, which is slow enough to notice as
 * rectangles and instant as a bitmap.
 */

export type TransectSample = {
  lon: number;
  lat: number;
  distance_m?: number | null;
  profile: Array<number | null>;
  fhd?: number | null;
  enl1d?: number | null;
  enl2d?: number | null;
  cr?: number | null;
};

export type Transect = {
  samples: TransectSample[];
  line_coordinates?: [number, number][] | null;
  total_length_m?: number | null;
  heatmap_max_height?: number | null;
};

/** Metric lines under the heatmap, sharing its x-axis. */
const METRICS = [
  { key: 'fhd', label: 'FHD', colour: '#2f7ed8' },
  { key: 'enl1d', label: '1D ENL', colour: '#1a9850' },
  { key: 'enl2d', label: '2D ENL', colour: '#d7301f' },
  { key: 'cr', label: 'CR', colour: '#8856a7' },
] as const;

function MetricLines({ samples }: { samples: TransectSample[] }) {
  const series = METRICS.map((m) => ({
    ...m,
    values: samples.map((s) => (typeof s[m.key] === 'number' ? (s[m.key] as number) : null)),
  })).filter((s) => s.values.some((v) => v != null));

  if (!series.length) return null;

  // One shared y-scale: the four are on comparable ranges here (roughly 0-7),
  // and separate axes would make them impossible to read against each other.
  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  const lo = Math.min(0, ...all);
  const hi = Math.max(...all);
  const W = 100;
  const H = 26;

  const path = (values: Array<number | null>) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      const x = (i / Math.max(1, values.length - 1)) * W;
      const y = H - ((v - lo) / (hi - lo || 1)) * H;
      d += `${pen ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
      pen = true;
    });
    return d;
  };

  return (
    <div className="ex-heat__metrics">
      {/* Labelled top and bottom, mirroring the heatmap's axis above, rather
          than quoting the range as a bare pair of numbers off to one side —
          which read as an unexplained annotation. */}
      <div className="ex-heat__plot">
        <div className="ex-heat__yaxis">
          <span>{hi.toFixed(1)}</span>
          <span>{lo.toFixed(1)}</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="ex-heat__lines">
          {series.map((s) => (
            <path key={s.key} d={path(s.values)} fill="none" stroke={s.colour} strokeWidth="0.5"
                  vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      </div>
      <ul className="ex-heat__legend">
        {series.map((s) => (
          <li key={s.key}>
            <span style={{ background: s.colour }} />
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Viridis, sampled at 16 stops — matches the app's heatmap. */
const VIRIDIS: Array<[number, number, number]> = [
  [68, 1, 84], [72, 26, 108], [71, 47, 125], [65, 68, 135],
  [57, 86, 140], [49, 104, 142], [42, 120, 142], [35, 136, 142],
  [31, 152, 139], [34, 168, 132], [53, 183, 121], [84, 197, 104],
  [122, 209, 81], [165, 219, 54], [210, 226, 27], [253, 231, 37],
];

function colour(t: number): [number, number, number] {
  if (!Number.isFinite(t)) return [68, 1, 84];
  const x = Math.min(1, Math.max(0, t)) * (VIRIDIS.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = VIRIDIS[i];
  const b = VIRIDIS[Math.min(VIRIDIS.length - 1, i + 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export function TransectHeatmap({ transect, max = 10 }: { transect: Transect; max?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const samples = transect.samples;
    if (!canvas || !samples?.length) return;

    const cols = samples.length;
    const rows = samples[0].profile.length;
    if (!rows) return;

    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = ctx.createImageData(cols, rows);
    for (let x = 0; x < cols; x++) {
      const profile = samples[x].profile;
      for (let y = 0; y < rows; y++) {
        // Row 0 is the ground; canvas y grows downward, so flip.
        const value = profile[rows - 1 - y];
        const [r, g, b] = value == null ? [68, 1, 84] : colour(value / max);
        const o = (y * cols + x) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [transect, max]);

  const maxHeight = transect.heatmap_max_height ?? 50;
  const lengthKm = transect.total_length_m ? (transect.total_length_m / 1000).toFixed(1) : null;

  return (
    <div className="ex-heat">
      <div className="ex-heat__plot">
        <div className="ex-heat__yaxis">
          <span>{maxHeight} m</span>
          <span>0</span>
        </div>
        {/* image-rendering:auto — the buffer is one pixel per sample, so the
            browser's smoothing is what makes it read as a continuous profile. */}
        <canvas ref={ref} className="ex-heat__canvas" />
      </div>
      <div className="ex-heat__xaxis">
        <span>0</span>
        <span>{lengthKm ? `${lengthKm} km along transect` : 'along transect'}</span>
        <span>{lengthKm ? `${lengthKm} km` : ''}</span>
      </div>
      <MetricLines samples={transect.samples} />
    </div>
  );
}
