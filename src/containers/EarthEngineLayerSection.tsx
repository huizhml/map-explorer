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
  Tooltip,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import AddIcon from '@mui/icons-material/Add';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import type { ReactNode } from 'react';
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
  accent: string;
  accentSolid: string;
  accentOnSolid: string;
  accentTintText: string;
  panelBg: string;
  panelBgAlt: string;
  cardBg: string;
  cardHover: string;
};

/** Outlined secondary card row used for EE presets (icon + title + muted subtitle). */
function PresetRow({
  title,
  subtitle,
  icon,
  active = false,
  onClick,
  ui,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  active?: boolean;
  onClick: () => void;
  ui: EarthEngineSidebarUi;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      sx={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.1,
        py: 0.7,
        textAlign: 'left',
        borderRadius: 2,
        border: `1px solid ${active ? ui.accentBorder : ui.border}`,
        background: active ? ui.accentSoft : ui.cardBg,
        color: ui.textPrimary,
        fontSize: '0.8rem',
        cursor: 'pointer',
        transition: 'background-color 120ms ease, border-color 120ms ease',
        '&:hover': { background: active ? ui.accentSoft : ui.cardHover },
      }}
    >
      <Box sx={{ display: 'flex', fontSize: 18, color: ui.accent }}>
        {icon ?? <MapOutlinedIcon sx={{ fontSize: 18 }} />}
      </Box>
      <Box sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {title}
        {subtitle && <Box component="span" sx={{ color: ui.textMuted }}> · {subtitle}</Box>}
      </Box>
    </Box>
  );
}

/** One-row segmented control; selected segment is filled. */
function EeSegmentedControl({
  options,
  value,
  onChange,
  ui,
}: {
  options: { value: string; label: ReactNode }[];
  value: string | null;
  onChange: (value: string) => void;
  ui: EarthEngineSidebarUi;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        gap: 0.25,
        p: 0.375,
        borderRadius: 2,
        background: ui.buttonBg,
        border: `1px solid ${ui.border}`,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Box
            key={opt.value}
            component="button"
            type="button"
            onClick={() => onChange(opt.value)}
            sx={{
              flex: 1,
              minWidth: 0,
              py: 0.6,
              px: 0.25,
              border: 'none',
              borderRadius: 1.5,
              background: active ? ui.accentSolid : 'transparent',
              color: active ? ui.accentOnSolid : ui.textSecondary,
              fontSize: '0.72rem',
              fontWeight: active ? 700 : 500,
              lineHeight: 1.2,
              textAlign: 'center',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              transition: 'background-color 120ms ease, color 120ms ease',
              '&:hover': { color: active ? '#fff' : ui.textPrimary },
            }}
          >
            {opt.label}
          </Box>
        );
      })}
    </Box>
  );
}

/** Renders a parsed hex list as a flex color band with a count badge. */
function PaletteBar({ colors, ui }: { colors: string[]; ui: EarthEngineSidebarUi }) {
  if (!colors.length) return null;
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        background: ui.fieldBg,
        border: `1px solid ${ui.borderStrong}`,
        borderRadius: 2,
        p: '7px 10px',
      }}
    >
      <Box sx={{ display: 'flex', borderRadius: 1, overflow: 'hidden', flex: 1, height: 18 }}>
        {colors.map((c, i) => (
          <Box key={`${c}-${i}`} sx={{ flex: 1, background: `#${c.replace(/^#/, '')}` }} />
        ))}
      </Box>
      <Box component="span" sx={{ fontSize: '0.7rem', color: ui.textMuted }}>{colors.length}</Box>
    </Box>
  );
}

const JRC_TMF_ANNUAL_CHANGES_PALETTE = ['005A00', '648723', 'FFBE2D', 'D2FA3C', '008CBE', 'FFFFFF'];

/**
 * Friendly layer names keyed by asset id, matching the preset buttons below.
 * A layer added from a preset then reads the same in the layer control as the
 * button that configured it; custom assets fall back to a generated `EE …` name.
 */
