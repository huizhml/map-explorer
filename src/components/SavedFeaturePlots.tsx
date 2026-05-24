import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Box,
  Button,
  IconButton,
  Paper,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import type { Theme } from '@mui/material/styles';
import { LineChart } from '@mui/x-charts';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import SaveAltIcon from '@mui/icons-material/SaveAlt';
import type { SavedFeaturePlotData } from '../services/savedFeaturesApi';
import type { VerticalProfilePoint, VerticalProfileCurvePoint } from '../stores/mapStore';
import { apiUrl } from '../utils/apiBase';
import { TransectExportDialog } from './TransectExportDialog';
import { VerticalProfileExportDialog } from './VerticalProfileExportDialog';
import { useMapStore } from '../stores/mapStore';
import {
  DEFAULT_DIVERSITY_HEIGHT_BIN_M,
  DEFAULT_HEATMAP_MAX_HEIGHT_M,
  HEATMAP_COLORMAP_MAX,
} from '../constants/diversityMetrics';

const CHART_H = 260;
const HEATMAP_H = 320;
/** MUI y-axis ids for transect metrics (ENL vs FHD use different scales; CR is a separate chart). */
const TRANSECT_Y_ENL = 'transect-enl';
const TRANSECT_Y_FHD = 'transect-fhd';

/** Fallback ENL axis when no ENL samples (e.g. FHD-only transect). */
const TRANSECT_AXIS_ENL_FALLBACK: [number, number] = [1, 50];
const TRANSECT_AXIS_FHD: [number, number] = [0, 4];
const TRANSECT_AXIS_CR: [number, number] = [0, 1];
const TRANSECT_AXIS_CR_HEADROOM = 0.05;
/** CR is [0, 1]; keep several ticks while always including max value `1`. */
const TRANSECT_CR_Y_TICKS = [0, 0.25, 0.5, 0.75, 1] as const;

/**
 * ENL (effective number of layers) y-domain from sample data.
 * A fixed [1, 50] domain forces ticks at ~10…40 while typical values sit near ~6–8,
 * so lines hug the bottom and tick labels miss the data range.
 */
function transectEnlAxisDomain(enlValues: number[]): [number, number] {
  if (enlValues.length === 0) return TRANSECT_AXIS_ENL_FALLBACK;
  const minV = Math.min(...enlValues);
  const maxV = Math.max(...enlValues);
  if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return TRANSECT_AXIS_ENL_FALLBACK;
  const minPad = 0.35;
  const padRatio = 0.12;
  if (minV === maxV) {
    const p = Math.max(minPad, Math.abs(minV) * 0.08);
    const lo = Math.max(1, minV - p);
    const hi = maxV + p;
    return lo < hi ? [lo, hi] : [Math.max(1, minV - 1), maxV + 1];
  }
  const span = maxV - minV;
  const pad = Math.max(span * padRatio, minPad);
  let lo = Math.max(1, minV - pad);
  let hi = maxV + pad;
  if (hi <= lo) hi = lo + 1;
  return [lo, hi];
}

function rampColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const hue = 235 - 175 * clamped;
  const saturation = 86;
  const lightness = 28 + 34 * clamped;
  return `hsl(${hue.toFixed(1)} ${saturation}% ${lightness.toFixed(1)}%)`;
}

function getNumericExtent(values: number[], padRatio = 0.06, fallbackPad = 1) {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= fallbackPad;
    max += fallbackPad;
  }
  const pad = (max - min) * padRatio || fallbackPad;
  return { min: min - pad, max: max + pad };
}

function chartTextStyles(theme: Theme, axisFontSize = 10, labelFontSize = 11) {
  return {
    '& .MuiChartsAxis-tickLabel': {
      fill: theme.palette.text.secondary,
      fontSize: `${axisFontSize}px`,
    },
    '& .MuiChartsAxis-label': {
      fill: theme.palette.text.secondary,
      fontSize: `${labelFontSize}px`,
    },
    '& text.MuiChartsAxis-tickLabel, & .MuiChartsAxis-tickLabel text': {
      fontSize: `${axisFontSize}px`,
    },
    '& .MuiChartsLegend-label': {
      fontSize: `${labelFontSize}px`,
      fill: theme.palette.text.secondary,
    },
  };
}

const TRANSECT_Y_CR = 'transect-cr';

/**
 * Pixel budgets for MUI X Charts axes: tick labels are ellipsized when `width`/`height` is too small
 * (see `ChartsSingleYAxisTicks` / `ChartsSingleXAxisTicks`). Sizes scale with font size.
 */
export function getTransectMetricsAxisLayout(
  fontSize: number,
  opts?: { compact?: boolean },
) {
  const compact = opts?.compact ?? false;
  const tickFs = Math.max(8, fontSize - 1);
  const labelFs = fontSize;
  /**
   * Compact = 2-tick export. MUI measures tick text vs axis `width`/`height`; budgets must scale with
   * **fontSize** (export slider 8–24px) or labels ellipsize / disappear when the user increases font size.
   */
  const estCharPx = tickFs * 0.72;
  /**
   * Compact export: reserve only enough strip for formatted ticks (`toFixed(2)` / `toFixed(3)`).
   * Very wide `width` leaves empty space between tick marks and numerals (MUI lays out inside the band).
   */
  const yLeft = compact
    ? Math.min(
      132,
      Math.max(50, Math.round(26 + estCharPx * 7.5 + labelFs * 0.28)),
    )
    : Math.min(168, Math.max(62, Math.round(50 + tickFs * 3.25)));
  const yRight = compact
    ? Math.min(
      118,
      Math.max(48, Math.round(22 + estCharPx * 5.5 + labelFs * 0.25)),
    )
    : Math.min(168, Math.max(58, Math.round(46 + tickFs * 3.1)));
  const xAxisHeight = compact
    ? Math.min(
      160,
      Math.max(
        52,
        Math.round(28 + tickFs * 2.15 + labelFs * 0.85 + estCharPx * 0.5),
      ),
    )
    : Math.min(140, Math.max(58, Math.round(46 + tickFs * 2.25 + labelFs * 0.4)));
  const margin = compact
    ? {
      top: Math.round(4 + labelFs * 0.22),
      left: Math.max(8, Math.round(6 + labelFs * 0.15)),
      right: Math.max(8, Math.round(6 + labelFs * 0.15)),
      bottom: Math.max(8, Math.round(6 + labelFs * 0.2)),
    }
    : {
      top: Math.round(6 + labelFs * 0.28),
      left: 12,
      right: 12,
      bottom: 10,
    };
  /**
   * HTML legend sits in a grid row above the SVG; avoid large `margin.top` here — it only adds an empty band
   * inside the SVG under the legend. Keep a tiny slack for y-axis / clipping.
   */
  const legendTopForMetricsRow = Math.max(2, Math.round(1 + labelFs * 0.12));
  return { margin, yLeft, yRight, xAxisHeight, tickFs, labelFs, legendTopForMetricsRow };
}

