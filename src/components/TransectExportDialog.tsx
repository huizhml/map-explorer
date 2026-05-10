import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMapStore } from '../stores/mapStore';
import type { VerticalProfileLineSample } from '../stores/mapStore';
import {
  DEFAULT_DIVERSITY_HEIGHT_BIN_M,
  DEFAULT_HEATMAP_MAX_HEIGHT_M,
  HEATMAP_COLORMAP_MAX,
} from '../constants/diversityMetrics';
import { apiUrl } from '../utils/apiBase';

type ExportFormat = 'pdf' | 'png' | 'jpg';

type TransectExportDialogProps = {
  open: boolean;
  onClose: () => void;
  samples: VerticalProfileLineSample[];
  lineCoordinates?: Array<[number, number]>;
  totalLengthMeters?: number;
  xAxis: 'lon' | 'lat';
  /** Y-axis top (m) for heatmap raster only (not diversity `max_height`). */
  heatmapMaxHeight?: number;
  /** Meters per vertical bin (matches transect profile histogram); defaults to Tools setting. */
  heightBinM?: number;
  /** Saved-feature display name; used as the default export filename. */
  featureName?: string;
};

/** Strip a free-form name down to a safe filename stem. */
function sanitizeFilename(s: string): string {
  const cleaned = s
    .trim()
    .replace(/[\s/\\?%*:|"<>]+/g, '_')  // replace illegal/whitespace chars
    .replace(/_{2,}/g, '_')                 // collapse repeated underscores
    .replace(/^[._]+|[._]+$/g, '');          // trim leading/trailing dots/underscores
  return cleaned.length > 0 ? cleaned.slice(0, 120) : '';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

const PREVIEW_RENDER_DEBOUNCE_MS = 350;

/** Build the JSON payload the `/transect/figure` endpoint expects. */
function buildFigurePayload(args: {
  samples: VerticalProfileLineSample[];
  xAxis: 'lon' | 'lat';
  heightBinM: number;
  heatmapMaxHeight: number;
  includeMap: boolean;
  includeEeAnnualChanges: boolean;
  includeHeatmap: boolean;
  includeEnlFhd: boolean;
  includeCr: boolean;
  figureWidth: number;
  mapHeight: number;
  heatmapHeight: number;
  enlFhdHeight: number;
  crHeight: number;
  fontSize: number;
  satelliteBufferM: number;
  fmt: ExportFormat;
  preview: boolean;
}) {
  const slim = args.samples.map((s) => ({
    lon: s.lon,
    lat: s.lat,
    distance_m: s.distance_m,
    profile: (s.profile ?? []).map((p) => ({
      rh: p.rh,
      value: p.value,
      missing: p.missing ?? false,
    })),
    fhd: s.fhd ?? null,
    enl1d: s.enl1d ?? null,
    enl2d: s.enl2d ?? null,
    cr: s.cr ?? null,
  }));
  return {
    samples: slim,
    x_axis: args.xAxis,
    height_bin_m: args.heightBinM,
    heatmap_max_height_m: args.heatmapMaxHeight,
    heatmap_colormap_max: HEATMAP_COLORMAP_MAX,
    include_map: args.includeMap,
    include_ee_annualchanges: args.includeEeAnnualChanges,
    include_heatmap: args.includeHeatmap,
    include_enl_fhd: args.includeEnlFhd,
    include_cr: args.includeCr,
    figure_width_px: args.figureWidth,
    map_height_px: args.mapHeight,
    heatmap_height_px: args.heatmapHeight,
    enl_fhd_height_px: args.enlFhdHeight,
    cr_height_px: args.crHeight,
    font_size: args.fontSize,
    satellite_buffer_m: args.satelliteBufferM,
    // Preview always renders PNG at lower DPI for snappy refresh; export honours format.
    fmt: args.preview ? 'png' : args.fmt,
    dpi: args.preview ? 90 : 150,
  };
}

export function TransectExportDialog({
  open,
  onClose,
  samples,
  lineCoordinates,
  totalLengthMeters,
  xAxis,
  heatmapMaxHeight,
  heightBinM: heightBinMProp,
  featureName,
}: TransectExportDialogProps) {
  void totalLengthMeters;
  void lineCoordinates;
  const diversityHeightBinM = useMapStore((state) => state.diversityHeightBinM);
  const heightBinM = heightBinMProp ?? diversityHeightBinM ?? DEFAULT_DIVERSITY_HEIGHT_BIN_M;

  const previewRenderTokenRef = useRef(0);
  const previewObjectUrlRef = useRef<string | null>(null);
  const previewDebounceRef = useRef<number | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [isRenderingPreview, setIsRenderingPreview] = useState(false);

  const [format, setFormat] = useState<ExportFormat>('png');
  const [fontSize, setFontSize] = useState<number>(11);
  const [figureWidth, setFigureWidth] = useState<number>(1200);
  const [mapPanelHeight, setMapPanelHeight] = useState<number>(220);
  const [heatmapHeight, setHeatmapHeight] = useState<number>(240);
  const [enlFhdHeight, setEnlFhdHeight] = useState<number>(300);
  const [crHeight, setCrHeight] = useState<number>(140);
  /** Vertical buffer (m) above/below the transect for the satellite snapshot. */
  const [satelliteBufferM, setSatelliteBufferM] = useState<number>(200);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [includeMapPanel, setIncludeMapPanel] = useState(true);
  const [includeEeAnnualChangesPanel, setIncludeEeAnnualChangesPanel] = useState(false);
  const [includeHeatmapPanel, setIncludeHeatmapPanel] = useState(true);
  const [includeEnlFhdPanel, setIncludeEnlFhdPanel] = useState(true);
  const [includeCrPanel, setIncludeCrPanel] = useState(true);

  const safeWidth = clamp(figureWidth, 700, 3000);
  const safeMapPanelHeight = clamp(mapPanelHeight, 80, 1800);
  const safeHeatmapHeight = clamp(heatmapHeight, 100, 1800);
  const safeEnlFhdHeight = clamp(enlFhdHeight, 120, 2200);
  const safeCrHeight = clamp(crHeight, 90, 1400);
  const safeFontSize = clamp(fontSize, 8, 24);
  const safeSatelliteBufferM = clamp(satelliteBufferM, 10, 5000);

  // Content fingerprint of the incoming `samples` prop. The parent often hands
  // us a freshly-allocated array on every render even when the underlying data
  // hasn't changed; without this the preview would re-fetch on every keystroke
  // anywhere in the page. Using length + endpoints + first profile length is
  // sufficient for our use case (transect samples are immutable once computed).
  const samplesFingerprint = useMemo(() => {
    if (samples.length === 0) return 'empty';
    const f = samples[0];
    const l = samples[samples.length - 1];
    return [
      samples.length,
      f.lon,
      f.lat,
      l.lon,
      l.lat,
      f.profile?.length ?? 0,
      f.fhd ?? '',
      l.fhd ?? '',
    ].join('|');
  }, [samples]);

  const usableSamples = useMemo(
    () =>
      samples.filter(
        (s) =>
          Number.isFinite(s.lon) &&
          Number.isFinite(s.lat) &&
          Math.abs(s.lon) <= 180 &&
          Math.abs(s.lat) <= 90,
      ),
    // Intentionally keyed on fingerprint, not the array reference itself —
    // see `samplesFingerprint` comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [samplesFingerprint],
  );
  const hasEnoughSamples = usableSamples.length >= 2;
  const anyPanelSelected =
    includeMapPanel ||
    includeEeAnnualChangesPanel ||
    includeHeatmapPanel ||
    includeEnlFhdPanel ||
    includeCrPanel;

  const requestFigure = useCallback(
    async (preview: boolean): Promise<{ blob: Blob; mediaType: string } | null> => {
      if (!hasEnoughSamples) return null;
      if (!anyPanelSelected) return null;
      const body = buildFigurePayload({
        samples: usableSamples,
        xAxis,
        heightBinM,
        heatmapMaxHeight: heatmapMaxHeight ?? DEFAULT_HEATMAP_MAX_HEIGHT_M,
        includeMap: includeMapPanel,
        includeEeAnnualChanges: includeEeAnnualChangesPanel,
        includeHeatmap: includeHeatmapPanel,
        includeEnlFhd: includeEnlFhdPanel,
        includeCr: includeCrPanel,
        figureWidth: safeWidth,
        mapHeight: safeMapPanelHeight,
        heatmapHeight: safeHeatmapHeight,
        enlFhdHeight: safeEnlFhdHeight,
        crHeight: safeCrHeight,
        fontSize: safeFontSize,
        satelliteBufferM: safeSatelliteBufferM,
        fmt: format,
        preview,
      });
      const resp = await fetch(apiUrl('/transect/figure'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        let detail = `${resp.status} ${resp.statusText}`;
        try {
          const j = await resp.json();
          if (j?.detail) detail = String(j.detail);
        } catch {
          /* ignore */
        }
        throw new Error(detail);
      }
      const mediaType = resp.headers.get('content-type') ?? 'image/png';
      const blob = await resp.blob();
      return { blob, mediaType };
    },
    [
      hasEnoughSamples,
      anyPanelSelected,
      usableSamples,
      xAxis,
      heightBinM,
      heatmapMaxHeight,
      includeMapPanel,
      includeEeAnnualChangesPanel,
      includeHeatmapPanel,
      includeEnlFhdPanel,
      includeCrPanel,
      safeWidth,
      safeMapPanelHeight,
      safeHeatmapHeight,
      safeEnlFhdHeight,
      safeCrHeight,
      safeFontSize,
      safeSatelliteBufferM,
      format,
    ],
  );

  // Debounced preview refresh whenever any setting changes (or dialog opens).
  // The previous image stays visible during refresh; we just dim it and show a
  // "Rendering…" badge after a small delay so quick renders don't flash anything.
  useEffect(() => {
    if (!open) return;
    if (previewDebounceRef.current != null) {
      window.clearTimeout(previewDebounceRef.current);
    }
    const token = ++previewRenderTokenRef.current;
    let busyBadgeTimer: number | null = null;
    previewDebounceRef.current = window.setTimeout(async () => {
      setExportError(null);
      // Only show the "Rendering…" badge if the request takes >180ms; otherwise
      // it never shows and the user only sees the freshly painted image.
      busyBadgeTimer = window.setTimeout(() => {
        if (token === previewRenderTokenRef.current) setIsRenderingPreview(true);
      }, 180);
      try {
        const result = await requestFigure(true);
        if (token !== previewRenderTokenRef.current) return;
        if (!result) {
          // Only clear the visible image when there's truly nothing to show
          // (no panels selected / not enough samples). Don't null it on every
          // keystroke — that's what caused the on/off flicker.
          if (previewObjectUrlRef.current) {
            URL.revokeObjectURL(previewObjectUrlRef.current);
            previewObjectUrlRef.current = null;
          }
          setPreviewImageUrl(null);
          return;
        }
        const url = URL.createObjectURL(result.blob);
        const prevUrl = previewObjectUrlRef.current;
        previewObjectUrlRef.current = url;
        setPreviewImageUrl(url);
        // Revoke the old URL only after React has swapped in the new one,
        // so the <img> never points at a freed blob mid-frame.
        if (prevUrl) {
          window.setTimeout(() => URL.revokeObjectURL(prevUrl), 0);
        }
      } catch (err) {
        if (token !== previewRenderTokenRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setExportError(`Preview failed: ${msg}`);
      } finally {
        if (busyBadgeTimer != null) window.clearTimeout(busyBadgeTimer);
        if (token === previewRenderTokenRef.current) {
          setIsRenderingPreview(false);
        }
      }
    }, PREVIEW_RENDER_DEBOUNCE_MS);
    return () => {
      if (previewDebounceRef.current != null) {
        window.clearTimeout(previewDebounceRef.current);
        previewDebounceRef.current = null;
      }
      if (busyBadgeTimer != null) window.clearTimeout(busyBadgeTimer);
    };
  }, [open, requestFigure]);

  // Cleanup the preview object URL when the dialog closes / unmounts.
  useEffect(() => {
    return () => {
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = null;
      }
    };
  }, []);

  const exportFigure = async () => {
    if (isExporting) return;
    if (!hasEnoughSamples) {
      setExportError('Need at least 2 transect samples to export.');
      return;
    }
    if (!anyPanelSelected) {
      setExportError('Select at least one panel to export.');
      return;
    }
    setExportError(null);
    setIsExporting(true);
    try {
      const result = await requestFigure(false);
      if (!result) {
        setExportError('Backend returned no data.');
        return;
      }
      const ext = format === 'pdf' ? 'pdf' : format === 'jpg' ? 'jpg' : 'png';
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      const stem = sanitizeFilename(featureName ?? '') || 'transect-figure';
      a.download = `${stem}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExportError(`Export failed: ${msg}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>Export transect figure</DialogTitle>
      <DialogContent>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1.25}
          sx={{ mb: 1.25, mt: 0.25 }}
          flexWrap="wrap"
          useFlexGap
        >
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel id="transect-export-format">Format</InputLabel>
            <Select
              labelId="transect-export-format"
              value={format}
              label="Format"
              onChange={(event) => setFormat(event.target.value as ExportFormat)}
            >
              <MenuItem value="pdf">PDF</MenuItem>
              <MenuItem value="png">PNG</MenuItem>
              <MenuItem value="jpg">JPG</MenuItem>
            </Select>
          </FormControl>
          <TextField
            size="small"
            type="number"
            label="Figure width (px)"
            value={figureWidth}
            onChange={(event) => setFigureWidth(Number(event.target.value))}
            inputProps={{ min: 700, max: 3000, step: 50 }}
            sx={{ minWidth: 160 }}
          />
          <TextField
            size="small"
            type="number"
            label="Map height (px)"
            value={mapPanelHeight}
            onChange={(event) => setMapPanelHeight(Number(event.target.value))}
            inputProps={{ min: 80, max: 1800, step: 20 }}
            sx={{ minWidth: 160 }}
          />
          <TextField
            size="small"
            type="number"
            label="Heatmap height (px)"
            value={heatmapHeight}
            onChange={(event) => setHeatmapHeight(Number(event.target.value))}
            inputProps={{ min: 100, max: 1800, step: 20 }}
            sx={{ minWidth: 170 }}
          />
          <TextField
            size="small"
            type="number"
            label="ENL/FHD height (px)"
            value={enlFhdHeight}
            onChange={(event) => setEnlFhdHeight(Number(event.target.value))}
            inputProps={{ min: 120, max: 2200, step: 20 }}
            sx={{ minWidth: 170 }}
          />
          <TextField
            size="small"
            type="number"
            label="CR height (px)"
            value={crHeight}
            onChange={(event) => setCrHeight(Number(event.target.value))}
            inputProps={{ min: 90, max: 1400, step: 20 }}
            sx={{ minWidth: 150 }}
          />
          <TextField
            size="small"
            type="number"
            label="Font size"
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value))}
            inputProps={{ min: 8, max: 24, step: 1 }}
            sx={{ minWidth: 130 }}
          />
          <TextField
            size="small"
            type="number"
            label="Satellite buffer (m)"
            value={satelliteBufferM}
            onChange={(event) => setSatelliteBufferM(Number(event.target.value))}
            inputProps={{ min: 10, max: 5000, step: 10 }}
            sx={{ minWidth: 170 }}
            disabled={!includeMapPanel}
            helperText="Vertical pad along transect"
          />
        </Stack>

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
          <FormControlLabel
            control={
              <Checkbox checked={includeMapPanel} onChange={(e) => setIncludeMapPanel(e.target.checked)} />
            }
            label="Map snapshot"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={includeEeAnnualChangesPanel}
                onChange={(e) => setIncludeEeAnnualChangesPanel(e.target.checked)}
              />
            }
            label="JRC TMF (Dec 2020)"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={includeHeatmapPanel}
                onChange={(e) => setIncludeHeatmapPanel(e.target.checked)}
              />
            }
            label="Heatmap"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={includeEnlFhdPanel}
                onChange={(e) => setIncludeEnlFhdPanel(e.target.checked)}
              />
            }
            label="ENL/FHD"
          />
          <FormControlLabel
            control={<Checkbox checked={includeCrPanel} onChange={(e) => setIncludeCrPanel(e.target.checked)} />}
            label="CR"
          />
        </Stack>

        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.75, display: 'block' }}>
          Server-rendered with matplotlib subplots (sharex). All panels share the same{' '}
          {xAxis === 'lon' ? 'longitude' : 'latitude'} axis so points line up exactly. Map snapshot uses
          Google Satellite (HD/retina tiles, {safeSatelliteBufferM} m buffer around the transect line).
        </Typography>
        {exportError && (
          <Typography variant="caption" color="error.main" sx={{ mb: 0.75, display: 'block' }}>
            {exportError}
          </Typography>
        )}

        <Paper
          variant="outlined"
          sx={{ p: 1, bgcolor: '#f8f9fa', overflowX: 'auto', position: 'relative' }}
        >
          {!previewImageUrl && (
            <Typography variant="caption" color="text.secondary">
              {!hasEnoughSamples
                ? 'Need at least 2 transect samples to render.'
                : isRenderingPreview
                  ? 'Rendering preview...'
                  : 'Select at least one panel to preview.'}
            </Typography>
          )}
          {!!previewImageUrl && (
            <Box sx={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
              <Box
                component="img"
                src={previewImageUrl}
                alt="Export preview"
                sx={{
                  width: '100%',
                  maxWidth: safeWidth,
                  height: 'auto',
                  display: 'block',
                  bgcolor: '#fff',
                  border: '1px solid #e0e0e0',
                  // Subtle dim while a refresh is in flight so the user knows
                  // the visible image is stale, without nuking the layout.
                  opacity: isRenderingPreview ? 0.7 : 1,
                  transition: 'opacity 120ms linear',
                }}
              />
              {isRenderingPreview && (
                <Box
                  sx={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    px: 1,
                    py: 0.25,
                    borderRadius: 1,
                    bgcolor: 'rgba(33,33,33,0.72)',
                    color: '#fff',
                    fontSize: 11,
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    pointerEvents: 'none',
                  }}
                >
                  Rendering…
                </Box>
              )}
            </Box>
          )}
        </Paper>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="contained"
          color="primary"
          onClick={exportFigure}
          disabled={isExporting || !anyPanelSelected || !hasEnoughSamples}
        >
          {isExporting ? 'Exporting...' : `Export figure (${format.toUpperCase()})`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
