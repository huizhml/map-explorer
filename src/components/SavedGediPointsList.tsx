import { useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Badge,
  Collapse,
  Tooltip,
  Button,
} from '@mui/material';
import ListAltIcon from '@mui/icons-material/ListAlt';
import DeleteIcon from '@mui/icons-material/Delete';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import MyLocationIcon from '@mui/icons-material/MyLocation';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useMapStore, type SavedGediPoint } from '../stores/mapStore';
import { transform } from 'ol/proj';

interface SavedGediPointsListProps {
  onLocatePoint?: (coordinate: number[]) => void;
}

function extractRh98(properties: Record<string, any>): number | null {
  const val = properties.rh98 ?? properties.RH98 ?? properties.rh_98;
  if (val == null || !isFinite(Number(val))) return null;
  return Number(val);
}

export function SavedGediPointsList({ onLocatePoint }: SavedGediPointsListProps) {
  const [expanded, setExpanded] = useState(false);
  const savedGediPoints = useMapStore((s) => s.savedGediPoints);
  const removeSavedGediPoint = useMapStore((s) => s.removeSavedGediPoint);
  const clearSavedGediPoints = useMapStore((s) => s.clearSavedGediPoints);

  const count = savedGediPoints.length;
  if (count === 0) return null;

  const handleCopyAll = async () => {
    const payload = savedGediPoints.map((p) => ({
      lon: p.lon,
      lat: p.lat,
      rh98: extractRh98(p.properties),
      properties: Object.fromEntries(
        Object.entries(p.properties).filter(([k]) => k !== 'geometry'),
      ),
    }));
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch {
      console.warn('Copy failed');
    }
  };

  const handleCopyCsv = async () => {
    if (savedGediPoints.length === 0) return;
    const propKeys = new Set<string>();
    for (const p of savedGediPoints) {
      for (const k of Object.keys(p.properties)) {
        if (k !== 'geometry') propKeys.add(k);
      }
    }
    const cols = ['lon', 'lat', ...Array.from(propKeys).sort()];
    const rows = savedGediPoints.map((p) =>
      cols.map((c) => {
        if (c === 'lon') return p.lon;
        if (c === 'lat') return p.lat;
        const v = p.properties[c];
        return v ?? '';
      }).join(','),
    );
    const csv = [cols.join(','), ...rows].join('\n');
    try {
      await navigator.clipboard.writeText(csv);
    } catch {
      console.warn('Copy failed');
    }
  };

  const handleLocate = (point: SavedGediPoint) => {
    const map = useMapStore.getState().map;
    if (!map) return;
    const coord3857 = transform([point.lon, point.lat], 'EPSG:4326', 'EPSG:3857');
    map.getView().animate({ center: coord3857, zoom: 16, duration: 600 });
    onLocatePoint?.(coord3857);
  };

  return (
    <Paper
      elevation={6}
      sx={{
        position: 'fixed',
        left: 16,
        bottom: 16,
        zIndex: 1100,
        width: expanded ? 380 : 'auto',
        maxHeight: expanded ? '50vh' : 'auto',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width 0.2s ease',
      }}
    >
      {/* Header / toggle */}
      <Box
        sx={{
          px: 1.5,
          py: 0.75,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          '&:hover': { bgcolor: 'primary.dark' },
        }}
        onClick={() => setExpanded((e) => !e)}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Badge badgeContent={count} color="warning" max={999}>
            <ListAltIcon fontSize="small" />
          </Badge>
          <Typography variant="subtitle2" fontWeight={600}>
            Saved GEDI Points
          </Typography>
        </Box>
        {expanded && <ExpandLessIcon fontSize="small" />}
      </Box>

      {/* Expanded list */}
      <Collapse in={expanded}>
        {/* Actions bar */}
        <Box sx={{ px: 1.5, py: 0.5, display: 'flex', gap: 0.5, borderBottom: 1, borderColor: 'divider' }}>
          <Tooltip title="Copy as JSON">
            <IconButton size="small" onClick={handleCopyAll}>
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Copy as CSV">
            <Button size="small" variant="text" onClick={handleCopyCsv} sx={{ minWidth: 0, textTransform: 'none', fontSize: '0.75rem' }}>
              CSV
            </Button>
          </Tooltip>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="Clear all">
            <IconButton size="small" color="error" onClick={clearSavedGediPoints}>
              <DeleteSweepIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        {/* Points */}
        <Box sx={{ maxHeight: 'calc(50vh - 100px)', overflowY: 'auto' }}>
          {savedGediPoints.map((point, idx) => {
            const rh98 = extractRh98(point.properties);
            return (
              <Box
                key={point.id}
                sx={{
                  px: 1.5,
                  py: 0.75,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  borderBottom: 1,
                  borderColor: 'divider',
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                <Typography variant="caption" color="text.secondary" sx={{ width: 20, flexShrink: 0, textAlign: 'right' }}>
                  {idx + 1}
                </Typography>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', fontSize: '0.8rem' }}>
                    {point.lon.toFixed(5)}, {point.lat.toFixed(5)}
                  </Typography>
                  {rh98 != null && (
                    <Typography variant="caption" color="text.secondary">
                      RH98: {rh98.toFixed(1)} m
                    </Typography>
                  )}
                </Box>
                <Tooltip title="Zoom to point">
                  <IconButton size="small" onClick={() => handleLocate(point)}>
                    <MyLocationIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Remove">
                  <IconButton size="small" onClick={() => removeSavedGediPoint(point.id)} color="error">
                    <DeleteIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            );
          })}
        </Box>
      </Collapse>
    </Paper>
  );
}
