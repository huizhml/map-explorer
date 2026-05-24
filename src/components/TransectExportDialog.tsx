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
  Slider,
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
import { EOX_S2CLOUDLESS_YEARS } from './Sidebar';
import { apiUrl } from '../utils/apiBase';

type ExportFormat = 'pdf' | 'png' | 'jpg';

/** Figure layout: stacked 2D panels, or the BIOMASS-style 3D perspective
 *  (satellite ground plane + vertical heatmap wall along the transect). */
type ViewMode = '2d' | '3d';

/** Map-snapshot source for the transect figure export.
 *
 *  - `none`            — omit the map panel entirely.
 *  - `google`          — Google Satellite HD tiles (pre-EOX behaviour).
 *  - `eox_s2cloudless` — EOX `s2cloudless-<year>` cloud-free Sentinel-2 mosaic.
 */
type BasemapSource = 'none' | 'google' | 'eox_s2cloudless';

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

/** Trim transect samples down to the wire shape both endpoints expect. */
function slimSamples(samples: VerticalProfileLineSample[]) {
  return samples.map((s) => ({
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
}

/** Build the JSON payload the `/transect/figure` endpoint expects. */
function buildFigurePayload(args: {
  samples: VerticalProfileLineSample[];
  xAxis: 'lon' | 'lat';
  heightBinM: number;
  heatmapMaxHeight: number;
  includeMap: boolean;
  basemapSource: 'google' | 'eox_s2cloudless';
  eoxYear: number;
  eoxBrightness: number;
  includeEeAnnualChanges: boolean;
  includeHeatmap: boolean;
  showFhd: boolean;
  showEnl1d: boolean;
  showEnl2d: boolean;
  showCr: boolean;
  crOwnYaxis: boolean;
  showPanelLabels: boolean;
  figureWidth: number;
  mapHeight: number;
  heatmapHeight: number;
  metricsHeight: number;
  fontSize: number;
  satelliteBufferM: number;
  fmt: ExportFormat;
  preview: boolean;
}) {
  const slim = slimSamples(args.samples);
  return {
    samples: slim,
    x_axis: args.xAxis,
    height_bin_m: args.heightBinM,
    heatmap_max_height_m: args.heatmapMaxHeight,
    heatmap_colormap_max: HEATMAP_COLORMAP_MAX,
    include_map: args.includeMap,
    include_ee_annualchanges: args.includeEeAnnualChanges,
    include_heatmap: args.includeHeatmap,
    show_fhd: args.showFhd,
    show_enl1d: args.showEnl1d,
    show_enl2d: args.showEnl2d,
    show_cr: args.showCr,
    cr_own_yaxis: args.crOwnYaxis,
    show_panel_labels: args.showPanelLabels,
    figure_width_px: args.figureWidth,
    map_height_px: args.mapHeight,
    heatmap_height_px: args.heatmapHeight,
    // Backend reuses `enl_fhd_height_px` as the merged-metrics-panel height.
    enl_fhd_height_px: args.metricsHeight,
    font_size: args.fontSize,
    satellite_buffer_m: args.satelliteBufferM,
    basemap_source: args.basemapSource,
    eox_year: args.eoxYear,
    eox_brightness: args.eoxBrightness,
    // Preview always renders PNG at lower DPI for snappy refresh; export honours format.
    fmt: args.preview ? 'png' : args.fmt,
    dpi: args.preview ? 90 : 150,
  };
}

/** Build the JSON payload the `/transect/figure-3d` endpoint expects.
 *
 * Reuses `TransectFigureRequest`, so it shares the satellite + heatmap fields
 * with the 2D figure but adds the camera knobs and drops the panel-layout /
 * metrics fields (the 3D renderer ignores them — the satellite is always the
 * ground plane and the heatmap is always the wall). */
function build3DFigurePayload(args: {
  samples: VerticalProfileLineSample[];
  xAxis: 'lon' | 'lat';
  heightBinM: number;
  heatmapMaxHeight: number;
  basemapSource: 'google' | 'eox_s2cloudless';
  eoxYear: number;
  eoxBrightness: number;
  figureWidth: number;
  fontSize: number;
  satelliteBufferM: number;
  viewElev: number;
  viewAzim: number | null;
  verticalExag: number;
  viewZoom: number;
  groundDetail: number;
  fmt: ExportFormat;
  preview: boolean;
}) {
  return {
    samples: slimSamples(args.samples),
    x_axis: args.xAxis,
    height_bin_m: args.heightBinM,
    heatmap_max_height_m: args.heatmapMaxHeight,
    heatmap_colormap_max: HEATMAP_COLORMAP_MAX,
    figure_width_px: args.figureWidth,
    font_size: args.fontSize,
    satellite_buffer_m: args.satelliteBufferM,
    basemap_source: args.basemapSource,
    eox_year: args.eoxYear,
    eox_brightness: args.eoxBrightness,
    view_elev: args.viewElev,
    // null → backend auto-derives the azimuth from the transect bearing.
    view_azim: args.viewAzim,
    vertical_exag: args.verticalExag,
    view_zoom: args.viewZoom,
    // Ground (satellite) detail = cells per row; each cell is a polygon, so
    // render time scales with it. The preview is capped for responsiveness;
    // the export uses the full requested detail (a one-time slower render).
    ground_max_px: args.preview ? Math.min(args.groundDetail, 500) : args.groundDetail,
    fmt: args.preview ? 'png' : args.fmt,
    // Export rasterizes at 300 dpi (vs 150) so the satellite ground plane and
    // heatmap wall — both rasterized surfaces — actually resolve the dense mesh
    // and HD imagery. The output doubles to ~2400 px wide; in PDF only those
    // surfaces are bitmaps (text/axes stay vector). Layout is unaffected (it
    // keys off LAYOUT_DPI). Preview stays at 90 dpi for a snappy refresh.
    dpi: args.preview ? 90 : 300,
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
  // Aborts the in-flight render (preview or export) when a new one starts or the
  // dialog closes, so requests never pile up against the browser's per-host
  // connection limit and a stale render can't block a fresh one.
  const abortRef = useRef<AbortController | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [isRenderingPreview, setIsRenderingPreview] = useState(false);
  // True once a render-affecting setting changes after the last render, so the
  // visible preview is known to be out of date until the user clicks Render.
  const [previewStale, setPreviewStale] = useState(false);

  const [viewMode, setViewMode] = useState<ViewMode>('2d');
  const is3D = viewMode === '3d';
  // 3D camera knobs (only used when viewMode === '3d').
  const [viewElev, setViewElev] = useState<number>(28);
  /** When true, backend auto-derives azimuth from the transect bearing. */
  const [azimAuto, setAzimAuto] = useState<boolean>(true);
  const [viewAzim, setViewAzim] = useState<number>(-45);
  const [verticalExag, setVerticalExag] = useState<number>(0.1);
  /** Camera zoom: >1 enlarges the scene in the frame. */
  const [viewZoom, setViewZoom] = useState<number>(2.2);
  /** Satellite ground detail (cells/row). Higher = sharper but slower export. */
  const [groundDetail, setGroundDetail] = useState<number>(1000);

  const [format, setFormat] = useState<ExportFormat>('png');
  const [fontSize, setFontSize] = useState<number>(11);
  const [figureWidth, setFigureWidth] = useState<number>(1200);
  const [mapPanelHeight, setMapPanelHeight] = useState<number>(220);
  const [heatmapHeight, setHeatmapHeight] = useState<number>(240);
  /** Height of the merged metrics panel (FHD / 1D ENL / 2D ENL / CR). */
  const [metricsHeight, setMetricsHeight] = useState<number>(300);
  /** Vertical buffer (m) above/below the transect for the satellite snapshot. */
  const [satelliteBufferM, setSatelliteBufferM] = useState<number>(200);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  /** Single-choice map-snapshot source: omit, Google Satellite HD, or EOX s2cloudless. */
  const [basemapSource, setBasemapSource] = useState<BasemapSource>('google');
  /** Year for EOX `s2cloudless-<year>`; ignored unless basemapSource === 'eox_s2cloudless'. */
  const [eoxYear, setEoxYear] = useState<number>(2020);
  /** Gamma-style brightness applied to the EOX mosaic: 1.0 = source pixels, >1 brighter. */
  const [eoxBrightness, setEoxBrightness] = useState<number>(1.3);
  const includeMapPanel = basemapSource !== 'none';
  const [includeEeAnnualChangesPanel, setIncludeEeAnnualChangesPanel] = useState(false);
  const [includeHeatmapPanel, setIncludeHeatmapPanel] = useState(true);
  // Per-line toggles for the merged metrics panel.
  const [showFhd, setShowFhd] = useState(true);
  const [showEnl1d, setShowEnl1d] = useState(true);
  const [showEnl2d, setShowEnl2d] = useState(true);
  const [showCr, setShowCr] = useState(true);
  // When true (and CR is plotted alongside another metric), CR gets its own
  // twin right y-axis (0..1.1); otherwise all four lines share the left axis.
  const [crOwnYaxis, setCrOwnYaxis] = useState(false);
  // Master toggle for the small per-panel source/label badges ("VSM Vertical
  // Profile", satellite source, etc.). Off hides every badge in one click.
  const [showPanelLabels, setShowPanelLabels] = useState(true);

  const safeWidth = clamp(figureWidth, 700, 3000);
  const safeMapPanelHeight = clamp(mapPanelHeight, 80, 1800);
  const safeHeatmapHeight = clamp(heatmapHeight, 100, 1800);
  const safeMetricsHeight = clamp(metricsHeight, 120, 2200);
  const safeFontSize = clamp(fontSize, 8, 24);
  const safeSatelliteBufferM = clamp(satelliteBufferM, 10, 20000);
  // Brightness is a float — keep two decimals' worth via *100 round-trip.
  const safeEoxBrightness = Math.max(0.2, Math.min(3.0, Number.isFinite(eoxBrightness) ? eoxBrightness : 1.3));
  const safeViewElev = Math.max(2, Math.min(85, Number.isFinite(viewElev) ? viewElev : 20));
  const safeViewAzim = Number.isFinite(viewAzim) ? viewAzim : -45;
  const safeVerticalExag = Math.max(0.02, Math.min(0.6, Number.isFinite(verticalExag) ? verticalExag : 0.1));
  const safeViewZoom = Math.max(0.5, Math.min(4, Number.isFinite(viewZoom) ? viewZoom : 1.5));
  const safeGroundDetail = clamp(groundDetail, 400, 2500);

  // The 3D renderer always drapes a satellite ground plane (it 502s without
  // one), so "Off" isn't a valid map source there — fall back to Google.
  useEffect(() => {
    if (is3D && basemapSource === 'none') setBasemapSource('google');
  }, [is3D, basemapSource]);

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
  const anyMetricSelected = showFhd || showEnl1d || showEnl2d || showCr;
  const anyPanelSelected = is3D
    ? true // 3D always has the satellite ground plane + heatmap wall.
    : includeMapPanel ||
      includeEeAnnualChangesPanel ||
      includeHeatmapPanel ||
      anyMetricSelected;

  const requestFigure = useCallback(
    async (
      preview: boolean,
      signal?: AbortSignal,
    ): Promise<{ blob: Blob; mediaType: string } | null> => {
      if (!hasEnoughSamples) return null;
      if (!anyPanelSelected) return null;
      const concreteBasemap = basemapSource === 'eox_s2cloudless' ? 'eox_s2cloudless' : 'google';
      const endpoint = is3D ? '/transect/figure-3d' : '/transect/figure';
      const body = is3D
        ? build3DFigurePayload({
            samples: usableSamples,
            xAxis,
            heightBinM,
            heatmapMaxHeight: heatmapMaxHeight ?? DEFAULT_HEATMAP_MAX_HEIGHT_M,
            basemapSource: concreteBasemap,
            eoxYear,
            eoxBrightness: safeEoxBrightness,
            figureWidth: safeWidth,
            fontSize: safeFontSize,
            satelliteBufferM: safeSatelliteBufferM,
            viewElev: safeViewElev,
            viewAzim: azimAuto ? null : safeViewAzim,
            verticalExag: safeVerticalExag,
            viewZoom: safeViewZoom,
            groundDetail: safeGroundDetail,
            fmt: format,
            preview,
          })
        : buildFigurePayload({
            samples: usableSamples,
            xAxis,
            heightBinM,
            heatmapMaxHeight: heatmapMaxHeight ?? DEFAULT_HEATMAP_MAX_HEIGHT_M,
            includeMap: includeMapPanel,
            // Backend ignores basemap_source / eox_year when include_map is false,
            // but always send a concrete value so the payload is stable.
            basemapSource: concreteBasemap,
            eoxYear,
            eoxBrightness: safeEoxBrightness,
            includeEeAnnualChanges: includeEeAnnualChangesPanel,
            includeHeatmap: includeHeatmapPanel,
            showFhd,
            showEnl1d,
            showEnl2d,
            showCr,
            crOwnYaxis,
            showPanelLabels,
            figureWidth: safeWidth,
            mapHeight: safeMapPanelHeight,
            heatmapHeight: safeHeatmapHeight,
            metricsHeight: safeMetricsHeight,
            fontSize: safeFontSize,
            satelliteBufferM: safeSatelliteBufferM,
            fmt: format,
            preview,
          });
      const resp = await fetch(apiUrl(endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
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
      is3D,
      includeMapPanel,
      basemapSource,
      eoxYear,
      safeEoxBrightness,
      includeEeAnnualChangesPanel,
      includeHeatmapPanel,
      showFhd,
      showEnl1d,
      showEnl2d,
      showCr,
      crOwnYaxis,
      showPanelLabels,
      safeWidth,
      safeMapPanelHeight,
      safeHeatmapHeight,
      safeMetricsHeight,
      safeFontSize,
      safeSatelliteBufferM,
      safeViewElev,
      azimAuto,
      safeViewAzim,
      safeVerticalExag,
      safeViewZoom,
      safeGroundDetail,
      format,
    ],
  );

  // Manual preview: rendering only happens when the user clicks "Render", never
  // automatically on settings changes. This keeps each render deliberate and
  // avoids stacking up heavy (esp. 3D) renders on the server while the user is
  // still adjusting parameters. The previous image stays visible (dimmed) during
  // a refresh so the panel doesn't flash empty.
  const renderPreview = useCallback(async () => {
    if (!hasEnoughSamples) {
      setExportError('Need at least 2 transect samples to render.');
      return;
    }
    if (!anyPanelSelected) {
      setExportError('Select at least one panel to preview.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const token = ++previewRenderTokenRef.current;
    setExportError(null);
    setIsRenderingPreview(true);
    try {
      const result = await requestFigure(true, controller.signal);
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
      setPreviewStale(false);
      // Revoke the old URL only after React has swapped in the new one,
      // so the <img> never points at a freed blob mid-frame.
      if (prevUrl) {
        window.setTimeout(() => URL.revokeObjectURL(prevUrl), 0);
      }
    } catch (err) {
      if (controller.signal.aborted) return; // superseded by a newer request
      if (token !== previewRenderTokenRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setExportError(`Preview failed: ${msg}`);
    } finally {
      if (token === previewRenderTokenRef.current) {
        setIsRenderingPreview(false);
      }
    }
  }, [hasEnoughSamples, anyPanelSelected, requestFigure]);

  // Mark the visible preview stale whenever a render-affecting setting changes
  // (requestFigure's identity tracks all of them). Skips the initial mount so an
  // unrendered dialog doesn't open already flagged as stale.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setPreviewStale(true);
  }, [requestFigure]);

  // Abort any in-flight render when the dialog closes.
  useEffect(() => {
    if (!open) abortRef.current?.abort();
  }, [open]);

  // Cleanup on unmount: abort any in-flight render and revoke the preview URL.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
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
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setExportError(null);
    setIsExporting(true);
    try {
      const result = await requestFigure(false, controller.signal);
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
      if (controller.signal.aborted) return; // superseded / dialog closed
      const msg = err instanceof Error ? err.message : String(err);
      setExportError(`Export failed: ${msg}`);
    } finally {
      if (!controller.signal.aborted) setIsExporting(false);
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
          <FormControl size="small" sx={{ minWidth: 170 }}>
            <InputLabel id="transect-export-view">View</InputLabel>
            <Select
              labelId="transect-export-view"
              value={viewMode}
              label="View"
              onChange={(event) => setViewMode(event.target.value as ViewMode)}
            >
              <MenuItem value="2d">2D panels</MenuItem>
              <MenuItem value="3d">3D perspective</MenuItem>
            </Select>
          </FormControl>
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
          {/* Per-panel heights only apply to the stacked 2D layout. */}
          {!is3D && (
            <>
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
                label="Metrics height (px)"
                value={metricsHeight}
                onChange={(event) => setMetricsHeight(Number(event.target.value))}
                inputProps={{ min: 120, max: 2200, step: 20 }}
                sx={{ minWidth: 170 }}
              />
            </>
          )}
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
            inputProps={{ min: 10, max: 20000, step: 10 }}
            sx={{ minWidth: 170 }}
            // 3D always has a ground plane, so the buffer always applies there.
            disabled={!is3D && !includeMapPanel}
            helperText={is3D ? 'Swath half-width (⊥ to line)' : 'Vertical pad along transect'}
          />
        </Stack>

        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1}
          sx={{ mb: 1 }}
          flexWrap="wrap"
          useFlexGap
          // Bottom-align so the actual input boxes share a baseline even when
          // some controls have a caption above (e.g. EOX Brightness).
          alignItems={{ md: 'flex-end' }}
        >
          <FormControl size="small" sx={{ minWidth: 220 }}>
            <InputLabel id="transect-export-basemap">Map snapshot</InputLabel>
            <Select
              labelId="transect-export-basemap"
              value={basemapSource}
              label="Map snapshot"
              onChange={(event) => setBasemapSource(event.target.value as BasemapSource)}
            >
              {/* 3D always needs a ground plane, so "Off" is hidden there. */}
              {!is3D && <MenuItem value="none">Off (no map panel)</MenuItem>}
              <MenuItem value="google">Google Satellite (HD)</MenuItem>
              <MenuItem value="eox_s2cloudless">EOX Sentinel-2 cloudless mosaic</MenuItem>
            </Select>
          </FormControl>
          {basemapSource === 'eox_s2cloudless' && (
            <>
              <FormControl size="small" sx={{ minWidth: 110 }}>
                <InputLabel id="transect-export-eox-year">EOX year</InputLabel>
                <Select
                  labelId="transect-export-eox-year"
                  value={eoxYear}
                  label="EOX year"
                  onChange={(event) => setEoxYear(Number(event.target.value))}
                >
                  {EOX_S2CLOUDLESS_YEARS.map((y) => (
                    <MenuItem key={y} value={y}>{y}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 130 }}>
                <Typography
                  variant="caption"
                  sx={{ color: 'text.secondary', lineHeight: 1.1, mb: 0.25 }}
                >
                  1.0 = source; &gt;1 brighter
                </Typography>
                <TextField
                  size="small"
                  type="number"
                  label="Brightness"
                  value={eoxBrightness}
                  onChange={(event) => setEoxBrightness(Number(event.target.value))}
                  inputProps={{ min: 0.2, max: 3.0, step: 0.05 }}
                />
              </Box>
            </>
          )}
          {/* Panel/metric toggles only apply to the stacked 2D layout. */}
          {!is3D && (
            <>
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
              {/* Per-line toggles for the merged metrics panel. Each box controls
                  whether the corresponding curve renders; the panel itself is
                  omitted when all four are unchecked. */}
              <FormControlLabel
                control={<Checkbox checked={showFhd} onChange={(e) => setShowFhd(e.target.checked)} />}
                label="FHD"
              />
              <FormControlLabel
                control={<Checkbox checked={showEnl1d} onChange={(e) => setShowEnl1d(e.target.checked)} />}
                label="1D ENL"
              />
              <FormControlLabel
                control={<Checkbox checked={showEnl2d} onChange={(e) => setShowEnl2d(e.target.checked)} />}
                label="2D ENL"
              />
              <FormControlLabel
                control={<Checkbox checked={showCr} onChange={(e) => setShowCr(e.target.checked)} />}
                label="CR"
              />
              {/* Disabled unless CR shares the panel with at least one other metric —
                  when CR is alone (or off) the twin-axis option has no effect. */}
              <FormControlLabel
                control={
                  <Checkbox
                    checked={crOwnYaxis}
                    onChange={(e) => setCrOwnYaxis(e.target.checked)}
                    disabled={!showCr || !(showFhd || showEnl1d || showEnl2d)}
                  />
                }
                label="CR on its own y-axis"
              />
              {/* Master toggle for the per-panel source/label badges (e.g.
                  "VSM Vertical Profile", satellite source). */}
              <FormControlLabel
                control={
                  <Checkbox
                    checked={showPanelLabels}
                    onChange={(e) => setShowPanelLabels(e.target.checked)}
                  />
                }
                label="Panel labels"
              />
            </>
          )}

          {/* 3D camera controls — satellite ground plane + heatmap wall. */}
          {is3D && (
            <>
              <TextField
                size="small"
                type="number"
                label="Elevation (°)"
                value={viewElev}
                onChange={(event) => setViewElev(Number(event.target.value))}
                inputProps={{ min: 2, max: 85, step: 1 }}
                sx={{ minWidth: 120 }}
                helperText="Camera tilt"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={azimAuto}
                    onChange={(e) => setAzimAuto(e.target.checked)}
                  />
                }
                label="Auto azimuth"
              />
              <TextField
                size="small"
                type="number"
                label="Azimuth (°)"
                value={viewAzim}
                onChange={(event) => setViewAzim(Number(event.target.value))}
                inputProps={{ step: 5 }}
                sx={{ minWidth: 120 }}
                disabled={azimAuto}
                helperText={azimAuto ? 'From transect bearing' : 'Manual rotation'}
              />
              <TextField
                size="small"
                type="number"
                label="Vertical exaggeration"
                value={verticalExag}
                onChange={(event) => setVerticalExag(Number(event.target.value))}
                inputProps={{ min: 0.02, max: 0.6, step: 0.01 }}
                sx={{ minWidth: 180 }}
                helperText="Wall height vs. swath"
              />
              <TextField
                size="small"
                type="number"
                label="Zoom"
                value={viewZoom}
                onChange={(event) => setViewZoom(Number(event.target.value))}
                inputProps={{ min: 0.5, max: 4, step: 0.1 }}
                sx={{ minWidth: 110 }}
                helperText="Camera distance"
              />
              <Box sx={{ minWidth: 200, px: 1 }}>
                <Typography
                  variant="caption"
                  sx={{ color: 'text.secondary', display: 'block', lineHeight: 1.2 }}
                >
                  Ground detail: {safeGroundDetail}px (export)
                </Typography>
                <Slider
                  size="small"
                  min={400}
                  max={2500}
                  step={100}
                  value={safeGroundDetail}
                  onChange={(_, v) => setGroundDetail(v as number)}
                  valueLabelDisplay="auto"
                  // Higher = sharper satellite but slower export render. The
                  // preview is capped server-side so dragging stays responsive.
                  sx={{ mt: 0.5 }}
                />
              </Box>
            </>
          )}
        </Stack>

        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.75, display: 'block' }}>
          {is3D ? (
            <>
              Server-rendered with matplotlib 3D — the satellite snapshot is the ground
              plane and the vertical-profile heatmap stands up as a wall along the transect.{' '}
            </>
          ) : (
            <>
              Server-rendered with matplotlib subplots (sharex). All panels share the same{' '}
              {xAxis === 'lon' ? 'longitude' : 'latitude'} axis so points line up exactly.{' '}
            </>
          )}
          {basemapSource === 'google' && (
            <>Map snapshot uses Google Satellite (HD/retina tiles, {safeSatelliteBufferM} m buffer around the transect line).</>
          )}
          {basemapSource === 'eox_s2cloudless' && (
            <>Map snapshot uses EOX <code>s2cloudless-{eoxYear}</code> ({safeSatelliteBufferM} m buffer; cloud-free Sentinel-2 mosaic).</>
          )}
          {basemapSource === 'none' && (
            <>Map snapshot panel is disabled.</>
          )}
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
                : !anyPanelSelected
                  ? 'Select at least one panel to preview.'
                  : isRenderingPreview
                    ? 'Rendering preview…'
                    : 'Click “Render” to generate a preview.'}
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
                  // Dim while rendering, or while the visible image is stale
                  // (settings changed since it was rendered), so it's clear the
                  // preview no longer matches the current parameters.
                  opacity: isRenderingPreview || previewStale ? 0.6 : 1,
                  transition: 'opacity 120ms linear',
                }}
              />
              {(isRenderingPreview || previewStale) && (
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
                  {isRenderingPreview ? 'Rendering…' : 'Stale — click Render'}
                </Box>
              )}
            </Box>
          )}
        </Paper>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="outlined"
          color="primary"
          onClick={renderPreview}
          disabled={isRenderingPreview || isExporting || !anyPanelSelected || !hasEnoughSamples}
        >
          {isRenderingPreview
            ? 'Rendering…'
            : previewImageUrl && previewStale
              ? 'Render (update)'
              : 'Render'}
        </Button>
        <Button
          variant="contained"
          color="primary"
          onClick={exportFigure}
          disabled={isExporting || isRenderingPreview || !anyPanelSelected || !hasEnoughSamples}
        >
          {isExporting ? 'Exporting...' : `Export figure (${format.toUpperCase()})`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
