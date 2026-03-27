import React, { useMemo } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import type { Layer } from './LayerControl';

type ColorbarGroup = {
  key: string;
  colormap: string;
  min: number;
  max: number;
  layerNames: string[];
  topZIndex: number;
};

const COLORMAP_GRADIENTS: Record<string, string[]> = {
  inferno: ['#000004', '#420a68', '#932667', '#dd513a', '#fba40a', '#fcffa4'],
  greens: ['#f7fcf5', '#d9f0d3', '#a6dba0', '#5aae61', '#1b7837', '#00441b'],
  ylgn_r: ['#004529', '#238443', '#78c679', '#c2e699', '#ffffcc'],
  rdbu: ['#67001f', '#d6604d', '#f7f7f7', '#4393c3', '#053061'],
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
        <Paper
          key={group.key}
          elevation={3}
          sx={{
            p: 1,
            display: 'flex',
            alignItems: 'stretch',
            gap: 1,
            bgcolor: 'rgba(255,255,255,0.95)',
            backdropFilter: 'blur(2px)',
          }}
        >
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
            <Box>
              <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', lineHeight: 1.2 }}>
                {group.layerNames.length > 1 ? `${group.layerNames.length} layers` : 'Layer'}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{
                  display: 'block',
                  lineHeight: 1.2,
                  wordBreak: 'break-word',
                }}
              >
                {getGroupLabel(group.layerNames)}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, textTransform: 'uppercase' }}>
                {group.colormap}
              </Typography>
            </Box>
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
        </Paper>
      ))}
    </Box>
  );
}