export function VerticalProfileSummary({
  metrics,
  dimmed,
  heightBinM,
  profile,
}: {
  metrics?: {
    fhd?: number | null;
    enl1d?: number | null;
    enl2d?: number | null;
    cr?: number | null;
  };
  dimmed?: boolean;
  /** RH diversity histogram bin width (m); defaults to Tools setting. */
  heightBinM?: number;
  /**
   * Source RH0–RH100 percentile→height samples. Used **only** for the copy
   * button (not the metric rows) so the user can export the raw RH curve
   * that produced these diversity metrics.
   */
  profile?: VerticalProfilePoint[];
}) {
  const storeBinM = useMapStore((s) => s.diversityHeightBinM);
  const binM = heightBinM ?? storeBinM;
  const formatMetric = (v: number | null, digits = 3) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits));
  const rows = [
    { label: `FHD (${binM} m height bins)`, value: formatMetric(metrics?.fhd ?? null) },
    { label: `1D ENL (${binM} m height bins)`, value: formatMetric(metrics?.enl1d ?? null) },
    { label: `2D ENL (${binM} m height bins)`, value: formatMetric(metrics?.enl2d ?? null) },
    { label: 'CR', value: formatMetric(metrics?.cr ?? null) },
  ];

  // Copy the raw RH0–RH100 values as TSV (`RH\tHeight (m)`), one row per
  // integer percentile present in `profile`. Missing / NaN samples are
  // skipped so the clipboard payload only contains real measurements.
  const canCopyRh = Boolean(
    profile?.some((p) => p.value != null && !p.missing && Number.isFinite(p.value)),
  );
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    if (!profile) return;
    const lines = ['RH\tHeight (m)'];
    for (const p of profile) {
      if (p.value == null || p.missing || !Number.isFinite(p.value)) continue;
      lines.push(`${Math.round(p.rh)}\t${(p.value as number).toFixed(4)}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.warn('Copy RH values failed', e);
    }
  }, [profile]);

  return (
    <Paper variant="outlined" sx={{ mb: 1, width: '100%', opacity: dimmed ? 0.65 : 1, position: 'relative' }}>
      {canCopyRh && (
        <Tooltip title={copied ? 'Copied!' : 'Copy RH0–RH100 values (TSV)'} placement="left">
          <IconButton
            size="small"
            onClick={handleCopy}
            aria-label="Copy RH0–RH100 values"
            sx={{
              position: 'absolute',
              top: 2,
              right: 2,
              p: 0.25,
              color: copied ? 'success.main' : 'action.active',
              zIndex: 1,
            }}
          >
            {copied ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 14 }} />}
          </IconButton>
        </Tooltip>
      )}
      {rows.map((row, idx) => (
        <Box
          key={row.label}
          sx={{
            px: 1.25,
            // First row leaves room for the copy button (only when rendered);
            // tabular-nums keeps the value column visually aligned across rows.
            pr: idx === 0 && canCopyRh ? 4 : 1.25,
            py: 0.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: idx < rows.length - 1 ? 1 : 0,
            borderColor: 'divider',
            gap: 1,
          }}
        >
          <Typography variant="body2" color="text.primary">
            {row.label}
          </Typography>
          <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
            {row.value}
          </Typography>
        </Box>
      ))}
    </Paper>
  );
}

export function VerticalProfileChart({
  profile,
  dimmed,
}: {
  profile: VerticalProfilePoint[];
  dimmed?: boolean;
}) {
  const theme = useTheme();
  const validPoints = profile.filter((p) => p.value != null && !p.missing && Number.isFinite(p.value));
  if (validPoints.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', py: 1 }}>
        No numeric values to plot (missing files or nodata).
      </Typography>
    );
  }

  const extent = getNumericExtent(validPoints.map((p) => p.value as number), 0.06, 10);

  return (
    <Box sx={{ width: '100%', opacity: dimmed ? 0.65 : 1, mb: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        Vertical profile by RH bin
      </Typography>
      <LineChart
        height={CHART_H}
        margin={{ top: 16, right: 20, bottom: 42, left: 56 }}
        grid={{ vertical: true, horizontal: true }}
        xAxis={[{
          data: profile.map((p) => p.rh),
          scaleType: 'linear',
          min: 0,
          max: 100,
          tickNumber: 5,
          label: 'RH (%)',
          valueFormatter: (value: number) => `${value}`,
        }]}
        yAxis={[{
          min: extent.min,
          max: extent.max,
          tickNumber: 5,
          label: 'Value',
          valueFormatter: (value: number) => `${Math.round(value)}`,
        }]}
        series={[{
          id: 'vertical-profile',
          data: profile.map((p) => (p.value != null && !p.missing && Number.isFinite(p.value) ? p.value : null)),
          color: theme.palette.primary.main,
          label: 'Profile',
          connectNulls: false,
          showMark: false,
          curve: 'linear',
        }]}
        hideLegend
        disableLineItemHighlight
        skipAnimation
        sx={chartTextStyles(theme)}
      />
    </Box>
  );
}

// On-screen colours kept in sync with the matplotlib export defaults
// (VerticalProfileFigureRequest.bar_color / line_color) so the figure the
// user exports matches what they see.
const VP_BAR_COLOR = '#6b8e5a';
const VP_LINE_COLOR = '#e8632a';
const VP_GROUND_COLOR = '#8a6d4b';

/** ~`count` evenly spaced tick values across [min, max]. */
function linearTicks(min: number, max: number, count: number): number[] {
  if (!(max > min) || count < 2) return [min];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => min + i * step);
}

export function VerticalProfileCurveChart({
  curve,
  dimmed,
  featureName,
  yMin,
  yMax,
}: {
  curve: VerticalProfileCurvePoint[];
  dimmed?: boolean;
  /** Saved-feature display name; used as the export filename stem. */
  featureName?: string;
  /** Fixed y-axis (height) bounds. The curve is pre-trimmed to the data
   *  extent; these add head/foot room. Falls back to the data extent. */
  yMin?: number;
  yMax?: number;
}) {
  const theme = useTheme();
  const [exportOpen, setExportOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(420);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setContainerWidth(Math.round(w));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const validPoints = curve
    .filter((p) => Number.isFinite(p.z) && Number.isFinite(p.value))
    .slice()
    .sort((a, b) => a.z - b.z);
  if (validPoints.length < 2) return null;

  const hasBars = validPoints.every((p) => Number.isFinite(p.binned));

  // Y-axis: fixed bounds when supplied, else pad the data extent. The curve
  // is already trimmed to real data, so a fixed axis leaves visible headroom.
  const yExtent = getNumericExtent(validPoints.map((p) => p.z), 0.03, 1);
  const y0 = Number.isFinite(yMin) ? (yMin as number) : yExtent.min;
  const y1 = Number.isFinite(yMax) ? (yMax as number) : yExtent.max;
  // X-axis: energy %, anchored at 0, headroom over the larger of bar/line.
  const xMaxRaw = Math.max(
    ...validPoints.map((p) => Math.max(p.value, hasBars ? (p.binned as number) : 0)),
  );
  const xMax = xMaxRaw > 0 ? xMaxRaw * 1.06 : 1;

  const W = containerWidth;
  const H = CHART_H;
  const M = { top: 16, right: 16, bottom: 42, left: 52 };
  const pw = Math.max(1, W - M.left - M.right);
  const ph = Math.max(1, H - M.top - M.bottom);
  const span = y1 - y0 || 1;
  const xPx = (e: number) => M.left + (e / xMax) * pw;
  const yPx = (z: number) => M.top + ((y1 - z) / span) * ph;

  // Bar thickness = median Δz between consecutive bins → contiguous bars.
  const dzs = validPoints
    .slice(1)
    .map((p, i) => p.z - validPoints[i].z)
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  const binDz = dzs.length ? dzs[Math.floor(dzs.length / 2)] : 0.4;
  const barPxH = Math.max(1, (binDz / span) * ph);

  const linePath = validPoints
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xPx(p.value).toFixed(1)},${yPx(p.z).toFixed(1)}`)
    .join(' ');

  const yTicks = linearTicks(y0, y1, 6);
  const xTicks = linearTicks(0, xMax, 5);
  const axisColor = theme.palette.text.secondary;
  const gridColor = theme.palette.divider;
  const showGround = y0 <= 0 && y1 >= 0;

  return (
    <Box sx={{ width: '100%', opacity: dimmed ? 0.65 : 1, position: 'relative' }} ref={containerRef}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        Derived vertical profile curve
      </Typography>
      <Tooltip title="Export figure (PNG / PDF / JPG)" placement="left">
        <IconButton
          size="small"
          onClick={() => setExportOpen(true)}
          aria-label="Export vertical profile curve"
          sx={{ position: 'absolute', top: 0, right: 0, p: 0.25, color: 'action.active', zIndex: 1 }}
        >
          <SaveAltIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
      <VerticalProfileExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        curve={validPoints}
        featureName={featureName}
        xLabel="Energy (%)"
        yLabel="Height (m)"
        title="Derived vertical profile curve"
        yMin={Number.isFinite(yMin) ? yMin : undefined}
        yMax={Number.isFinite(yMax) ? yMax : undefined}
      />
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Derived vertical profile curve"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* grid + y ticks */}
        {yTicks.map((zt, i) => {
          const y = yPx(zt);
          return (
            <g key={`y${i}`}>
              <line x1={M.left} y1={y} x2={M.left + pw} y2={y} stroke={gridColor} strokeWidth={0.5} opacity={0.5} />
              <text x={M.left - 6} y={y + 3} textAnchor="end" fontSize={10} fill={axisColor}>
                {Math.round(zt)}
              </text>
            </g>
          );
        })}
        {/* x ticks */}
        {xTicks.map((xt, i) => {
          const x = xPx(xt);
          return (
            <g key={`x${i}`}>
              <line x1={x} y1={M.top} x2={x} y2={M.top + ph} stroke={gridColor} strokeWidth={0.5} opacity={0.35} />
              <text x={x} y={M.top + ph + 14} textAnchor="middle" fontSize={10} fill={axisColor}>
                {xt.toFixed(1)}
              </text>
            </g>
          );
        })}
        {/* binned bars */}
        {hasBars &&
          validPoints.map((p, i) => {
            const bw = (Math.max(0, p.binned as number) / xMax) * pw;
            if (bw <= 0) return null;
            return (
              <rect
                key={`b${i}`}
                x={M.left}
                y={yPx(p.z) - barPxH / 2}
                width={bw}
                height={barPxH}
                fill={VP_BAR_COLOR}
                fillOpacity={0.85}
              />
            );
          })}
        {/* ground reference (z = 0) */}
        {showGround && (
          <line
            x1={M.left}
            y1={yPx(0)}
            x2={M.left + pw}
            y2={yPx(0)}
            stroke={VP_GROUND_COLOR}
            strokeWidth={1.4}
            strokeDasharray="5 4"
          />
        )}
        {/* smoothed line */}
        <path d={linePath} fill="none" stroke={VP_LINE_COLOR} strokeWidth={1.8} />
        {/* axis frame */}
        <line x1={M.left} y1={M.top} x2={M.left} y2={M.top + ph} stroke={axisColor} strokeWidth={1} />
        <line x1={M.left} y1={M.top + ph} x2={M.left + pw} y2={M.top + ph} stroke={axisColor} strokeWidth={1} />
        {/* axis labels */}
        <text
          x={M.left + pw / 2}
          y={H - 4}
          textAnchor="middle"
          fontSize={11}
          fill={axisColor}
        >
          Energy (%)
        </text>
        <text
          x={12}
          y={M.top + ph / 2}
          textAnchor="middle"
          fontSize={11}
          fill={axisColor}
          transform={`rotate(-90 12 ${M.top + ph / 2})`}
        >
          Height (m)
        </text>
        {/* legend */}
        <g transform={`translate(${M.left + pw - 96}, ${M.top + 4})`}>
          {hasBars && (
            <>
              <rect x={0} y={0} width={12} height={9} fill={VP_BAR_COLOR} fillOpacity={0.85} />
              <text x={16} y={8} fontSize={10} fill={axisColor}>
                Binned
              </text>
            </>
          )}
          <line x1={0} y1={hasBars ? 20 : 4} x2={12} y2={hasBars ? 20 : 4} stroke={VP_LINE_COLOR} strokeWidth={2} />
          <text x={16} y={hasBars ? 24 : 8} fontSize={10} fill={axisColor}>
            Smoothed
          </text>
        </g>
      </svg>
    </Box>
  );
}

