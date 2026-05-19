import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { apiUrl } from '../utils/apiBase';

type ExportFormat = 'png' | 'jpg' | 'pdf';

type VerticalProfileExportDialogProps = {
  open: boolean;
  onClose: () => void;
  curve: Array<{ z: number; value: number }>;
  /** Saved-feature display name; used as the default export filename stem. */
  featureName?: string;
  xLabel?: string;
  yLabel?: string;
  title?: string;
};

/** Strip a free-form name down to a safe filename stem. */
function sanitizeFilename(s: string): string {
  const cleaned = s
    .trim()
    .replace(/[\s/\\?%*:|"<>]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : '';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

const PREVIEW_RENDER_DEBOUNCE_MS = 350;

export function VerticalProfileExportDialog({
  open,
  onClose,
  curve,
  featureName,
  xLabel = 'Energy (%)',
  yLabel = 'Height (m)',
  title,
}: VerticalProfileExportDialogProps) {
  const previewRenderTokenRef = useRef(0);
  const previewObjectUrlRef = useRef<string | null>(null);
  const previewDebounceRef = useRef<number | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [isRenderingPreview, setIsRenderingPreview] = useState(false);

  const [format, setFormat] = useState<ExportFormat>('png');
  const [fontSize, setFontSize] = useState<number>(12);
  const [figureWidth, setFigureWidth] = useState<number>(900);
  const [figureHeight, setFigureHeight] = useState<number>(700);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const safeWidth = clamp(figureWidth, 400, 4000);
  const safeHeight = clamp(figureHeight, 300, 4000);
  const safeFontSize = clamp(fontSize, 6, 40);

  // Only finite points are renderable; below 2 there's no line to draw.
  const cleanCurve = useMemo(
    () =>
      (curve ?? [])
        .filter((p) => Number.isFinite(p.z) && Number.isFinite(p.value))
        .map((p) => ({ z: p.z, value: p.value })),
    [curve],
  );
  const hasEnoughPoints = cleanCurve.length >= 2;

  const requestFigure = useCallback(
    async (preview: boolean): Promise<{ blob: Blob; mediaType: string } | null> => {
      if (!hasEnoughPoints) return null;
      const body = {
        curve: cleanCurve,
        title: title ?? null,
        x_label: xLabel,
        y_label: yLabel,
        figure_width_px: safeWidth,
        figure_height_px: safeHeight,
        font_size: safeFontSize,
        // Preview always renders PNG at lower DPI for snappy refresh; export
        // honours the chosen format. Same split as TransectExportDialog.
        fmt: preview ? 'png' : format,
        dpi: preview ? 90 : 150,
      };
      const resp = await fetch(apiUrl('/vertical-profile/figure'), {
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
    [hasEnoughPoints, cleanCurve, title, xLabel, yLabel, safeWidth, safeHeight, safeFontSize, format],
  );

  // Debounced preview refresh whenever any setting changes (or dialog opens).
  useEffect(() => {
    if (!open) return;
    if (previewDebounceRef.current != null) {
      window.clearTimeout(previewDebounceRef.current);
    }
    const token = ++previewRenderTokenRef.current;
    let busyBadgeTimer: number | null = null;
    previewDebounceRef.current = window.setTimeout(async () => {
      setExportError(null);
      busyBadgeTimer = window.setTimeout(() => {
        if (token === previewRenderTokenRef.current) setIsRenderingPreview(true);
      }, 180);
      try {
        const result = await requestFigure(true);
        if (token !== previewRenderTokenRef.current) return;
        if (!result) {
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
    if (!hasEnoughPoints) {
      setExportError('Need at least 2 curve points to export.');
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
      const stem = sanitizeFilename(featureName ?? '') || 'vertical-profile-curve';
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
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Export vertical profile curve</DialogTitle>
      <DialogContent>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.25}
          sx={{ mb: 1.25, mt: 0.25 }}
          flexWrap="wrap"
          useFlexGap
        >
          <TextField
            label="Width (px)"
            type="number"
            size="small"
            value={figureWidth}
            onChange={(e) => setFigureWidth(Number(e.target.value))}
            inputProps={{ min: 400, max: 4000, step: 50 }}
            sx={{ width: 130 }}
          />
          <TextField
            label="Height (px)"
            type="number"
            size="small"
            value={figureHeight}
            onChange={(e) => setFigureHeight(Number(e.target.value))}
            inputProps={{ min: 300, max: 4000, step: 50 }}
            sx={{ width: 130 }}
          />
          <TextField
            label="Font size"
            type="number"
            size="small"
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            inputProps={{ min: 6, max: 40, step: 1 }}
            sx={{ width: 110 }}
          />
          <FormControl size="small" sx={{ width: 110 }}>
            <InputLabel id="vp-export-format-label">Format</InputLabel>
            <Select
              labelId="vp-export-format-label"
              label="Format"
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              <MenuItem value="png">PNG</MenuItem>
              <MenuItem value="pdf">PDF</MenuItem>
              <MenuItem value="jpg">JPG</MenuItem>
            </Select>
          </FormControl>
        </Stack>

        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.75, display: 'block' }}>
          Server-rendered with matplotlib. Width is pixel-exact; height follows
          the figure aspect after a tight crop.
        </Typography>
        {exportError && (
          <Typography variant="caption" color="error.main" sx={{ mb: 0.75, display: 'block' }}>
            {exportError}
          </Typography>
        )}

        <Paper variant="outlined" sx={{ p: 1, bgcolor: '#f8f9fa', overflowX: 'auto', position: 'relative' }}>
          {!previewImageUrl && (
            <Typography variant="caption" color="text.secondary">
              {!hasEnoughPoints
                ? 'Need at least 2 curve points to render.'
                : isRenderingPreview
                  ? 'Rendering preview...'
                  : 'Preview will appear here.'}
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
          disabled={isExporting || !hasEnoughPoints}
        >
          {isExporting ? 'Exporting...' : `Export figure (${format.toUpperCase()})`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
