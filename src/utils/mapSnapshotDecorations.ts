import type Map from 'ol/Map';
import { getPointResolution } from 'ol/proj';

/** OGC default screen DPI used by OpenLayers ScaleLine (same as `ol/control/ScaleLine`). */
const OL_DEFAULT_DPI = 25.4 / 0.28;
const LEADING_DIGITS = [1, 2, 5];

export type MetricScaleBarLayout = {
  barWidthCss: number;
  scaleLength: number;
  suffix: string;
};

/**
 * Chooses bar length (CSS px) and labeled distance to match OpenLayers metric ScaleLine.
 */
export function computeMetricScaleBarLayout(
  cssMinWidth: number,
  pointResolutionMPerCssPx: number,
): MetricScaleBarLayout | null {
  const minWidth = cssMinWidth;
  let nominalCount = minWidth * pointResolutionMPerCssPx;
  let suffix = '';
  let pr = pointResolutionMPerCssPx;

  if (nominalCount < 1e-6) {
    suffix = 'nm';
    pr *= 1e9;
  } else if (nominalCount < 0.001) {
    suffix = 'μm';
    pr *= 1000000;
  } else if (nominalCount < 1) {
    suffix = 'mm';
    pr *= 1000;
  } else if (nominalCount < 1000) {
    suffix = 'm';
  } else {
    suffix = 'km';
    pr /= 1000;
  }

  let i = 3 * Math.floor(Math.log(minWidth * pr) / Math.log(10));
  let count: number;
  let width: number;

  while (true) {
    const decimalCount = Math.floor(i / 3);
    const decimal = 10 ** decimalCount;
    count = LEADING_DIGITS[((i % 3) + 3) % 3] * decimal;
    width = Math.round(count / pr);
    if (Number.isNaN(width)) return null;
    if (width >= minWidth) break;
    ++i;
  }

  return { barWidthCss: width, scaleLength: count, suffix };
}

function mapScaleDenominator(map: Map): number | null {
  const view = map.getView();
  const projection = view.getProjection();
  const center = view.getCenter();
  const resolution = view.getResolution();
  if (!projection || !center || resolution == null) return null;
  const mPerPx = getPointResolution(projection, resolution, center, 'm');
  const inchesPerMeter = 1000 / 25.4;
  return mPerPx * inchesPerMeter * OL_DEFAULT_DPI;
}

function strokeFillLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  pxScale: number,
  align: CanvasTextAlign,
) {
  ctx.save();
  ctx.font = `${10 * pxScale}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = align;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, 3 * pxScale);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.fillStyle = '#333';
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * Draws a metric scale bar (OpenLayers-style alternating segments + tick labels) in **device pixels**.
 * Matches Map.tsx ScaleLine options: metric, bar, steps 4, text, minWidth 120.
 */
export function drawMetricScaleBarOnSnapshot(
  ctx: CanvasRenderingContext2D,
  map: Map,
  options: {
    canvasHeightPx: number;
    padLeftPx: number;
    padBottomPx: number;
    pxPerCss: number;
    minWidthCss: number;
    steps: number;
    showMapScaleText: boolean;
  },
): void {
  const {
    canvasHeightPx,
    padLeftPx,
    padBottomPx,
    pxPerCss,
    minWidthCss,
    steps,
    showMapScaleText,
  } = options;

  const view = map.getView();
  const projection = view.getProjection();
  const center = view.getCenter();
  const resolution = view.getResolution();
  if (!projection || !center || resolution == null) return;

  const pointResolutionM = getPointResolution(projection, resolution, center, 'm');
  const layout = computeMetricScaleBarLayout(minWidthCss, pointResolutionM);
  if (!layout) return;

  const { barWidthCss, scaleLength, suffix } = layout;
  const wPx = barWidthCss * pxPerCss;
  const barHPx = 10 * pxPerCss;
  const labelAreaPx = 16 * pxPerCss;
  const scaleTitlePx = 12 * pxPerCss;
  const titleGapPx = 6 * pxPerCss;

  let barTopPx =
    canvasHeightPx - padBottomPx - labelAreaPx - barHPx;
  if (showMapScaleText) {
    barTopPx -= scaleTitlePx + titleGapPx;
  }

  const barBottomPx = barTopPx + barHPx;
  const platePad = 3 * pxPerCss;

  let mapScaleStr: string | null = null;
  let titleY = 0;
  if (showMapScaleText) {
    const denom = mapScaleDenominator(map);
    if (denom != null) {
      mapScaleStr =
        denom < 1
          ? `${Math.round(1 / denom).toLocaleString()} : 1`
          : `1 : ${Math.round(denom).toLocaleString()}`;
      titleY = barTopPx - titleGapPx / 2;
    }
  }

  const titleTopPx = mapScaleStr != null ? titleY - scaleTitlePx : null;
  const plateTop = (titleTopPx ?? barTopPx) - platePad;
  const plateBottom = barBottomPx + labelAreaPx;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
  ctx.lineWidth = 1 * pxPerCss;
  const plateW = wPx + platePad * 2;
  const plateH = plateBottom - plateTop;
  const rx = 4 * pxPerCss;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(padLeftPx - platePad, plateTop, plateW, plateH, rx);
  } else {
    ctx.rect(padLeftPx - platePad, plateTop, plateW, plateH);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  if (mapScaleStr != null) {
    const cx = padLeftPx + wPx / 2;
    ctx.save();
    ctx.font = `${scaleTitlePx}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = Math.max(2, 3 * pxPerCss);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillStyle = '#333';
    ctx.strokeText(mapScaleStr, cx, titleY);
    ctx.fillText(mapScaleStr, cx, titleY);
    ctx.restore();
  }

  const stepW = wPx / steps;
  for (let i = 0; i < steps; i++) {
    const x0 = padLeftPx + i * stepW;
    ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#888888';
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = Math.max(1, 1 * pxPerCss);
    ctx.fillRect(x0, barTopPx, stepW, barHPx);
    ctx.strokeRect(x0, barTopPx, stepW, barHPx);
  }

  const labelY = barBottomPx + 2 * pxPerCss;
  for (let i = 0; i <= steps; i++) {
    const length = i === 0 ? 0 : Math.round((scaleLength / steps) * i * 100) / 100;
    const txt = i === 0 ? '0' : `${length} ${suffix}`.trim();
    const x = padLeftPx + (wPx * i) / steps;
    const align: CanvasTextAlign = i === 0 ? 'left' : i === steps ? 'right' : 'center';
    strokeFillLabel(ctx, txt, x, labelY, pxPerCss, align);
  }
}