export function TransectProfileHeatmap({
  samples,
  totalLengthMeters,
  xAxis,
  dimmed,
  chartHeight = HEATMAP_H,
  svgWidth = 860,
  fontSize = 11,
  showInteractionHints = true,
  heatmapMaxHeight,
  heightBinM = DEFAULT_DIVERSITY_HEIGHT_BIN_M,
  /** Column index highlighted from the metrics chart hover (kept in sync with store). */
  metricsHoverIndex,
  /** When hover/lock highlights a column, notifies parent (e.g. map marker along the transect line). */
  onActiveSampleIndexChange,
}: {
  samples: Array<{
    distance_m: number;
    lon: number;
    lat: number;
    profile: VerticalProfilePoint[];
  }>;
  totalLengthMeters?: number;
  xAxis: 'lon' | 'lat';
  dimmed?: boolean;
  chartHeight?: number;
  svgWidth?: number;
  fontSize?: number;
  showInteractionHints?: boolean;
  /** Y-axis top (m) for heatmap only; diversity metrics use the API `max_height` domain separately. */
  heatmapMaxHeight?: number;
  /** Meters per vertical histogram bin (must match API `fhd_interval`). `profile[].rh` is bin index. */
  heightBinM?: number;
  metricsHoverIndex?: number | null;
  onActiveSampleIndexChange?: (sampleColumnIndex: number | null) => void;
}) {
  const theme = useTheme();
  const [hovered, setHovered] = useState<{ xIndex: number; rh: number; value: number; clientX: number; clientY: number } | null>(null);
  const [lockedSampleIndex, setLockedSampleIndex] = useState<number | null>(null);
  // Mouse interactivity (hover tooltips + click-to-lock) is opt-in: off by
  // default so the heatmap reads as a static figure, toggled on via the toolbar
  // button. `showInteractionHints` still gates whether that button even appears
  // (preview/export contexts pass it false to stay fully static).
  const [interactionEnabled, setInteractionEnabled] = useState(false);
  const interactive = showInteractionHints && interactionEnabled;
  const toggleInteraction = () => {
    setInteractionEnabled((prev) => {
      if (prev) {
        // Turning off: drop any transient hover/lock so no highlight lingers.
        setHovered(null);
        setLockedSampleIndex(null);
      }
      return !prev;
    });
  };
  const cbGradientId = useId().replace(/:/g, '');
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(svgWidth);
  useEffect(() => {
    const el = svgContainerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setContainerWidth(Math.round(w));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const points = samples.flatMap((sample, sampleIndex) =>
    sample.profile
      .filter((p) => p.value != null && !p.missing && Number.isFinite(p.value))
      .map((p) => ({
        xIndex: sampleIndex,
        rh: Math.round(p.rh),
        value: p.value as number,
      })),
  );

  if (points.length === 0) {
    return <Typography variant="body2" color="text.secondary">Transect profile values are unavailable.</Typography>;
  }

  const zValues = points.map((p) => p.value);
  const zDataMin = Math.min(...zValues);
  const zScaleMin = zDataMin;
  const zScaleMax = HEATMAP_COLORMAP_MAX;
  const colorDenom = zScaleMax > zScaleMin ? zScaleMax - zScaleMin : 1;

  const formatCoord = (index: number) => {
    const sample = samples[index];
    const coord = sample ? (xAxis === 'lon' ? sample.lon : sample.lat) : NaN;
    return Number.isFinite(coord) ? coord.toFixed(4) : '—';
  };
  const hb = Math.max(1, heightBinM);
  const maxHm = Math.max(1, Math.round(heatmapMaxHeight ?? DEFAULT_HEATMAP_MAX_HEIGHT_M));
  /** Vertical bins; `profile[].rh` is bin index 0 … nBins−1 (histogram), not height in meters. */
  const nBins = Math.max(
    1,
    samples.reduce((acc, s) => Math.max(acc, s.profile?.length ?? 0), 0) || Math.round(maxHm / hb),
  );
  /** Meters per row — derived from domain so labels match the grid even if `heightBinM` prop drifts. */
  const binMeters = maxHm / nBins;

  const formatHeightBin = (rhIndex: number) => {
    const lo = rhIndex * binMeters;
    return `${lo}–${lo + binMeters} m`;
  };

  const height = chartHeight;
  const colorbarGap = 8;
  const colorbarThickness = 18;
  const colorbarLabelReserve = 40;
  const colorbarTickLen = 4;
  const tickLabelFs = Math.max(8, fontSize - 1);
  const tickPadSvg = 6;
  // Derive margins from the same layout function TransectMetricsChart uses so all
  // subplot panels share identical inner-plot left/right boundaries.
  const sharedAxisLayout = getTransectMetricsAxisLayout(fontSize, { compact: false });
  const marginLeft = sharedAxisLayout.margin.left + sharedAxisLayout.yLeft;
  const marginRight = sharedAxisLayout.margin.right + sharedAxisLayout.yRight;
  const totalWidth = containerWidth;
  const xCount = Math.max(1, samples.length);
  const yCount = nBins;
  const xTickCount = Math.min(6, xCount);
  const xTicks = Array.from({ length: xTickCount }, (_, i) =>
    Math.round((i * (xCount - 1)) / Math.max(1, xTickCount - 1)));
  const desiredYTicks = 5;
  const yTicksMeters = Array.from({ length: desiredYTicks + 1 }, (_, i) =>
    Math.round((i / desiredYTicks) * maxHm));
  const margin = { top: 6, right: marginRight, bottom: 28, left: marginLeft };
  const innerW = Math.max(1, totalWidth - margin.left - margin.right);
  const innerH = Math.max(1, height - margin.top - margin.bottom);
  const barLeft = margin.left + innerW + colorbarGap;
  const cellW = innerW / xCount;
  const cellH = innerH / yCount;
  // Y-axis title centered in left margin (midpoint between SVG edge and tick labels).
  const yAxisTitleCx = Math.round(marginLeft / 2);
  // Energy title centered in the remaining right-margin space after the colorbar labels.
  const afterLabelX = barLeft + colorbarThickness + colorbarTickLen + colorbarLabelReserve;
  const energyTitleX = Math.round(afterLabelX + (totalWidth - afterLabelX) / 2);
  const metricsColumn =
    metricsHoverIndex != null &&
    metricsHoverIndex >= 0 &&
    metricsHoverIndex < samples.length
      ? metricsHoverIndex
      : null;
  const activeSampleIndex =
    lockedSampleIndex ?? metricsColumn ?? hovered?.xIndex ?? null;

  useEffect(() => {
    onActiveSampleIndexChange?.(activeSampleIndex);
  }, [activeSampleIndex, onActiveSampleIndexChange]);

  return (
    <Box sx={{ width: '100%', opacity: dimmed ? 0.65 : 1, mb: 1, position: 'relative' }}>
      {/* <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        Heatmap across transect locations ({xAxis === 'lon' ? 'longitude' : 'latitude'}) and height bins (y, 1m).
      </Typography> */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
        {interactive ? (
          <Typography variant="caption" color="text.secondary">
            Hover cells for details. Click a column to lock, click again to unlock.
          </Typography>
        ) : (
          <Box />
        )}
        {showInteractionHints && (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            {interactive && lockedSampleIndex != null && (
              <Button
                size="small"
                variant="outlined"
                onClick={() => setLockedSampleIndex(null)}
                sx={{ minWidth: 74, px: 1 }}
              >
                Unlock
              </Button>
            )}
            <Button
              size="small"
              variant={interactive ? 'contained' : 'outlined'}
              onClick={toggleInteraction}
              sx={{ px: 1 }}
            >
              {interactive ? 'Interactive: on' : 'Enable interactivity'}
            </Button>
          </Box>
        )}
      </Box>
      <Box ref={svgContainerRef} sx={{ width: '100%', height: chartHeight }}>
        <svg
          viewBox={`0 0 ${totalWidth} ${height}`}
          width="100%"
          height={height}
          shapeRendering="auto"
          role="img"
          aria-label="Transect heatmap"
          onMouseLeave={() => setHovered(null)}
        >
          <defs>
            <linearGradient
              id={cbGradientId}
              gradientUnits="userSpaceOnUse"
              x1={barLeft}
              y1={margin.top + innerH}
              x2={barLeft}
              y2={margin.top}
            >
              <stop offset="0%" stopColor={rampColor(0)} />
              <stop offset="25%" stopColor={rampColor(0.25)} />
              <stop offset="50%" stopColor={rampColor(0.5)} />
              <stop offset="75%" stopColor={rampColor(0.75)} />
              <stop offset="100%" stopColor={rampColor(1)} />
            </linearGradient>
          </defs>
          <rect x={margin.left} y={margin.top} width={innerW} height={innerH} fill="#fafafa" />
          {activeSampleIndex != null && (
            <rect
              x={margin.left + activeSampleIndex * cellW}
              y={margin.top}
              width={Math.max(1, cellW)}
              height={innerH}
              fill="rgba(255,255,255,0.18)"
              stroke={theme.palette.primary.main}
              strokeWidth={1}
            />
          )}
          {points.map((p) => {
            const x = margin.left + p.xIndex * cellW;
            const y = margin.top + (nBins - 1 - p.rh) * cellH;
            const t =
              zScaleMin >= zScaleMax
                ? 1
                : Math.max(
                  0,
                  Math.min(1, (Math.min(p.value, zScaleMax) - zScaleMin) / colorDenom),
                );
            const color = rampColor(t);
            const isActiveColumn = activeSampleIndex != null && activeSampleIndex === p.xIndex;
            const isDimmedColumn = activeSampleIndex != null && activeSampleIndex !== p.xIndex;
            return (
              <g key={`${p.xIndex}-${p.rh}`}>
                <rect
                  x={x - 0.2}
                  y={y - 0.2}
                  width={Math.max(1, cellW + 0.4)}
                  height={Math.max(1, cellH + 0.4)}
                  fill={color}
                  opacity={isDimmedColumn ? 0.35 : 1}
                  stroke={isActiveColumn ? theme.palette.primary.main : 'none'}
                  strokeWidth={isActiveColumn ? 0.45 : 0}
                  style={{ cursor: interactive ? 'pointer' : 'default' }}
                  onMouseMove={interactive
                    ? (evt) => setHovered({
                      xIndex: p.xIndex,
                      rh: p.rh,
                      value: p.value,
                      clientX: evt.clientX,
                      clientY: evt.clientY,
                    })
                    : undefined}
                  onClick={interactive
                    ? () => setLockedSampleIndex((prev) => (prev === p.xIndex ? null : p.xIndex))
                    : undefined}
                />
                {interactive && (
                  <title>{`${xAxis === 'lon' ? 'Lon' : 'Lat'} ${formatCoord(p.xIndex)}, Height bin ${formatHeightBin(p.rh)}, Energy ${p.value.toFixed(2)}%`}</title>
                )}
              </g>
            );
          })}
          <line x1={margin.left} y1={margin.top + innerH} x2={margin.left + innerW} y2={margin.top + innerH} stroke="#9e9e9e" strokeWidth="1" />
          <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + innerH} stroke="#9e9e9e" strokeWidth="1" />
          {xTicks.map((idx) => {
            const x = margin.left + (idx + 0.5) * cellW;
            return (
              <g key={`xt-${idx}`}>
                <line x1={x} y1={margin.top + innerH} x2={x} y2={margin.top + innerH + 3} stroke="#9e9e9e" strokeWidth="1" />
                <text x={x} y={height - 5} textAnchor="middle" fontSize={Math.max(8, fontSize - 1)} fill="#616161">
                  {formatCoord(idx)}
                </text>
              </g>
            );
          })}
          {yTicksMeters.map((m) => {
            const y = margin.top + innerH - (m / maxHm) * innerH;
            return (
              <g key={`yt-${m}`}>
                <line x1={margin.left - tickPadSvg + 2} y1={y} x2={margin.left} y2={y} stroke="#9e9e9e" strokeWidth="1" />
                <text x={margin.left - tickPadSvg} y={y + 3} textAnchor="end" fontSize={tickLabelFs} fill="#616161">
                  {m}
                </text>
              </g>
            );
          })}
          <text x={margin.left + innerW / 2} y={height - 2} textAnchor="middle" fontSize={fontSize} fill="#616161">
            {xAxis === 'lon' ? 'Longitude' : 'Latitude'}
          </text>
          <text
            x={yAxisTitleCx}
            y={margin.top + innerH / 2}
            transform={`rotate(-90 ${yAxisTitleCx} ${margin.top + innerH / 2})`}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={fontSize}
            fill="#616161"
          >
            Height (m)
          </text>
          <rect
            x={barLeft}
            y={margin.top}
            width={colorbarThickness}
            height={innerH}
            fill={`url(#${cbGradientId})`}
            stroke={theme.palette.divider}
            strokeWidth={1}
            rx={2}
          />
          {[0, 1].map((i) => {
            const t = i;
            const ty = margin.top + innerH - t * innerH;
            const zAt =
              zScaleMin >= zScaleMax
                ? zScaleMax
                : zScaleMin + t * (zScaleMax - zScaleMin);
            return (
              <g key={`cb-${i}`}>
                <line
                  x1={barLeft + colorbarThickness}
                  y1={ty}
                  x2={barLeft + colorbarThickness + colorbarTickLen}
                  y2={ty}
                  stroke="#616161"
                  strokeWidth={1}
                />
                <text
                  x={barLeft + colorbarThickness + colorbarTickLen + 2}
                  y={ty + 4}
                  fontSize={Math.max(8, fontSize - 1)}
                  fill="#616161"
                >
                  {zAt.toFixed(2)}
                </text>
              </g>
            );
          })}
          <text
            x={energyTitleX}
            y={margin.top + innerH / 2}
            transform={`rotate(-90 ${energyTitleX} ${margin.top + innerH / 2})`}
            textAnchor="middle"
            fontSize={fontSize}
            fill="#616161"
          >
            Energy (%)
          </text>
        </svg>
      </Box>
      {totalLengthMeters != null && Number.isFinite(totalLengthMeters) && (
        <Typography sx={{ fontSize, color: 'text.secondary', textAlign: 'center', display: 'block', mt: 0.75 }}>
          {Math.round(totalLengthMeters)} m total
        </Typography>
      )}
      {interactive && hovered && (
        <Paper
          elevation={6}
          sx={{
            position: 'fixed',
            left: hovered.clientX + 12,
            top: hovered.clientY + 12,
            px: 1,
            py: 0.65,
            pointerEvents: 'none',
            zIndex: 1600,
            bgcolor: 'rgba(20,20,20,0.92)',
            color: '#fff',
          }}
        >
          <Typography sx={{ fontSize: 11, lineHeight: 1.25 }}>
            {xAxis === 'lon' ? 'Lon' : 'Lat'} {formatCoord(hovered.xIndex)}
          </Typography>
          <Typography sx={{ fontSize: 11, lineHeight: 1.25 }}>Height bin {formatHeightBin(hovered.rh)}</Typography>
          <Typography sx={{ fontSize: 11, lineHeight: 1.25 }}>Energy {hovered.value.toFixed(2)}%</Typography>
        </Paper>
      )}
    </Box>
  );
}

export type TransectMetricsChartMode = 'both' | 'main' | 'cr';

/** Map pointer x to the nearest transect sample column (sync with heatmap / map marker). */
function nearestTransectSampleIndexFromPointer(
  clientX: number,
  rect: DOMRect,
  padLeft: number,
  padRight: number,
  xMin: number,
  xMax: number,
  xValues: readonly number[],
): number | null {
  const w = rect.width;
  const innerW = w - padLeft - padRight;
  if (innerW <= 1 || xValues.length === 0) return null;
  const rx = clientX - rect.left;
  const t = (rx - padLeft) / innerW;
  if (t < -0.03 || t > 1.03) return null;
  const clamped = Math.max(0, Math.min(1, t));
  const dataX = xMin + clamped * (xMax - xMin);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < xValues.length; i++) {
    const d = Math.abs(xValues[i] - dataX);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function TransectMetricsChart({
  samples,
  xAxis,
  onXAxisChange,
  dimmed,
  chartHeight = CHART_H,
  fontSize = 11,
  showAxisToggle = true,
  mode = 'both',
  axisTickNumber,
  highlightSampleIndex,
  onHoverSampleIndexChange,
}: {
  samples: Array<{
    lon: number;
    lat: number;
    fhd?: number | null;
    enl1d?: number | null;
    enl2d?: number | null;
    cr?: number | null;
  }>;
  xAxis: 'lon' | 'lat';
  onXAxisChange: (axis: 'lon' | 'lat') => void;
  dimmed?: boolean;
  chartHeight?: number;
  fontSize?: number;
  showAxisToggle?: boolean;
  /** `main` / `cr`: render one panel only (for separate exports). */
  mode?: TransectMetricsChartMode;
  /** When set (e.g. 2 for figure export), reduces X/Y tick density; omit for default chart density. */
  axisTickNumber?: number;
  /** Vertical guide + synced highlight when aligned with heatmap / map (sample index). */
  highlightSampleIndex?: number | null;
  /** Metrics chart hover drives the same sample index as the heatmap (Inspect panel). */
  onHoverSampleIndexChange?: (sampleIndex: number | null) => void;
}) {
  const theme = useTheme();
  const metricsInteractRootRef = useRef<HTMLDivElement>(null);
  const xValues = samples.map((s) => (xAxis === 'lon' ? s.lon : s.lat));
  const enlValues = samples.flatMap((s) => [s.enl1d, s.enl2d].filter((v): v is number => v != null && Number.isFinite(v)));
  const fhdValues = samples.flatMap((s) => [s.fhd].filter((v): v is number => v != null && Number.isFinite(v)));
  const crValues = samples.flatMap((s) => [s.cr].filter((v): v is number => v != null && Number.isFinite(v)));
  const hasMainMetrics = enlValues.length > 0 || fhdValues.length > 0;
  const hasCr = crValues.length > 0;
  const showMain = hasMainMetrics && (mode === 'both' || mode === 'main');
  const showCr = hasCr && (mode === 'both' || mode === 'cr');
  if (xValues.length < 2 || (!showMain && !showCr)) return null;

  const [enlMin, enlMax] = transectEnlAxisDomain(enlValues);
  const [fhdMin, fhdMax] = TRANSECT_AXIS_FHD;
  const [crMin, crMax] = TRANSECT_AXIS_CR;
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  /** Sparse (export) charts: 2 ticks + compact axes; `chartHeight` is the export figure height budget. */
  const sparseDualYTicks = axisTickNumber === 2;

  const axisLayout = getTransectMetricsAxisLayout(fontSize, { compact: sparseDualYTicks });
  const { yLeft, yRight, xAxisHeight, tickFs, labelFs, legendTopForMetricsRow } = axisLayout;

  /**
   * Export (`sparseDualYTicks`): honor `chartHeight` by splitting pixels between title row + stacked charts.
   * (Old `Math.max(198 + …, chartHeight * 0.62)` ignored the user’s figure height whenever the floor won.)
   */
  const titleRowReserve = mode === 'both' ? 40 : 0;
  /** Sparse export: minimal gutter; whitespace was dominated by doubled Y-axis padding on adjacent panels. */
  const betweenChartsGap =
    showMain && showCr && mode === 'both' ? (sparseDualYTicks ? 2 : 8) : 0;
  const chartsBudget = Math.max(
    80,
    chartHeight - titleRowReserve - betweenChartsGap,
  );

  let mainChartHeight: number;
  let crChartHeight: number;
  if (sparseDualYTicks) {
    const W_MAIN = 62;
    const W_CR = 52;
    const W_SUM = W_MAIN + W_CR;
    if (mode === 'both' && showMain && showCr) {
      mainChartHeight = Math.round((chartsBudget * W_MAIN) / W_SUM);
      crChartHeight = Math.round((chartsBudget * W_CR) / W_SUM);
    } else if (mode === 'both' && showMain && !showCr) {
      mainChartHeight = chartsBudget;
      crChartHeight = 0;
    } else if (mode === 'both' && !showMain && showCr) {
      mainChartHeight = 0;
      crChartHeight = chartsBudget;
    } else if (mode === 'main') {
      mainChartHeight = Math.max(100, chartHeight - titleRowReserve);
      crChartHeight = 0;
    } else {
      mainChartHeight = 0;
      crChartHeight = Math.max(100, chartHeight - titleRowReserve);
    }
  } else {
    mainChartHeight =
      mode === 'both'
        ? Math.max(160, Math.round(chartHeight * 0.62))
        : mode === 'main'
          ? chartHeight
          : 160;
    crChartHeight =
      mode === 'both'
        ? Math.max(120, Math.round(chartHeight * 0.52))
        : mode === 'cr'
          ? chartHeight
          : 120;
  }

  /** Ideal vertical SVG padding for endpoint Y labels; clamp per panel so margins never exceed `chartHeight`. */
  const idealSparseYPad = sparseDualYTicks ? Math.round(20 + tickFs * 2.45) : 0;
  const clampSparseYPad = (panelHeight: number) => {
    if (!sparseDualYTicks || panelHeight <= 0) return 0;
    const maxPad = Math.max(4, Math.floor((panelHeight - 56) / 2));
    return Math.min(idealSparseYPad, maxPad);
  };
  const sparseYPadMain = clampSparseYPad(mainChartHeight);
  const sparseYPadCr = clampSparseYPad(crChartHeight);
  /**
   * When main + CR stack, inner edges shared one visual band — full pad on **both** doubled the gap.
   * Outer edges keep full pad (max tick on main top, min tick on CR bottom).
   */
  const stackedSparse = sparseDualYTicks && mode === 'both' && showMain && showCr;
  const sparseJunction =
    stackedSparse
      ? Math.min(
        idealSparseYPad,
        Math.max(8, Math.round(Math.min(mainChartHeight, crChartHeight) * 0.1)),
      )
      : 0;
  /** Bottom X-axis row must grow with fontSize or MUI hides longitude/latitude tick labels. */
  const bottomXAxisHeight = sparseDualYTicks
    ? Math.max(Math.round(34 + fontSize * 1.65), xAxisHeight - 6)
    : Math.max(34, xAxisHeight - 16);
  const axisTickStyle = { fontSize: tickFs, fill: theme.palette.text.secondary };
  const axisLabelStyle = { fontSize: labelFs, fill: theme.palette.text.secondary };
  /** Pull numerals toward tick strokes (narrow axis band + small dx fixes wide gap). */
  const sparseTickDx = sparseDualYTicks ? Math.min(12, Math.max(3, Math.round(tickFs * 0.5))) : 0;
  const axisTickStyleSparseLeft =
    sparseDualYTicks ? { ...axisTickStyle, dx: sparseTickDx as number } : axisTickStyle;
  const axisTickStyleSparseRight =
    sparseDualYTicks ? { ...axisTickStyle, dx: -sparseTickDx as number } : axisTickStyle;
  const tickN = axisTickNumber ?? 5;
  const enlYAxisTicks = sparseDualYTicks
    ? { tickInterval: [enlMin, enlMax] as number[] }
    : { tickNumber: tickN };
  const fhdYAxisTicks = sparseDualYTicks
    ? { tickInterval: [fhdMin, fhdMax] as number[] }
    : { tickNumber: tickN };
  const crYAxisTicks =
    sparseDualYTicks
      ? { tickInterval: [crMin, crMax + TRANSECT_AXIS_CR_HEADROOM] as number[] }
      : axisTickNumber != null
        ? { tickNumber: tickN as number }
        : { tickInterval: [...TRANSECT_CR_Y_TICKS] as number[], tickNumber: 5 as number };

  /** Default `tickLabelInterval` is `'auto'` and drops labels that overlap — cripples 2-tick export when height is small. */
  const sparseYTickLabels = sparseDualYTicks ? { tickLabelInterval: () => true as boolean } : {};
  const sparseXTickLabels = sparseDualYTicks
    ? { tickLabelInterval: () => true as boolean, tickLabelMinGap: 0 }
    : {};
  const mainMargin = {
    ...axisLayout.margin,
    top: axisLayout.margin.top + (showMain ? legendTopForMetricsRow : 0) + sparseYPadMain,
    bottom: axisLayout.margin.bottom + (stackedSparse ? sparseJunction : sparseYPadMain),
  };
  /** Pad right by `yRight` so plot width matches ENL/FHD (dual Y) without drawing a right axis. */
  const crMargin = {
    ...axisLayout.margin,
    right: axisLayout.margin.right + yRight,
    top: axisLayout.margin.top + (stackedSparse ? sparseJunction : sparseYPadCr),
    bottom: axisLayout.margin.bottom + sparseYPadCr,
  };

  const xAxisDef = {
    data: xValues,
    scaleType: 'linear' as const,
    min: xMin,
    max: xMax,
    ...(sparseDualYTicks ? { tickInterval: [xMin, xMax] as number[] } : { tickNumber: tickN }),
    ...sparseXTickLabels,
    label: xAxis === 'lon' ? 'Longitude' : 'Latitude',
    valueFormatter: (value: number) => value.toFixed(4),
    tickLabelStyle: axisTickStyle,
    labelStyle: {
      ...axisLabelStyle,
      transform: sparseDualYTicks ? 'translateY(-4px)' : 'translateY(-14px)',
    },
    height: bottomXAxisHeight,
  };
  const xAxisMain = mode === 'both'
    ? {
      ...xAxisDef,
      tickLabelInterval: () => false,
      label: '',
      height: Math.max(0, Math.round(xAxisHeight * 0.1)),
    }
    : xAxisDef;

  const sxMetrics = chartTextStyles(theme, tickFs, labelFs);
  const sxMetricsSparse = sparseDualYTicks
    ? {
      ...sxMetrics,
      '& .MuiChartsSurface-root': { overflow: 'visible' },
      '& svg': { overflow: 'visible' },
      '& .MuiChartsAxis-tickLabel': {
        overflow: 'visible',
        maxWidth: 'none',
        textOverflow: 'clip',
      },
      '& .MuiChartsAxis-tickLabel text, & .MuiChartsAxis-tickLabel tspan': {
        overflow: 'visible',
        maxWidth: 'none',
        textOverflow: 'clip',
      },
    }
    : sxMetrics;

  const padLeftMetricsHover = showMain
    ? mainMargin.left + yLeft
    : crMargin.left + yLeft;
  const padRightMetricsHover = showMain
    ? mainMargin.right + yRight
    : crMargin.right;

  const refLineIdx =
    highlightSampleIndex != null &&
    highlightSampleIndex >= 0 &&
    highlightSampleIndex < samples.length
      ? highlightSampleIndex
      : null;
  const refLineX = refLineIdx != null ? xValues[refLineIdx] : null;

  const handleMetricsChartMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!onHoverSampleIndexChange || !metricsInteractRootRef.current) return;
    const idx = nearestTransectSampleIndexFromPointer(
      e.clientX,
      metricsInteractRootRef.current.getBoundingClientRect(),
      padLeftMetricsHover,
      padRightMetricsHover,
      xMin,
      xMax,
      xValues,
    );
    onHoverSampleIndexChange(idx);
  };

  const axisHighlightProps = onHoverSampleIndexChange ? { x: 'none' as const } : { x: 'line' as const };

  return (
    <Box
      ref={metricsInteractRootRef}
      onMouseMove={onHoverSampleIndexChange ? handleMetricsChartMouseMove : undefined}
      onMouseLeave={onHoverSampleIndexChange ? () => onHoverSampleIndexChange(null) : undefined}
      sx={{ width: '100%', opacity: dimmed ? 0.65 : 1 }}
    >
      {mode === 'both' && (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5, gap: 1 }}>
          <Typography sx={{ fontSize: '0.9rem', fontWeight: 700, color: 'text.primary' }}>
            Transect metrics by {xAxis === 'lon' ? 'longitude' : 'latitude'}
          </Typography>
          {showAxisToggle && (
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              <Button size="small" variant={xAxis === 'lon' ? 'contained' : 'outlined'} onClick={() => onXAxisChange('lon')} sx={{ minWidth: 56, px: 1 }}>Lon</Button>
              <Button size="small" variant={xAxis === 'lat' ? 'contained' : 'outlined'} onClick={() => onXAxisChange('lat')} sx={{ minWidth: 56, px: 1 }}>Lat</Button>
            </Box>
          )}
        </Box>
      )}
      {showMain && (
        <LineChart
          height={mainChartHeight}
          margin={mainMargin}
          axisHighlight={axisHighlightProps}
          grid={{ vertical: false, horizontal: false }}
          xAxis={[xAxisMain]}
          yAxis={[
            {
              id: TRANSECT_Y_ENL,
              position: 'left',
              width: yLeft,
              min: enlMin,
              max: enlMax,
              ...enlYAxisTicks,
              ...sparseYTickLabels,
              label: 'ENL1D / ENL2D',
              valueFormatter: (value: number) => value.toFixed(2),
              tickLabelStyle: axisTickStyleSparseLeft,
              labelStyle: axisLabelStyle,
            },
            {
              id: TRANSECT_Y_FHD,
              position: 'right',
              width: yRight,
              min: fhdMin,
              max: fhdMax,
              ...fhdYAxisTicks,
              ...sparseYTickLabels,
              label: 'FHD',
              valueFormatter: (value: number) => value.toFixed(2),
              tickLabelStyle: axisTickStyleSparseRight,
              labelStyle: axisLabelStyle,
            },
          ]}
          series={[
            { id: 'fhd', yAxisId: TRANSECT_Y_FHD, label: 'FHD', data: samples.map((s) => s.fhd ?? null), color: '#7b1fa2', showMark: false, curve: 'linear', connectNulls: false },
            { id: 'enl1d', yAxisId: TRANSECT_Y_ENL, label: 'ENL1D', data: samples.map((s) => s.enl1d ?? null), color: '#1565c0', showMark: false, curve: 'linear', connectNulls: false },
            { id: 'enl2d', yAxisId: TRANSECT_Y_ENL, label: 'ENL2D', data: samples.map((s) => s.enl2d ?? null), color: '#2e7d32', showMark: false, curve: 'linear', connectNulls: false },
          ]}
          slotProps={{
            legend: {
              direction: 'horizontal',
              sx: {
                // Default ChartsLegend uses marginBlock/gap theme.spacing(1–2); tighten legend ↔ SVG gap.
                my: 0,
                mx: 0,
                gap: 0.25,
                lineHeight: 1,
                transform: 'translateY(2px)',
                '& .MuiChartsLegend-series': {
                  gap: 0.125,
                },
                '& .MuiChartsLegend-label': {
                  fontSize: `${labelFs}px`,
                  lineHeight: 1.05,
                },
              },
            },
          }}
          disableLineItemHighlight
          skipAnimation
          sx={sxMetricsSparse}
        >
          {refLineX != null && (
            <ChartsReferenceLine
              x={refLineX}
              lineStyle={{
                stroke: theme.palette.primary.main,
                strokeWidth: 1.25,
                strokeDasharray: '4 3',
              }}
            />
          )}
        </LineChart>
      )}
      {showCr && (
        <Box sx={{ mt: mode === 'both' && hasMainMetrics ? (sparseDualYTicks ? -0.5 : -2) : 0 }}>
          <LineChart
            height={crChartHeight}
            margin={crMargin}
            axisHighlight={axisHighlightProps}
            grid={{ vertical: false, horizontal: false }}
            xAxis={[xAxisDef]}
            yAxis={[
              {
                id: TRANSECT_Y_CR,
                position: 'left',
                width: yLeft,
                min: crMin,
                max: crMax + TRANSECT_AXIS_CR_HEADROOM,
                ...crYAxisTicks,
                tickLabelInterval: () => true,
                label: 'CR',
                valueFormatter: (value: number) => value.toFixed(3),
                tickLabelStyle: axisTickStyleSparseLeft,
                labelStyle: axisLabelStyle,
              },
            ]}
            series={[
              {
                id: 'cr',
                yAxisId: TRANSECT_Y_CR,
                label: 'CR',
                data: samples.map((s) => s.cr ?? null),
                color: '#ef6c00',
                showMark: false,
                curve: 'linear',
                connectNulls: false,
              },
            ]}
            hideLegend
            disableLineItemHighlight
            skipAnimation
            sx={sxMetricsSparse}
          >
            {refLineX != null && (
              <ChartsReferenceLine
                x={refLineX}
                lineStyle={{
                  stroke: theme.palette.primary.main,
                  strokeWidth: 1.25,
                  strokeDasharray: '4 3',
                }}
              />
            )}
          </LineChart>
        </Box>
      )}
    </Box>
  );
}

