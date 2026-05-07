import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { useMapStore } from '../stores/mapStore';
import type { VerticalProfileLineSample } from '../stores/mapStore';
import { TransectMetricsChart } from './SavedFeaturePlots';
import { DEFAULT_DIVERSITY_HEIGHT_BIN_M } from '../constants/diversityMetrics';
import {
  drawMetricScaleBarOnSnapshot,
  drawNorthArrowOnSnapshot,
} from '../utils/mapSnapshotDecorations';

type ExportFormat = 'pdf' | 'png' | 'jpg';
type PlotTarget = 'heatmap' | 'metrics';
type PdfQuality = 'standard' | 'high' | 'ultra';
const DEFAULT_MAX_HEIGHT = 50;

/** Inset for scale bar + north arrow on exported map snapshots (aligns with OL control margins). */
const MAP_EXPORT_DECORATION_PAD = 10;

/** ScaleLine options in {@link Map.tsx} — keep snapshot bar consistent with the live map. */
const MAP_EXPORT_SCALEBAR_MIN_WIDTH_CSS = 120;
const MAP_EXPORT_SCALEBAR_STEPS = 4;

/** Scale + pixel caps for PDF embedding (heatmap raster + metrics html2canvas). */
const PDF_QUALITY_PRESETS: Record<
  PdfQuality,
  { heatmapScale: number; heatmapMaxPixels: number; metricsScale: number; metricsMaxPixels: number }
> = {
  standard: {
    heatmapScale: 1,
    heatmapMaxPixels: 4_800_000,
    metricsScale: 1.5,
    metricsMaxPixels: 4_000_000,
  },
  high: {
    heatmapScale: 2,
    heatmapMaxPixels: 8_000_000,
    metricsScale: 2,
    metricsMaxPixels: 6_000_000,
  },
  ultra: {
    heatmapScale: 3,
    heatmapMaxPixels: 14_000_000,
    /** 3× metrics raster is very slow; heatmap can still use 3×. */
    metricsScale: 2.5,
    metricsMaxPixels: 10_000_000,
  },
};

/**
 * html2canvas for MUI X Charts (SVG-heavy).
 * Keep `foreignObjectRendering: false` — the FO path often yields blank images with
 * nested SVG / charts and can hang the main thread in Chrome.
 */
const HTML2CANVAS_METRICS = {
  backgroundColor: '#ffffff',
  useCORS: true,
  logging: false,
  foreignObjectRendering: false,
  scrollX: 0,
  scrollY: 0,
} as const;

/** Hard cap — metrics plots are wider than tall; 2.5× is plenty for print/PDF without huge buffers. */
const METRICS_EXPORT_MAX_SCALE = 2.5;

type TransectExportDialogProps = {
  open: boolean;
  onClose: () => void;
  samples: VerticalProfileLineSample[];
  totalLengthMeters?: number;
  xAxis: 'lon' | 'lat';
  maxHeight?: number;
  /** Meters per vertical bin (matches transect profile histogram); defaults to Tools setting. */
  heightBinM?: number;
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function rampColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const hue = 235 - 175 * clamped;
  const saturation = 86;
  const lightness = 28 + 34 * clamped;
  return `hsl(${hue.toFixed(1)} ${saturation}% ${lightness.toFixed(1)}%)`;
}

