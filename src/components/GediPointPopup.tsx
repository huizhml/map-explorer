import { useEffect, useState } from 'react';
import {
  Box, Paper, Typography, IconButton, CircularProgress,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

export interface GediPointData {
  coordinate: number[];
  properties: Record<string, any>;
}

interface ProfileResponse {
  success: boolean;
  rh_curve: { rh: number; value: number }[];
  vertical_profile: { z: number; value: number }[];
  fhd: number | null;
  fhd_interval: number;
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

// Minimal SVG line chart (zero external dependencies)
function SvgLineChart({
  data, xKey, yKey, xLabel, yLabel, color, width, height,
  xDomain, yDomain, reversed, referenceLine,
}: {
  data: { [k: string]: number }[];
  xKey: string; yKey: string;
  xLabel: string; yLabel: string;
  color: string; width: number; height: number;
  xDomain?: [number, number]; yDomain?: [number, number];
  reversed?: boolean;
  referenceLine?: { axis: 'x' | 'y'; value: number };
}) {
  if (data.length === 0) return null;
  const pad = { top: 12, right: 16, bottom: 32, left: 48 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;

  const xs = data.map((d) => d[xKey]);
  const ys = data.map((d) => d[yKey]);
  const [xMin, xMax] = xDomain ?? [Math.min(...xs), Math.max(...xs)];
  let [yMin, yMax] = yDomain ?? [Math.min(...ys), Math.max(...ys)];
  if (yMax === yMin) yMax = yMin + 1;
  if (xMax === xMin) return null;

  const scaleX = (v: number) => pad.left + ((v - xMin) / (xMax - xMin)) * w;
  const scaleY = (v: number) => {
    const ratio = (v - yMin) / (yMax - yMin);
    return reversed ? pad.top + ratio * h : pad.top + (1 - ratio) * h;
  };

  const pts = data.map((d) => `${scaleX(d[xKey]).toFixed(1)},${scaleY(d[yKey]).toFixed(1)}`).join(' ');

  const xTicks = 5, yTicks = 5;
  const xTickVals = Array.from({ length: xTicks + 1 }, (_, i) => xMin + (i / xTicks) * (xMax - xMin));
  const yTickVals = Array.from({ length: yTicks + 1 }, (_, i) => yMin + (i / yTicks) * (yMax - yMin));

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {/* Grid */}
      {yTickVals.map((v, i) => (
        <line key={`yg${i}`} x1={pad.left} x2={pad.left + w} y1={scaleY(v)} y2={scaleY(v)} stroke="#e0e0e0" strokeDasharray="3 3" />
      ))}
      {xTickVals.map((v, i) => (
        <line key={`xg${i}`} x1={scaleX(v)} x2={scaleX(v)} y1={pad.top} y2={pad.top + h} stroke="#e0e0e0" strokeDasharray="3 3" />
      ))}
      {/* Reference line */}
      {referenceLine && referenceLine.axis === 'y' && (
        <line x1={pad.left} x2={pad.left + w} y1={scaleY(referenceLine.value)} y2={scaleY(referenceLine.value)} stroke="#999" strokeDasharray="4 4" />
      )}
      {/* Axes */}
      <line x1={pad.left} x2={pad.left + w} y1={pad.top + h} y2={pad.top + h} stroke="#666" />
      <line x1={pad.left} x2={pad.left} y1={pad.top} y2={pad.top + h} stroke="#666" />
      {/* X ticks */}
      {xTickVals.map((v, i) => (
        <text key={`xt${i}`} x={scaleX(v)} y={pad.top + h + 14} textAnchor="middle" fontSize={9} fill="#666">{v % 1 === 0 ? v : v.toFixed(1)}</text>
      ))}
      {/* Y ticks */}
      {yTickVals.map((v, i) => (
        <text key={`yt${i}`} x={pad.left - 6} y={scaleY(v) + 3} textAnchor="end" fontSize={9} fill="#666">{v % 1 === 0 ? v : v.toFixed(1)}</text>
      ))}
      {/* Labels */}
      <text x={pad.left + w / 2} y={height - 4} textAnchor="middle" fontSize={10} fill="#444">{xLabel}</text>
      <text x={14} y={pad.top + h / 2} textAnchor="middle" fontSize={10} fill="#444" transform={`rotate(-90, 14, ${pad.top + h / 2})`}>{yLabel}</text>
      {/* Line */}
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

export function GediPointPopup({ data, onClose }: GediPointPopupProps) {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { values: rhValues, keys: rhKeys } = extractRhValues(data.properties);

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
        const resp = await fetch('http://localhost:8000/auxiliary/gedi/point-profile', {
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

  const rhMax = rhValues.length > 0 ? Math.max(...rhValues) : 0;
  const profileFiltered = profile?.vertical_profile?.filter(d => d.z >= -20 && d.z <= 50) ?? [];

  return (
    <Paper elevation={6} sx={{
      position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)',
      zIndex: 1200, width: 720, maxHeight: '70vh', overflow: 'auto', borderRadius: 2,
    }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, pt: 1.5, pb: 0.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>GEDI Point Profile</Typography>
        <IconButton size="small" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
      </Box>

      {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={28} /></Box>}
      {error && <Typography color="error" sx={{ px: 2, pb: 2 }}>{error}</Typography>}

      {profile && profile.success && (
        <Box sx={{ px: 1.5, pb: 2 }}>
          <Box sx={{ px: 1, mb: 1, display: 'flex', gap: 2, alignItems: 'center' }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              FHD (interval={profile.fhd_interval}m): {profile.fhd != null ? profile.fhd.toFixed(4) : 'N/A'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              RH range: 0–{rhMax.toFixed(1)} m &nbsp;|&nbsp; {rhValues.length} RH values
              {rhKeys.length > 0 && <> &nbsp;|&nbsp; keys: {rhKeys[0]}…{rhKeys[rhKeys.length - 1]}</>}
            </Typography>
          </Box>

          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="caption" sx={{ fontWeight: 600, pl: 1 }}>RH Curve</Typography>
              <SvgLineChart
                data={profile.rh_curve}
                xKey="rh" yKey="value" xLabel="RH percentile" yLabel="Height (m)"
                color="#1976d2" width={340} height={220}
                xDomain={[0, 100]}
              />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="caption" sx={{ fontWeight: 600, pl: 1 }}>Vertical Profile (derivative)</Typography>
              <SvgLineChart
                data={profileFiltered.map(d => ({ z: d.z, value: d.value }))}
                xKey="value" yKey="z" xLabel="Density" yLabel="Height (m)"
                color="#2e7d32" width={340} height={220}
                yDomain={[-20, 50]} reversed
                referenceLine={{ axis: 'y', value: 0 }}
              />
            </Box>
          </Box>
        </Box>
      )}
    </Paper>
  );
}
