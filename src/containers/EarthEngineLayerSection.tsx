import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  FormControlLabel,
  Switch,
  Alert,
  Collapse,
  IconButton,
  Tooltip,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import TileLayer from 'ol/layer/Tile';
import XYZ from 'ol/source/XYZ';
import type { EarthEngineLegendSpec } from '../components/EarthEngineLegend';
import { apiService } from '../services/api';
import { useMapStore } from '../stores/mapStore';

/** Minimal theme slice from Sidebar surface tokens */
export type EarthEngineSidebarUi = {
  border: string;
  fieldBg: string;
  fieldText: string;
  fieldLabel: string;
  textMuted: string;
  textSecondary: string;
  textPrimary: string;
  buttonBg: string;
  borderStrong: string;
  accentBorder: string;
  accentSoft: string;
};

const JRC_TMF_ANNUAL_CHANGES_PALETTE = ['005A00', '648723', 'FFBE2D', 'D2FA3C', '008CBE', 'FFFFFF'];

function parsePalette(input: string): string[] | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  return raw.split(/[\s,]+/).filter(Boolean);
}

function syncLayersFromManager() {
  const { layerManager, setLayers } = useMapStore.getState();
  if (!layerManager) return;
  layerManager.syncAllProperties();
  setLayers(
    layerManager.getAllLayers().map((m) => ({
      id: m.id,
      name: m.name,
      visible: m.visible,
      opacity: m.opacity,
      zIndex: m.zIndex,
      type: m.type,
      metadata: m.metadata,
    })),
  );
}

function fieldSx(ui: EarthEngineSidebarUi) {
  return {
    '& .MuiOutlinedInput-root': { backgroundColor: ui.fieldBg, color: ui.fieldText },
    '& .MuiInputLabel-root': { color: ui.fieldLabel },
    '& .MuiOutlinedInput-notchedOutline': { borderColor: ui.borderStrong },
    '& .MuiSvgIcon-root': { color: ui.textMuted },
  };
}

