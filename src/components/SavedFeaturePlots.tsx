import { useId, useState } from 'react';
import {
  Box,
  Button,
  Paper,
  Typography,
  useTheme,
} from '@mui/material';
import type { Theme } from '@mui/material/styles';
import { LineChart } from '@mui/x-charts';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import { useDrawingArea, useYScale } from '@mui/x-charts/hooks';
import type { SavedFeaturePlotData } from '../services/savedFeaturesApi';
import type { VerticalProfilePoint } from '../stores/mapStore';
import { apiUrl } from '../utils/apiBase';
import { TransectExportDialog } from './TransectExportDialog';
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

function CrBandAnnotations({ refY, fontSize }: { refY: number; fontSize: number }) {
  const theme = useTheme();
  const yScale = useYScale();
  const { left, top, width, height } = useDrawingArea();
  const yRef = yScale(refY);
  if (yRef === undefined) return null;
  const cx = left + width / 2;
  const fill = theme.palette.text.secondary;
  const fs = Math.max(8, fontSize - 1);
  const yTop = top;
  const yBot = top + height;
  const yMidUpper = (yTop + yRef) / 2;
  const yMidLower = (yRef + yBot) / 2;
  return (
    <g pointerEvents="none">
      <text
        x={cx}
        y={yMidUpper}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={fill}
        fontSize={fs}
      >
        More canopy materials from the bottom
      </text>
      <text
        x={cx}
        y={yMidLower}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={fill}
        fontSize={fs}
      >
        More canopy materials from the top
      </text>
    </g>
  );
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

  return (
    <Paper variant="outlined" sx={{ mb: 1, width: '100%', opacity: dimmed ? 0.65 : 1 }}>
      {rows.map((row, idx) => (
        <Box
          key={row.label}
          sx={{
            px: 1.25,
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

export function VerticalProfileCurveChart({
  curve,
  dimmed,
}: {
  curve: Array<{ z: number; value: number }>;
  dimmed?: boolean;
}) {
  const theme = useTheme();
  const validPoints = curve.filter((p) => Number.isFinite(p.z) && Number.isFinite(p.value));
  if (validPoints.length < 2) return null;

  const xExtent = getNumericExtent(validPoints.map((p) => p.value), 0.06, 0.5);
  const yExtent = getNumericExtent(validPoints.map((p) => p.z), 0.03, 1);

  return (
    <Box sx={{ width: '100%', opacity: dimmed ? 0.65 : 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        Derived vertical profile curve
      </Typography>
      <LineChart
        height={CHART_H}
        margin={{ top: 16, right: 20, bottom: 42, left: 56 }}
        grid={{ vertical: true, horizontal: true }}
        xAxis={[{
          data: validPoints.map((p) => p.value),
          scaleType: 'linear',
          min: xExtent.min,
          max: xExtent.max,
          tickNumber: 5,
          label: 'Profile value',
          valueFormatter: (value: number) => value.toFixed(1),
        }]}
        yAxis={[{
          min: yExtent.min,
          max: yExtent.max,
          tickNumber: 5,
          label: 'Height (m)',
          valueFormatter: (value: number) => `${Math.round(value)}`,
        }]}
        series={[{
          id: 'vertical-curve',
          data: validPoints.map((p) => p.z),
          color: theme.palette.success.main,
          label: 'Curve',
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
}) {
  const theme = useTheme();
  const [hovered, setHovered] = useState<{ xIndex: number; rh: number; value: number; clientX: number; clientY: number } | null>(null);
  const [lockedSampleIndex, setLockedSampleIndex] = useState<number | null>(null);
  const cbGradientId = useId().replace(/:/g, '');
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

  const width = svgWidth;
  const height = chartHeight;
  const legacyMarginRight = 6;
  const colorbarGap = 8;
  const colorbarThickness = 18;
  const colorbarLabelReserve = 40;
  /** Space for rotated "Energy (%)" beside numeric ticks */
  const colorbarEnergyReserve = 18;
  const marginRightWithColorbar =
    colorbarGap + colorbarThickness + colorbarLabelReserve + colorbarEnergyReserve;
  const totalWidth = width - legacyMarginRight + marginRightWithColorbar;
  const xCount = Math.max(1, samples.length);
  const yCount = nBins;
  const xTickCount = Math.min(6, xCount);
  const xTicks = Array.from({ length: xTickCount }, (_, i) =>
    Math.round((i * (xCount - 1)) / Math.max(1, xTickCount - 1)));
  /** Y-axis tick marks in meters (0 … maxHm). */
  const desiredYTicks = 5;
  const yTicksMeters = Array.from({ length: desiredYTicks + 1 }, (_, i) =>
    Math.round((i / desiredYTicks) * maxHm));
  const tickLabelFs = Math.max(8, fontSize - 1);
  const yTickNumeralWidthEst =
    Math.max(...yTicksMeters.map((m) => `${m}`.length), 1) * tickLabelFs * 0.56;
  /** Match canvas heatmap: space for rotated "Height (m)" + y numerals + ticks (px). */
  const yTitleHalf = fontSize * 0.58;
  const padSvgLeft = 6;
  const gapTicksToYTitle = 8;
  const tickPadSvg = 6;
  const marginLeftSvg = Math.ceil(
    padSvgLeft + 2 * yTitleHalf + gapTicksToYTitle + yTickNumeralWidthEst + tickPadSvg,
  );
  const margin = { top: 6, right: marginRightWithColorbar, bottom: 28, left: marginLeftSvg };
  const innerW = totalWidth - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const barLeft = margin.left + innerW + colorbarGap;
  const cellW = innerW / xCount;
  const cellH = innerH / yCount;
  const yAxisTitleCx = padSvgLeft + yTitleHalf;
  const activeSampleIndex = lockedSampleIndex ?? hovered?.xIndex ?? null;

  return (
    <Box sx={{ width: '100%', opacity: dimmed ? 0.65 : 1, mb: 1, position: 'relative' }}>
      {/* <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        Heatmap across transect locations ({xAxis === 'lon' ? 'longitude' : 'latitude'}) and height bins (y, 1m).
      </Typography> */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
        {showInteractionHints ? (
          <Typography variant="caption" color="text.secondary">
            Hover cells for details. Click a column to lock, click again to unlock.
          </Typography>
        ) : (
          <Box />
        )}
        {showInteractionHints && lockedSampleIndex != null && (
          <Button
            size="small"
            variant="outlined"
            onClick={() => setLockedSampleIndex(null)}
            sx={{ minWidth: 74, px: 1 }}
          >
            Unlock
          </Button>
        )}
      </Box>
      <Box sx={{ width: '100%', height: chartHeight }}>
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
                  style={{ cursor: 'pointer' }}
                  onMouseMove={showInteractionHints
                    ? (evt) => setHovered({
                      xIndex: p.xIndex,
                      rh: p.rh,
                      value: p.value,
                      clientX: evt.clientX,
                      clientY: evt.clientY,
                    })
                    : undefined}
                  onClick={showInteractionHints
                    ? () => setLockedSampleIndex((prev) => (prev === p.xIndex ? null : p.xIndex))
                    : undefined}
                />
                {showInteractionHints && (
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
                  x2={barLeft + colorbarThickness + 4}
                  y2={ty}
                  stroke="#616161"
                  strokeWidth={1}
                />
                <text
                  x={barLeft + colorbarThickness + 6}
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
            x={barLeft + colorbarThickness + 4 + colorbarLabelReserve + 6 + colorbarEnergyReserve / 2}
            y={margin.top + innerH / 2}
            transform={`rotate(-90 ${barLeft + colorbarThickness + 4 + colorbarLabelReserve + 6 + colorbarEnergyReserve / 2} ${margin.top + innerH / 2})`}
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
      {showInteractionHints && hovered && (
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
}) {
  const theme = useTheme();
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

  return (
    <Box sx={{ width: '100%', opacity: dimmed ? 0.65 : 1 }}>
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
        />
      )}
      {showCr && (
        <Box sx={{ mt: mode === 'both' && hasMainMetrics ? (sparseDualYTicks ? -0.5 : -2) : 0 }}>
          <LineChart
            height={crChartHeight}
            margin={crMargin}
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
            {/* <ChartsReferenceLine
              y={0.74}
              label=""
              lineStyle={{
                stroke: theme.palette.divider,
                strokeWidth: 1.5,
                strokeDasharray: '5 5',
              }}
            />
            <CrBandAnnotations refY={0.74} fontSize={fontSize} /> */}
          </LineChart>
        </Box>
      )}
    </Box>
  );
}

export function SavedFeaturePlots({ plotData }: { plotData?: SavedFeaturePlotData | null }) {
  const diversityHeightBinM = useMapStore((s) => s.diversityHeightBinM);
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
          <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
            Saved images ({imageExports.length})
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1 }}>
            {imageExports.map((img, idx) => {
              const url = img.url ? apiUrl(img.url) : (img.relative_path ? apiUrl(`/saved-features/image/${img.relative_path}`) : '');
              return (
                <Box key={`${img.filename}-${idx}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 0.75 }}>
                  <Typography variant="caption" sx={{ display: 'block', mb: 0.5, color: 'text.secondary' }}>
                    {img.layer_name || img.filename}{img.band_name ? ` - ${img.band_name}` : ''}
                  </Typography>
                  {url && (
                    <Box
                      component="img"
                      src={url}
                      alt={img.filename}
                      sx={{ width: '100%', borderRadius: 1, border: 1, borderColor: 'divider', mb: 0.5 }}
                    />
                  )}
                  {url && (
                    <Button size="small" component="a" href={url} target="_blank" rel="noreferrer" sx={{ px: 0.5, minWidth: 0 }}>
                      Open image
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
          />
          <TransectMetricsChart
            samples={transect.samples}
            xAxis={transectMetricXAxis}
            onXAxisChange={setTransectMetricXAxis}
          />
        </>
      )}
      {transect?.samples && transect.samples.length > 0 && (
        <TransectExportDialog
          open={isExportDialogOpen}
          onClose={() => setIsExportDialogOpen(false)}
          samples={transect.samples}
          totalLengthMeters={transect.total_length_m}
          xAxis={transectMetricXAxis}
          heatmapMaxHeight={transectHeatmapMaxHeight}
          heightBinM={diversityHeightBinM}
        />
      )}
      {hasVerticalMetrics && <VerticalProfileSummary metrics={verticalMetricsData} />}
      {hasNumericVerticalValues && hasVerticalCurve && verticalData && verticalCurveData && (
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 1.5, alignItems: 'flex-start' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <VerticalProfileChart profile={verticalData} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <VerticalProfileCurveChart curve={verticalCurveData} />
          </Box>
        </Box>
      )}
    </Box>
  );
}