const EE_PRESET_LABELS: Record<string, string> = {
  'projects/JRC/TMF/v1_2025/AnnualChanges': 'JRC TMF AnnualChanges',
  'users/potapovpeter/GEDI_V27': 'UMD 30m',
  'users/nlang/ETH_GlobalCanopyHeight_2020_10m_v1': 'ETH 10m',
  'projects/worldwidemap/assets/canopyheight2020': 'UM 10m',
  'projects/meta-forest-monitoring-okw37/assets/CanopyHeight': 'Meta 1m',
  'projects/nature-trace/assets/forest_typology/forest_typology_2020_v1_0_collection':
    'Forest Typology 2020',
};

const FOREST_TYPOLOGY_PALETTE = ['FFFFFF', '008000'];

/** matplotlib "inferno" sampled to hex — used for the canopy-height presets. */
const INFERNO_PALETTE = [
  '000004', '1B0C42', '4B0C6B', '781C6D', 'A52C60',
  'CF4446', 'ED6925', 'FB9B06', 'F7D13D', 'FCFFA4',
];

/**
 * QGIS-style named colormaps for the palette picker, sampled from matplotlib.
 * Picking one fills the palette hex field; the user can still edit it freely.
 */
const PALETTE_COLORMAPS: { name: string; colors: string[] }[] = [
  { name: 'Viridis', colors: ['440154', '472d7b', '3b528b', '2c728e', '21918c', '28ae80', '5ec962', 'addc30', 'fde725'] },
  { name: 'Inferno', colors: ['000004', '1b0c42', '4b0c6b', '781c6d', 'a52c60', 'cf4446', 'ed6925', 'fb9b06', 'fcffa4'] },
  { name: 'Magma', colors: ['000004', '1c1044', '4f127b', '812581', 'b5367a', 'e55064', 'fb8761', 'fec287', 'fcfdbf'] },
  { name: 'Plasma', colors: ['0d0887', '4c02a1', '7e03a8', 'a92395', 'cb4679', 'e56b5d', 'f89441', 'fdc328', 'f0f921'] },
  { name: 'Cividis', colors: ['00204d', '00336f', '39486b', '575d6d', '707173', '8a8779', 'a69d75', 'c4b56c', 'fee838'] },
  { name: 'Turbo', colors: ['30123b', '4458cb', '3e9bfe', '18d6cb', '46f884', 'a4fc3b', 'e1dd37', 'fb8022', 'd23105'] },
  { name: 'Greens', colors: ['f7fcf5', 'e5f5e0', 'c7e9c0', 'a1d99b', '74c476', '41ab5d', '238b45', '006d2c', '00441b'] },
  { name: 'Blues', colors: ['f7fbff', 'deebf7', 'c6dbef', '9ecae1', '6baed6', '4292c6', '2171b5', '08519c', '08306b'] },
  { name: 'Spectral', colors: ['9e0142', 'd53e4f', 'f46d43', 'fdae61', 'fee08b', 'e6f598', 'abdda4', '66c2a5', '3288bd'] },
  { name: 'RdYlGn', colors: ['a50026', 'd73027', 'f46d43', 'fdae61', 'fee08b', 'd9ef8b', 'a6d96a', '66bd63', '1a9850'] },
  { name: 'RdBu', colors: ['67001f', 'b2182b', 'd6604d', 'f4a582', 'f7f7f7', '92c5de', '4393c3', '2166ac', '053061'] },
];

