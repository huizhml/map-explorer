import type { Snapshot } from './CubeScene';
import { ENERGY_LUT } from './colormaps';
import { INFERNO } from './inferno';

/**
 * The downloaded PNG: the 3D view with its legend drawn in the top-left corner. The legend on the page
 * is HTML over the canvas, so it has to be redrawn here. `cssWidth` is the canvas width on the page, to
 * keep the legend the size it has there.
 */
export async function withLegend(viewPng: string, snap: Snapshot, cssWidth: number): Promise<string> {
  const img = new Image();
  img.src = viewPng;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);

  const k = img.width / Math.max(1, cssWidth);
  g.scale(k, k);
  g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
  g.textBaseline = 'middle';
  const INK = '#1f2a25';
  const bold = (on: boolean) => (g.font = `${on ? '600 ' : ''}11px system-ui, -apple-system, "Segoe UI", sans-serif`);

  const X = 10;
  const Y = 10;
  const PAD = 8;
  const box = (w: number, h: number) => {
    g.fillStyle = 'rgba(255, 255, 255, 0.92)';
    g.strokeStyle = '#d5dcd8';
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(X + 0.5, Y + 0.5, w, h, 8);
    g.fill();
    g.stroke();
    g.fillStyle = INK;
  };

  if (snap.mode === 'surfaces') {
    const on = snap.levels.filter((l) => l.on);
    const COLS = 5;
    const CELL = 34;
    const rows = Math.ceil(on.length / COLS);
    box(PAD * 2 + COLS * CELL, 26 + rows * 16);
    bold(true);
    g.fillText('RH', X + PAD, Y + 13);
    bold(false);
    on.forEach((l, i) => {
      const x = X + PAD + (i % COLS) * CELL;
      const y = Y + 32 + Math.floor(i / COLS) * 16;
      g.fillStyle = l.colour;
      g.fillRect(x, y - 5, 10, 10);
      g.fillStyle = INK;
      g.fillText(String(l.rh), x + 13, y);
    });
    return c.toDataURL('image/png');
  }

  const canopyTop = snap.mode === 'energy' && snap.topMode === 'canopy';
  const note = 'top slice: RH98, 0–50 m';
  bold(true);
  const w = Math.max(150, g.measureText(snap.cbarTitle).width + PAD * 2, canopyTop ? g.measureText(note).width + PAD * 2 : 0);
  box(w, canopyTop ? 60 : 46);
  g.fillText(snap.cbarTitle, X + PAD, Y + 13);
  bold(false);

  // The ramp, 256 steps; in Energy the low end that is drawn transparent is shown as a checkerboard.
  const lut = snap.mode === 'rh' ? INFERNO : ENERGY_LUT;
  const rx = X + PAD;
  const ry = Y + 22;
  const rw = w - PAD * 2;
  const RH = 8;
  for (let i = 0; i < 256; i++) {
    g.fillStyle = `rgb(${lut[i * 3]}, ${lut[i * 3 + 1]}, ${lut[i * 3 + 2]})`;
    g.fillRect(rx + (i / 256) * rw, ry, rw / 256 + 0.5, RH);
  }
  if (snap.mode === 'energy' && snap.cutoff > 0) {
    const cw = rw * snap.cutoff;
    g.save();
    g.beginPath();
    g.rect(rx, ry, cw, RH);
    g.clip();
    g.fillStyle = '#fff';
    g.fillRect(rx, ry, cw, RH);
    g.fillStyle = '#c3ccc7';
    for (let i = 0; i * 3 < cw; i++) for (let j = 0; j * 3 < RH; j++) if ((i + j) % 2 === 0) g.fillRect(rx + i * 3, ry + j * 3, 3, 3);
    g.restore();
  }
  g.fillStyle = INK;
  g.fillText('0', rx, ry + RH + 9);
  g.textAlign = 'right';
  g.fillText(`${+snap.vmax.toFixed(2)} ${snap.unit}`.trim(), rx + rw, ry + RH + 9);
  g.textAlign = 'left';
  if (canopyTop) {
    g.fillStyle = '#5c6a64';
    g.fillText(note, rx, ry + RH + 23);
  }
  return c.toDataURL('image/png');
}