export function SavedFeaturePlots({
  plotData,
  featureName,
}: {
  plotData?: SavedFeaturePlotData | null;
  /** Display name of the saved feature; used as the default export filename. */
  featureName?: string;
}) {
  const diversityHeightBinM = useMapStore((s) => s.diversityHeightBinM);
  const transectHeatmapSampleIndex = useMapStore((s) => s.transectHeatmapSampleIndex);
  const setTransectHeatmapSampleIndex = useMapStore((s) => s.setTransectHeatmapSampleIndex);
  const transectHeatmapLocalRef = useRef<number | null>(null);
  const transectMetricsHoverRef = useRef<number | null>(null);
  const [transectMetricsHoverIdx, setTransectMetricsHoverIdx] = useState<number | null>(null);

  const onSavedTransectHeatmapActiveColumn = useCallback(
    (index: number | null) => {
      transectHeatmapLocalRef.current = index;
      if (transectMetricsHoverRef.current == null) {
        setTransectHeatmapSampleIndex(index);
      }
    },
    [setTransectHeatmapSampleIndex],
  );

  const onSavedTransectMetricsHoverSampleIndex = useCallback(
    (index: number | null) => {
      transectMetricsHoverRef.current = index;
      setTransectMetricsHoverIdx(index);
      if (index == null) {
        setTransectHeatmapSampleIndex(transectHeatmapLocalRef.current);
      } else {
        setTransectHeatmapSampleIndex(index);
      }
    },
    [setTransectHeatmapSampleIndex],
  );

  useEffect(() => {
    return () => setTransectHeatmapSampleIndex(null);
  }, [setTransectHeatmapSampleIndex]);

  const [transectMetricXAxis, setTransectMetricXAxis] = useState<'lon' | 'lat'>('lon');
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  if (!plotData) return null;
  const imageExports = Array.isArray(plotData.image_exports) ? plotData.image_exports : [];

  const transect = plotData.transect;
  const transectHeatmapMaxHeight = transect?.heatmap_max_height ?? DEFAULT_HEATMAP_MAX_HEIGHT_M;
  const activeSample = transect?.samples?.[0];
  const verticalData = transect?.samples?.length ? activeSample?.profile : plotData.vertical_profile;
  const verticalCurveData = transect?.samples?.length ? activeSample?.vertical_profile_curve : plotData.vertical_profile_curve;
  const verticalMetricsData = transect?.samples?.length
    ? {
      fhd: activeSample?.fhd ?? null,
      enl1d: activeSample?.enl1d ?? null,
      enl2d: activeSample?.enl2d ?? null,
      cr: activeSample?.cr ?? null,
    }
    : plotData.profile_metrics;

  const hasNumericVerticalValues = Boolean(verticalData?.some((p) => p.value != null && !p.missing && Number.isFinite(p.value)));
  const hasVerticalMetrics = Boolean(verticalMetricsData && [verticalMetricsData.fhd, verticalMetricsData.enl1d, verticalMetricsData.enl2d, verticalMetricsData.cr].some((v) => v != null && Number.isFinite(v)));
  const hasVerticalCurve = Boolean(verticalCurveData && verticalCurveData.length > 0);

  return (
    <Box sx={{ mt: 1.1 }}>
      {imageExports.length > 0 && (
        <Box sx={{ mb: 1.25 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              Saved images ({imageExports.length})
            </Typography>
            <Button
              size="small"
              variant="outlined"
              onClick={async () => {
                for (const img of imageExports) {
                  const url = img.url
                    ? apiUrl(img.url)
                    : img.relative_path
                      ? apiUrl(`/saved-features/image/${img.relative_path}`)
                      : '';
                  if (!url) continue;
                  try {
                    const resp = await fetch(url);
                    if (!resp.ok) continue;
                    const blob = await resp.blob();
                    const objUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = objUrl;
                    a.download = img.filename || 'image';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(objUrl);
                  } catch {
                    // Skip failures; continue downloading the rest.
                  }
                }
              }}
              sx={{ textTransform: 'none', py: 0, minHeight: 0 }}
            >
              Download all
            </Button>
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1 }}>
            {imageExports.map((img, idx) => {
              const url = img.url ? apiUrl(img.url) : (img.relative_path ? apiUrl(`/saved-features/image/${img.relative_path}`) : '');
              // PDFs can't be displayed in an <img> tag — fall back to an
              // <embed> preview so vector exports still show inline.
              const isPdf = img.mime_type === 'application/pdf'
                || (img.filename || '').toLowerCase().endsWith('.pdf');
              return (
                <Box key={`${img.filename}-${idx}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 0.75 }}>
                  <Typography variant="caption" sx={{ display: 'block', mb: 0.5, color: 'text.secondary' }}>
                    {img.layer_name || img.filename}{img.band_name ? ` - ${img.band_name}` : ''}
                  </Typography>
                  {url && (isPdf ? (
                    <Box
                      component="embed"
                      src={url}
                      type="application/pdf"
                      sx={{ width: '100%', height: 240, borderRadius: 1, border: 1, borderColor: 'divider', mb: 0.5 }}
                    />
                  ) : (
                    <Box
                      component="img"
                      src={url}
                      alt={img.filename}
                      sx={{ width: '100%', borderRadius: 1, border: 1, borderColor: 'divider', mb: 0.5 }}
                    />
                  ))}
                  {url && (
                    <Button size="small" component="a" href={url} target="_blank" rel="noreferrer" sx={{ px: 0.5, minWidth: 0 }}>
                      {isPdf ? 'Open PDF' : 'Open image'}
                    </Button>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      )}
      {transect?.samples && transect.samples.length > 0 && (
        <>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 0.25 }}>
            <Button
              size="small"
              variant="outlined"
              onClick={() => setIsExportDialogOpen(true)}
              sx={{ textTransform: 'none' }}
            >
              Export
            </Button>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
            Sampled locations along line: {transect.samples.length} (auto-extracted every ~10 m).
          </Typography>
          <TransectProfileHeatmap
            samples={transect.samples}
            totalLengthMeters={transect.total_length_m}
            xAxis={transectMetricXAxis}
            heatmapMaxHeight={transectHeatmapMaxHeight}
            heightBinM={diversityHeightBinM}
            metricsHoverIndex={transectMetricsHoverIdx}
            onActiveSampleIndexChange={onSavedTransectHeatmapActiveColumn}
          />
          <TransectMetricsChart
            samples={transect.samples}
            xAxis={transectMetricXAxis}
            onXAxisChange={setTransectMetricXAxis}
            highlightSampleIndex={transectHeatmapSampleIndex}
            onHoverSampleIndexChange={onSavedTransectMetricsHoverSampleIndex}
          />
        </>
      )}
      {transect?.samples && transect.samples.length > 0 && (
        <TransectExportDialog
          open={isExportDialogOpen}
          onClose={() => setIsExportDialogOpen(false)}
          samples={transect.samples}
          lineCoordinates={transect.line_coordinates}
          totalLengthMeters={transect.total_length_m}
          xAxis={transectMetricXAxis}
          heatmapMaxHeight={transectHeatmapMaxHeight}
          heightBinM={diversityHeightBinM}
          featureName={featureName}
        />
      )}
      {hasVerticalMetrics && <VerticalProfileSummary metrics={verticalMetricsData} profile={verticalData} />}
      {hasNumericVerticalValues && hasVerticalCurve && verticalData && verticalCurveData && (
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 1.5, alignItems: 'flex-start' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <VerticalProfileChart profile={verticalData} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <VerticalProfileCurveChart
              curve={verticalCurveData}
              featureName={featureName}
              yMin={plotData.profile_y_min}
              yMax={plotData.profile_y_max}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
