import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import type { Layer } from './LayerControl';
import { COLORMAP_GRADIENTS } from '../constants/colormaps';
import { CollapsibleLegend } from './CollapsibleLegend';

type ColorbarGroup = {
  key: string;
  colormap: string;
  min: number;
  max: number;
  layerNames: string[];
  topZIndex: number;
};

function getGradient(colormap: string): string {
  const colors = COLORMAP_GRADIENTS[colormap.toLowerCase()];
  if (!colors) {
    return 'linear-gradient(to top, #222 0%, #bbb 50%, #fff 100%)';
  }
  return `linear-gradient(to top, ${colors.join(', ')})`;
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Math.abs(value) >= 100 || Number.isInteger(value)) return value.toString();
  return value.toFixed(2).replace(/\.?0+$/, '');
}

function getGroupLabel(layerNames: string[]): string {
  if (layerNames.length === 1) return layerNames[0];
  if (layerNames.length === 2) return `${layerNames[0]}, ${layerNames[1]}`;
  return `${layerNames[0]} +${layerNames.length - 1} more`;
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

      const key = `${colormap}|${min}|${max}`;
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
        gap: 1,
        pointerEvents: 'none',
        maxWidth: 220,
      }}
    >
      {groups.map((group) => (
        <CollapsibleLegend
          key={group.key}
          title={group.layerNames.length > 1 ? `${group.layerNames.length} layers` : 'Layer'}
          subtitle={
            <Box component="span" sx={{ wordBreak: 'break-word' }}>{getGroupLabel(group.layerNames)}</Box>
          }
          sx={{ maxWidth: 220 }}
        >
          <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 1 }}>
            <Box
              sx={{
                width: 18,
                height: 110,
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'divider',
                background: getGradient(group.colormap),
                flexShrink: 0,
              }}
            />
            <Box sx={{ minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textTransform: 'uppercase' }}>
                {group.colormap}
              </Typography>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <Typography variant="caption" sx={{ lineHeight: 1 }}>
                  {formatValue(group.max)}
                </Typography>
                <Box sx={{ flexGrow: 1 }} />
                <Typography variant="caption" sx={{ lineHeight: 1 }}>
                  {formatValue(group.min)}
                </Typography>
              </Box>
            </Box>
          </Box>
        </CollapsibleLegend>
      ))}
    </Box>
  );
}