/**
 * Same as `drawMetricScaleBarOnSnapshot` but accepts `metersPerCssPx` directly
 * (no OL map required — use when the image comes from an off-map source).
 */
export function drawMetricScaleBarFromResolution(
  ctx: CanvasRenderingContext2D,
  metersPerCssPx: number,
  options: {
    canvasHeightPx: number;
    padLeftPx: number;
    padBottomPx: number;
    pxPerCss: number;
    minWidthCss: number;
    steps: number;
  },
): void {
  const { canvasHeightPx, padLeftPx, padBottomPx, pxPerCss, minWidthCss, steps } = options;
  const layout = computeMetricScaleBarLayout(minWidthCss, metersPerCssPx);
  if (!layout) return;
  const { barWidthCss, scaleLength, suffix } = layout;
  const wPx = barWidthCss * pxPerCss;
  const barHPx = 10 * pxPerCss;
  const labelAreaPx = 16 * pxPerCss;
  const platePad = 3 * pxPerCss;
  const barTopPx = canvasHeightPx - padBottomPx - labelAreaPx - barHPx;
  const barBottomPx = barTopPx + barHPx;
  const plateTop = barTopPx - platePad;
  const plateBottom = barBottomPx + labelAreaPx;
  const rx = 4 * pxPerCss;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
  ctx.lineWidth = 1 * pxPerCss;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(padLeftPx - platePad, plateTop, wPx + platePad * 2, plateBottom - plateTop, rx);
  } else {
    ctx.rect(padLeftPx - platePad, plateTop, wPx + platePad * 2, plateBottom - plateTop);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  const stepW = wPx / steps;
  for (let i = 0; i < steps; i++) {
    const x0 = padLeftPx + i * stepW;
    ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#888888';
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = Math.max(1, 1 * pxPerCss);
    ctx.fillRect(x0, barTopPx, stepW, barHPx);
    ctx.strokeRect(x0, barTopPx, stepW, barHPx);
  }
  const labelY = barBottomPx + 2 * pxPerCss;
  for (let i = 0; i <= steps; i++) {
    const length = i === 0 ? 0 : Math.round((scaleLength / steps) * i * 100) / 100;
    const txt = i === 0 ? '0' : `${length} ${suffix}`.trim();
    const x = padLeftPx + (wPx * i) / steps;
    const align: CanvasTextAlign = i === 0 ? 'left' : i === steps ? 'right' : 'center';
    strokeFillLabel(ctx, txt, x, labelY, pxPerCss, align);
  }
}

/**
 * North arrow in the bottom-right; `pxScale` scales geometry for HiDPI exports.
 */
export function drawNorthArrowOnSnapshot(
  ctx: CanvasRenderingContext2D,
  widthPx: number,
  heightPx: number,
  viewRotationRad: number,
  pxScale: number,
  padCss: number,
) {
  const box = 52 * pxScale;
  const pad = padCss * pxScale;
  const cx = widthPx - pad - box / 2;
  const cy = heightPx - pad - box / 2;
  const rotation = Number.isFinite(viewRotationRad) ? viewRotationRad : 0;
  const half = box / 2;
  const r = 4 * pxScale;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-rotation);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
  ctx.strokeStyle = 'rgba(51, 51, 51, 0.85)';
  ctx.lineWidth = Math.max(1, 1.25 * pxScale);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(-half, -half, box, box, r);
  } else {
    ctx.rect(-half, -half, box, box);
  }
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.moveTo(0, -half + 10 * pxScale);
  ctx.lineTo(-9 * pxScale, 4 * pxScale);
  ctx.lineTo(9 * pxScale, 4 * pxScale);
  ctx.closePath();
  ctx.fill();

  ctx.font = `bold ${14 * pxScale}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#222';
  ctx.fillText('N', 0, 14 * pxScale);

  ctx.restore();
}