export function EarthEngineLayerSection({ ui }: { ui: EarthEngineSidebarUi }) {
  const map = useMapStore((s) => s.map);
  const layerManager = useMapStore((s) => s.layerManager);

  const [expanded, setExpanded] = useState(true);
  const [status, setStatus] = useState<{
    ee_import_ok: boolean;
    credentials_path_set: boolean;
    credentials_file_exists: boolean;
  } | null>(null);

  const [assetId, setAssetId] = useState('projects/JRC/TMF/v1_2025/AnnualChanges');
  const [assetKind, setAssetKind] = useState<'image' | 'image_collection'>('image_collection');
  const [reduceCollection, setReduceCollection] = useState<'mosaic' | 'median' | 'first'>('mosaic');
  const [band, setBand] = useState('Dec2020');
  const [maskSelf, setMaskSelf] = useState(true);
  const [visMin, setVisMin] = useState('1');
  const [visMax, setVisMax] = useState('6');
  const [paletteStr, setPaletteStr] = useState(JRC_TMF_ANNUAL_CHANGES_PALETTE.join(', '));

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiService
      .getEarthEngineStatus()
      .then(setStatus)
      .catch(() => setStatus({ ee_import_ok: false, credentials_path_set: false, credentials_file_exists: false }));
  }, []);

  const applyPresetJrc = () => {
    setAssetId('projects/JRC/TMF/v1_2025/AnnualChanges');
    setAssetKind('image_collection');
    setReduceCollection('mosaic');
    setBand('Dec2020');
    setMaskSelf(true);
    setVisMin('1');
    setVisMax('6');
    setPaletteStr(JRC_TMF_ANNUAL_CHANGES_PALETTE.join(', '));
  };

  const addLayer = useCallback(async () => {
    if (!map || !layerManager) {
      setError('Map not ready.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const vmin = visMin.trim() === '' ? undefined : Number(visMin);
      const vmax = visMax.trim() === '' ? undefined : Number(visMax);
      const palette = parsePalette(paletteStr);

      if ((vmin === undefined) !== (vmax === undefined)) {
        setError('Provide both vis min and max, or clear both for default stretch 0–1.');
        return;
      }
      if (vmin !== undefined && (!Number.isFinite(vmin) || !Number.isFinite(vmax!))) {
        setError('vis min and max must be valid numbers.');
        return;
      }

      const vis: { min?: number; max?: number; palette?: string[] } = {};
      if (vmin !== undefined && vmax !== undefined) {
        vis.min = vmin;
        vis.max = vmax;
      }
      if (palette?.length) vis.palette = palette;

      const body = {
        asset_id: assetId.trim(),
        asset_kind: assetKind,
        reduce_collection: reduceCollection,
        band: band.trim() || undefined,
        mask_self: maskSelf,
        vis,
      };

      const { tile_url, asset_id: resolvedAsset } = await apiService.getEarthEngineTileUrl(body);

      const labelBand = band.trim() ? ` — ${band.trim()}` : '';
      const layerId = `earthengine-${Date.now()}`;
      const name = `EE ${resolvedAsset.split('/').pop() ?? resolvedAsset}${labelBand}`;

      const olLayer = new TileLayer({
        source: new XYZ({
          url: tile_url,
          maxZoom: 18,
          crossOrigin: 'anonymous',
        }),
        opacity: 0.85,
        zIndex: 350,
      });

      const legendSpec: EarthEngineLegendSpec =
        vmin !== undefined && vmax !== undefined
          ? { min: vmin, max: vmax, palette: palette ?? [] }
          : { min: 0, max: 1, palette: palette ?? [] };

      layerManager.addLayer(layerId, name, 'earthengine', olLayer, {
        url: tile_url,
        assetId: resolvedAsset,
        band: band.trim() || undefined,
        ee: true,
        eeLegend: legendSpec,
      });
      syncLayersFromManager();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [
    map,
    layerManager,
    assetId,
    assetKind,
    reduceCollection,
    band,
    maskSelf,
    visMin,
    visMax,
    paletteStr,
  ]);

  const eeReady =
    status?.ee_import_ok && status?.credentials_path_set && status?.credentials_file_exists;

  const dashedBtnSx = {
    borderStyle: 'dashed',
    borderColor: ui.borderStrong,
    color: ui.textSecondary,
    py: 1,
    '&:hover': { borderStyle: 'dashed', borderColor: ui.accentBorder, backgroundColor: ui.accentSoft },
  };

  return (
    <Box sx={{ mt: 2.5, pt: 2.5, borderTop: `1px solid ${ui.border}` }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 1,
          py: 0.75,
          mb: 1,
          borderRadius: 1,
          bgcolor: ui.buttonBg,
          border: `1px solid ${ui.border}`,
          cursor: 'pointer',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <Typography
          variant="caption"
          sx={{
            color: ui.textMuted,
            fontSize: '0.7rem',
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          Earth Engine layer
        </Typography>
        <IconButton size="small" sx={{ color: ui.textMuted }}>
          {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        </IconButton>
      </Box>

      <Collapse in={expanded}>
        <Box>
          {status && !eeReady && (
            <Alert
              severity="warning"
              sx={{
                mb: 1,
                bgcolor: ui.buttonBg,
                color: ui.textSecondary,
                border: `1px solid ${ui.border}`,
                '& .MuiAlert-icon': { color: 'warning.main' },
              }}
            >
              Backend needs Python <code>earthengine-api</code> and{' '}
              <code>GOOGLE_APPLICATION_CREDENTIALS</code> (or <code>EE_CREDENTIALS_PATH</code>)
              pointing to a service-account JSON with Earth Engine access.
            </Alert>
          )}
          <Typography variant="caption" sx={{ display: 'block', mb: 1, color: ui.textMuted, lineHeight: 1.45 }}>
            Tiles are generated server-side; EE credentials stay on the server.
          </Typography>
          <Button
            size="small"
            variant="outlined"
            fullWidth
            onClick={applyPresetJrc}
            sx={{ ...dashedBtnSx, mb: 1, textTransform: 'none' }}
          >
            Preset: JRC TMF AnnualChanges (Dec2020)
          </Button>
          <TextField
            label="Asset ID"
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
            fullWidth
            size="small"
            sx={{ mb: 1, ...fieldSx(ui) }}
          />
          <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
            <FormControl size="small" fullWidth sx={fieldSx(ui)}>
              <InputLabel>Kind</InputLabel>
              <Select
                label="Kind"
                value={assetKind}
                onChange={(e) => setAssetKind(e.target.value as 'image' | 'image_collection')}
                MenuProps={{
                  PaperProps: {
                    sx: { bgcolor: ui.fieldBg, color: ui.fieldText, border: `1px solid ${ui.border}` },
                  },
                }}
              >
                <MenuItem value="image_collection">ImageCollection</MenuItem>
                <MenuItem value="image">Image</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth disabled={assetKind !== 'image_collection'} sx={fieldSx(ui)}>
              <InputLabel>Reduce</InputLabel>
              <Select
                label="Reduce"
                value={reduceCollection}
                onChange={(e) =>
                  setReduceCollection(e.target.value as 'mosaic' | 'median' | 'first')
                }
                MenuProps={{
                  PaperProps: {
                    sx: { bgcolor: ui.fieldBg, color: ui.fieldText, border: `1px solid ${ui.border}` },
                  },
                }}
              >
                <MenuItem value="mosaic">mosaic</MenuItem>
                <MenuItem value="median">median</MenuItem>
                <MenuItem value="first">first</MenuItem>
              </Select>
            </FormControl>
          </Box>
          <TextField
            label="Band (optional)"
            value={band}
            onChange={(e) => setBand(e.target.value)}
            placeholder="e.g. Dec2020"
            fullWidth
            size="small"
            sx={{ mb: 1, ...fieldSx(ui) }}
          />
          <FormControlLabel
            control={
              <Switch
                checked={maskSelf}
                onChange={(_, v) => setMaskSelf(v)}
                size="small"
                sx={{ color: ui.accentBorder }}
              />
            }
            label="Mask nodata (updateMask)"
            sx={{ mb: 1, ml: 0, color: ui.textSecondary }}
          />
          <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
            <TextField
              label="vis min"
              value={visMin}
              onChange={(e) => setVisMin(e.target.value)}
              size="small"
              fullWidth
              sx={fieldSx(ui)}
            />
            <TextField
              label="vis max"
              value={visMax}
              onChange={(e) => setVisMax(e.target.value)}
              size="small"
              fullWidth
              sx={fieldSx(ui)}
            />
          </Box>
          <TextField
            label="Palette (comma-separated hex)"
            value={paletteStr}
            onChange={(e) => setPaletteStr(e.target.value)}
            fullWidth
            size="small"
            multiline
            minRows={2}
            sx={{ mb: 1, ...fieldSx(ui) }}
          />
          {error && (
            <Alert severity="error" sx={{ mb: 1, bgcolor: ui.buttonBg, color: ui.textSecondary }}>
              {error}
            </Alert>
          )}
          <Tooltip title={!eeReady ? 'Configure EE on the backend first' : ''}>
            <span>
              <Button
                variant="outlined"
                fullWidth
                disabled={loading || !eeReady}
                onClick={addLayer}
                sx={{
                  ...dashedBtnSx,
                  fontWeight: 700,
                  borderStyle: 'solid',
                  borderColor: eeReady ? ui.accentBorder : ui.border,
                  color: ui.textPrimary,
                  '&:disabled': { borderStyle: 'solid', opacity: 0.5 },
                }}
              >
                {loading ? 'Loading…' : 'Add layer'}
              </Button>
            </span>
          </Tooltip>
        </Box>
      </Collapse>
    </Box>
  );
}
