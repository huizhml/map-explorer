import { Box, Paper, Typography } from '@mui/material';
import type { Layer } from './LayerControl';
import { EarthEngineDiscreteLegend, type EarthEngineLegendSpec } from './EarthEngineLegend';

interface EarthEngineLegendOverlayProps {
  layers: Layer[];
}

export function EarthEngineLegendOverlay({ layers }: EarthEngineLegendOverlayProps) {
  const active = layers
    .filter((l) => l.type === 'earthengine' && l.visible && l.metadata?.eeLegend)
    .sort((a, b) => b.zIndex - a.zIndex);

  if (active.length === 0) return null;

  const top = active[0];
  const legend = top.metadata?.eeLegend as EarthEngineLegendSpec;

  return (
    <Box
      sx={{
        position: 'absolute',
        bottom: 22,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1100,
        pointerEvents: 'none',
      }}
    >
      <Paper
        elevation={4}
        sx={{
          px: 1.5,
          py: 1.2,
          minWidth: 210,
          maxWidth: 280,
          bgcolor: 'rgba(255,255,255,0.96)',
          backdropFilter: 'blur(2px)',
        }}
      >
        <Typography
          variant="caption"
          sx={{ display: 'block', fontWeight: 700, letterSpacing: 0.15, textTransform: 'uppercase', mb: 0.4 }}
        >
          Earth Engine Legend
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.8 }}>
          {top.name}
        </Typography>
        <EarthEngineDiscreteLegend spec={legend} />
      </Paper>
    </Box>
  );
}
