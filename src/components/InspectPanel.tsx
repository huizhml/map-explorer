import {
  Box,
  Paper,
  Typography,
  IconButton,
  CircularProgress,
  Button,
  Divider,
} from '@mui/material';
import { Close as CloseIcon, ContentCopy as CopyIcon } from '@mui/icons-material';
import type { InspectPanelState } from '../stores/mapStore';

/** TiTiler /cog/point returns { coordinates, values, band_names } — user wants values only */
function formatPixelValuesOnly(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.values)) return null;
  return (o.values as unknown[])
    .map((x) => (x === null || x === undefined ? '—' : String(x)))
    .join(', ');
}

function formatValueFallback(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

interface InspectPanelProps {
  panel: InspectPanelState;
  onClose: () => void;
}

export function InspectPanel({ panel, onClose }: InspectPanelProps) {
  const { lon, lat, loading, layers, pendingSample } = panel;
  const hasStaleView = Boolean(loading && pendingSample && layers.length > 0);

  const handleCopy = async () => {
    const payload = {
      coordinates: { lon, lat },
      layers: layers.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        ...(r.error ? { error: r.error } : { value: r.value }),
      })),
    };
    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      console.warn('Copy failed', payload);
    }
  };

  return (
    <Paper
      elevation={8}
      sx={{
        position: 'fixed',
        right: 16,
        // Above BaseMapSelector (bottom ~20 + ~48px control height + gap)
        bottom: 88,
        zIndex: 1100,
        width: { xs: 'calc(100% - 32px)', sm: 380 },
        maxWidth: 420,
        maxHeight: '45vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          px: 2,
          py: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          bgcolor: 'secondary.dark',
          color: 'secondary.contrastText',
        }}
      >
        <Typography variant="subtitle1" fontWeight={600}>
          Inspect point
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {!loading && layers.length > 0 && (
            <IconButton size="small" onClick={handleCopy} sx={{ color: 'inherit' }} aria-label="Copy JSON">
              <CopyIcon fontSize="small" />
            </IconButton>
          )}
          {loading && layers.length > 0 && (
            <CircularProgress size={18} sx={{ color: 'secondary.contrastText' }} aria-label="Loading" />
          )}
          <IconButton size="small" onClick={onClose} sx={{ color: 'inherit' }} aria-label="Close">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>

      {/* Fixed height avoids layout jump; scroll if many layers */}
      <Box
        sx={{
          px: 2,
          py: 1.5,
          height: 300,
          overflowY: 'auto',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1, flexShrink: 0 }}>
          <strong>Lon</strong> {lon.toFixed(6)}, <strong>Lat</strong> {lat.toFixed(6)}
        </Typography>

        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent:
              loading && layers.length === 0 ? 'center' : 'flex-start',
            alignItems: loading && layers.length === 0 ? 'center' : 'stretch',
          }}
        >
          {loading && layers.length === 0 && (
            <CircularProgress size={32} sx={{ color: 'secondary.main' }} aria-label="Loading" />
          )}

          {!loading && layers.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No visible raster layers with a COG URL. Add a prediction or COG layer and ensure it is visible.
            </Typography>
          )}

          {layers.length > 0 &&
            layers.map((row, i) => (
              <Box
                key={row.id}
                sx={{
                  opacity: hasStaleView ? 0.65 : 1,
                  transition: 'opacity 0.2s ease',
                }}
              >
                {i > 0 && <Divider sx={{ my: 1 }} />}
                <Typography variant="subtitle2" color="primary" sx={{ mb: 0.5 }}>
                  {row.name}
                </Typography>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                  {row.type}
                  {row.error && (
                    <Typography component="span" color="error.main" sx={{ ml: 1 }}>
                      {row.error}
                    </Typography>
                  )}
                </Typography>
                {!row.error && (() => {
                  const pixels = formatPixelValuesOnly(row.value);
                  if (pixels !== null) {
                    return (
                      <Typography
                        variant="h5"
                        component="div"
                        sx={{
                          fontWeight: 600,
                          fontVariantNumeric: 'tabular-nums',
                          color: 'text.primary',
                          letterSpacing: '-0.02em',
                        }}
                      >
                        {pixels}
                      </Typography>
                    );
                  }
                  return (
                    <Typography
                      component="pre"
                      variant="body2"
                      sx={{
                        m: 0,
                        p: 1,
                        bgcolor: 'action.hover',
                        borderRadius: 1,
                        fontSize: '0.75rem',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {formatValueFallback(row.value)}
                    </Typography>
                  );
                })()}
              </Box>
            ))}
        </Box>
      </Box>

      <Box sx={{ px: 2, pb: 1.5, pt: 0 }}>
        <Button size="small" onClick={onClose} fullWidth variant="outlined">
          Done
        </Button>
      </Box>
    </Paper>
  );
}
