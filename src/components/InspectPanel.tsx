import { useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  CircularProgress,
  Button,
  useTheme,
} from '@mui/material';
import { Close as CloseIcon, ContentCopy as CopyIcon } from '@mui/icons-material';
import type { InspectPanelState, VerticalProfilePoint } from '../stores/mapStore';

/** TiTiler /cog/point returns { coordinates, values, band_names } — user wants values only */
function formatPixelValuesOnly(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.values)) return null;
  return (o.values as unknown[])
    .map((x) => (x === null || x === undefined ? '—' : String(x)))
    .join(', ');
}

function formatValueFallback(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

const CHART_W = 380;
const CHART_H = 260;
const SNAP_PX = 14;
const MAX_HEIGHT = 100;

function computeFhd(rhsValues: number[], interval: number): number | null {
  const finiteValues = rhsValues.filter((v) => Number.isFinite(v));
  if (finiteValues.length === 0 || interval <= 0) return null;

  const nBins = Math.floor(MAX_HEIGHT / interval);
  if (nBins <= 0) return null;

  const hist = new Array<number>(nBins).fill(0);
  for (const rh of finiteValues) {
    if (rh < 0 || rh > MAX_HEIGHT) continue;
    const idx = Math.min(nBins - 1, Math.floor(rh / interval));
    hist[idx] += 1;
  }

  const total = hist.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;

  let fhd = 0;
  for (const count of hist) {
    if (count <= 0) continue;
    const p = count / total;
    fhd -= p * Math.log(p);
  }
  return fhd;
}

function getRhValue(profile: VerticalProfilePoint[], rhTarget: number): number | null {
  const point = profile.find((p) => p.rh === rhTarget);
  if (!point || point.missing || point.value == null || !Number.isFinite(point.value)) return null;
  return point.value;
}

function VerticalProfileSummary({ profile, dimmed }: { profile: VerticalProfilePoint[]; dimmed?: boolean }) {
  const rh98 = getRhValue(profile, 98);
  const rh25 = getRhValue(profile, 25);

  const canopyRatio =
    rh98 != null && rh25 != null && rh98 !== 0 ? (rh98 - rh25) / rh98 : null;

  const rhsValues = profile
    .filter((p) => p.value != null && !p.missing)
    .map((p) => p.value as number);
  const fhd5 = computeFhd(rhsValues, 5);
  const fhd10 = computeFhd(rhsValues, 10);

  const formatMetric = (v: number | null, digits = 3) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits));
  const rows = [
    { label: 'Canopy ratio (RH98 - RH25) / RH98', value: formatMetric(canopyRatio) },
    { label: 'FHD (5m interval)', value: formatMetric(fhd5) },
    { label: 'FHD (10m interval)', value: formatMetric(fhd10) },
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

function VerticalProfileChart({
  profile,
  dimmed,
}: {
  profile: VerticalProfilePoint[];
  dimmed?: boolean;
}) {
  const theme = useTheme();
  const stroke = theme.palette.primary.main;
  const fill = theme.palette.primary.dark;
  const snapRing = theme.palette.warning.main;
  const margin = { t: 12, r: 12, b: 34, l: 48 };
  const iw = CHART_W - margin.l - margin.r;
  const ih = CHART_H - margin.t - margin.b;

  const [hover, setHover] = useState<{
    clientX: number;
    clientY: number;
    line1: string;
    line2: string;
    snap: boolean;
    crossMx: number;
    crossVy: number | null;
    activeRh: number | null;
  } | null>(null);

  const values = profile
    .filter((p) => p.value != null && !p.missing)
    .map((p) => p.value as number);
  if (values.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', py: 1 }}>
        No numeric values to plot (missing files or nodata).
      </Typography>
    );
  }

  let vmin = Math.min(...values);
  let vmax = Math.max(...values);
  if (vmin === vmax) {
    vmin -= Math.max(Math.abs(vmin) * 0.15, 10);
    vmax += Math.max(Math.abs(vmax) * 0.15, 10);
  }
  const pad = (vmax - vmin) * 0.06 || 15;
  vmin -= pad;
  vmax += pad;

  // Swapped axes: X = RH (%), Y = value.
  const xPx = (rh: number) => margin.l + (rh / 100) * iw;
  const yPx = (v: number) => margin.t + ih - ((v - vmin) / (vmax - vmin || 1)) * ih;

  const interpAtRh = (rh: number): number | null => {
    const r = Math.max(0, Math.min(100, rh));
    let lo = -1;
    let vlo: number | null = null;
    for (let i = Math.floor(r); i >= 0; i--) {
      const p = profile[i];
      if (p?.value != null && !p.missing) {
        lo = i;
        vlo = p.value;
        break;
      }
    }
    let hi = 101;
    let vhi: number | null = null;
    for (let i = Math.ceil(r); i <= 100; i++) {
      const p = profile[i];
      if (p?.value != null && !p.missing) {
        hi = i;
        vhi = p.value;
        break;
      }
    }
    if (vlo == null && vhi == null) return null;
    if (vlo == null) return vhi;
    if (vhi == null) return vlo;
    if (lo === hi) return vlo;
    return vlo + ((r - lo) / (hi - lo)) * (vhi - vlo);
  };

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const sx = CHART_W / rect.width;
    const mx = (e.clientX - rect.left) * sx;
    const my = (e.clientY - rect.top) * (CHART_H / rect.height);

    if (mx < margin.l || mx > margin.l + iw || my < margin.t || my > margin.t + ih) {
      setHover(null);
      return;
    }

    let best: { rh: number; value: number; cx: number; cy: number } | null = null;
    let bestD = SNAP_PX;
    for (const p of profile) {
      if (p.value == null || p.missing) continue;
      const cx = xPx(p.rh);
      const cy = yPx(p.value);
      const d = Math.hypot(mx - cx, my - cy);
      if (d < bestD) {
        bestD = d;
        best = { rh: p.rh, value: p.value, cx, cy };
      }
    }

    if (best) {
      setHover({
        clientX: e.clientX,
        clientY: e.clientY,
        line1: `RH ${best.rh}`,
        line2: String(Math.round(best.value)),
        snap: true,
        crossMx: best.cx,
        crossVy: best.cy,
        activeRh: best.rh,
      });
      return;
    }

    const rh = ((mx - margin.l) / iw) * 100;
    const v = interpAtRh(rh);
    setHover({
      clientX: e.clientX,
      clientY: e.clientY,
      line1: `RH ${rh.toFixed(1)}`,
      line2: v != null ? String(Math.round(v)) : "—",
      snap: false,
      crossMx: xPx(Math.max(0, Math.min(100, rh))),
      crossVy: v != null ? yPx(v) : my,
      activeRh: null,
    });
  };

  const paths: string[] = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (a.value != null && !a.missing && b.value != null && !b.missing) {
      paths.push(`M${xPx(a.rh)} ${yPx(a.value)}L${xPx(b.rh)} ${yPx(b.value)}`);
    }
  }

  const xTicks = [0, 25, 50, 75, 100];
  const yTicks: number[] = [];
  for (let i = 0; i <= 4; i++) {
    yTicks.push(vmin + (i / 4) * (vmax - vmin));
  }

  const tipLeft =
    hover != null ? Math.min(hover.clientX + 12, (typeof window !== "undefined" ? window.innerWidth : 9999) - 128) : 0;

  return (
    <Box sx={{ position: "relative", width: "100%", opacity: dimmed ? 0.65 : 1, mb: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
        Hover or drag: crosshair + tooltip · snap near a sample point
      </Typography>
      <svg
        width="100%"
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        style={{ display: "block", cursor: "crosshair" }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
        aria-label="Interactive vertical profile"
      >
        <rect
          x={margin.l}
          y={margin.t}
          width={iw}
          height={ih}
          fill={theme.palette.action.hover}
          rx={4}
        />
        {xTicks.map((rh, i) => {
          const x = xPx(rh);
          return (
            <g key={i}>
              <line
                x1={x}
                y1={margin.t}
                x2={x}
                y2={margin.t + ih}
                stroke={theme.palette.divider}
                strokeWidth={0.5}
                strokeDasharray="2 3"
              />
              <text
                x={x}
                y={CHART_H - 8}
                textAnchor="middle"
                fontSize={9}
                fill={theme.palette.text.secondary}
              >
                {rh}
              </text>
            </g>
          );
        })}
        {paths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
        ))}
        {profile.map((p) =>
          p.value != null && !p.missing ? (
            <circle
              key={p.rh}
              cx={xPx(p.rh)}
              cy={yPx(p.value)}
              r={hover?.activeRh === p.rh ? 4 : 2.5}
              fill={hover?.activeRh === p.rh ? snapRing : fill}
            />
          ) : null,
        )}
        <line
          x1={margin.l}
          y1={margin.t + ih}
          x2={margin.l + iw}
          y2={margin.t + ih}
          stroke={theme.palette.text.secondary}
          strokeWidth={1}
        />
        <line
          x1={margin.l}
          y1={margin.t}
          x2={margin.l}
          y2={margin.t + ih}
          stroke={theme.palette.text.secondary}
          strokeWidth={1}
        />
        {yTicks.map((yv) => (
          <text
            key={yv}
            x={margin.l - 6}
            y={yPx(yv) + 3}
            textAnchor="end"
            fontSize={10}
            fill={theme.palette.text.secondary}
          >
            {Math.round(yv)}
          </text>
        ))}
        <text
          x={margin.l + iw / 2}
          y={CHART_H - 2}
          textAnchor="middle"
          fontSize={10}
          fill={theme.palette.text.secondary}
        >
          RH (%)
        </text>
        <text
          x={12}
          y={margin.t + ih / 2}
          textAnchor="middle"
          fontSize={10}
          fill={theme.palette.text.secondary}
          transform={`rotate(-90, 12, ${margin.t + ih / 2})`}
        >
          Value
        </text>
        {hover && (
          <g pointerEvents="none">
            <line
              x1={hover.crossMx}
              y1={margin.t}
              x2={hover.crossMx}
              y2={margin.t + ih}
              stroke={stroke}
              strokeWidth={1}
              strokeDasharray="5 4"
              opacity={0.85}
            />
            {hover.crossVy != null && (
              <line
                x1={margin.l}
                y1={hover.crossVy}
                x2={margin.l + iw}
                y2={hover.crossVy}
                stroke={stroke}
                strokeWidth={1}
                strokeDasharray="5 4"
                opacity={0.5}
              />
            )}
            {hover.crossVy != null && (
              <circle
                cx={hover.crossMx}
                cy={hover.crossVy}
                r={hover.snap ? 9 : 6}
                fill={hover.snap ? snapRing : stroke}
                fillOpacity={0.35}
                stroke={hover.snap ? snapRing : stroke}
                strokeWidth={2}
              />
            )}
          </g>
        )}
      </svg>
      {hover && (
        <Paper
          elevation={8}
          sx={{
            position: "fixed",
            left: tipLeft,
            top: hover.clientY - 78,
            pointerEvents: "none",
            zIndex: 2000,
            px: 1.25,
            py: 0.75,
            minWidth: 100,
            border: 1,
            borderColor: "divider",
          }}
        >
          <Typography variant="caption" color="text.secondary" display="block" sx={{ lineHeight: 1.2 }}>
            {hover.snap ? "Sample" : "Interpolated"}
          </Typography>
          <Typography variant="body2" fontWeight={700}>
            {hover.line1}
          </Typography>
          <Typography variant="h6" component="div" sx={{ fontWeight: 600, lineHeight: 1.15, mt: 0.25 }}>
            {hover.line2}
          </Typography>
        </Paper>
      )}
    </Box>
  );
}

