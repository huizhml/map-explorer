import { useMemo, useState } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { Layer } from './LayerControl';
import { COLORMAP_GRADIENTS } from '../constants/colormaps';

type ColorbarGroup = {
  key: string;
  colormap: string;
  min: number;
  max: number;
  /** Multiplier from raw raster values to the labelled unit. */
  scale: number;
  unit: string;
  layerNames: string[];
  topZIndex: number;
};

function getGradient(colormap: string): string {
  const colors = COLORMAP_GRADIENTS[colormap.toLowerCase()];
  if (!colors) {
    return 'linear-gradient(to right, #222 0%, #bbb 50%, #fff 100%)';
  }
  return `linear-gradient(to right, ${colors.join(', ')})`;
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Math.abs(value) >= 100) return Math.round(value).toString();
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Canopy-height rasters (anything with an RH index) are int16 decimetres, and
 * their rescale bounds are in those raw units; label them in metres. Other
 * prediction-typed layers (canopy ratio, entropy, diversity, ALS/LVIS) keep
 * their raw values with no unit.
 */
const DECIMETRES_TO_M = 0.1;

function getUnit(layer: Layer): { scale: number; unit: string } {
  return Number.isFinite(Number(layer.metadata?.rhIndex))
    ? { scale: DECIMETRES_TO_M, unit: 'm' }
    : { scale: 1, unit: '' };
}

function getGroupLabel(layerNames: string[]): string {
  if (layerNames.length === 1) return layerNames[0];
  if (layerNames.length === 2) return `${layerNames[0]}, ${layerNames[1]}`;
  return `${layerNames[0]} +${layerNames.length - 1} more`;
}

/**
 * One horizontal colorbar: a single-line name row, then a thin gradient with
 * min / mid / max underneath. Clicking the name row hides the bar, leaving
 * just that row on the map.
 */
function CompactColorbar({ group }: { group: ColorbarGroup }) {
  const [open, setOpen] = useState(true);
  const label = getGroupLabel(group.layerNames);
  const mid = (group.min + group.max) / 2;
  return (
    <Paper
      elevation={3}
      sx={{
        pointerEvents: 'auto',
        width: 200,
        px: 1,
        py: 0.5,
        bgcolor: 'rgba(255,255,255,0.92)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <Box
        onClick={() => setOpen((v) => !v)}
        title={`${group.layerNames.join('\n')}\n${group.colormap}`}
        aria-label={open ? 'Collapse colorbar' : 'Expand colorbar'}
        sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'pointer' }}
      >
        <Typography
          variant="caption"
          sx={{ flex: 1, minWidth: 0, lineHeight: 1.4, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {label}
        </Typography>
        {open
          ? <ExpandLessIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
          : <ExpandMoreIcon sx={{ fontSize: 16, color: 'text.secondary' }} />}
      </Box>
      {open && (
        <Box sx={{ mt: 0.25 }}>
          <Box
            sx={{
              height: 8,
              borderRadius: 0.5,
              border: '1px solid',
              borderColor: 'divider',
              background: getGradient(group.colormap),
            }}
          />
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.25 }}>
            {[group.min, mid, group.max].map((v, i) => (
              <Typography key={i} variant="caption" color="text.secondary" sx={{ lineHeight: 1.2, fontSize: 10 }}>
                {formatValue(v * group.scale)}
                {i === 2 && group.unit && ` ${group.unit}`}
              </Typography>
            ))}
          </Box>
        </Box>
      )}
    </Paper>
  );
}

interface MapColorbarOverlayProps {
  layers: Layer[];
}

export function MapColorbarOverlay({ layers }: MapColorbarOverlayProps) {
  const groups = useMemo<ColorbarGroup[]>(() => {
    const grouped = new Map<string, ColorbarGroup>();

    for (const layer of layers) {
      const min = Number(layer.metadata?.rescaleMin);
      const max = Number(layer.metadata?.rescaleMax);
      const colormap = String(layer.metadata?.colormap ?? '').trim();

      if (
        layer.type !== 'prediction' ||
        !layer.visible ||
        !colormap ||
        !Number.isFinite(min) ||
        !Number.isFinite(max)
      ) {
        continue;
      }

      const { scale, unit } = getUnit(layer);
      const key = `${colormap}|${min}|${max}|${unit}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.layerNames.push(layer.name);
        existing.topZIndex = Math.max(existing.topZIndex, layer.zIndex);
        continue;
      }

      grouped.set(key, {
        key,
        colormap,
        min,
        max,
        scale,
        unit,
        layerNames: [layer.name],
        topZIndex: layer.zIndex,
      });
    }

    return [...grouped.values()].sort((a, b) => b.topZIndex - a.topZIndex);
  }, [layers]);

  if (groups.length === 0) return null;

  return (
    <Box
      sx={{
        position: 'absolute',
        right: 20,
        bottom: 84,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.75,
        pointerEvents: 'none',
      }}
    >
      {groups.map((group) => (
        <CompactColorbar key={group.key} group={group} />
      ))}
    </Box>
  );
}
