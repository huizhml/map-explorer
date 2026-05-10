import { Box, Typography } from '@mui/material';

/** Stored on EE layer metadata for legend display */
export type EarthEngineLegendSpec = {
  min: number;
  max: number;
  palette: string[];
};

function hexColor(hex: string): string {
  const s = (hex ?? '').trim();
  if (!s) return '#888888';
  return s.startsWith('#') ? s : `#${s}`;
}

function formatLegendValue(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Number.isInteger(n)) return String(n);
  const t = n.toFixed(4).replace(/\.?0+$/, '');
  return t || String(n);
}

function classLabels(spec: EarthEngineLegendSpec): string[] {
  const { min, max, palette } = spec;
  if (palette.length === 0) return [];
  if (Number.isInteger(min) && Number.isInteger(max)) {
    const classCount = max - min + 1;
    if (classCount === palette.length) {
      return palette.map((_, i) => String(min + i));
    }
  }
  return palette.map((_, i) => `Class ${i + 1}`);
}

/**
 * Discrete class legend for Earth Engine palettes.
 */
export function EarthEngineDiscreteLegend({
  spec,
}: {
  spec: EarthEngineLegendSpec;
}) {
  const { min, max, palette } = spec;
  const labels = classLabels(spec);

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
        Discrete classes ({formatLegendValue(min)} to {formatLegendValue(max)})
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.6 }}>
        {palette.map((entry, i) => (
          <Box key={`${entry}-${i}`} sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
            <Box
              sx={{
                width: 16,
                height: 16,
                borderRadius: 0.5,
                border: '1px solid',
                borderColor: 'divider',
                backgroundColor: hexColor(entry),
                flexShrink: 0,
              }}
            />
            <Typography variant="caption" color="text.secondary">
              {labels[i] ?? `Class ${i + 1}`}
            </Typography>
          </Box>
        ))}
        {palette.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            No palette provided
          </Typography>
        )}
        {palette.length > 0 && !Number.isInteger(min) && (
          <Typography variant="caption" color="text.secondary" sx={{ opacity: 0.8 }}>
            Class labels inferred from palette order.
          </Typography>
        )}
        {palette.length > 0 && Number.isInteger(min) && Number.isInteger(max) && labels[0]?.startsWith('Class') && (
          <Typography variant="caption" color="text.secondary" sx={{ opacity: 0.8 }}>
            Range has {max - min + 1} values and palette has {palette.length} classes.
        </Typography>
        )}
      </Box>
    </Box>
  );
}
