import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Box, Paper, Typography, IconButton, CircularProgress, Tooltip,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import CheckIcon from '@mui/icons-material/Check';
import { transform } from 'ol/proj';
import { fetchVerticalProfile } from '../utils/verticalProfile';
import { apiUrl } from '../utils/apiBase';
import { useMapStore } from '../stores/mapStore';

export interface GediPointData {
  coordinate: number[];
  properties: Record<string, any>;
}

interface ProfileResponse {
  success: boolean;
  rh_curve: { rh: number; value: number }[];
  vertical_profile: { z: number; value: number }[];
  fhd: number | null;
  enl1d: number | null;
  enl2d: number | null;
  cr: number | null;
  fhd_interval: number;
}

interface CogProfile {
  rhCurve: { rh: number; value: number }[];
  verticalCurve: { z: number; value: number }[];
  fhd: number | null;
  enl1d: number | null;
  enl2d: number | null;
  cr: number | null;
}

interface GediPointPopupProps {
  data: GediPointData;
  onClose: () => void;
}

function extractRhValues(props: Record<string, any>): { values: number[]; keys: string[] } {
  const values: number[] = [];
  const keys: string[] = [];
  const propKeys = Object.keys(props);
  for (let i = 0; i <= 100; i++) {
    const key = propKeys.find((k) => k === `rh${i}`);
    if (key !== undefined && props[key] != null && isFinite(Number(props[key]))) {
      values.push(Number(props[key]));
      keys.push(key);
    }
  }
  return { values, keys };
}

interface LineSeries {
  data: { [k: string]: number }[];
  color: string;
  label: string;
  dashed?: boolean;
}

interface HoverState {
  mx: number; my: number;
  clientX: number; clientY: number;
  snapped: { seriesIdx: number; dataIdx: number; cx: number; cy: number; xVal: number; yVal: number } | null;
  crossX: number; crossY: number;
  xVal: number; yVal: number;
}

const SNAP_PX = 16;

