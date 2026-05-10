import { useState } from 'react';
import {
  Box,
  Button,
  Paper,
  Typography,
  IconButton,
  CircularProgress,
} from '@mui/material';
import { Close as CloseIcon, ContentCopy as CopyIcon, BookmarkAdd as BookmarkAddIcon } from '@mui/icons-material';
import type { InspectPanelState } from '../stores/mapStore';
import type { SavedFeatureDraft } from '../services/savedFeaturesApi';
import {
  TransectMetricsChart,
  TransectProfileHeatmap,
  VerticalProfileChart,
  VerticalProfileCurveChart,
  VerticalProfileSummary,
} from './SavedFeaturePlots';
import { TransectExportDialog } from './TransectExportDialog';
import { useMapStore } from '../stores/mapStore';
import { DEFAULT_DIVERSITY_HEIGHT_BIN_M, DEFAULT_HEATMAP_MAX_HEIGHT_M } from '../constants/diversityMetrics';

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
  onSave?: (draft: SavedFeatureDraft) => void;
}

export function InspectPanel({ panel, onClose, onSave }: InspectPanelProps) {
  const diversityHeightBinM = useMapStore((s) => s.diversityHeightBinM);
  const kind = panel.kind ?? 'layers';
  const {
    lon,
    lat,
    loading,
    layers,
    pendingSample,
    verticalProfile,
    verticalProfileCurve,
    profileMetrics,
    profileMeta,
    transectProfile,
    inspectError,
  } = panel;
  const [transectMetricXAxis, setTransectMetricXAxis] = useState<'lon' | 'lat'>('lon');
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);

  const hasStaleLayers = Boolean(loading && pendingSample && layers.length > 0);
  const hasStaleVertical = Boolean(
    loading && pendingSample && verticalProfile && verticalProfile.length > 0,
  );
  const showHeaderSpinner =
    kind === 'layers'
      ? loading && layers.length > 0
      : loading && (kind === 'vertical_profile_line'
        ? (transectProfile?.samples?.length ?? 0) > 0
        : (verticalProfile?.length ?? 0) > 0);

  const handleCopyLayers = async () => {
    const payload = {
      coordinates: { lon, lat },
      layers: layers.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        visible: r.visible,
        ...(r.error ? { error: r.error } : { value: r.value }),
      })),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch {
      console.warn('Copy failed', payload);
    }
  };

  const handleCopyVertical = async () => {
    const activeTransectSample = kind === 'vertical_profile_line'
      ? transectProfile?.samples?.[0]
      : undefined;
    const payload = kind === 'vertical_profile_line'
      ? {
        transect: {
          sample_count: transectProfile?.sampleCount,
          total_length_m: transectProfile?.totalLengthMeters,
          line_coordinates: transectProfile?.lineCoordinates,
          active_sample_index: 0,
          active_sample: activeTransectSample,
        },
      }
      : {
        coordinates: { lon, lat },
        tile: profileMeta?.tileName,
        year: profileMeta?.year,
        q_index: profileMeta?.qIndex,
        source: profileMeta?.source,
        metrics: profileMetrics,
        profile: verticalProfile,
      };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch {
      console.warn('Copy failed', payload);
    }
  };

  const isVertical = kind === 'vertical_profile';
  const isVerticalLine = kind === 'vertical_profile_line';
  const activeTransectSample = isVerticalLine
    ? transectProfile?.samples?.[0]
    : undefined;
  const verticalData = isVerticalLine ? activeTransectSample?.profile : verticalProfile;
  const verticalCurveData = isVerticalLine ? activeTransectSample?.vertical_profile_curve : verticalProfileCurve;
  const verticalMetricsData = isVerticalLine
    ? {
      fhd: activeTransectSample?.fhd ?? null,
      enl1d: activeTransectSample?.enl1d ?? null,
      enl2d: activeTransectSample?.enl2d ?? null,
      cr: activeTransectSample?.cr ?? null,
    }
    : profileMetrics;
  const profileMetaData = isVerticalLine
    ? {
      tileName: activeTransectSample?.tile_name ?? '',
      year: profileMeta?.year ?? panel.profileMeta?.year ?? 0,
      qIndex: profileMeta?.qIndex ?? panel.profileMeta?.qIndex ?? 1,
      source: profileMeta?.source,
      maxHeight: profileMeta?.maxHeight ?? panel.profileMeta?.maxHeight,
      heatmapMaxHeight: profileMeta?.heatmapMaxHeight ?? panel.profileMeta?.heatmapMaxHeight,
      fhdInterval: profileMeta?.fhdInterval ?? panel.profileMeta?.fhdInterval,
    }
    : profileMeta;
  const verticalLoadingFirst = (isVertical || isVerticalLine) && loading && !(verticalData?.length ?? 0);
  const sourceLabel =
    profileMetaData?.source === 'original'
      ? 'original'
      : profileMetaData?.source === 'blended'
        ? 'blended'
        : profileMetaData?.source || '';
  const hasNumericVerticalValues = Boolean(
    verticalData?.some((p) => p.value != null && !p.missing && Number.isFinite(p.value)),
  );
  const hasVerticalMetrics = Boolean(
    verticalMetricsData
    && [verticalMetricsData.fhd, verticalMetricsData.enl1d, verticalMetricsData.enl2d, verticalMetricsData.cr]
      .some((v) => v != null && Number.isFinite(v)),
  );
  const hasVerticalCurve = Boolean(verticalCurveData && verticalCurveData.length > 0);
  const showVerticalSummary = Boolean(isVertical && verticalData && verticalData.length > 0 && hasVerticalMetrics);
  const showVerticalPlots = Boolean(
    isVertical && verticalData && verticalData.length > 0 && hasNumericVerticalValues && hasVerticalCurve,
  );
  const showTransectHeatmap = Boolean(
    isVerticalLine && transectProfile && transectProfile.samples.length > 0,
  );
  const pointDraft: SavedFeatureDraft | null =
    lon !== 0 || lat !== 0
      ? {
        geometry: { type: 'Point', coordinates: [lon, lat] },
        metadata: {
          source: isVertical || isVerticalLine ? sourceLabel || undefined : undefined,
          tile_name: profileMetaData?.tileName || undefined,
          year: profileMetaData?.year,
          q_index: profileMetaData?.qIndex,
        },
        plot_data: isVertical || isVerticalLine
          ? {
            vertical_profile: verticalData,
            vertical_profile_curve: verticalCurveData,
            profile_metrics: verticalMetricsData,
            ...(isVerticalLine && transectProfile
              ? {
                transect: {
                  sample_count: transectProfile.sampleCount,
                  total_length_m: transectProfile.totalLengthMeters,
                  max_height: profileMetaData?.maxHeight,
                  heatmap_max_height: profileMetaData?.heatmapMaxHeight,
                  line_coordinates: transectProfile.lineCoordinates,
                  samples: transectProfile.samples,
                },
              }
              : {}),
          }
          : {
            layers: layers.map((r) => ({
              id: r.id,
              name: r.name,
              type: r.type,
              visible: r.visible,
              ...(r.error ? { error: r.error } : { value: r.value }),
            })),
          },
      }
      : null;
  const transectDraft: SavedFeatureDraft | null =
    isVerticalLine && transectProfile?.lineCoordinates && transectProfile.lineCoordinates.length >= 2
      ? {
        geometry: { type: 'LineString', coordinates: transectProfile.lineCoordinates },
        metadata: {
          source: sourceLabel || undefined,
          tile_name: profileMetaData?.tileName || undefined,
          year: profileMetaData?.year,
          q_index: profileMetaData?.qIndex,
          sample_count: transectProfile.sampleCount,
          total_length_m: transectProfile.totalLengthMeters,
        },
        plot_data: {
          vertical_profile: verticalData,
          vertical_profile_curve: verticalCurveData,
          profile_metrics: verticalMetricsData,
          transect: {
            sample_count: transectProfile.sampleCount,
            total_length_m: transectProfile.totalLengthMeters,
            max_height: profileMetaData?.maxHeight,
            heatmap_max_height: profileMetaData?.heatmapMaxHeight,
            line_coordinates: transectProfile.lineCoordinates,
            samples: transectProfile.samples,
          },
        },
      }
      : null;

  return (
    <>
      <Paper
      elevation={8}
      sx={{
        position: 'fixed',
        right: 16,
        bottom: 88,
        zIndex: 1100,
        width: isVertical
          || isVerticalLine
          ? { xs: 'calc(100% - 32px)', sm: 'min(92vw, 920px)' }
          : { xs: 'calc(100% - 32px)', sm: 380 },
        maxWidth: (isVertical || isVerticalLine) ? 920 : 420,
        maxHeight: (isVertical || isVerticalLine) ? '52vh' : '45vh',
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
          {isVertical
            ? 'Vertical profile (original, Q1)'
            : isVerticalLine
              ? 'Vertical profile transect'
              : 'Inspect point'}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {!loading && isVerticalLine && (transectProfile?.samples?.length ?? 0) > 0 && (
            <Button
              size="small"
              variant="outlined"
              onClick={() => setIsExportDialogOpen(true)}
              sx={{
                color: 'inherit',
                borderColor: 'rgba(255,255,255,0.45)',
                '&:hover': { borderColor: 'rgba(255,255,255,0.7)' },
                textTransform: 'none',
                minWidth: 68,
              }}
            >
              Export
            </Button>
          )}
          {!loading && onSave && (() => {
            if (isVerticalLine) {
              if (transectDraft) {
                return (
                  <IconButton
                    size="small"
                    onClick={() => onSave(transectDraft)}
                    sx={{ color: 'inherit' }}
                    aria-label="Save transect line"
                    title="Save this transect line"
                  >
                    <BookmarkAddIcon fontSize="small" />
                  </IconButton>
                );
              }
            } else if (pointDraft) {
              return (
                <IconButton
                  size="small"
                  onClick={() => onSave(pointDraft)}
                  sx={{ color: 'inherit' }}
                  aria-label="Save this location"
                  title="Save this location"
                >
                  <BookmarkAddIcon fontSize="small" />
                </IconButton>
              );
            }
            return null;
          })()}
          {!loading && (
            (isVertical && (verticalData?.length ?? 0) > 0)
            || (isVerticalLine && (transectProfile?.samples?.length ?? 0) > 0)
          ) && (
            <IconButton
              size="small"
              onClick={handleCopyVertical}
              sx={{ color: 'inherit' }}
              aria-label="Copy profile JSON"
            >
              <CopyIcon fontSize="small" />
            </IconButton>
          )}
          {!loading && !isVertical && !isVerticalLine && layers.length > 0 && (
            <IconButton size="small" onClick={handleCopyLayers} sx={{ color: 'inherit' }} aria-label="Copy JSON">
              <CopyIcon fontSize="small" />
            </IconButton>
          )}
          {showHeaderSpinner && (
            <CircularProgress size={18} sx={{ color: 'secondary.contrastText' }} aria-label="Loading" />
          )}
          <IconButton size="small" onClick={onClose} sx={{ color: 'inherit' }} aria-label="Close">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>

      <Box
        sx={{
          px: 2,
          py: 1.5,
          ...(isVertical
            || isVerticalLine
            ? { flex: 1, minHeight: 0, maxHeight: 'calc(52vh - 120px)', overflowY: 'auto' }
            : { height: 300, overflowY: 'auto', flexShrink: 0 }),
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1, flexShrink: 0 }}>
          <strong>Lon</strong> {(activeTransectSample?.lon ?? lon).toFixed(6)}, <strong>Lat</strong> {(activeTransectSample?.lat ?? lat).toFixed(6)}
        </Typography>

        {(isVertical || isVerticalLine) && profileMetaData?.tileName && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Tile <strong>{profileMetaData.tileName}</strong> · {profileMetaData.year} · Q{profileMetaData.qIndex}
            {sourceLabel && (
              <>
                {' '}
                · <strong>{sourceLabel}</strong>
              </>
            )}
          </Typography>
        )}

        {inspectError && (
          <Typography variant="body2" color="error.main" sx={{ mb: 1 }}>
            {inspectError}
          </Typography>
        )}

        {(isVertical || isVerticalLine) ? (
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: verticalLoadingFirst ? 'center' : 'flex-start',
              alignItems: verticalLoadingFirst ? 'center' : 'stretch',
            }}
          >
            {verticalLoadingFirst && (
              <CircularProgress size={32} sx={{ color: 'secondary.main' }} aria-label="Loading" />
            )}
            {showTransectHeatmap && (
              <>
                <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
                  Sampled locations along line: {transectProfile!.samples.length} (auto-extracted every ~10 m).
                </Typography>
                <TransectProfileHeatmap
                  samples={transectProfile!.samples}
                  totalLengthMeters={transectProfile!.totalLengthMeters}
                  xAxis={transectMetricXAxis}
                  dimmed={hasStaleVertical}
                  heatmapMaxHeight={profileMetaData?.heatmapMaxHeight ?? DEFAULT_HEATMAP_MAX_HEIGHT_M}
                  heightBinM={profileMetaData?.fhdInterval ?? diversityHeightBinM ?? DEFAULT_DIVERSITY_HEIGHT_BIN_M}
                />
                <TransectMetricsChart
                  samples={transectProfile!.samples}
                  xAxis={transectMetricXAxis}
                  onXAxisChange={setTransectMetricXAxis}
                  dimmed={hasStaleVertical}
                />
              </>
            )}
            {showVerticalSummary && (
              <>
                <VerticalProfileSummary metrics={verticalMetricsData} dimmed={hasStaleVertical} heightBinM={profileMeta?.fhdInterval} />
              </>
            )}
            {showVerticalPlots && (
              <>
                <Box
                  sx={{
                    display: 'flex',
                    flexDirection: { xs: 'column', md: 'row' },
                    gap: 1.5,
                    alignItems: 'flex-start',
                  }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <VerticalProfileChart profile={verticalData!} dimmed={hasStaleVertical} />
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <VerticalProfileCurveChart curve={verticalCurveData!} dimmed={hasStaleVertical} />
                  </Box>
                </Box>
              </>
            )}
            {isVertical && verticalData && verticalData.length > 0 && !showVerticalSummary && !showVerticalPlots && !loading && !inspectError && (
              <Typography variant="body2" color="text.secondary">
                Vertical profile metrics and plots are unavailable for this point.
              </Typography>
            )}
            {!loading && !inspectError && ((isVerticalLine && !showTransectHeatmap) || (isVertical && !verticalData?.length)) && (
              <Typography variant="body2" color="text.secondary">
                {isVerticalLine
                  ? 'Draw a line on the map to sample multiple RH profiles.'
                  : 'Click the map — loads original RH0–RH100 (Q1) for the selected year.'}
              </Typography>
            )}
          </Box>
        ) : (
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: loading && layers.length === 0 ? 'center' : 'flex-start',
              alignItems: loading && layers.length === 0 ? 'center' : 'stretch',
            }}
          >
            {loading && layers.length === 0 && (
              <CircularProgress size={32} sx={{ color: 'secondary.main' }} aria-label="Loading" />
            )}

            {!loading && layers.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No raster layers with a COG URL. Add a prediction or COG layer.
              </Typography>
            )}

            {layers.length > 0 &&
              layers.map((row, i) => (
                <Box
                  key={row.id}
                  sx={{
                    opacity: hasStaleLayers ? 0.65 : 1,
                    transition: 'opacity 0.2s ease',
                  }}
                >
                  {i > 0 && <Box sx={{ borderTop: 1, borderColor: 'divider', my: 1 }} />}
                  <Typography variant="subtitle2" color="primary" sx={{ mb: 0.5 }}>
                    {row.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                    {row.type}
                    {!row.visible && (
                      <Typography component="span" color="warning.main" sx={{ ml: 1 }}>
                        hidden
                      </Typography>
                    )}
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
        )}
      </Box>

      </Paper>
      {isVerticalLine && transectProfile && transectProfile.samples.length > 0 && (
        <TransectExportDialog
          open={isExportDialogOpen}
          onClose={() => setIsExportDialogOpen(false)}
          samples={transectProfile.samples}
          totalLengthMeters={transectProfile.totalLengthMeters}
          xAxis={transectMetricXAxis}
          heatmapMaxHeight={profileMetaData?.heatmapMaxHeight ?? DEFAULT_HEATMAP_MAX_HEIGHT_M}
          heightBinM={profileMetaData?.fhdInterval ?? diversityHeightBinM ?? DEFAULT_DIVERSITY_HEIGHT_BIN_M}
        />
      )}
    </>
  );
}
