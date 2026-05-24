import { Box } from '@mui/material';
import type { Layer } from './LayerControl';
import { EarthEngineDiscreteLegend, type EarthEngineLegendSpec } from './EarthEngineLegend';
import { CollapsibleLegend } from './CollapsibleLegend';

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
      <CollapsibleLegend
        title="Earth Engine Legend"
        subtitle={top.name}
        sx={{ minWidth: 210, maxWidth: 280 }}
      >
        <EarthEngineDiscreteLegend spec={legend} />
      </CollapsibleLegend>
    </Box>
  );
}