function rampRgb(t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const h = (235 - 175 * clamped) / 360;
  const s = 0.86;
  const l = 0.28 + 0.34 * clamped;
  const hueToRgb = (p: number, q: number, tt: number) => {
    let x = tt;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hueToRgb(p, q, h + 1 / 3);
  const g = hueToRgb(p, q, h);
  const b = hueToRgb(p, q, h - 1 / 3);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function getSafeExportSize(width: number, height: number, maxPixels: number) {
  const pixels = width * height;
  if (pixels <= maxPixels) return { width, height };
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(480, Math.round(width * scale)),
    height: Math.max(320, Math.round(height * scale)),
  };
}

export function TransectExportDialog({
  open,
  onClose,
  samples,
  totalLengthMeters,
  xAxis,
  maxHeight,
  heightBinM: heightBinMProp,
}: TransectExportDialogProps) {
  const map = useMapStore((state) => state.map);
  const diversityHeightBinM = useMapStore((state) => state.diversityHeightBinM);
  const heightBinM = heightBinMProp ?? diversityHeightBinM ?? DEFAULT_DIVERSITY_HEIGHT_BIN_M;
  const heatmapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const metricsPreviewRef = useRef<HTMLDivElement | null>(null);
  /** Off-screen DOM used for one-file metrics export. */
  const metricsExportRef = useRef<HTMLDivElement | null>(null);
  const [format, setFormat] = useState<ExportFormat>('png');
  const [previewPlot, setPreviewPlot] = useState<PlotTarget>('heatmap');
  const [fontSize, setFontSize] = useState<number>(11);
  const [figureWidth, setFigureWidth] = useState<number>(1200);
  const [figureHeight, setFigureHeight] = useState<number>(560);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [pdfQuality, setPdfQuality] = useState<PdfQuality>('high');
  /** Vertical colorbar strip width in px (heatmap only); bar height matches plot inner height. */
  const [colorbarHeightPx, setColorbarHeightPx] = useState<number>(18);

  const safeWidth = clamp(figureWidth, 700, 3000);
  const safeHeight = clamp(figureHeight, 380, 1800);
  const safeFontSize = clamp(fontSize, 8, 24);
  const safeColorbarHeightPx = clamp(colorbarHeightPx, 10, 44);

  /** Matches {@link TransectMetricsChart} so we only run html2canvas on non-empty panels. */
  const metricsExportPanels = useMemo(() => {
    if (samples.length < 2) return { main: false, cr: false };
    const hasMain = samples.some((s) =>
      [s.fhd, s.enl1d, s.enl2d].some((v) => v != null && Number.isFinite(Number(v))),
    );
    const hasCr = samples.some((s) => s.cr != null && Number.isFinite(s.cr));
    return { main: hasMain, cr: hasCr };
  }, [samples]);

  // Heavy data prep cached: builds xCount × nBins RGBA bitmap (`rh` = bin index).
  const heatmapData = useMemo(() => {
    let zMin = Infinity;
    let zMax = -Infinity;
    const xCount = Math.max(1, samples.length);
    const hb = Math.max(1, heightBinM);
    const maxHm = Math.max(1, Math.round(maxHeight ?? DEFAULT_MAX_HEIGHT));
    const nBins = Math.max(
      1,
      samples.reduce((acc, s) => Math.max(acc, s.profile?.length ?? 0), 0) || Math.round(maxHm / hb),
    );

    type Pt = { xIndex: number; rh: number; value: number };
    const points: Pt[] = [];

    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i];
      const profile = sample.profile;
      for (let j = 0; j < profile.length; j += 1) {
        const p = profile[j];
        if (p.missing || p.value == null) continue;
        const v = p.value;
        if (!Number.isFinite(v)) continue;
        const rh = Math.round(p.rh);
        if (v < zMin) zMin = v;
        if (v > zMax) zMax = v;
        points.push({ xIndex: i, rh, value: v });
      }
    }

    const denom = zMax - zMin || 1;
    const yCount = nBins;

    let gridCanvas: HTMLCanvasElement | null = null;
    if (points.length > 0) {
      const c = document.createElement('canvas');
      c.width = xCount;
      c.height = yCount;
      const gridCtx = c.getContext('2d');
      if (gridCtx) {
        const imgData = gridCtx.createImageData(xCount, yCount);
        const data = imgData.data;
        // Default every pixel to opaque #fafafa so empty bins blend with the
        // chart background (matches the manual fillRect path used previously).
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 250;
          data[i + 1] = 250;
          data[i + 2] = 250;
          data[i + 3] = 255;
        }
        for (let i = 0; i < points.length; i += 1) {
          const p = points[i];
          const px = p.xIndex;
          const py = nBins - 1 - p.rh;
          if (px < 0 || px >= xCount || py < 0 || py >= yCount) continue;
          const t = (p.value - zMin) / denom;
          const [r, g, b] = rampRgb(t);
          const idx = (py * xCount + px) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = 255;
        }
        gridCtx.putImageData(imgData, 0, 0);
        gridCanvas = c;
      }
    }

    return { points, zMin, zMax, denom, nBins, maxHm, xCount, gridCanvas };
  }, [samples, maxHeight, heightBinM]);

  const drawHeatmapInto = (
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
  ): boolean => {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    const { points, zMin, zMax, maxHm, xCount, gridCanvas } = heatmapData;
    // When PDF export uses a larger bitmap than the figure size (high/ultra),
    // scale all typography, margins, and strokes so proportions match the preview.
    const sc = Math.min(width / safeWidth, height / safeHeight);
    if (points.length === 0 || !gridCanvas) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#9e9e9e';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${safeFontSize * sc}px sans-serif`;
      ctx.fillText('No transect data to plot', width / 2, height / 2);
      return false;
    }

    const tickFontSize = Math.max(10, safeFontSize - 1) * sc;
    const axisFontSize = safeFontSize * sc;
    const desiredTicks = 5;
    const yTicksMeters = Array.from({ length: desiredTicks + 1 }, (_, i) =>
      Math.round((i / desiredTicks) * maxHm));
    ctx.font = `${tickFontSize}px sans-serif`;
    const yTickMaxWidth = yTicksMeters.reduce((mx, m) => Math.max(mx, ctx.measureText(`${m}`).width), 0);
    const zSpanForMargin = zMax - zMin || 1;
    let colorbarLabelMaxW = 0;
    for (let i = 0; i < 5; i += 1) {
      const t = i / 4;
      const zAt = zMin + t * zSpanForMargin;
      colorbarLabelMaxW = Math.max(colorbarLabelMaxW, ctx.measureText(zAt.toFixed(2)).width);
    }
    const colorbarGap = 12 * sc;
    const colorbarTickLen = 5 * sc;
    const barThickness = safeColorbarHeightPx * sc;
    ctx.font = `${axisFontSize}px sans-serif`;
    const energyLabelReserve = 12 * sc + ctx.measureText('Energy (%)').width / 2 + axisFontSize * 0.75;
    // Right margin: gap + bar + ticks + value labels + rotated "Energy (%)" title.
    const marginRightColorbar =
      colorbarGap + barThickness + colorbarTickLen + colorbarLabelMaxW + 10 * sc + energyLabelReserve;
    const margin = {
      top: Math.max(56 * sc, Math.round(24 * sc + tickFontSize)),
      right: Math.max(18 * sc, marginRightColorbar),
      bottom: Math.max(56 * sc, Math.round(30 * sc + tickFontSize + axisFontSize)),
      left: Math.max(72 * sc, Math.ceil(28 * sc + axisFontSize + 12 * sc + yTickMaxWidth + 14 * sc)),
    };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const cellW = innerW / xCount;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#4f4f4f';
    ctx.font = `${safeFontSize * sc}px sans-serif`;
    ctx.textBaseline = 'top';
    // ctx.fillText(
    //   `Heatmap across transect locations (${xAxis === 'lon' ? 'longitude' : 'latitude'}) and height bins (y, 1m).`,
    //   12,
    //   10,
    // );

    ctx.fillStyle = '#fafafa';
    ctx.fillRect(margin.left, margin.top, innerW, innerH);

    // Single-shot upscale of the precomputed cell bitmap. Nearest-neighbor
    // (imageSmoothingEnabled=false) preserves the discrete cell look.
    const prevSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(gridCanvas, margin.left, margin.top, innerW, innerH);
    ctx.imageSmoothingEnabled = prevSmoothing;

    ctx.strokeStyle = '#9e9e9e';
    ctx.lineWidth = Math.max(1, sc);
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + innerH);
    ctx.lineTo(margin.left + innerW, margin.top + innerH);
    ctx.moveTo(margin.left, margin.top);
    ctx.lineTo(margin.left, margin.top + innerH);
    ctx.stroke();

    const xTickCount = Math.min(6, xCount);
    const xTicks = Array.from({ length: xTickCount }, (_, i) =>
      Math.round((i * (xCount - 1)) / Math.max(1, xTickCount - 1)));
    ctx.fillStyle = '#616161';
    ctx.font = `${tickFontSize}px sans-serif`;
    xTicks.forEach((idx) => {
      const sample = samples[idx];
      const coord = sample ? (xAxis === 'lon' ? sample.lon : sample.lat) : NaN;
      const label = Number.isFinite(coord) ? coord.toFixed(4) : '—';
      const x = margin.left + (idx + 0.5) * cellW;
      ctx.beginPath();
      ctx.moveTo(x, margin.top + innerH);
      ctx.lineTo(x, margin.top + innerH + 4 * sc);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText(label, x, margin.top + innerH + 8 * sc + tickFontSize);
    });

    yTicksMeters.forEach((m) => {
      const y = margin.top + innerH - (m / maxHm) * innerH;
      ctx.beginPath();
      ctx.moveTo(margin.left - 4 * sc, y);
      ctx.lineTo(margin.left, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${m}`, margin.left - 10 * sc, y);
    });
    ctx.textBaseline = 'alphabetic';

    ctx.textAlign = 'center';
    ctx.font = `${axisFontSize}px sans-serif`;
    ctx.fillText(xAxis === 'lon' ? 'Longitude' : 'Latitude', margin.left + innerW / 2, height - 8 * sc);

    ctx.save();
    const yTickTextX = margin.left - 10 * sc;
    const yLabelX = yTickTextX - yTickMaxWidth - Math.max(14 * sc, axisFontSize + 8 * sc);
    ctx.translate(Math.max(10 * sc, yLabelX), margin.top + innerH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Height (m)', 0, 0);
    ctx.restore();

    // Vertical colorbar: full plot height, flush right of plot with a small gap.
    const zSpan = zMax - zMin || 1;
    const barLeft = margin.left + innerW + colorbarGap;
    const barTop = margin.top;
    const barH = innerH;
    const vGrad = ctx.createLinearGradient(barLeft, barTop + barH, barLeft, barTop);
    vGrad.addColorStop(0, rampColor(0));
    vGrad.addColorStop(0.25, rampColor(0.25));
    vGrad.addColorStop(0.5, rampColor(0.5));
    vGrad.addColorStop(0.75, rampColor(0.75));
    vGrad.addColorStop(1, rampColor(1));
    ctx.fillStyle = vGrad;
    ctx.fillRect(barLeft, barTop, barThickness, barH);
    ctx.strokeStyle = '#c7c7c7';
    ctx.lineWidth = Math.max(1, sc);
    ctx.strokeRect(barLeft, barTop, barThickness, barH);
    ctx.fillStyle = '#616161';
    ctx.font = `${tickFontSize}px sans-serif`;
    ctx.strokeStyle = '#616161';
    ctx.textAlign = 'left';
    const colorbarTickCount = 5;
    for (let i = 0; i < colorbarTickCount; i += 1) {
      const t = i / (colorbarTickCount - 1);
      const ty = barTop + barH - t * barH;
      ctx.beginPath();
      ctx.moveTo(barLeft + barThickness, ty);
      ctx.lineTo(barLeft + barThickness + colorbarTickLen, ty);
      ctx.stroke();
      const zAt = zMin + t * zSpan;
      ctx.textBaseline = 'middle';
      ctx.fillText(zAt.toFixed(2), barLeft + barThickness + colorbarTickLen + 4 * sc, ty);
    }
    ctx.textBaseline = 'alphabetic';

    ctx.save();
    ctx.font = `${axisFontSize}px sans-serif`;
    ctx.fillStyle = '#616161';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const numericLabelsRight = barLeft + barThickness + colorbarTickLen + colorbarLabelMaxW;
    const energyLabelCx = numericLabelsRight + 10 * sc + energyLabelReserve / 2;
    ctx.translate(energyLabelCx, barTop + barH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Energy (%)', 0, 0);
    ctx.restore();

    return true;
  };

  const HEATMAP_PREVIEW_MAX_PIXELS = 1_400_000;

  // Draw the heatmap synchronously into whatever canvas is currently mounted.
  // Memoized data prep already keeps this fast even for large transects.
  const paintHeatmap = useCallback(() => {
    const canvas = heatmapCanvasRef.current;
    if (!canvas) return;
    const safe = getSafeExportSize(safeWidth, safeHeight, HEATMAP_PREVIEW_MAX_PIXELS);
    drawHeatmapInto(canvas, safe.width, safe.height);
  }, [
    safeWidth,
    safeHeight,
    safeFontSize,
    safeColorbarHeightPx,
    samples,
    totalLengthMeters,
    xAxis,
    maxHeight,
    heatmapData,
  ]);

  const renderHeatmapExportCanvas = (maxPixels: number, scale = 1) => {
    const targetW = Math.round(safeWidth * Math.max(1, scale));
    const targetH = Math.round(safeHeight * Math.max(1, scale));
    const safe = getSafeExportSize(targetW, targetH, maxPixels);
    const exportCanvas = document.createElement('canvas');
    const ok = drawHeatmapInto(exportCanvas, safe.width, safe.height);
    return ok ? exportCanvas : null;
  };

  /**
   * SVG-only raster (no HTML). MUI LineChart puts the legend and some chrome **outside**
   * the `<svg>`, so this path cannot match on-screen output — use only as a fallback when
   * html2canvas fails.
   */
  const renderMetricsExportCanvas = async (
    node: HTMLElement,
    scale: number,
    maxPixels: number,
  ): Promise<HTMLCanvasElement | null> => {
    const svgs = Array.from(node.querySelectorAll<SVGSVGElement>('svg'));
    if (svgs.length === 0) return null;
    const rootRect = node.getBoundingClientRect();
    if (!rootRect.width || !rootRect.height) return null;

    const target = getSafeExportSize(
      Math.max(1, Math.round(rootRect.width * scale)),
      Math.max(1, Math.round(rootRect.height * scale)),
      maxPixels,
    );
    const sx = target.width / rootRect.width;
    const sy = target.height / rootRect.height;
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const svg of svgs) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
      clone.setAttribute('width', `${Math.max(1, Math.round(rect.width))}`);
      clone.setAttribute('height', `${Math.max(1, Math.round(rect.height))}`);
      const vb = svg.getAttribute('viewBox');
      if (!vb) clone.setAttribute('viewBox', `0 0 ${Math.max(1, Math.round(rect.width))} ${Math.max(1, Math.round(rect.height))}`);

      const xml = new XMLSerializer().serializeToString(clone);
      const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('Failed to decode metrics SVG for export.'));
          img.src = url;
        });
        ctx.drawImage(
          image,
          (rect.left - rootRect.left) * sx,
          (rect.top - rootRect.top) * sy,
          rect.width * sx,
          rect.height * sy,
        );
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return canvas;
  };

  // Repaint whenever the dialog is open and any input that affects the figure
  // changes. useLayoutEffect runs after DOM mutations but before paint, so the
  // canvas is guaranteed to be mounted by the time we draw into it.
  useLayoutEffect(() => {
    if (!open) return;
    paintHeatmap();
  }, [open, paintHeatmap]);

  // Ref callback ensures we paint as soon as the <canvas> node is attached,
  // even if that happens after the initial useLayoutEffect (e.g. when toggling
  // the preview between heatmap and metrics).
  const setHeatmapCanvasRef = useCallback((node: HTMLCanvasElement | null) => {
    heatmapCanvasRef.current = node;
    if (node && open) paintHeatmap();
  }, [open, paintHeatmap]);

  const handleExportPlot = async (target: PlotTarget) => {
    if (isExporting) return;
    setExportError(null);
    setIsExporting(true);
    try {
      if (target === 'heatmap') {
        const pdfPreset = PDF_QUALITY_PRESETS[pdfQuality];
        // For PDF, render a higher-resolution canvas than preview so text and
        // color transitions stay sharp when zooming the document.
        // Always render export bitmap with drawHeatmapInto so PNG/JPG/PDF match the
        // same code path; PNG/JPG use the same pixel budget as the dialog preview
        // (ref can differ from preview after rapid UI changes).
        const canvasForExport = format === 'pdf'
          ? renderHeatmapExportCanvas(pdfPreset.heatmapMaxPixels, pdfPreset.heatmapScale)
          : renderHeatmapExportCanvas(HEATMAP_PREVIEW_MAX_PIXELS, 1);
        if (!canvasForExport || !canvasForExport.width || !canvasForExport.height) {
          setExportError('Heatmap preview is not ready yet — try again in a moment.');
          return;
        }
        await downloadCanvas(canvasForExport, 'transect-heatmap');
        return;
      }

      setPreviewPlot('metrics');
      // Let the metrics panel mount and layout (display + chart measure) before capture.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });
      const pdfPreset = PDF_QUALITY_PRESETS[pdfQuality];
      const requestedScale = format === 'pdf' ? pdfPreset.metricsScale : 1;
      const requestedPixels = safeWidth * safeHeight * requestedScale * requestedScale;
      const maxPixels = format === 'pdf' ? pdfPreset.metricsMaxPixels : 2_000_000;
      let scale = requestedPixels > maxPixels
        ? Math.sqrt(maxPixels / Math.max(1, safeWidth * safeHeight))
        : requestedScale;
      scale = Math.min(scale, METRICS_EXPORT_MAX_SCALE);

      const hasAnyMetrics = metricsExportPanels.main || metricsExportPanels.cr;
      /** Prefer visible preview — html2canvas often mis-crops `transform`-positioned off-screen clones. */
      const exportNode = metricsPreviewRef.current ?? metricsExportRef.current;
      if (!hasAnyMetrics || !exportNode) {
        setExportError('No transect metrics panels to export (need ENL/FHD or CR samples).');
      } else {
        let canvas: HTMLCanvasElement | null = null;
        try {
          canvas = await html2canvas(exportNode, { ...HTML2CANVAS_METRICS, scale });
        } catch {
          canvas = null;
        }
        if (!canvas || canvas.width < 2 || canvas.height < 2) {
          canvas = await renderMetricsExportCanvas(exportNode, scale, maxPixels);
        }
        if (!canvas || !canvas.width || !canvas.height) {
          setExportError('Metrics capture failed (empty canvas).');
          return;
        }
        await downloadCanvas(canvas, 'transect-metrics');
      }
    } finally {
      setIsExporting(false);
    }
  };

  const downloadCanvas = async (canvas: HTMLCanvasElement, basename: string) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const encodeBlob = (mime: string, quality?: number) => new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas encoding failed'));
      }, mime, quality);
    });
    if (format === 'pdf') {
      // Keep PDF crisp by embedding a lossless PNG image.
      const blob = await encodeBlob('image/png');
      const imgData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('Failed reading export blob'));
        reader.readAsDataURL(blob);
      });
      const pdf = new jsPDF({
        orientation: canvas.width >= canvas.height ? 'landscape' : 'portrait',
        unit: 'px',
        format: [canvas.width, canvas.height],
        compress: false,
      });
      pdf.addImage(imgData, 'PNG', 0, 0, canvas.width, canvas.height, undefined, 'FAST');
      pdf.save(`${basename}-${stamp}.pdf`);
      return;
    }
    const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    const quality = format === 'jpg' ? 0.92 : 1;
    const blob = await encodeBlob(mime, quality);
    const dataUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `${basename}-${stamp}.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(dataUrl), 1000);
  };

  const exportCurrentMapSnapshot = async () => {
    if (!map || isExporting) return;
    setExportError(null);
    setIsExporting(true);
    try {
      await new Promise<void>((resolve) => {
        map.once('rendercomplete', () => resolve());
        map.renderSync();
      });
      const mapSize = map.getSize();
      if (!mapSize) return;
      const [width] = mapSize;
      const canvasNodes = map.getViewport().querySelectorAll<HTMLCanvasElement>('.ol-layer canvas, canvas.ol-layer');
      if (canvasNodes.length === 0) {
        throw new Error('No renderable map canvas found in current viewport.');
      }
      const firstCanvas = canvasNodes[0];
      const pxPerCss = firstCanvas.width / width;
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = firstCanvas.width;
      exportCanvas.height = firstCanvas.height;
      const context = exportCanvas.getContext('2d', { alpha: true });
      if (!context) return;

      canvasNodes.forEach((canvas) => {
        if (!canvas.width || !canvas.height) return;
        const opacity = canvas.parentElement ? Number(canvas.parentElement.style.opacity || '1') : 1;
        context.globalAlpha = Number.isFinite(opacity) ? opacity : 1;
        const transform = canvas.style.transform;
        if (transform) {
          const matrix = transform.match(/^matrix\(([-\d., ]+)\)$/);
          if (matrix?.[1]) {
            const values = matrix[1].split(',').map((v) => Number(v.trim()));
            if (values.length === 6 && values.every((v) => Number.isFinite(v))) {
              context.setTransform(values[0], values[1], values[2], values[3], values[4], values[5]);
            } else {
              context.setTransform(1, 0, 0, 1, 0, 0);
            }
          } else {
            context.setTransform(1, 0, 0, 1, 0, 0);
          }
        } else {
          context.setTransform(1, 0, 0, 1, 0, 0);
        }
        context.drawImage(canvas, 0, 0);
      });
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1;
      context.imageSmoothingEnabled = true;

      const padPx = MAP_EXPORT_DECORATION_PAD * pxPerCss;
      drawMetricScaleBarOnSnapshot(context, map, {
        canvasHeightPx: exportCanvas.height,
        padLeftPx: padPx,
        padBottomPx: padPx,
        pxPerCss,
        minWidthCss: MAP_EXPORT_SCALEBAR_MIN_WIDTH_CSS,
        steps: MAP_EXPORT_SCALEBAR_STEPS,
        showMapScaleText: true,
      });
      drawNorthArrowOnSnapshot(
        context,
        exportCanvas.width,
        exportCanvas.height,
        map.getView().getRotation(),
        pxPerCss,
        MAP_EXPORT_DECORATION_PAD,
      );

      await downloadCanvas(exportCanvas, 'transect-map-snapshot');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const corsBlocked = /tainted|securityerror|cross-origin|insecure/i.test(message);
      setExportError(
        corsBlocked
          ? 'Map snapshot blocked by browser CORS security for this basemap (common with Google tiles). Try Esri World Imagery or OSM for snapshot export.'
          : `Map snapshot failed: ${message}`,
      );
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>Export transect figure</DialogTitle>
      <DialogContent>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25} sx={{ mb: 1.25, mt: 0.25 }}>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel id="transect-export-format">Format</InputLabel>
            <Select
              labelId="transect-export-format"
              value={format}
              label="Format"
              onChange={(event) => setFormat(event.target.value as ExportFormat)}
            >
              <MenuItem value="pdf">PDF</MenuItem>
              <MenuItem value="png">PNG</MenuItem>
              <MenuItem value="jpg">JPG</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 170 }}>
            <InputLabel id="transect-export-preview">Preview plot</InputLabel>
            <Select
              labelId="transect-export-preview"
              value={previewPlot}
              label="Preview plot"
              onChange={(event: SelectChangeEvent<PlotTarget>) => setPreviewPlot(event.target.value as PlotTarget)}
            >
              <MenuItem value="heatmap">Heatmap</MenuItem>
              <MenuItem value="metrics">Metrics chart</MenuItem>
            </Select>
          </FormControl>
          <TextField
            size="small"
            type="number"
            label="Figure width (px)"
            value={figureWidth}
            onChange={(event) => setFigureWidth(Number(event.target.value))}
            inputProps={{ min: 700, max: 3000, step: 50 }}
          />
          <TextField
            size="small"
            type="number"
            label="Figure height (px)"
            value={figureHeight}
            onChange={(event) => setFigureHeight(Number(event.target.value))}
            inputProps={{ min: 380, max: 1800, step: 20 }}
          />
          <TextField
            size="small"
            type="number"
            label="Font size"
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value))}
            inputProps={{ min: 8, max: 24, step: 1 }}
          />
        </Stack>

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25} sx={{ mb: 1.25 }} flexWrap="wrap" useFlexGap>
          {format === 'pdf' && (
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel id="transect-pdf-quality">PDF quality</InputLabel>
              <Select
                labelId="transect-pdf-quality"
                value={pdfQuality}
                label="PDF quality"
                onChange={(event) => setPdfQuality(event.target.value as PdfQuality)}
              >
                <MenuItem value="standard">Standard</MenuItem>
                <MenuItem value="high">High</MenuItem>
                <MenuItem value="ultra">Ultra</MenuItem>
              </Select>
            </FormControl>
          )}
          <TextField
            size="small"
            type="number"
            label="Colorbar thickness (px)"
            value={colorbarHeightPx}
            onChange={(event) => setColorbarHeightPx(Number(event.target.value))}
            inputProps={{ min: 10, max: 44, step: 1 }}
            sx={{ minWidth: 150 }}
          />
        </Stack>

        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.75, display: 'block' }}>
          Heatmap export includes its colorbar. Metrics export saves one combined figure (`transect-metrics`) with ENL/FHD and CR stacked as shared-x subplots.
          {format === 'pdf'
            ? ' PDF quality sets raster resolution for heatmap and metrics PDFs (PNG/JPG unchanged).'
            : ''}{' '}
          Vertical colorbar sits right of the plot with the same height; thickness controls strip width (heatmap only). Font size applies to axis ticks, axis titles, and legend.
        </Typography>
        {exportError && (
          <Typography variant="caption" color="error.main" sx={{ mb: 0.75, display: 'block' }}>
            {exportError}
          </Typography>
        )}

        <Paper variant="outlined" sx={{ p: 1, bgcolor: '#f8f9fa', overflowX: 'auto' }}>
          <Box sx={{ display: previewPlot === 'heatmap' ? 'block' : 'none' }}>
            <Box
              sx={{
                p: 1,
                bgcolor: '#fff',
                border: '1px solid #e0e0e0',
                display: 'inline-block',
              }}
            >
              <canvas
                ref={setHeatmapCanvasRef}
                style={{
                  display: 'block',
                  maxWidth: '100%',
                  height: 'auto',
                }}
              />
            </Box>
          </Box>
          <Box sx={{ display: previewPlot === 'metrics' ? 'block' : 'none' }}>
            <Box
              ref={metricsPreviewRef}
              sx={{
                width: safeWidth,
                p: 1,
                bgcolor: '#fff',
                border: '1px solid #e0e0e0',
              }}
            >
              <TransectMetricsChart
                samples={samples}
                xAxis={xAxis}
                onXAxisChange={() => {}}
                chartHeight={safeHeight}
                fontSize={safeFontSize}
                showAxisToggle={false}
                mode="both"
              />
            </Box>
          </Box>
        </Paper>

        {/* Off-viewport clone for one-file metrics export (same layout as on-screen preview). */}
        <Box
          aria-hidden
          sx={{
            position: 'fixed',
            left: -12000,
            top: 0,
            pointerEvents: 'none',
            bgcolor: '#fff',
          }}
        >
          <Box
            ref={metricsExportRef}
            sx={{
              width: safeWidth,
              p: 1,
              bgcolor: '#fff',
              border: '1px solid #e0e0e0',
            }}
          >
            <TransectMetricsChart
              samples={samples}
              xAxis={xAxis}
              onXAxisChange={() => {}}
              chartHeight={safeHeight}
              fontSize={safeFontSize}
              showAxisToggle={false}
              mode="both"
            />
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button variant="outlined" onClick={() => handleExportPlot('heatmap')} disabled={isExporting}>
          {isExporting ? 'Exporting...' : `Export heatmap (${format.toUpperCase()})`}
        </Button>
        <Button variant="contained" onClick={() => handleExportPlot('metrics')} disabled={isExporting}>
          {isExporting ? 'Exporting...' : `Export metrics (${format.toUpperCase()})`}
        </Button>
        <Button variant="contained" color="secondary" onClick={exportCurrentMapSnapshot} disabled={isExporting || !map}>
          {isExporting ? 'Exporting...' : `Export map snapshot (${format.toUpperCase()})`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