/** Normalize a hex list for comparison: lowercase, no leading '#'. */
function normPalette(colors: string[]): string {
  return colors.map((c) => c.replace(/^#/, '').toLowerCase()).join(',');
}

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

  const [expanded, setExpanded] = useState(() => {
    try {
      const v = localStorage.getItem('exploreVsm.eeOpen');
      return v === null ? true : v === '1';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('exploreVsm.eeOpen', expanded ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [expanded]);
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

  const [customMode, setCustomMode] = useState(false);
  const [editPalette, setEditPalette] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiService
      .getEarthEngineStatus()
      .then(setStatus)
      .catch(() => setStatus({ ee_import_ok: false, credentials_path_set: false, credentials_file_exists: false }));
  }, []);

  const applyPresetJrc = () => {
    setCustomMode(false);
    setAssetId('projects/JRC/TMF/v1_2025/AnnualChanges');
    setAssetKind('image_collection');
    setReduceCollection('mosaic');
    setBand('Dec2020');
    setMaskSelf(true);
    setVisMin('1');
    setVisMax('6');
    setPaletteStr(JRC_TMF_ANNUAL_CHANGES_PALETTE.join(', '));
  };

  /**
   * Canopy-height presets. All are single-band height rasters, so we leave the
   * band field blank (the backend visualizes the lone band directly, avoiding
   * any band-name mismatch). ImageCollections are mosaicked into one image.
   */
  const applyCanopyPreset = (assetId: string, kind: 'image' | 'image_collection', max: string) => {
    setCustomMode(false);
    setAssetId(assetId);
    setAssetKind(kind);
    setReduceCollection('mosaic');
    setBand('');
    setMaskSelf(true);
    setVisMin('0');
    setVisMax(max);
    setPaletteStr(INFERNO_PALETTE.join(', '));
  };

  const CANOPY_PRESETS: {
    value: string;
    label: string;
    kind: 'image' | 'image_collection';
    max: string;
  }[] = [
    { value: 'users/potapovpeter/GEDI_V27', label: 'UMD 30m', kind: 'image_collection', max: '50' },
    { value: 'users/nlang/ETH_GlobalCanopyHeight_2020_10m_v1', label: 'ETH 10m', kind: 'image', max: '50' },
    { value: 'projects/worldwidemap/assets/canopyheight2020', label: 'UM 10m', kind: 'image_collection', max: '5000' },
    { value: 'projects/meta-forest-monitoring-okw37/assets/CanopyHeight', label: 'Meta 1m', kind: 'image_collection', max: '50' },
  ];
  const activeCanopy = customMode ? null : CANOPY_PRESETS.find((p) => p.value === assetId)?.value ?? null;
  const jrcActive = !customMode && assetId === 'projects/JRC/TMF/v1_2025/AnnualChanges';
  const forestActive =
    !customMode &&
    assetId === 'projects/nature-trace/assets/forest_typology/forest_typology_2020_v1_0_collection';
  const matchedColormap =
    PALETTE_COLORMAPS.find((c) => normPalette(c.colors) === normPalette(parsePalette(paletteStr) ?? []))
      ?.name ?? '';

  const applyPresetForestTypology = () => {
    setCustomMode(false);
    setAssetId('projects/nature-trace/assets/forest_typology/forest_typology_2020_v1_0_collection');
    setAssetKind('image_collection');
    setReduceCollection('mosaic');
    setBand('PrimaryForest');
    setMaskSelf(true);
    setVisMin('0');
    setVisMax('250');
    setPaletteStr(FOREST_TYPOLOGY_PALETTE.join(', '));
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
      // Prefer the preset's friendly name (matches the button) when the asset is
      // a known preset; otherwise fall back to the generated `EE …` name.
      const presetLabel = EE_PRESET_LABELS[assetId.trim()] ?? EE_PRESET_LABELS[resolvedAsset];
      const name = presetLabel
        ? `${presetLabel}${labelBand}`
        : `EE ${resolvedAsset.split('/').pop() ?? resolvedAsset}${labelBand}`;

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

  return (
    <Box
      sx={{
        mb: 1.5,
        borderRadius: 2,
        background: ui.panelBgAlt,
        border: `1px solid ${ui.border}`,
        p: 1.25,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          mb: expanded ? 1.25 : 0,
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
        <Box sx={{ display: 'flex', alignItems: 'center', color: ui.textMuted }}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </Box>
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
            Add layers from Google Earth Engine.
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', mb: 0.75, color: ui.textSecondary, fontSize: '0.72rem' }}>
            Presets
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.6, mb: 1.25 }}>
            <PresetRow
              title="JRC TMF AnnualChanges"
              subtitle="Dec 2020"
              active={jrcActive}
              onClick={applyPresetJrc}
              ui={ui}
            />
            <PresetRow
              title="Forest Typology 2020"
              subtitle="nature-trace"
              active={forestActive}
              onClick={applyPresetForestTypology}
              ui={ui}
            />
            <PresetRow
              title="Custom asset"
              subtitle="enter your own"
              icon={<TuneOutlinedIcon sx={{ fontSize: 18 }} />}
              active={customMode}
              onClick={() => setCustomMode(true)}
              ui={ui}
            />
          </Box>
          <Typography variant="caption" sx={{ display: 'block', mb: 0.75, color: ui.textSecondary, fontSize: '0.72rem' }}>
            Canopy height <Box component="span" sx={{ color: ui.textMuted }}>(inferno)</Box>
          </Typography>
          <Box sx={{ mb: 1.25 }}>
            <EeSegmentedControl
              value={activeCanopy}
              onChange={(v) => {
                const p = CANOPY_PRESETS.find((c) => c.value === v);
                if (p) applyCanopyPreset(p.value, p.kind, p.max);
              }}
              options={CANOPY_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
              ui={ui}
            />
          </Box>
          {customMode && (
            <>
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
            </>
          )}
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
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="caption" sx={{ color: ui.fieldLabel }}>Palette</Typography>
            <FormControl size="small" sx={{ minWidth: 130, ...fieldSx(ui) }}>
              <Select
                displayEmpty
                value={matchedColormap}
                onChange={(e) => {
                  const cm = PALETTE_COLORMAPS.find((c) => c.name === e.target.value);
                  if (cm) setPaletteStr(cm.colors.join(', '));
                }}
                variant="standard"
                disableUnderline
                renderValue={(v) => (
                  <Box component="span" sx={{ fontSize: '0.74rem', color: v ? ui.fieldText : ui.textMuted }}>
                    {v || 'Colormap…'}
                  </Box>
                )}
                sx={{ '& .MuiSvgIcon-root': { color: ui.textMuted, fontSize: 18 } }}
                MenuProps={{
                  PaperProps: {
                    sx: { bgcolor: ui.fieldBg, color: ui.fieldText, border: `1px solid ${ui.border}` },
                  },
                }}
              >
                {PALETTE_COLORMAPS.map((cm) => (
                  <MenuItem key={cm.name} value={cm.name}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                      <Box sx={{ display: 'flex', flex: 1, height: 12, borderRadius: 0.5, overflow: 'hidden' }}>
                        {cm.colors.map((c, i) => (
                          <Box key={`${c}-${i}`} sx={{ flex: 1, background: `#${c}` }} />
                        ))}
                      </Box>
                      <Box component="span" sx={{ fontSize: '0.74rem' }}>{cm.name}</Box>
                    </Box>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
          <Tooltip title={editPalette ? 'Hide hex codes' : 'Click to edit hex codes'} placement="top">
            <Box
              onClick={() => setEditPalette((v) => !v)}
              sx={{ mb: 1, cursor: 'pointer', position: 'relative' }}
            >
              <PaletteBar colors={parsePalette(paletteStr) ?? []} ui={ui} />
              <EditOutlinedIcon
                sx={{
                  position: 'absolute',
                  top: '50%',
                  right: 32,
                  transform: 'translateY(-50%)',
                  fontSize: 14,
                  color: editPalette ? ui.accent : ui.textMuted,
                  pointerEvents: 'none',
                }}
              />
            </Box>
          </Tooltip>
          {editPalette && (
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
          )}
          {error && (
            <Alert severity="error" sx={{ mb: 1, bgcolor: ui.buttonBg, color: ui.textSecondary }}>
              {error}
            </Alert>
          )}
          <Tooltip title={!eeReady ? 'Configure EE on the backend first' : ''}>
            <span style={{ display: 'block' }}>
              <Button
                variant="contained"
                disableElevation
                startIcon={<AddIcon />}
                fullWidth
                disabled={loading || !eeReady}
                onClick={addLayer}
                sx={{
                  py: 0.8,
                  fontWeight: 700,
                  textTransform: 'none',
                  backgroundColor: ui.accentSolid,
                  color: ui.accentOnSolid,
                  '&:hover': { backgroundColor: ui.accentSolid, filter: 'brightness(1.08)' },
                  '&:disabled': { backgroundColor: ui.accentSolid, color: ui.accentOnSolid, opacity: 0.45 },
                }}
              >
                {loading ? 'Loading…' : 'Add EE layer'}
              </Button>
            </span>
          </Tooltip>
        </Box>
      </Collapse>
    </Box>
  );
}