function SvgLineChart({
  lines, xKey, yKey, xLabel, yLabel, width, height,
  xDomain, yDomain, referenceLine,
}: {
  lines: LineSeries[];
  xKey: string; yKey: string;
  xLabel: string; yLabel: string;
  width: number; height: number;
  xDomain?: [number, number]; yDomain?: [number, number];
  referenceLine?: { axis: 'x' | 'y'; value: number };
}) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const allData = lines.flatMap((l) => l.data);
  if (allData.length === 0) return null;
  const pad = { top: 12, right: 16, bottom: 32, left: 48 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;

  const xs = allData.map((d) => d[xKey]);
  const ys = allData.map((d) => d[yKey]);
  const [xMin, xMax] = xDomain ?? [Math.min(...xs), Math.max(...xs)];
  let [yMin, yMax] = yDomain ?? [Math.min(...ys), Math.max(...ys)];
  if (yMax === yMin) yMax = yMin + 1;
  if (xMax === xMin) return null;

  const scaleX = (v: number) => pad.left + ((v - xMin) / (xMax - xMin)) * w;
  const scaleY = (v: number) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * h;
  const invX = (px: number) => xMin + ((px - pad.left) / w) * (xMax - xMin);
  const invY = (px: number) => yMin + (1 - (px - pad.top) / h) * (yMax - yMin);

  const handleMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = width / rect.width;
    const sy = height / rect.height;
    const mx = (e.clientX - rect.left) * sx;
    const my = (e.clientY - rect.top) * sy;

    if (mx < pad.left || mx > pad.left + w || my < pad.top || my > pad.top + h) {
      setHover(null);
      return;
    }

    let best: HoverState['snapped'] = null;
    let bestDist = SNAP_PX;
    for (let si = 0; si < lines.length; si++) {
      const series = lines[si];
      for (let di = 0; di < series.data.length; di++) {
        const d = series.data[di];
        const cx = scaleX(d[xKey]);
        const cy = scaleY(d[yKey]);
        const dist = Math.hypot(mx - cx, my - cy);
        if (dist < bestDist) {
          bestDist = dist;
          best = { seriesIdx: si, dataIdx: di, cx, cy, xVal: d[xKey], yVal: d[yKey] };
        }
      }
    }

    setHover({
      mx, my, clientX: e.clientX, clientY: e.clientY,
      snapped: best,
      crossX: best ? best.cx : mx,
      crossY: best ? best.cy : my,
      xVal: best ? best.xVal : invX(mx),
      yVal: best ? best.yVal : invY(my),
    });
  }, [lines, xKey, yKey, width, height, w, h, xMin, xMax, yMin, yMax]);

  const xTicks = 5, yTicks = 5;
  const xTickVals = Array.from({ length: xTicks + 1 }, (_, i) => xMin + (i / xTicks) * (xMax - xMin));
  const yTickVals = Array.from({ length: yTicks + 1 }, (_, i) => yMin + (i / yTicks) * (yMax - yMin));

  const fmt = (v: number) => Math.abs(v) >= 100 ? Math.round(v).toString() : v.toFixed(1);

  return (
    <Box sx={{ position: 'relative' }}>
      <svg ref={svgRef} width={width} height={height}
        style={{ display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleMove} onMouseLeave={() => setHover(null)}>
        {yTickVals.map((v, i) => (
          <line key={`yg${i}`} x1={pad.left} x2={pad.left + w} y1={scaleY(v)} y2={scaleY(v)} stroke="#e0e0e0" strokeDasharray="3 3" />
        ))}
        {xTickVals.map((v, i) => (
          <line key={`xg${i}`} x1={scaleX(v)} x2={scaleX(v)} y1={pad.top} y2={pad.top + h} stroke="#e0e0e0" strokeDasharray="3 3" />
        ))}
        {referenceLine && referenceLine.axis === 'y' && (
          <line x1={pad.left} x2={pad.left + w} y1={scaleY(referenceLine.value)} y2={scaleY(referenceLine.value)} stroke="#999" strokeDasharray="4 4" />
        )}
        <line x1={pad.left} x2={pad.left + w} y1={pad.top + h} y2={pad.top + h} stroke="#666" />
        <line x1={pad.left} x2={pad.left} y1={pad.top} y2={pad.top + h} stroke="#666" />
        {xTickVals.map((v, i) => (
          <text key={`xt${i}`} x={scaleX(v)} y={pad.top + h + 14} textAnchor="middle" fontSize={9} fill="#666">{v % 1 === 0 ? v : v.toFixed(1)}</text>
        ))}
        {yTickVals.map((v, i) => (
          <text key={`yt${i}`} x={pad.left - 6} y={scaleY(v) + 3} textAnchor="end" fontSize={9} fill="#666">{v % 1 === 0 ? v : v.toFixed(1)}</text>
        ))}
        <text x={pad.left + w / 2} y={height - 4} textAnchor="middle" fontSize={10} fill="#444">{xLabel}</text>
        <text x={14} y={pad.top + h / 2} textAnchor="middle" fontSize={10} fill="#444" transform={`rotate(-90, 14, ${pad.top + h / 2})`}>{yLabel}</text>
        {lines.map((series, si) => {
          if (series.data.length === 0) return null;
          const pts = series.data.map((d) => `${scaleX(d[xKey]).toFixed(1)},${scaleY(d[yKey]).toFixed(1)}`).join(' ');
          return (
            <polyline key={si} points={pts} fill="none" stroke={series.color} strokeWidth={1.5}
              strokeDasharray={series.dashed ? '6 3' : undefined} />
          );
        })}
        {hover && (
          <g>
            <line x1={hover.crossX} x2={hover.crossX} y1={pad.top} y2={pad.top + h}
              stroke={hover.snapped ? lines[hover.snapped.seriesIdx]?.color ?? '#666' : '#666'}
              strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
            <line x1={pad.left} x2={pad.left + w} y1={hover.crossY} y2={hover.crossY}
              stroke={hover.snapped ? lines[hover.snapped.seriesIdx]?.color ?? '#666' : '#666'}
              strokeWidth={1} strokeDasharray="4 3" opacity={0.5} />
            {hover.snapped && (
              <circle cx={hover.snapped.cx} cy={hover.snapped.cy}
                r={hover.snapped ? 7 : 5}
                fill={lines[hover.snapped.seriesIdx]?.color ?? '#666'}
                fillOpacity={0.3}
                stroke={lines[hover.snapped.seriesIdx]?.color ?? '#666'}
                strokeWidth={2} />
            )}
          </g>
        )}
      </svg>
      {hover && (
        <Paper elevation={6} sx={{
          position: 'fixed',
          left: Math.min(hover.clientX + 14, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 140),
          top: hover.clientY - 60,
          pointerEvents: 'none', zIndex: 2200,
          px: 1.25, py: 0.6, minWidth: 90, border: 1, borderColor: 'divider',
        }}>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ lineHeight: 1.1, mb: 0.25 }}>
            {hover.snapped ? lines[hover.snapped.seriesIdx]?.label ?? '' : 'interpolated'}
          </Typography>
          <Typography variant="body2" fontWeight={600} sx={{ lineHeight: 1.2 }}>
            {xLabel.replace(/ *\(.*/, '')}: {fmt(hover.xVal)}
          </Typography>
          <Typography variant="body2" fontWeight={600} sx={{ lineHeight: 1.2 }}>
            {yLabel.replace(/ *\(.*/, '')}: {fmt(hover.yVal)}
          </Typography>
        </Paper>
      )}
    </Box>
  );
}

