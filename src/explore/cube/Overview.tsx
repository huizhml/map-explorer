import { useEffect, useMemo, useRef } from 'react';
import { NODATA, type Cube } from './cubeData';
import type { Snapshot } from './CubeScene';
import { INFERNO } from './inferno';

/**
 * The window seen from above: a ground image, or the canopy height (RH98 on
 * the VSM inferno 0–50 m scale), with where the slices are — or what the
 * cutaway keeps — and the pin. The cube hides most of its own ground, so this
 * is where the image is actually seen.
 */

/** A ground image, or one RH of the cube on inferno 0–vmax m (the VSM height-map convention). */
type Source = (CanvasImageSource & { width: number; height: number }) | { rh: number; vmax: number };

const isRh = (s: Source): s is { rh: number; vmax: number } => typeof (s as { rh?: number }).rh === 'number';

const INFERNO_CSS = `linear-gradient(to right, ${Array.from({ length: 9 }, (_, i) => {
  const k = Math.round((i / 8) * 255) * 3;
  return `rgb(${INFERNO[k]}, ${INFERNO[k + 1]}, ${INFERNO[k + 2]})`;
}).join(', ')})`;

/** One RH of the window as an image, 1 px per voxel column. */
function rhImage(cube: Cube, rh: number, vmax: number): HTMLCanvasElement {
  const n = cube.meta.size;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(n, n);
  const off = (rh - cube.meta.rh_first) * n * n;
  for (let i = 0; i < n * n; i++) {
    const v = cube.raw[off + i];
    const o = i * 4;
    if (v === NODATA) {
      img.data.set([214, 220, 217, 255], o);
      continue;
    }
    const k = Math.round(Math.max(0, Math.min(1, v / 10 / vmax)) * 255) * 3;
    img.data.set([INFERNO[k], INFERNO[k + 1], INFERNO[k + 2], 255], o);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** A map pin with its tip on (x, y), in the explorer's green. */
function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-3, -6, -8, -10, -8, -16);
  ctx.arc(0, -16, 8, Math.PI, 0);
  ctx.bezierCurveTo(8, -10, 3, -6, 0, 0);
  ctx.closePath();
  ctx.fillStyle = '#10796a';
  ctx.fill();
  ctx.lineWidth = 2 / s;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -16, 3, 0, 2 * Math.PI);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();
}

export function Overview({
  src,
  cube,
  snap,
  probe,
  caption,
  title,
  className,
  onPick,
}: {
  src: Source;
  cube: Cube;
  snap: Snapshot | null;
  probe: { row: number; col: number } | null;
  caption: string;
  title?: string;
  className?: string;
  /** Click or drag on the image moves the pin to that pixel (row 0 = north). */
  onPick?: (row: number, col: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  // Pass a stable `src` object (a module constant) for RH maps, or this rebuilds every render.
  const canopy = useMemo(() => (isRh(src) ? rhImage(cube, src.rh, src.vmax) : null), [src, cube]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const S = c.width;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, S, S);
    // Canopy pixels are 10 m data: keep them square, not smoothed.
    ctx.imageSmoothingEnabled = !canopy;
    ctx.drawImage(canopy ?? (src as CanvasImageSource), 0, 0, S, S);
    ctx.imageSmoothingEnabled = true;

    if (snap) {
      const k = S / snap.nx;
      if (snap.display === 'cut') {
        const w = (snap.cx + 1) * k;
        const h = (snap.ny - snap.cy) * k;
        if (w < S || h < S) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
          ctx.fillRect(w, 0, S - w, S);
          ctx.fillRect(0, h, w, S - h);
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.strokeRect(1, 1, w - 2, h - 2);
        }
      } else {
        const x = (snap.cx + 0.5) * k;
        const y = (snap.ny - 1 - snap.cy + 0.5) * k;
        for (const [colour, width] of [['rgba(0, 0, 0, 0.45)', 4], ['#e4ddff', 2]] as const) {
          ctx.strokeStyle = colour;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, S);
          ctx.moveTo(0, y);
          ctx.lineTo(S, y);
          ctx.stroke();
        }
      }
    }
    const p = probe ?? cube.meta.click;
    const k = S / cube.meta.size;
    drawPin(ctx, (p.col + 0.5) * k, (p.row + 0.5) * k, S / 360);
  }, [src, canopy, cube, snap, probe]);

  const pick = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onPick) return;
    const r = ev.currentTarget.getBoundingClientRect();
    const n = cube.meta.size;
    const col = Math.max(0, Math.min(n - 1, Math.floor(((ev.clientX - r.left) / r.width) * n)));
    const row = Math.max(0, Math.min(n - 1, Math.floor(((ev.clientY - r.top) / r.height) * n)));
    onPick(row, col);
  };

  return (
    <figure
      className={`ex-cube__overview${onPick ? ' is-pickable' : ''}${className ? ` ${className}` : ''}`}
      title={onPick ? `${title ? `${title}. ` : ''}Click or drag to move the pin` : title}
    >
      <canvas
        ref={ref}
        width={480}
        height={480}
        aria-label={`${caption}, from above, with the slices and the pin`}
        onPointerDown={(ev) => {
          if (!onPick) return;
          ev.currentTarget.setPointerCapture(ev.pointerId);
          pick(ev);
        }}
        onPointerMove={(ev) => {
          if (ev.currentTarget.hasPointerCapture(ev.pointerId)) pick(ev);
        }}
      />
      <figcaption>{caption}</figcaption>
      {isRh(src) && (
        <div className="ex-cube__overview-bar" aria-label={`colour scale 0 to ${src.vmax} m`}>
          <div style={{ background: INFERNO_CSS }} />
          <span>0</span>
          <span>{src.vmax} m</span>
        </div>
      )}
    </figure>
  );
}
