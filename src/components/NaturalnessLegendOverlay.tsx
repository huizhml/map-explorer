import { Box, Paper, Typography } from '@mui/material';
import type { Layer } from './LayerControl';
import { NATURALNESS_MAP_CLASSES, type NaturalnessClass } from '../constants/naturalnessMap';

interface NaturalnessLegendOverlayProps {
  layers: Layer[];
}

export function NaturalnessLegendOverlay({ layers }: NaturalnessLegendOverlayProps) {
  const active = layers
    .filter((l) => l.visible && l.metadata?.layerType === 'naturalness_map')
    .sort((a, b) => b.zIndex - a.zIndex);

  if (active.length === 0) return null;

  const top = active[0];
  const classes = (top.metadata?.naturalnessLegend as NaturalnessClass[]) ?? NATURALNESS_MAP_CLASSES;

  return (
    <Box
      sx={{
        position: 'absolute',
        bottom: 22,
        left: 20,
        zIndex: 1100,
        pointerEvents: 'none',
      }}
    >
      <Paper
        elevation={4}
        sx={{
          px: 1.5,
          py: 1.2,
          maxWidth: 360,
          bgcolor: 'rgba(255,255,255,0.96)',
          backdropFilter: 'blur(2px)',
        }}
      >
        <Typography
          variant="caption"
          sx={{ display: 'block', fontWeight: 700, letterSpacing: 0.15, textTransform: 'uppercase', mb: 0.4 }}
        >
          Naturalness map
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.8 }}>
          {top.name}
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.6 }}>
          {classes.map((c) => (
            <Box key={c.value} sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.8 }}>
              <Box
                sx={{
                  width: 16,
                  height: 16,
                  borderRadius: 0.5,
                  border: '1px solid',
                  borderColor: 'divider',
                  backgroundColor: c.color,
                  flexShrink: 0,
                  mt: '1px',
                }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.3 }}>
                <Box component="span" sx={{ fontWeight: 700, color: 'text.primary' }}>{c.value}</Box>{' '}
                {c.label}
              </Typography>
            </Box>
          ))}
        </Box>
      </Paper>
    </Box>
  );
}