function Legend({ items }: { items: { color: string; label: string; dashed?: boolean }[] }) {
  return (
    <Box sx={{ display: 'flex', gap: 2, px: 1, mb: 0.5 }}>
      {items.map((item) => (
        <Box key={item.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <svg width={20} height={10}>
            <line x1={0} y1={5} x2={20} y2={5} stroke={item.color} strokeWidth={2}
              strokeDasharray={item.dashed ? '4 2' : undefined} />
          </svg>
          <Typography variant="caption" color="text.secondary">{item.label}</Typography>
        </Box>
      ))}
    </Box>
  );
}

function DiversityTable({ gedi, cog, interval }: {
  gedi: ProfileResponse;
  cog: CogProfile | null;
  interval: number;
}) {
  const fmt = (v: number | null) => v != null ? v.toFixed(4) : '—';
  const rows = [
    { label: `FHD (${interval}m)`, gedi: gedi.fhd, cog: cog?.fhd ?? null },
    { label: `1D ENL (${interval}m)`, gedi: gedi.enl1d, cog: cog?.enl1d ?? null },
    { label: `2D ENL (${interval}m)`, gedi: gedi.enl2d, cog: cog?.enl2d ?? null },
    { label: 'CR', gedi: gedi.cr, cog: cog?.cr ?? null },
  ];
  return (
    <Box sx={{
      mx: 1, mb: 1, border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden',
    }}>
      <Box sx={{
        display: 'grid', gridTemplateColumns: '1fr 100px 100px',
        bgcolor: 'grey.100', px: 1.5, py: 0.5,
      }}>
        <Typography variant="caption" sx={{ fontWeight: 700 }}>Metric</Typography>
        <Typography variant="caption" sx={{ fontWeight: 700, textAlign: 'right', color: '#1976d2' }}>GEDI</Typography>
        <Typography variant="caption" sx={{ fontWeight: 700, textAlign: 'right', color: '#e65100' }}>COG</Typography>
      </Box>
      {rows.map((row, i) => (
        <Box key={row.label} sx={{
          display: 'grid', gridTemplateColumns: '1fr 100px 100px',
          px: 1.5, py: 0.4,
          borderTop: 1, borderColor: 'divider',
          bgcolor: i % 2 === 1 ? 'grey.50' : 'transparent',
        }}>
          <Typography variant="body2">{row.label}</Typography>
          <Typography variant="body2" sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
            {fmt(row.gedi)}
          </Typography>
          <Typography variant="body2" sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
            {fmt(row.cog)}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

export function GediPointPopup({ data, onClose }: GediPointPopupProps) {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [cogProfile, setCogProfile] = useState<CogProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [cogLoading, setCogLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [justAdded, setJustAdded] = useState(false);
  const vsmYear = useMapStore((s) => s.vsmYear);
  const addSavedGediPoint = useMapStore((s) => s.addSavedGediPoint);
  const savedGediPoints = useMapStore((s) => s.savedGediPoints);
  const { values: rhValues, keys: rhKeys } = extractRhValues(data.properties);

  const [lon, lat] = transform(data.coordinate, 'EPSG:3857', 'EPSG:4326');

  const isAlreadySaved = savedGediPoints.some(
    (p) => Math.abs(p.lon - lon) < 1e-8 && Math.abs(p.lat - lat) < 1e-8,
  );

  const handleAddToList = useCallback(() => {
    if (isAlreadySaved) return;
    addSavedGediPoint({ lon, lat, coordinate: data.coordinate, properties: data.properties });
    setJustAdded(true);
    setTimeout(() => setJustAdded(false), 1500);
  }, [lon, lat, data, addSavedGediPoint, isAlreadySaved]);

  useEffect(() => {
    if (rhValues.length < 3) {
      const keys = Object.keys(data.properties).filter(k => k !== 'geometry').join(', ');
      setError(`Only ${rhValues.length} RH values found. Available keys: ${keys}`);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(apiUrl('/auxiliary/gedi/point-profile'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rh_values: rhValues, fhd_interval: 5 }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        if (!cancelled) setProfile(json);
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? 'Failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    setCogLoading(true);
    setCogProfile(null);
    fetchVerticalProfile(lon, lat, vsmYear).then((res) => {
      if (cancelled) return;
      if (res.success && res.profile) {
        const rhCurve = res.profile
          .filter((p) => p.value != null && !p.missing)
          .map((p) => ({ rh: p.rh, value: p.value as number }));
        const verticalCurve = res.vertical_profile_curve ?? [];
        setCogProfile({
          rhCurve,
          verticalCurve,
          fhd: res.fhd ?? null,
          enl1d: res.enl1d ?? null,
          enl2d: res.enl2d ?? null,
          cr: res.cr ?? null,
        });
      }
      setCogLoading(false);
    }).catch(() => { if (!cancelled) setCogLoading(false); });
    return () => { cancelled = true; };
  }, [lon, lat, vsmYear]);

  const rhMax = rhValues.length > 0 ? Math.max(...rhValues) : 0;
  const gediProfileFiltered = profile?.vertical_profile?.filter(d => d.z >= -20 && d.z <= 50) ?? [];
  const cogCurveFiltered = cogProfile?.verticalCurve?.filter(d => d.z >= -20 && d.z <= 50) ?? [];

  const rhLines: LineSeries[] = [];
  if (profile?.rh_curve) rhLines.push({ data: profile.rh_curve, color: '#1976d2', label: 'GEDI' });
  if (cogProfile?.rhCurve && cogProfile.rhCurve.length > 0) rhLines.push({ data: cogProfile.rhCurve, color: '#e65100', label: 'COG', dashed: true });

  const vpLines: LineSeries[] = [];
  if (gediProfileFiltered.length > 0) vpLines.push({ data: gediProfileFiltered.map(d => ({ z: d.z, value: d.value })), color: '#2e7d32', label: 'GEDI' });
  if (cogCurveFiltered.length > 0) vpLines.push({ data: cogCurveFiltered.map(d => ({ z: d.z, value: d.value })), color: '#e65100', label: 'COG', dashed: true });

  const anyLoading = loading || cogLoading;

  return (
    <Paper elevation={6} sx={{
      position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)',
      zIndex: 1200, width: 720, maxHeight: '70vh', overflow: 'auto', borderRadius: 2,
    }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, pt: 1.5, pb: 0.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>GEDI Point Profile</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="caption" color="text.secondary">
            {lon.toFixed(5)}, {lat.toFixed(5)}
          </Typography>
          <Tooltip title={isAlreadySaved || justAdded ? 'Already saved' : 'Add to saved list'}>
            <span>
              <IconButton
                size="small"
                onClick={handleAddToList}
                disabled={isAlreadySaved}
                color={justAdded ? 'success' : 'default'}
              >
                {justAdded || isAlreadySaved ? <CheckIcon fontSize="small" /> : <PlaylistAddIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
          <IconButton size="small" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
        </Box>
      </Box>

      {anyLoading && !profile && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={28} /></Box>
      )}
      {error && <Typography color="error" sx={{ px: 2, pb: 2 }}>{error}</Typography>}

      {profile && profile.success && (
        <Box sx={{ px: 1.5, pb: 2 }}>
          <Box sx={{ px: 1, mb: 0.5, display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="caption" color="text.secondary">
              RH range: 0–{rhMax.toFixed(1)} m &nbsp;|&nbsp; {rhValues.length} RH values
              {rhKeys.length > 0 && <> &nbsp;|&nbsp; keys: {rhKeys[0]}…{rhKeys[rhKeys.length - 1]}</>}
            </Typography>
            {cogLoading && <CircularProgress size={14} />}
          </Box>

          <DiversityTable gedi={profile} cog={cogProfile} interval={profile.fhd_interval} />

          <Legend items={[
            { color: '#1976d2', label: 'GEDI' },
            { color: '#e65100', label: `COG (${vsmYear})`, dashed: true },
          ]} />

          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="caption" sx={{ fontWeight: 600, pl: 1 }}>RH Curve</Typography>
              <SvgLineChart
                lines={rhLines}
                xKey="rh" yKey="value" xLabel="RH percentile" yLabel="Height (m)"
                width={340} height={220}
                xDomain={[0, 100]}
              />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="caption" sx={{ fontWeight: 600, pl: 1 }}>Vertical Profile (derivative)</Typography>
              <SvgLineChart
                lines={vpLines}
                xKey="value" yKey="z" xLabel="Density" yLabel="Height (m)"
                width={340} height={220}
                yDomain={[-20, 50]}
                referenceLine={{ axis: 'y', value: 0 }}
              />
            </Box>
          </Box>
        </Box>
      )}
    </Paper>
  );
}