function VerticalProfileCurveChart({
  curve,
  dimmed,
}: {
  curve: Array<{ z: number; value: number }>;
  dimmed?: boolean;
}) {
  const theme = useTheme();
  const stroke = theme.palette.success.main;
  const snapRing = theme.palette.warning.main;
  const margin = { t: 12, r: 12, b: 34, l: 48 };
  const iw = CHART_W - margin.l - margin.r;
  const ih = CHART_H - margin.t - margin.b;
  const [hover, setHover] = useState<{
    clientX: number;
    clientY: number;
    line1: string;
    line2: string;
    snap: boolean;
    crossMx: number;
    crossVy: number;
    activeZ: number | null;
  } | null>(null);

  if (!curve || curve.length < 2) return null;
  const zVals = curve.map((p) => p.z).filter((v) => Number.isFinite(v));
  const profileVals = curve.map((p) => p.value).filter((v) => Number.isFinite(v));
  if (zVals.length === 0 || profileVals.length === 0) return null;

  const zmin = Math.min(...zVals);
  const zmax = Math.max(...zVals);
  let vmin = Math.min(...profileVals);
  let vmax = Math.max(...profileVals);
  if (vmin === vmax) {
    vmin -= 1;
    vmax += 1;
  }
  const vpad = (vmax - vmin) * 0.06 || 0.5;
  vmin -= vpad;
  vmax += vpad;

  // Swapped axes: X=profile value, Y=height (z).
  const xPx = (v: number) => margin.l + ((v - vmin) / (vmax - vmin || 1)) * iw;
  const yPx = (z: number) => margin.t + ih - ((z - zmin) / (zmax - zmin || 1)) * ih;
  const zFromY = (y: number) => zmin + ((margin.t + ih - y) / ih) * (zmax - zmin);

  const interpAtZ = (z: number): number | null => {
    const clamped = Math.max(zmin, Math.min(zmax, z));
    let lo: { z: number; value: number } | null = null;
    let hi: { z: number; value: number } | null = null;
    for (const p of curve) {
      if (!Number.isFinite(p.value) || !Number.isFinite(p.z)) continue;
      if (p.z <= clamped) lo = p;
      if (p.z >= clamped) {
        hi = p;
        break;
      }
    }
    if (!lo && !hi) return null;
    if (!lo) return hi!.value;
    if (!hi) return lo.value;
    if (hi.z === lo.z) return lo.value;
    return lo.value + ((clamped - lo.z) / (hi.z - lo.z)) * (hi.value - lo.value);
  };

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const sx = CHART_W / rect.width;
    const mx = (e.clientX - rect.left) * sx;
    const my = (e.clientY - rect.top) * (CHART_H / rect.height);

    if (mx < margin.l || mx > margin.l + iw || my < margin.t || my > margin.t + ih) {
      setHover(null);
      return;
    }

    let best: { z: number; value: number; cx: number; cy: number } | null = null;
    let bestD = SNAP_PX;
    for (const p of curve) {
      if (!Number.isFinite(p.value) || !Number.isFinite(p.z)) continue;
      const cx = xPx(p.value);
      const cy = yPx(p.z);
      const d = Math.hypot(mx - cx, my - cy);
      if (d < bestD) {
        bestD = d;
        best = { z: p.z, value: p.value, cx, cy };
      }
    }

    if (best) {
      setHover({
        clientX: e.clientX,
        clientY: e.clientY,
        line1: `Height ${Math.round(best.z)} m`,
        line2: best.value.toFixed(3),
        snap: true,
        crossMx: best.cx,
        crossVy: best.cy,
        activeZ: best.z,
      });
      return;
    }

    const z = zFromY(my);
    const v = interpAtZ(z);
    setHover({
      clientX: e.clientX,
      clientY: e.clientY,
      line1: `Height ${Math.round(z)} m`,
      line2: v != null ? v.toFixed(3) : '—',
      snap: false,
      crossMx: v != null ? xPx(v) : mx,
      crossVy: yPx(z),
      activeZ: null,
    });
  };

  const d = curve
    .filter((p) => Number.isFinite(p.value))
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xPx(p.value)} ${yPx(p.z)}`)
    .join('');

  const xTicks = [0, 1, 2, 3, 4].map((i) => vmin + (i / 4) * (vmax - vmin));
  const yTicks = [0, 1, 2, 3, 4].map((i) => zmin + (i / 4) * (zmax - zmin));
  const tipLeft =
    hover != null ? Math.min(hover.clientX + 12, (typeof window !== "undefined" ? window.innerWidth : 9999) - 140) : 0;

  return (
    <Box sx={{ width: '100%', opacity: dimmed ? 0.65 : 1, position: 'relative' }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        Derived vertical profile curve (interactive)
      </Typography>
      <svg
        width="100%"
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        style={{ display: 'block', cursor: 'crosshair' }}
        aria-label="Derived vertical profile"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <rect x={margin.l} y={margin.t} width={iw} height={ih} fill={theme.palette.action.hover} rx={4} />
        {xTicks.map((xv, i) => {
          const x = xPx(xv);
          return (
            <g key={`x-${i}`}>
              <line x1={x} y1={margin.t} x2={x} y2={margin.t + ih} stroke={theme.palette.divider} strokeWidth={0.5} strokeDasharray="2 3" />
              <text x={x} y={CHART_H - 8} textAnchor="middle" fontSize={9} fill={theme.palette.text.secondary}>
                {xv.toFixed(1)}
              </text>
            </g>
          );
        })}
        {yTicks.map((zv, i) => {
          const y = yPx(zv);
          return (
            <g key={`y-${i}`}>
              <line x1={margin.l} y1={y} x2={margin.l + iw} y2={y} stroke={theme.palette.divider} strokeWidth={0.5} strokeDasharray="2 3" />
              <text x={margin.l - 6} y={y + 3} textAnchor="end" fontSize={9} fill={theme.palette.text.secondary}>
                {Math.round(zv)}
              </text>
            </g>
          );
        })}
        <path d={d} fill="none" stroke={stroke} strokeWidth={2} />
        {curve.map((p) =>
          Number.isFinite(p.value) && Number.isFinite(p.z) ? (
            <circle
              key={`${p.z}-${p.value}`}
              cx={xPx(p.value)}
              cy={yPx(p.z)}
              r={hover?.activeZ === p.z ? 3 : 1.8}
              fill={hover?.activeZ === p.z ? snapRing : stroke}
            />
          ) : null,
        )}
        <line x1={margin.l} y1={margin.t + ih} x2={margin.l + iw} y2={margin.t + ih} stroke={theme.palette.text.secondary} strokeWidth={1} />
        <line x1={margin.l} y1={margin.t} x2={margin.l} y2={margin.t + ih} stroke={theme.palette.text.secondary} strokeWidth={1} />
        {hover && (
          <g pointerEvents="none">
            <line
              x1={hover.crossMx}
              y1={margin.t}
              x2={hover.crossMx}
              y2={margin.t + ih}
              stroke={stroke}
              strokeWidth={1}
              strokeDasharray="5 4"
              opacity={0.85}
            />
            <line
              x1={margin.l}
              y1={hover.crossVy}
              x2={margin.l + iw}
              y2={hover.crossVy}
              stroke={stroke}
              strokeWidth={1}
              strokeDasharray="5 4"
              opacity={0.5}
            />
            <circle
              cx={hover.crossMx}
              cy={hover.crossVy}
              r={hover.snap ? 8 : 6}
              fill={hover.snap ? snapRing : stroke}
              fillOpacity={0.35}
              stroke={hover.snap ? snapRing : stroke}
              strokeWidth={2}
            />
          </g>
        )}
        <text x={margin.l + iw / 2} y={CHART_H - 2} textAnchor="middle" fontSize={10} fill={theme.palette.text.secondary}>
          Profile value
        </text>
        <text
          x={12}
          y={margin.t + ih / 2}
          textAnchor="middle"
          fontSize={10}
          fill={theme.palette.text.secondary}
          transform={`rotate(-90, 12, ${margin.t + ih / 2})`}
        >
          Height (m)
        </text>
      </svg>
      {hover && (
        <Paper
          elevation={8}
          sx={{
            position: 'fixed',
            left: tipLeft,
            top: hover.clientY - 78,
            pointerEvents: 'none',
            zIndex: 2000,
            px: 1.25,
            py: 0.75,
            minWidth: 110,
            border: 1,
            borderColor: 'divider',
          }}
        >
          <Typography variant="caption" color="text.secondary" display="block" sx={{ lineHeight: 1.2 }}>
            {hover.snap ? 'Sample' : 'Interpolated'}
          </Typography>
          <Typography variant="body2" fontWeight={700}>
            {hover.line1}
          </Typography>
          <Typography variant="h6" component="div" sx={{ fontWeight: 600, lineHeight: 1.15, mt: 0.25 }}>
            {hover.line2}
          </Typography>
        </Paper>
      )}
    </Box>
  );
}


interface InspectPanelProps {
  panel: InspectPanelState;
  onClose: () => void;
}

export function InspectPanel({ panel, onClose }: InspectPanelProps) {
  const kind = panel.kind ?? 'layers';
  const {
    lon,
    lat,
    loading,
    layers,
    pendingSample,
    verticalProfile,
    verticalProfileCurve,
    profileMeta,
    inspectError,
  } = panel;

  const hasStaleLayers = Boolean(loading && pendingSample && layers.length > 0);
  const hasStaleVertical = Boolean(
    loading && pendingSample && verticalProfile && verticalProfile.length > 0,
  );
  const showHeaderSpinner =
    kind === 'layers'
      ? loading && layers.length > 0
      : loading && (verticalProfile?.length ?? 0) > 0;

  const handleCopyLayers = async () => {
    const payload = {
      coordinates: { lon, lat },
      layers: layers.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        visible: r.visible,
        ...(r.error ? { error: r.error } : { value: r.value }),
      })),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch {
      console.warn('Copy failed', payload);
    }
  };

  const handleCopyVertical = async () => {
    const payload = {
      coordinates: { lon, lat },
      tile: profileMeta?.tileName,
      year: profileMeta?.year,
      q_index: profileMeta?.qIndex,
      source: profileMeta?.source,
      profile: verticalProfile,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch {
      console.warn('Copy failed', payload);
    }
  };

  const isVertical = kind === 'vertical_profile';
  const verticalLoadingFirst = isVertical && loading && !(verticalProfile?.length ?? 0);
  const sourceLabel =
    profileMeta?.source === 'original'
      ? 'original'
      : profileMeta?.source === 'blended'
        ? 'blended'
        : profileMeta?.source || '';
  const hasNumericVerticalValues = Boolean(
    verticalProfile?.some((p) => p.value != null && !p.missing && Number.isFinite(p.value)),
  );
  const hasVerticalCurve = Boolean(verticalProfileCurve && verticalProfileCurve.length > 0);
  const showVerticalSummaryAndPlots = Boolean(
    verticalProfile && verticalProfile.length > 0 && hasNumericVerticalValues && hasVerticalCurve,
  );

  return (
    <Paper
      elevation={8}
      sx={{
        position: 'fixed',
        right: 16,
        bottom: 88,
        zIndex: 1100,
        width: isVertical
          ? { xs: 'calc(100% - 32px)', sm: 'min(92vw, 920px)' }
          : { xs: 'calc(100% - 32px)', sm: 380 },
        maxWidth: isVertical ? 920 : 420,
        maxHeight: isVertical ? '52vh' : '45vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          px: 2,
          py: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          bgcolor: 'secondary.dark',
          color: 'secondary.contrastText',
        }}
      >
        <Typography variant="subtitle1" fontWeight={600}>
          {isVertical ? 'Vertical profile (original, Q1)' : 'Inspect point'}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {!loading && isVertical && verticalProfile && verticalProfile.length > 0 && (
            <IconButton
              size="small"
              onClick={handleCopyVertical}
              sx={{ color: 'inherit' }}
              aria-label="Copy profile JSON"
            >
              <CopyIcon fontSize="small" />
            </IconButton>
          )}
          {!loading && !isVertical && layers.length > 0 && (
            <IconButton size="small" onClick={handleCopyLayers} sx={{ color: 'inherit' }} aria-label="Copy JSON">
              <CopyIcon fontSize="small" />
            </IconButton>
          )}
          {showHeaderSpinner && (
            <CircularProgress size={18} sx={{ color: 'secondary.contrastText' }} aria-label="Loading" />
          )}
          <IconButton size="small" onClick={onClose} sx={{ color: 'inherit' }} aria-label="Close">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>

      <Box
        sx={{
          px: 2,
          py: 1.5,
          ...(isVertical
            ? { flex: 1, minHeight: 0, maxHeight: 'calc(52vh - 120px)', overflowY: 'auto' }
            : { height: 300, overflowY: 'auto', flexShrink: 0 }),
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1, flexShrink: 0 }}>
          <strong>Lon</strong> {lon.toFixed(6)}, <strong>Lat</strong> {lat.toFixed(6)}
        </Typography>

        {isVertical && profileMeta?.tileName && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Tile <strong>{profileMeta.tileName}</strong> · {profileMeta.year} · Q{profileMeta.qIndex}
            {sourceLabel && (
              <>
                {' '}
                · <strong>{sourceLabel}</strong>
              </>
            )}
          </Typography>
        )}

        {inspectError && (
          <Typography variant="body2" color="error.main" sx={{ mb: 1 }}>
            {inspectError}
          </Typography>
        )}

        {isVertical ? (
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: verticalLoadingFirst ? 'center' : 'flex-start',
              alignItems: verticalLoadingFirst ? 'center' : 'stretch',
            }}
          >
            {verticalLoadingFirst && (
              <CircularProgress size={32} sx={{ color: 'secondary.main' }} aria-label="Loading" />
            )}
            {showVerticalSummaryAndPlots && (
              <>
                <VerticalProfileSummary profile={verticalProfile!} dimmed={hasStaleVertical} />
                <Box
                  sx={{
                    display: 'flex',
                    flexDirection: { xs: 'column', md: 'row' },
                    gap: 1.5,
                    alignItems: 'flex-start',
                  }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <VerticalProfileChart profile={verticalProfile!} dimmed={hasStaleVertical} />
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <VerticalProfileCurveChart curve={verticalProfileCurve!} dimmed={hasStaleVertical} />
                  </Box>
                </Box>
              </>
            )}
            {verticalProfile && verticalProfile.length > 0 && !showVerticalSummaryAndPlots && !loading && !inspectError && (
              <Typography variant="body2" color="text.secondary">
                Vertical profile metrics and plots are unavailable for this point.
              </Typography>
            )}
            {!loading && !verticalProfile?.length && !inspectError && (
              <Typography variant="body2" color="text.secondary">
                Click the map — loads original RH0–RH100 (Q1) for the selected year.
              </Typography>
            )}
          </Box>
        ) : (
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: loading && layers.length === 0 ? 'center' : 'flex-start',
              alignItems: loading && layers.length === 0 ? 'center' : 'stretch',
            }}
          >
            {loading && layers.length === 0 && (
              <CircularProgress size={32} sx={{ color: 'secondary.main' }} aria-label="Loading" />
            )}

            {!loading && layers.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No raster layers with a COG URL. Add a prediction or COG layer.
              </Typography>
            )}

            {layers.length > 0 &&
              layers.map((row, i) => (
                <Box
                  key={row.id}
                  sx={{
                    opacity: hasStaleLayers ? 0.65 : 1,
                    transition: 'opacity 0.2s ease',
                  }}
                >
                  {i > 0 && <Box sx={{ borderTop: 1, borderColor: 'divider', my: 1 }} />}
                  <Typography variant="subtitle2" color="primary" sx={{ mb: 0.5 }}>
                    {row.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                    {row.type}
                    {!row.visible && (
                      <Typography component="span" color="warning.main" sx={{ ml: 1 }}>
                        hidden
                      </Typography>
                    )}
                    {row.error && (
                      <Typography component="span" color="error.main" sx={{ ml: 1 }}>
                        {row.error}
                      </Typography>
                    )}
                  </Typography>
                  {!row.error && (() => {
                    const pixels = formatPixelValuesOnly(row.value);
                    if (pixels !== null) {
                      return (
                        <Typography
                          variant="h5"
                          component="div"
                          sx={{
                            fontWeight: 600,
                            fontVariantNumeric: 'tabular-nums',
                            color: 'text.primary',
                            letterSpacing: '-0.02em',
                          }}
                        >
                          {pixels}
                        </Typography>
                      );
                    }
                    return (
                      <Typography
                        component="pre"
                        variant="body2"
                        sx={{
                          m: 0,
                          p: 1,
                          bgcolor: 'action.hover',
                          borderRadius: 1,
                          fontSize: '0.75rem',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {formatValueFallback(row.value)}
                      </Typography>
                    );
                  })()}
                </Box>
              ))}
          </Box>
        )}
      </Box>

      <Box sx={{ px: 2, pb: 1.5, pt: 0 }}>
        <Button size="small" onClick={onClose} fullWidth variant="outlined">
          Done
        </Button>
      </Box>
    </Paper>
  );
}
