import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import {
  Box,
  Typography,
  Button,
  styled,
  TextField,
  List,
  ListItemText,
  ListItemButton,
  Checkbox,
  FormControlLabel,
  IconButton,
  CircularProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Alert,
  Collapse,
  Tooltip,
} from '@mui/material';
import {
  Layers as LayersIcon,
  CropFree as CropFreeIcon,
  Close as CloseIcon,
  Search as SearchIcon,
  ShowChart as ShowChartIcon,
  UploadFile as UploadFileIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  FolderOpen as FolderOpenIcon,
  ArrowUpward as ArrowUpwardIcon,
  CreateNewFolder as CreateNewFolderIcon,
  DeleteOutline as DeleteOutlineIcon,
  BookmarkBorder as BookmarkBorderIcon,
  Refresh as RefreshIcon,
  MyLocation as MyLocationIcon,
  InfoOutlined as InfoOutlinedIcon,
  SettingsOutlined as SettingsOutlinedIcon,
  SaveAltOutlined as SaveAltOutlinedIcon,
  LightModeOutlined as LightModeOutlinedIcon,
  DarkModeOutlined as DarkModeOutlinedIcon,
  OpenInFull as OpenInFullIcon,
  EditOutlined as EditOutlinedIcon,
} from '@mui/icons-material';
import type { VsmQChoice } from '../constants/predictions';
import type { FigureLayerOverrides } from '../containers/SidebarContainer';
import { apiUrl } from '../utils/apiBase';
import type { SavedFeature } from '../services/savedFeaturesApi';
import { SavedFeatureDialog, type SavedFeatureDialogPrefill } from './SavedFeatureDialog';
import { SavedFeaturePlots } from './SavedFeaturePlots';
import { useMapStore } from '../stores/mapStore';
import { DIVERSITY_HEIGHT_BIN_OPTIONS } from '../constants/diversityMetrics';
import { COLORMAPS } from '../constants/colormaps';
import { EarthEngineLayerSection } from '../containers/EarthEngineLayerSection';

export interface VsmLayerEntryDisplay {
  year: number;
  rhIndex: number;
  qChoice: string;
}

interface SidebarProps {
  // VSM add-layer props
  onAddLayer: () => void;
  addedVsmLayers: VsmLayerEntryDisplay[];
  vsmYear: number;
  onVsmYearChange: (year: number) => void;
  vsmRhIndex: number;
  onVsmRhIndexChange: (rh: number) => void;
  vsmQChoice: VsmQChoice;
  onVsmQChoiceChange: (q: VsmQChoice) => void;
  // Drawing tools props
  drawingActive: boolean;
  drawingMode: 'tiles' | 'figures' | 'figures_db';
  onGetTiles: () => void;
  onCreateFiguresDraw: () => void;
  onCreateDbFiguresDraw: () => void;
  onSaveFiguresToDb: (payload: { name: string; description: string; category: string; tags: string[] }) => void;
  savingFiguresToDb: boolean;
  figuresToDbMessage: string | null;
  figuresToDbError: string | null;
  /** Distinct tags across all saved features, used by the save dialog's tag autocomplete. */
  savedFeatureTags: string[];
  /** Prefill values for the area-images save dialog, computed by the container when
   *  the dialog opens via `onPrepareAreaImageSave`. Null when no prior save matches
   *  the current drawing's geometry. */
  areaImagePrefill: SavedFeatureDialogPrefill | null;
  /** Called when the user clicks "Save area images to DB" — triggers the container
   *  to look up an existing save at the same geometry and refresh tag suggestions. */
  onPrepareAreaImageSave: () => void;
  selectedTiles: string[];
  figureSelectionReady: boolean;
  figureFormat: 'jpg' | 'png' | 'pdf';
  onFigureFormatChange: (format: 'jpg' | 'png' | 'pdf') => void;
  figureOutputFolder: string;
  onFigureOutputFolderChange: (folder: string) => void;
  /** Editable base filename (no extension); backend sanitizes. Empty omits filename_stem → auto layer+location naming. */
  figureFilenameStem: string;
  onFigureFilenameStemChange: (stem: string) => void;
  /** Current automatic stem for “Use default name”. */
  suggestedFigureFilenameStem: string;
  /** Also save a high-resolution Google Satellite snapshot of the drawn area. */
  includeGoogleSatellite: boolean;
  onIncludeGoogleSatelliteChange: (next: boolean) => void;
  /** Burn a metric scale bar into the HD Google Satellite snapshot. */
  includeGoogleSatelliteScaleBar: boolean;
  onIncludeGoogleSatelliteScaleBarChange: (next: boolean) => void;
  availableFigureLayers: Array<{
    id: string;
    name: string;
    bandNames?: string[];
    defaultColormap?: string;
    defaultRescaleMin?: number;
    defaultRescaleMax?: number;
    defaultSelectedBand?: number;
    /** Used to surface a scale-bar toggle on EOX s2cloudless mosaic rows. */
    layerSubType?: string;
    /** Layer type (e.g. 'earthengine') — also surfaces the scale-bar toggle. */
    layerType?: string;
  }>;
  selectedFigureLayerIds: string[];
  onToggleFigureLayer: (layerId: string) => void;
  figureLayerOverrides: Record<string, FigureLayerOverrides>;
  onUpdateFigureLayerOverride: (layerId: string, patch: Partial<FigureLayerOverrides>) => void;
  onSaveFigures: () => void;
  savingFigures: boolean;
  figureSaveMessage: string | null;
  figureSaveError: string | null;
  /** Inspect mode: map clicks sample rasters; bottom-right panel shows values */
  inspectMode: boolean;
  inspectKind: 'layers' | 'vertical_profile' | 'vertical_profile_line';
  onInspectModeChange: (active: boolean) => void;
  onVerticalProfileClick: () => void;
  onVerticalProfileLineClick: () => void;
  savedMapFeatures: SavedFeature[];
  savedFeaturesLoading: boolean;
  savedFeaturesError: string | null;
  onReloadSavedFeatures: () => void;
  deletingSavedFeatureId: number | null;
  updatingSavedFeatureId: number | null;
  /** Feature id currently being re-rendered via the per-feature "Update" button; disables the action while a refresh is in-flight. */
  refreshingPredictionSnapshotId: number | null;
  /** Surfaces refresh failures (e.g. tile missing, render error) per feature. */
  refreshPredictionSnapshotError: { id: number; message: string } | null;
  /** Re-renders the saved RH98 prediction snapshot using the live map's current rescale/colormap. */
  onRefreshPredictionSnapshot: (feature: SavedFeature) => void;
  /** Feature id currently being re-rendered via the area-images "Update" button. */
  refreshingAreaImagesId: number | null;
  /** Surfaces refresh failures (e.g. layer fetch errors) per area-images feature. */
  refreshAreaImagesError: { id: number; message: string } | null;
  /** Re-renders every image attached to a saved area_images polygon from its
   *  stored layer specs. When `square` is set, the polygon is first cropped to
   *  a square on its shortest side and the geometry is updated to match. */
  onRefreshAreaImages: (feature: SavedFeature, options?: {
    square?: boolean;
    includeGoogleSatelliteScaleBar?: boolean;
    includeEoxScaleBar?: boolean;
  }) => void;
  onDeleteSavedFeature: (id: number) => void;
  onUpdateSavedFeature: (id: number, payload: { name: string; description: string; tags: string[] }) => Promise<void>;
  onJumpToFeature: (feature: SavedFeature) => void;
  // File upload
  onUploadFile: (file: File) => Promise<void>;
  uploadingFile: boolean;
  onLoadNaturalnessMap: () => void;
  onLoadForestNaturalnessData: () => void;
  onLoadForestNaturalnessDataVal: () => void;
  fgbPathInput: string;
  onFgbPathInputChange: (value: string) => void;
  onLoadFgbPath: () => void;
  onLoadEoxS2CloudlessMosaic: (year: number) => void;
}

/** EOX s2cloudless mosaic years currently published on tiles.maps.eox.at. */
export const EOX_S2CLOUDLESS_YEARS = [2016, 2018, 2019, 2020, 2021, 2022, 2023, 2024] as const;

const SidebarContainer = styled(Box)(() => ({
  position: 'absolute',
  left: 12,
  top: 12,
  bottom: 12,
  width: 'fit-content',
  zIndex: 1000,
  display: 'flex',
  alignItems: 'stretch',
  gap: 0,
  pointerEvents: 'auto',
}));

type SidebarSurfaceMode = 'dark' | 'light';

type SidebarThemeTokens = {
  railBg: string;
  panelBg: string;
  panelBgAlt: string;
  border: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentSoft: string;
  accentBorder: string;
  buttonBg: string;
  buttonHover: string;
  fieldBg: string;
  fieldText: string;
  fieldLabel: string;
  cardBg: string;
  cardHover: string;
  cardActive: string;
  success: string;
  shadow: string;
};

const SIDEBAR_THEME: Record<SidebarSurfaceMode, SidebarThemeTokens> = {
  dark: {
    railBg: 'linear-gradient(180deg, #14141b 0%, #101016 100%)',
    panelBg: 'linear-gradient(180deg, #1a1a24 0%, #15151d 100%)',
    panelBgAlt: '#111119',
    border: 'rgba(255,255,255,0.08)',
    borderStrong: 'rgba(255,255,255,0.16)',
    textPrimary: '#f4f4fa',
    textSecondary: 'rgba(238,238,247,0.72)',
    textMuted: 'rgba(238,238,247,0.48)',
    accent: '#6c5ce7',
    accentSoft: 'rgba(162,155,254,0.16)',
    accentBorder: 'rgba(162,155,254,0.38)',
    buttonBg: 'rgba(255,255,255,0.04)',
    buttonHover: 'rgba(255,255,255,0.08)',
    fieldBg: '#111119',
    fieldText: '#ececf5',
    fieldLabel: 'rgba(238,238,247,0.52)',
    cardBg: '#15151d',
    cardHover: '#1b1b25',
    cardActive: 'rgba(162,155,254,0.12)',
    success: '#82e5aa',
    shadow: '0 18px 42px rgba(0,0,0,0.28)',
  },
  light: {
    railBg: 'linear-gradient(180deg, #ffffff 0%, #f6f7fb 100%)',
    panelBg: 'linear-gradient(180deg, #ffffff 0%, #f7f8fc 100%)',
    panelBgAlt: '#f1f4fb',
    border: 'rgba(32,41,71,0.12)',
    borderStrong: 'rgba(32,41,71,0.2)',
    textPrimary: '#172033',
    textSecondary: 'rgba(23,32,51,0.78)',
    textMuted: 'rgba(23,32,51,0.5)',
    accent: '#5b4ee8',
    accentSoft: 'rgba(91,78,232,0.12)',
    accentBorder: 'rgba(91,78,232,0.26)',
    buttonBg: 'rgba(23,32,51,0.03)',
    buttonHover: 'rgba(23,32,51,0.07)',
    fieldBg: '#ffffff',
    fieldText: '#172033',
    fieldLabel: 'rgba(23,32,51,0.5)',
    cardBg: '#ffffff',
    cardHover: '#f4f6fb',
    cardActive: 'rgba(91,78,232,0.1)',
    success: '#1f8f4e',
    shadow: '0 18px 42px rgba(31, 45, 74, 0.16)',
  },
};

function HoverHelp({ title, ui }: { title: string; ui: SidebarThemeTokens }) {
  return (
    <Tooltip title={title} arrow placement="top">
      <IconButton component="span" size="small" sx={{ color: ui.textMuted }} aria-label="More information">
        <InfoOutlinedIcon fontSize="inherit" />
      </IconButton>
    </Tooltip>
  );
}

function SectionLabel({ children, ui }: { children: ReactNode; ui: SidebarThemeTokens }) {
  return (
    <Typography
      variant="caption"
      sx={{
        display: 'block',
        mb: 0.75,
        color: ui.textMuted,
        fontSize: '0.7rem',
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </Typography>
  );
}

function RailButton({
  active,
  label,
  icon,
  onClick,
  ui,
}: {
  active: boolean;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  ui: SidebarThemeTokens;
}) {
  return (
    <Tooltip title={label} placement="right" arrow>
      <Box
        component="button"
        type="button"
        onClick={onClick}
        sx={{
          width: 42,
          minHeight: 48,
          px: 0.5,
          py: 0.75,
          border: 'none',
          borderRadius: 2.5,
          background: active ? ui.accentSoft : 'transparent',
          color: active ? ui.accent : ui.textMuted,
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0.5,
          transition: 'background-color 120ms ease, color 120ms ease, transform 120ms ease',
          '&:hover': {
            background: active ? ui.accentSoft : ui.buttonHover,
            color: active ? ui.accent : ui.textSecondary,
            transform: 'translateY(-1px)',
          },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, lineHeight: 1 }}>
          {icon}
        </Box>
        <Typography sx={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.02em', lineHeight: 1.1 }}>
          {label}
        </Typography>
      </Box>
    </Tooltip>
  );
}

function SelectionChip({
  label,
  active,
  onClick,
  ui,
}: {
  label: ReactNode;
  active: boolean;
  onClick: () => void;
  ui: SidebarThemeTokens;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      sx={{
        px: 1.25,
        py: 0.65,
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: active ? ui.accentBorder : ui.border,
        background: active ? ui.accentSoft : ui.buttonBg,
        color: active ? ui.accent : ui.textSecondary,
        fontSize: '0.75rem',
        fontWeight: active ? 700 : 500,
        lineHeight: 1.2,
        cursor: 'pointer',
        transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease',
        '&:hover': {
          background: active ? ui.accentSoft : ui.buttonHover,
          borderColor: active ? ui.accentBorder : ui.borderStrong,
        },
      }}
    >
      {label}
    </Box>
  );
}

function PanelActionCard({
  icon,
  label,
  description,
  active = false,
  onClick,
  ui,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  active?: boolean;
  onClick: () => void;
  ui: SidebarThemeTokens;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      sx={{
        p: 1.4,
        borderRadius: 2.5,
        border: '1px solid',
        borderColor: active ? ui.accentBorder : ui.border,
        background: active ? ui.cardActive : ui.cardBg,
        color: ui.textPrimary,
        cursor: 'pointer',
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.8,
        transition: 'background-color 120ms ease, border-color 120ms ease, transform 120ms ease',
        '&:hover': {
          background: active ? ui.cardActive : ui.cardHover,
          transform: 'translateY(-1px)',
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box sx={{ color: active ? ui.accent : ui.textMuted, display: 'flex', alignItems: 'center', fontSize: 18 }}>
          {icon}
        </Box>
        <HoverHelp title={description} ui={ui} />
      </Box>
      <Box>
        <Typography sx={{ fontSize: '0.9rem', fontWeight: 700, color: ui.textPrimary }}>
          {label}
        </Typography>
        <Typography sx={{ mt: 0.35, fontSize: '0.78rem', color: ui.textMuted, lineHeight: 1.45 }}>
          {description}
        </Typography>
      </Box>
    </Box>
  );
}

export function Sidebar({
  onAddLayer,
  addedVsmLayers,
  vsmYear,
  onVsmYearChange,
  vsmRhIndex,
  onVsmRhIndexChange,
  vsmQChoice,
  onVsmQChoiceChange,
  drawingActive,
  drawingMode,
  onGetTiles,
  onCreateFiguresDraw,
  onCreateDbFiguresDraw,
  onSaveFiguresToDb,
  savingFiguresToDb,
  figuresToDbMessage,
  figuresToDbError,
  selectedTiles,
  figureSelectionReady,
  figureFormat,
  onFigureFormatChange,
  figureOutputFolder,
  onFigureOutputFolderChange,
  figureFilenameStem,
  onFigureFilenameStemChange,
  suggestedFigureFilenameStem,
  includeGoogleSatellite,
  onIncludeGoogleSatelliteChange,
  includeGoogleSatelliteScaleBar,
  onIncludeGoogleSatelliteScaleBarChange,
  availableFigureLayers,
  selectedFigureLayerIds,
  onToggleFigureLayer,
  figureLayerOverrides,
  onUpdateFigureLayerOverride,
  onSaveFigures,
  savingFigures,
  figureSaveMessage,
  figureSaveError,
  inspectMode,
  inspectKind,
  onInspectModeChange,
  onVerticalProfileClick,
  onVerticalProfileLineClick,
  savedMapFeatures,
  savedFeaturesLoading,
  savedFeaturesError,
  onReloadSavedFeatures,
  deletingSavedFeatureId,
  updatingSavedFeatureId,
  refreshingPredictionSnapshotId,
  refreshPredictionSnapshotError,
  onRefreshPredictionSnapshot,
  refreshingAreaImagesId,
  refreshAreaImagesError,
  onRefreshAreaImages,
  onDeleteSavedFeature,
  onUpdateSavedFeature,
  onJumpToFeature,
  onUploadFile,
  uploadingFile,
  onLoadNaturalnessMap,
  onLoadForestNaturalnessData,
  onLoadForestNaturalnessDataVal,
  fgbPathInput,
  onFgbPathInputChange,
  onLoadFgbPath,
  onLoadEoxS2CloudlessMosaic,
  savedFeatureTags,
  areaImagePrefill,
  onPrepareAreaImageSave,
}: SidebarProps) {
  const diversityHeightBinM = useMapStore((s) => s.diversityHeightBinM);
  const setDiversityHeightBinM = useMapStore((s) => s.setDiversityHeightBinM);
  const [showAddedInfo, setShowAddedInfo] = useState(true);
  const [eoxMosaicYear, setEoxMosaicYear] = useState<number>(
    EOX_S2CLOUDLESS_YEARS.includes(2020 as (typeof EOX_S2CLOUDLESS_YEARS)[number])
      ? 2020
      : EOX_S2CLOUDLESS_YEARS[EOX_S2CLOUDLESS_YEARS.length - 1],
  );
  const [expandedFigureLayer, setExpandedFigureLayer] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<'layers' | 'tools' | 'saved' | 'export' | null>('layers');
  const [surfaceMode, setSurfaceMode] = useState<SidebarSurfaceMode>('dark');
  const [plotViewerFeature, setPlotViewerFeature] = useState<SavedFeature | null>(null);
  const [plotViewerRect, setPlotViewerRect] = useState({ x: 120, y: 120, width: 720, height: 520 });
  const [plotViewerDragMode, setPlotViewerDragMode] = useState<'move' | 'resize' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const plotViewerDragRef = useRef<{ mouseX: number; mouseY: number; rect: typeof plotViewerRect } | null>(null);
  const plotViewerPanelRef = useRef<HTMLDivElement | null>(null);

  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [browsingPath, setBrowsingPath] = useState('');
  const [dirEntries, setDirEntries] = useState<string[]>([]);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [savedSearch, setSavedSearch] = useState('');
  const [expandedSavedId, setExpandedSavedId] = useState<number | null>(null);
  const [expandedSavedPropsId, setExpandedSavedPropsId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [savedCategoryFilter, setSavedCategoryFilter] = useState<string>('');
  const [savedTypeFilter, setSavedTypeFilter] = useState<string>('');
  // Feature ids whose "square" checkbox is ticked — when set, the area-image
  // Update will crop the polygon to a square on its shortest side.
  const [squareAreaFeatureIds, setSquareAreaFeatureIds] = useState<Set<number>>(new Set());
  // Feature ids whose HD Google Satellite scale-bar checkbox has been *explicitly
  // turned off* for the next Update. Stored as opt-OUT so the default (on)
  // matches the save-time behaviour without us having to seed every row.
  const [refreshSuppressSatBarIds, setRefreshSuppressSatBarIds] = useState<Set<number>>(new Set());
  // Same pattern for the EOX s2cloudless mosaic scale bar on Update.
  const [refreshSuppressEoxBarIds, setRefreshSuppressEoxBarIds] = useState<Set<number>>(new Set());
  const [editingSavedId, setEditingSavedId] = useState<number | null>(null);
  const [editSavedName, setEditSavedName] = useState('');
  const [editSavedDescription, setEditSavedDescription] = useState('');
  const [editSavedTags, setEditSavedTags] = useState('');
  const [openDbSaveDialog, setOpenDbSaveDialog] = useState(false);

  const savedCategories = Array.from(new Set(savedMapFeatures.map((f) => f.category).filter(Boolean))) as string[];

  const filteredSavedFeatures = savedMapFeatures.filter((f) => {
    if (savedTypeFilter && f.geometry.type !== savedTypeFilter) return false;
    if (savedCategoryFilter && f.category !== savedCategoryFilter) return false;
    if (savedSearch.trim()) {
      const q = savedSearch.trim().toLowerCase();
      try {
        if (!new RegExp(q, 'i').test(f.name)) return false;
      } catch {
        if (!f.name.toLowerCase().includes(q)) return false;
      }
    }
    return true;
  });

  const fetchDirs = useCallback(async (dirPath: string) => {
    setLoadingDirs(true);
    try {
      const resp = await fetch(apiUrl(`/auxiliary/list-dirs?path=${encodeURIComponent(dirPath)}`));
      const data = await resp.json();
      setBrowsingPath(data.path || dirPath);
      setDirEntries(data.dirs || []);
    } catch {
      setDirEntries([]);
    } finally {
      setLoadingDirs(false);
    }
  }, []);

  const handleOpenBrowser = useCallback(() => {
    setShowFolderBrowser(true);
    fetchDirs(figureOutputFolder || '');
  }, [figureOutputFolder, fetchDirs]);

  const handleSelectDir = useCallback((dir: string) => {
    const newPath = browsingPath ? `${browsingPath}/${dir}` : dir;
    fetchDirs(newPath);
  }, [browsingPath, fetchDirs]);

  const handleGoUp = useCallback(() => {
    const parent = browsingPath.replace(/\/[^/]+\/?$/, '') || '/';
    fetchDirs(parent);
  }, [browsingPath, fetchDirs]);

  const handleConfirmFolder = useCallback(() => {
    onFigureOutputFolderChange(browsingPath);
    setShowFolderBrowser(false);
  }, [browsingPath, onFigureOutputFolderChange]);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    const fullPath = `${browsingPath}/${newFolderName.trim()}`;
    onFigureOutputFolderChange(fullPath);
    setNewFolderName('');
    setShowNewFolder(false);
    setShowFolderBrowser(false);
  }, [browsingPath, newFolderName, onFigureOutputFolderChange]);

  useEffect(() => {
    if (addedVsmLayers.length === 0) return;
    setShowAddedInfo(true);
    const t = setTimeout(() => setShowAddedInfo(false), 10000);
    return () => clearTimeout(t);
  }, [addedVsmLayers]);

  useEffect(() => {
    if (!plotViewerDragMode || !plotViewerDragRef.current) return;

    const handleMove = (event: MouseEvent) => {
      const start = plotViewerDragRef.current;
      const panelEl = plotViewerPanelRef.current;
      if (!start || !panelEl) return;
      const dx = event.clientX - start.mouseX;
      const dy = event.clientY - start.mouseY;

      if (plotViewerDragMode === 'move') {
        const maxX = Math.max(24, window.innerWidth - start.rect.width - 24);
        const maxY = Math.max(24, window.innerHeight - start.rect.height - 24);
        const nextRect = {
          ...start.rect,
          x: Math.min(Math.max(24, start.rect.x + dx), maxX),
          y: Math.min(Math.max(24, start.rect.y + dy), maxY),
        };
        panelEl.style.left = `${nextRect.x}px`;
        panelEl.style.top = `${nextRect.y}px`;
        return;
      }

      const nextRect = {
        ...start.rect,
        width: Math.max(480, Math.min(window.innerWidth - start.rect.x - 24, start.rect.width + dx)),
        height: Math.max(360, Math.min(window.innerHeight - start.rect.y - 24, start.rect.height + dy)),
      };
      panelEl.style.width = `${nextRect.width}px`;
      panelEl.style.height = `${nextRect.height}px`;
    };

    const handleUp = () => {
      const start = plotViewerDragRef.current;
      const panelEl = plotViewerPanelRef.current;
      if (start && panelEl) {
        setPlotViewerRect({
          x: Math.round(parseFloat(panelEl.style.left || `${start.rect.x}`)),
          y: Math.round(parseFloat(panelEl.style.top || `${start.rect.y}`)),
          width: Math.round(parseFloat(panelEl.style.width || `${start.rect.width}`)),
          height: Math.round(parseFloat(panelEl.style.height || `${start.rect.height}`)),
        });
      }
      setPlotViewerDragMode(null);
      plotViewerDragRef.current = null;
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [plotViewerDragMode]);

  const ui = SIDEBAR_THEME[surfaceMode];
  const plotViewerUi = SIDEBAR_THEME.light;
  const openPlotViewer = useCallback((feature: SavedFeature) => {
    const width = Math.max(520, Math.round(window.innerWidth * 0.5));
    const height = Math.max(400, Math.round(window.innerHeight * 0.5));
    setPlotViewerRect({
      width,
      height,
      x: Math.max(24, Math.round((window.innerWidth - width) / 2)),
      y: Math.max(24, Math.round((window.innerHeight - height) / 2)),
    });
    setPlotViewerFeature(feature);
    setPlotViewerDragMode(null);
    plotViewerDragRef.current = null;
  }, []);

  return (
    <SidebarContainer>
      <Box
        sx={{
          width: 58,
          borderTopLeftRadius: 4,
          borderBottomLeftRadius: 4,
          borderTopRightRadius: activePanel ? 0 : 4,
          borderBottomRightRadius: activePanel ? 0 : 4,
          background: ui.railBg,
          border: `1px solid ${ui.border}`,
          boxShadow: ui.shadow,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          p: 1,
          gap: 0.5,
          overflow: 'hidden',
        }}
      >
        <RailButton
          active={activePanel === 'layers'}
          label="Layers"
          icon={<LayersIcon fontSize="inherit" />}
          onClick={() => setActivePanel(activePanel === 'layers' ? null : 'layers')}
          ui={ui}
        />
        <RailButton
          active={activePanel === 'tools'}
          label="Tools"
          icon={<SettingsOutlinedIcon fontSize="inherit" />}
          onClick={() => setActivePanel(activePanel === 'tools' ? null : 'tools')}
          ui={ui}
        />
        <RailButton
          active={activePanel === 'saved'}
          label="Saved"
          icon={<BookmarkBorderIcon fontSize="inherit" />}
          onClick={() => setActivePanel(activePanel === 'saved' ? null : 'saved')}
          ui={ui}
        />
        <RailButton
          active={activePanel === 'export'}
          label="Export"
          icon={<SaveAltOutlinedIcon fontSize="inherit" />}
          onClick={() => setActivePanel(activePanel === 'export' ? null : 'export')}
          ui={ui}
        />
        <IconButton
          size="small"
          onClick={() => setSurfaceMode(surfaceMode === 'dark' ? 'light' : 'dark')}
          aria-label={surfaceMode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          sx={{
            mt: 'auto',
            color: ui.textMuted,
            border: `1px solid ${ui.border}`,
            backgroundColor: ui.buttonBg,
            '&:hover': { backgroundColor: ui.buttonHover },
          }}
        >
          {surfaceMode === 'dark' ? <LightModeOutlinedIcon fontSize="small" /> : <DarkModeOutlinedIcon fontSize="small" />}
        </IconButton>
      </Box>

      {activePanel && (
        <Box
          sx={{
            width: { xs: 280, sm: 306 },
            ml: '-1px',
            borderTopRightRadius: 4,
            borderBottomRightRadius: 4,
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0,
            background: ui.panelBg,
            border: `1px solid ${ui.border}`,
            boxShadow: ui.shadow,
            color: ui.textSecondary,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <Box sx={{ px: 2, py: 1.75, borderBottom: `1px solid ${ui.border}` }}>
            <Typography sx={{ fontSize: '1rem', fontWeight: 800, letterSpacing: '-0.01em', color: ui.textPrimary }}>
              {activePanel === 'layers' && 'Explore VSM'}
              {activePanel === 'tools' && 'Tools'}
              {activePanel === 'saved' && 'Saved'}
              {activePanel === 'export' && 'Export'}
            </Typography>
          </Box>

          <Box sx={{ p: 2, overflowY: 'auto', flex: 1 }}>
            {activePanel === 'layers' && (
              <Box>
                <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
                  <TextField
                    label="Year"
                    type="number"
                    value={vsmYear}
                    onChange={(e) => {
                      const v = parseInt(e.target.value);
                      if (!isNaN(v)) onVsmYearChange(v);
                    }}
                    size="small"
                    fullWidth
                    inputProps={{ min: 2015, max: 2030 }}
                    sx={{
                      '& .MuiOutlinedInput-root': { backgroundColor: ui.fieldBg, color: ui.fieldText },
                      '& .MuiInputLabel-root': { color: ui.fieldLabel },
                    }}
                  />
                  <TextField
                    label="RH index"
                    type="number"
                    value={vsmRhIndex}
                    onChange={(e) => {
                      const v = parseInt(e.target.value);
                      if (!isNaN(v)) onVsmRhIndexChange(v);
                    }}
                    size="small"
                    fullWidth
                    sx={{
                      '& .MuiOutlinedInput-root': { backgroundColor: ui.fieldBg, color: ui.fieldText },
                      '& .MuiInputLabel-root': { color: ui.fieldLabel },
                    }}
                  />
                </Box>

                <SectionLabel ui={ui}>Quantiles</SectionLabel>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 1.75 }}>
                  <SelectionChip label="5%" active={vsmQChoice === '5%'} onClick={() => onVsmQChoiceChange('5%')} ui={ui} />
                  <SelectionChip label="Median" active={vsmQChoice === 'median'} onClick={() => onVsmQChoiceChange('median')} ui={ui} />
                  <SelectionChip label="95%" active={vsmQChoice === '95%'} onClick={() => onVsmQChoiceChange('95%')} ui={ui} />
                </Box>

                <SectionLabel ui={ui}>Intervals</SectionLabel>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 1.75 }}>
                  <SelectionChip label="95%-5%" active={vsmQChoice === '95%-5%'} onClick={() => onVsmQChoiceChange('95%-5%')} ui={ui} />
                  <SelectionChip label="95%-50%" active={vsmQChoice === '95%-50%'} onClick={() => onVsmQChoiceChange('95%-50%')} ui={ui} />
                  <SelectionChip label="50%-5%" active={vsmQChoice === '50%-5%'} onClick={() => onVsmQChoiceChange('50%-5%')} ui={ui} />
                </Box>

                <SectionLabel ui={ui}>Skewness</SectionLabel>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 2 }}>
                  <SelectionChip
                    label={
                      <span>
                        (Q<sub>0.95</sub> - Q<sub>0.50</sub>) - (Q<sub>0.50</sub> - Q<sub>0.05</sub>)
                      </span>
                    }
                    active={vsmQChoice === 'skewness'}
                    onClick={() => onVsmQChoiceChange('skewness')}
                    ui={ui}
                  />
                </Box>

                <Button
                  variant="outlined"
                  onClick={onAddLayer}
                  fullWidth
                  sx={{
                    borderStyle: 'dashed',
                    borderColor: ui.borderStrong,
                    color: ui.textSecondary,
                    py: 1,
                    '&:hover': { borderStyle: 'dashed', borderColor: ui.accentBorder, backgroundColor: ui.accentSoft },
                  }}
                >
                  + Add Layer
                </Button>

                <Box sx={{ mt: 1, display: 'flex', gap: 1, alignItems: 'stretch' }}>
                  <FormControl size="small" sx={{ minWidth: 96 }}>
                    <InputLabel sx={{ color: ui.fieldLabel }}>Year</InputLabel>
                    <Select
                      label="Year"
                      value={eoxMosaicYear}
                      onChange={(e) => setEoxMosaicYear(Number(e.target.value))}
                      sx={{
                        backgroundColor: ui.fieldBg,
                        color: ui.fieldText,
                        '& .MuiSvgIcon-root': { color: ui.fieldLabel },
                      }}
                    >
                      {EOX_S2CLOUDLESS_YEARS.map((y) => (
                        <MenuItem key={y} value={y}>{y}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Button
                    variant="outlined"
                    onClick={() => onLoadEoxS2CloudlessMosaic(eoxMosaicYear)}
                    sx={{
                      flex: 1,
                      borderStyle: 'dashed',
                      borderColor: ui.borderStrong,
                      color: ui.textSecondary,
                      py: 1,
                      textTransform: 'none',
                      '&:hover': { borderStyle: 'dashed', borderColor: ui.accentBorder, backgroundColor: ui.accentSoft },
                    }}
                  >
                    Load cloud free sentinel-2 mosaic
                  </Button>
                </Box>

                <Button
                  variant="outlined"
                  onClick={onLoadNaturalnessMap}
                  fullWidth
                  sx={{
                    mt: 1,
                    borderStyle: 'dashed',
                    borderColor: ui.borderStrong,
                    color: ui.textSecondary,
                    py: 1,
                    textTransform: 'none',
                    '&:hover': { borderStyle: 'dashed', borderColor: ui.accentBorder, backgroundColor: ui.accentSoft },
                  }}
                >
                  Load naturalness map
                </Button>
                <Button
                  variant="outlined"
                  onClick={onLoadForestNaturalnessData}
                  fullWidth
                  sx={{
                    mt: 1,
                    borderStyle: 'dashed',
                    borderColor: ui.borderStrong,
                    color: ui.textSecondary,
                    py: 1,
                    textTransform: 'none',
                    '&:hover': { borderStyle: 'dashed', borderColor: ui.accentBorder, backgroundColor: ui.accentSoft },
                  }}
                >
                  Load forest naturalness data
                </Button>
                <Button
                  variant="outlined"
                  onClick={onLoadForestNaturalnessDataVal}
                  fullWidth
                  sx={{
                    mt: 1,
                    borderStyle: 'dashed',
                    borderColor: ui.borderStrong,
                    color: ui.textSecondary,
                    py: 1,
                    textTransform: 'none',
                    '&:hover': { borderStyle: 'dashed', borderColor: ui.accentBorder, backgroundColor: ui.accentSoft },
                  }}
                >
                  Load forest naturalness data (val)
                </Button>

                <TextField
                  label="FlatGeobuf path"
                  placeholder="/path/to/file.fgb"
                  value={fgbPathInput}
                  onChange={(e) => onFgbPathInputChange(e.target.value)}
                  size="small"
                  fullWidth
                  sx={{
                    mt: 1,
                    '& .MuiOutlinedInput-root': { backgroundColor: ui.fieldBg, color: ui.fieldText },
                    '& .MuiInputLabel-root': { color: ui.fieldLabel },
                  }}
                />
                <Button
                  variant="outlined"
                  onClick={onLoadFgbPath}
                  fullWidth
                  disabled={!fgbPathInput.trim()}
                  sx={{
                    mt: 1,
                    borderStyle: 'dashed',
                    borderColor: ui.borderStrong,
                    color: ui.textSecondary,
                    py: 1,
                    textTransform: 'none',
                    '&:hover': { borderStyle: 'dashed', borderColor: ui.accentBorder, backgroundColor: ui.accentSoft },
                  }}
                >
                  Load fbg layer
                </Button>

                <EarthEngineLayerSection ui={ui} />

                {addedVsmLayers.length > 0 && showAddedInfo && (
                  <Box
                    sx={{
                      mt: 1.25,
                      p: 1.1,
                      borderRadius: 2,
                      backgroundColor: ui.buttonBg,
                      border: `1px solid ${ui.border}`,
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 0.5,
                    }}
                  >
                    <Typography variant="caption" sx={{ flex: 1, color: ui.textMuted, lineHeight: 1.45 }}>
                      Added: {addedVsmLayers.map((e) => `${e.year} (RH${e.rhIndex}, ${e.qChoice})`).join('; ')}
                    </Typography>
                    <IconButton size="small" onClick={() => setShowAddedInfo(false)} aria-label="Dismiss" sx={{ color: ui.textMuted, mt: -0.4, mr: -0.4 }}>
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Box>
                )}
              </Box>
            )}

            {activePanel === 'tools' && (
              <Box>                
                <Box sx={{ mt: 1.5 }}>
                  <SectionLabel ui={ui}>Diversity metrics</SectionLabel>
                  <FormControl size="small" fullWidth sx={{ mt: 0.5 }}>
                    <InputLabel id="diversity-height-bin-label">Height bin (m)</InputLabel>
                    <Select
                      labelId="diversity-height-bin-label"
                      label="Height bin (m)"
                      value={diversityHeightBinM}
                      onChange={(e) => setDiversityHeightBinM(Number(e.target.value))}
                    >
                      {DIVERSITY_HEIGHT_BIN_OPTIONS.map((m) => (
                        <MenuItem key={m} value={m}>{m} m</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Typography variant="caption" sx={{ display: 'block', mt: 0.75, color: ui.textMuted, lineHeight: 1.4 }}>
                    FHD, ENL, and CR: one global step for height bins (GEDI compare, V-Profile, transect). Change and re-sample to apply.
                  </Typography>
                </Box>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                  <PanelActionCard
                    icon={<SearchIcon fontSize="inherit" />}
                    label={inspectMode && inspectKind === 'layers' ? 'Inspect On' : 'Inspect'}
                    description={inspectMode && inspectKind === 'layers'
                      ? 'Click the map to send all raster values, including hidden layers, to the inspect panel.'
                      : 'Sample all COG layers at the clicked location, including hidden layers.'}
                    active={inspectMode && inspectKind === 'layers'}
                    onClick={() => onInspectModeChange(!inspectMode || inspectKind !== 'layers')}
                    ui={ui}
                  />
                  <PanelActionCard
                    icon={<ShowChartIcon fontSize="inherit" />}
                    label={inspectMode && inspectKind === 'vertical_profile' ? 'V-Profile On' : 'V-Profile'}
                    description={inspectMode && inspectKind === 'vertical_profile'
                      ? `Click the map to sample the original RH0-RH100 (Q1) profile for ${vsmYear}.`
                      : 'Inspect a single vertical profile from the original prediction COGs.'}
                    active={inspectMode && inspectKind === 'vertical_profile'}
                    onClick={onVerticalProfileClick}
                    ui={ui}
                  />
                  <PanelActionCard
                    icon={<ShowChartIcon fontSize="inherit" />}
                    label={inspectMode && inspectKind === 'vertical_profile_line' ? 'Transect On' : 'Transect'}
                    description={inspectMode && inspectKind === 'vertical_profile_line'
                      ? `Draw a line on the map to sample full RH0-RH100 profiles for ${vsmYear}.`
                      : 'Draw a transect to sample multiple vertical profiles along a line.'}
                    active={inspectMode && inspectKind === 'vertical_profile_line'}
                    onClick={onVerticalProfileLineClick}
                    ui={ui}
                  />
                  <PanelActionCard
                    icon={uploadingFile ? <CircularProgress size={18} color="inherit" /> : <UploadFileIcon fontSize="inherit" />}
                    label={uploadingFile ? 'Uploading' : 'Upload'}
                    description='Import CSV, GeoJSON, FlatGeobuf, or zipped Shapefiles.'
                    active={uploadingFile}
                    onClick={() => fileInputRef.current?.click()}
                    ui={ui}
                  />
                  <PanelActionCard
                    icon={<CropFreeIcon fontSize="inherit" />}
                    label={drawingActive && drawingMode === 'tiles' ? 'Tiles On' : 'Tiles'}
                    description={drawingActive && drawingMode === 'tiles'
                      ? 'Drag a rectangle on the map to select tiles.'
                      : 'Start rectangle drawing to collect tile IDs from the map.'}
                    active={drawingActive && drawingMode === 'tiles'}
                    onClick={onGetTiles}
                    ui={ui}
                  />
                  <PanelActionCard
                    icon={<CropFreeIcon fontSize="inherit" />}
                    label={drawingActive && drawingMode === 'figures_db' ? 'DB Images On' : 'DB Images'}
                    description={drawingActive && drawingMode === 'figures_db'
                      ? 'Drag a rectangle, then save polygon + extracted images to database.'
                      : 'Draw a rectangle and save area images to the database.'}
                    active={drawingActive && drawingMode === 'figures_db'}
                    onClick={onCreateDbFiguresDraw}
                    ui={ui}
                  />
                </Box>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.tsv,.geojson,.json,.fgb,.zip"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onUploadFile(f);
                    e.target.value = '';
                  }}
                />

                {(figureSelectionReady || selectedTiles.length > 0) && (
                  <Box
                    sx={{
                      mt: 1.5,
                      p: 1.1,
                      borderRadius: 2,
                      backgroundColor: ui.buttonBg,
                      border: `1px solid ${ui.border}`,
                    }}
                  >
                    {figureSelectionReady && (
                      <Typography variant="caption" sx={{ display: 'block', color: '#82e5aa', mb: selectedTiles.length > 0 ? 0.75 : 0 }}>
                        Figure area selected
                      </Typography>
                    )}
                    {selectedTiles.length > 0 && (
                      <Typography variant="caption" sx={{ color: ui.textMuted }}>
                        Selected tiles ({selectedTiles.length}): {selectedTiles.slice(0, 4).join(', ')}
                        {selectedTiles.length > 4 ? '…' : ''}
                      </Typography>
                    )}
                  </Box>
                )}
                {((drawingMode === 'figures_db') || (figureSelectionReady && drawingMode !== 'figures')) && (
                  <Box sx={{ mt: 1.1 }}>
                    <SectionLabel ui={ui}>Layers To Save</SectionLabel>
                    <Box sx={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${ui.border}`, borderRadius: 2, p: 1, backgroundColor: ui.panelBgAlt }}>
                      {availableFigureLayers.length === 0 ? (
                        <Typography variant="caption" sx={{ color: ui.textMuted }}>
                          No exportable layers found
                        </Typography>
                      ) : (
                        availableFigureLayers.map((layer) => {
                          const isChecked = selectedFigureLayerIds.includes(layer.id);
                          const isExpanded = expandedFigureLayer === layer.id;
                          const ovr = figureLayerOverrides[layer.id];
                          const hasBands = layer.bandNames && layer.bandNames.length > 1;
                          return (
                            <Box key={layer.id} sx={{ mb: 0.75, borderRadius: 1.5, border: `1px solid ${ui.border}`, backgroundColor: isChecked ? ui.accentSoft : ui.buttonBg }}>
                              <Box sx={{ display: 'flex', alignItems: 'center', px: 0.5 }}>
                                <Checkbox
                                  size="small"
                                  checked={isChecked}
                                  onChange={() => onToggleFigureLayer(layer.id)}
                                  sx={{ color: ui.textMuted }}
                                />
                                <Typography
                                  variant="caption"
                                  sx={{ flex: 1, cursor: 'pointer', userSelect: 'none', color: ui.textPrimary }}
                                  onClick={() => setExpandedFigureLayer(isExpanded ? null : layer.id)}
                                >
                                  {layer.name}
                                  {hasBands && ` (${layer.bandNames!.length} bands)`}
                                </Typography>
                                <IconButton size="small" onClick={() => setExpandedFigureLayer(isExpanded ? null : layer.id)} sx={{ color: ui.textMuted }}>
                                  {isExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                                </IconButton>
                              </Box>
                              <Collapse in={isExpanded}>
                                <Box sx={{ pl: 1.75, pr: 1, pb: 1, display: 'flex', flexDirection: 'column', gap: 0.9 }}>
                                  {hasBands && (
                                    <>
                                      <Typography variant="caption" sx={{ color: ui.textMuted }}>Bands</Typography>
                                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.25 }}>
                                        {layer.bandNames!.map((bname, idx) => {
                                          const bi = idx + 1;
                                          const selected = ovr?.selectedBands?.includes(bi) ?? false;
                                          return (
                                            <FormControlLabel
                                              key={bi}
                                              control={
                                                <Checkbox
                                                  size="small"
                                                  checked={selected}
                                                  onChange={() => {
                                                    const prev = ovr?.selectedBands ?? [];
                                                    const next = selected ? prev.filter((b) => b !== bi) : [...prev, bi];
                                                    onUpdateFigureLayerOverride(layer.id, { selectedBands: next });
                                                  }}
                                                  sx={{ color: ui.textMuted }}
                                                />
                                              }
                                              label={<Typography variant="caption" sx={{ color: ui.textPrimary }}>{bname}</Typography>}
                                              sx={{ m: 0, mr: 0.5 }}
                                            />
                                          );
                                        })}
                                      </Box>
                                    </>
                                  )}
                                  {layer.layerType === 'prediction' && (
                                    <FormControlLabel
                                      sx={{ m: 0 }}
                                      control={
                                        <Checkbox
                                          size="small"
                                          checked={ovr?.includeColorbar !== false}
                                          onChange={(e) => onUpdateFigureLayerOverride(layer.id, { includeColorbar: e.target.checked })}
                                          sx={{ color: ui.textMuted }}
                                        />
                                      }
                                      label={<Typography variant="caption" sx={{ color: ui.textPrimary }}>Include colorbar</Typography>}
                                    />
                                  )}
                                  {(layer.layerSubType === 's2cloudless_mosaic' || layer.layerType === 'earthengine') && (
                                    <FormControlLabel
                                      sx={{ m: 0 }}
                                      control={
                                        <Checkbox
                                          size="small"
                                          checked={ovr?.includeScaleBar !== false}
                                          onChange={(e) => onUpdateFigureLayerOverride(layer.id, { includeScaleBar: e.target.checked })}
                                          sx={{ color: ui.textMuted }}
                                        />
                                      }
                                      label={<Typography variant="caption" sx={{ color: ui.textPrimary }}>Include scale bar</Typography>}
                                    />
                                  )}
                                </Box>
                              </Collapse>
                            </Box>
                          );
                        })
                      )}
                    </Box>
                  </Box>
                )}

                <FormControlLabel
                  sx={{ mt: 0.5, mb: -0.5 }}
                  control={
                    <Checkbox
                      size="small"
                      checked={includeGoogleSatellite}
                      onChange={(e) => onIncludeGoogleSatelliteChange(e.target.checked)}
                    />
                  }
                  label={
                    <Typography variant="body2" sx={{ color: ui.text }}>
                      Also save HD Google Satellite snapshot
                    </Typography>
                  }
                />
                <FormControlLabel
                  sx={{ ml: 2.5, mt: -0.25, mb: -0.5 }}
                  disabled={!includeGoogleSatellite}
                  control={
                    <Checkbox
                      size="small"
                      checked={includeGoogleSatelliteScaleBar}
                      onChange={(e) => onIncludeGoogleSatelliteScaleBarChange(e.target.checked)}
                    />
                  }
                  label={
                    <Typography variant="caption" sx={{ color: includeGoogleSatellite ? ui.text : ui.textMuted }}>
                      Include scale bar on satellite snapshot
                    </Typography>
                  }
                />

                <Box sx={{ mt: 1.1 }}>
                  {figuresToDbError && <Alert severity="error" sx={{ mb: 0.75 }}>{figuresToDbError}</Alert>}
                  {figuresToDbMessage && <Alert severity="success" sx={{ mb: 0.75 }}>{figuresToDbMessage}</Alert>}
                  <Button
                    variant="contained"
                    onClick={() => {
                      onPrepareAreaImageSave();
                      setOpenDbSaveDialog(true);
                    }}
                    disabled={savingFiguresToDb || !figureSelectionReady}
                    startIcon={savingFiguresToDb ? <CircularProgress size={16} color="inherit" /> : undefined}
                    sx={{
                      width: '100%',
                      textTransform: 'none',
                      borderRadius: 2,
                      py: 0.95,
                      background: `linear-gradient(135deg, ${ui.accent} 0%, #a29bfe 100%)`,
                    }}
                  >
                    {savingFiguresToDb ? 'Saving to database...' : 'Save area images to DB'}
                  </Button>
                </Box>

                <SavedFeatureDialog
                  open={openDbSaveDialog}
                  geometryType="Polygon"
                  saving={savingFiguresToDb}
                  error={null}
                  existingCategories={savedCategories}
                  existingTags={savedFeatureTags}
                  // When the user revisits the same drawing area, the container's
                  // lookup fills name/category/description/tags; otherwise default
                  // category to "area_images" to match the previous behaviour.
                  prefill={areaImagePrefill ?? { category: 'area_images' }}
                  onCancel={() => setOpenDbSaveDialog(false)}
                  onSubmit={(payload) => {
                    onSaveFiguresToDb(payload);
                    setOpenDbSaveDialog(false);
                  }}
                />
              </Box>
            )}

            {activePanel === 'saved' && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                {/* Header row */}
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography sx={{ fontSize: '0.8rem', color: ui.accent, fontWeight: 700 }}>
                    {filteredSavedFeatures.length}{filteredSavedFeatures.length !== savedMapFeatures.length ? `/${savedMapFeatures.length}` : ''} items
                  </Typography>
                  <IconButton
                    size="small"
                    onClick={onReloadSavedFeatures}
                    disabled={savedFeaturesLoading}
                    aria-label="Reload saved features"
                    sx={{ color: ui.textMuted }}
                  >
                    {savedFeaturesLoading ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
                  </IconButton>
                </Box>

                {savedFeaturesError && (
                  <Alert severity="error" sx={{ py: 0.5 }}>
                    {savedFeaturesError}
                  </Alert>
                )}

                {/* Search input */}
                <TextField
                  size="small"
                  fullWidth
                  placeholder="Search by name (regex ok)"
                  value={savedSearch}
                  onChange={(e) => setSavedSearch(e.target.value)}
                  slotProps={{
                    input: {
                      endAdornment: savedSearch
                        ? (
                          <IconButton size="small" onClick={() => setSavedSearch('')} sx={{ color: ui.textMuted }}>
                            <CloseIcon fontSize="inherit" />
                          </IconButton>
                        )
                        : null,
                    },
                  }}
                  sx={{
                    '& .MuiOutlinedInput-root': {
                      backgroundColor: ui.fieldBg,
                      color: ui.fieldText,
                      fontSize: '0.85rem',
                      '& fieldset': { borderColor: ui.border },
                      '&:hover fieldset': { borderColor: ui.borderStrong },
                    },
                    '& .MuiOutlinedInput-input::placeholder': { color: ui.textMuted, opacity: 1 },
                  }}
                />

                {/* Filter row: type + category */}
                <Box sx={{ display: 'flex', gap: 0.75 }}>
                  <FormControl size="small" sx={{ flex: 1 }}>
                    <Select
                      displayEmpty
                      value={savedTypeFilter}
                      onChange={(e) => setSavedTypeFilter(e.target.value)}
                      sx={{
                        fontSize: '0.82rem',
                        backgroundColor: ui.fieldBg,
                        color: savedTypeFilter ? ui.textPrimary : ui.textMuted,
                        '& .MuiOutlinedInput-notchedOutline': { borderColor: ui.border },
                        '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: ui.borderStrong },
                        '& .MuiSelect-icon': { color: ui.textMuted },
                      }}
                    >
                      <MenuItem value=""><em style={{ color: ui.textMuted, fontStyle: 'normal' }}>All types</em></MenuItem>
                      <MenuItem value="Point">Point</MenuItem>
                      <MenuItem value="LineString">LineString</MenuItem>
                      <MenuItem value="Polygon">Polygon</MenuItem>
                    </Select>
                  </FormControl>

                  <FormControl size="small" sx={{ flex: 1 }}>
                    <Select
                      displayEmpty
                      value={savedCategoryFilter}
                      onChange={(e) => setSavedCategoryFilter(e.target.value)}
                      sx={{
                        fontSize: '0.82rem',
                        backgroundColor: ui.fieldBg,
                        color: savedCategoryFilter ? ui.textPrimary : ui.textMuted,
                        '& .MuiOutlinedInput-notchedOutline': { borderColor: ui.border },
                        '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: ui.borderStrong },
                        '& .MuiSelect-icon': { color: ui.textMuted },
                      }}
                    >
                      <MenuItem value=""><em style={{ color: ui.textMuted, fontStyle: 'normal' }}>All categories</em></MenuItem>
                      {savedCategories.map((cat) => (
                        <MenuItem key={cat} value={cat}>{cat}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Box>

                {savedMapFeatures.length === 0 && !savedFeaturesLoading && !savedFeaturesError && (
                  <Typography variant="body2" sx={{ color: ui.textMuted }}>
                    No saved locations yet. Use inspect tools and save from the panel.
                  </Typography>
                )}

                {savedMapFeatures.length > 0 && filteredSavedFeatures.length === 0 && (
                  <Typography variant="body2" sx={{ color: ui.textMuted }}>
                    No matches. Clear filters to see all {savedMapFeatures.length} items.
                  </Typography>
                )}

                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                  {filteredSavedFeatures.map((feature) => {
                    const isExpanded = expandedSavedId === feature.id;
                    const isConfirmingDelete = confirmDeleteId === feature.id;
                    const isDeleting = deletingSavedFeatureId === feature.id;
                    const isUpdating = updatingSavedFeatureId === feature.id;
                    const isEditing = editingSavedId === feature.id;
                    const tags = Array.isArray(feature.metadata?.tags) ? feature.metadata?.tags : [];
                    return (
                      <Box
                        key={feature.id}
                        sx={{
                          background: ui.panelBgAlt,
                          borderRadius: 2,
                          border: `1px solid ${isExpanded ? ui.accentBorder : ui.border}`,
                          overflow: 'hidden',
                        }}
                      >
                        {/* Header row — text clicks expand; buttons right-aligned */}
                        <Box
                          sx={{
                            px: 1.2, py: 0.75,
                            display: 'flex', alignItems: 'center', gap: 0.5,
                          }}
                        >
                          {/* Clickable text area */}
                          <Box
                            onClick={() => { setExpandedSavedId(isExpanded ? null : feature.id); setConfirmDeleteId(null); }}
                            sx={{ minWidth: 0, flex: 1, cursor: 'pointer', py: 0.25 }}
                          >
                            <Typography sx={{ fontSize: '0.875rem', fontWeight: 700, color: ui.textPrimary }} noWrap>
                              {feature.name}
                            </Typography>
                            <Typography sx={{ mt: 0.15, fontSize: '0.76rem', color: ui.textMuted }}>
                              {feature.geometry.type}{feature.category ? ` · ${feature.category}` : ''} · {new Date(feature.created_at).toLocaleDateString()}
                            </Typography>
                          </Box>

                          {/* Right-aligned action buttons */}
                          <Tooltip title="Jump to feature" placement="top" arrow>
                            <IconButton
                              size="small"
                              onClick={() => onJumpToFeature(feature)}
                              sx={{ color: ui.accent, flexShrink: 0 }}
                            >
                              <MyLocationIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Edit" placement="top" arrow>
                            <IconButton
                              size="small"
                              disabled={isDeleting || isUpdating}
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(null);
                                setExpandedSavedId(feature.id);
                                setEditingSavedId(feature.id);
                                setEditSavedName(feature.name ?? '');
                                setEditSavedDescription(feature.description ?? '');
                                setEditSavedTags(tags.join(', '));
                              }}
                              sx={{ color: ui.textMuted, flexShrink: 0 }}
                            >
                              <EditOutlinedIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>

                          {isConfirmingDelete ? (
                            <>
                              <Button
                                size="small"
                                variant="contained"
                                color="error"
                                disabled={isDeleting}
                                onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); onDeleteSavedFeature(feature.id); }}
                                sx={{ minWidth: 0, px: 0.75, py: 0.2, fontSize: '0.75rem', flexShrink: 0 }}
                              >
                                {isDeleting ? <CircularProgress size={13} /> : 'Yes'}
                              </Button>
                              <Button
                                size="small"
                                variant="outlined"
                                onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
                                sx={{ minWidth: 0, px: 0.75, py: 0.2, fontSize: '0.75rem', flexShrink: 0, borderColor: ui.border, color: ui.textSecondary }}
                              >
                                No
                              </Button>
                            </>
                          ) : (
                            <Tooltip title="Delete" placement="top" arrow>
                              <IconButton
                                size="small"
                                disabled={isDeleting}
                                onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(feature.id); }}
                                sx={{ color: ui.textMuted, flexShrink: 0 }}
                              >
                                {isDeleting ? <CircularProgress size={14} /> : <DeleteOutlineIcon fontSize="small" />}
                              </IconButton>
                            </Tooltip>
                          )}
                        </Box>

                        {/* Expanded: details */}
                        {isExpanded && (
                          <Box sx={{ px: 1.5, pb: 1.2, borderTop: `1px solid ${ui.border}` }}>
                            {isEditing ? (
                              <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.8 }}>
                                <TextField
                                  size="small"
                                  label="Name"
                                  value={editSavedName}
                                  onChange={(e) => setEditSavedName(e.target.value)}
                                  fullWidth
                                />
                                <TextField
                                  size="small"
                                  label="Description"
                                  value={editSavedDescription}
                                  onChange={(e) => setEditSavedDescription(e.target.value)}
                                  fullWidth
                                  multiline
                                  minRows={2}
                                />
                                <TextField
                                  size="small"
                                  label="Tags (comma-separated)"
                                  value={editSavedTags}
                                  onChange={(e) => setEditSavedTags(e.target.value)}
                                  fullWidth
                                />
                                <Box sx={{ display: 'flex', gap: 0.8, justifyContent: 'flex-end' }}>
                                  <Button
                                    size="small"
                                    variant="outlined"
                                    onClick={() => setEditingSavedId(null)}
                                    disabled={isUpdating}
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    size="small"
                                    variant="contained"
                                    disabled={isUpdating || !editSavedName.trim()}
                                    onClick={async () => {
                                      const tagList = editSavedTags
                                        .split(',')
                                        .map((t) => t.trim())
                                        .filter(Boolean);
                                      await onUpdateSavedFeature(feature.id, {
                                        name: editSavedName.trim(),
                                        description: editSavedDescription,
                                        tags: tagList,
                                      });
                                      setEditingSavedId(null);
                                    }}
                                  >
                                    {isUpdating ? <CircularProgress size={13} /> : 'Save'}
                                  </Button>
                                </Box>
                              </Box>
                            ) : (
                              <>
                                <Typography sx={{ mt: 0.8, mb: 0.35, fontSize: '0.68rem', color: ui.textMuted, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                                  Description
                                </Typography>
                                <Typography sx={{ fontSize: '0.82rem', color: feature.description ? ui.textSecondary : ui.textMuted, fontStyle: feature.description ? 'normal' : 'italic', whiteSpace: 'pre-wrap' }}>
                                  {feature.description || 'No description'}
                                </Typography>
                              </>
                            )}

                            {!isEditing && tags.length > 0 && (
                              <Box sx={{ mt: 0.9, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                                {tags.map((tag) => (
                                  <Box key={tag} sx={{ px: 0.8, py: 0.2, borderRadius: 999, backgroundColor: ui.buttonBg, border: `1px solid ${ui.border}` }}>
                                    <Typography sx={{ fontSize: '0.72rem', color: ui.textSecondary }}>
                                      #{tag}
                                    </Typography>
                                  </Box>
                                ))}
                              </Box>
                            )}

                            {(feature.metadata?.tile_name || feature.metadata?.year || feature.metadata?.source || feature.metadata?.sample_count || feature.metadata?.total_length_m || feature.metadata?.satellite_snapshot_status) && (
                              <Box sx={{ mt: 1.1 }}>
                                <Typography sx={{ mb: 0.5, fontSize: '0.68rem', color: ui.textMuted, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                                  Metadata
                                </Typography>
                                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                                  {feature.metadata?.tile_name && (
                                    <Box sx={{ px: 0.8, py: 0.35, borderRadius: 999, backgroundColor: ui.buttonBg, border: `1px solid ${ui.border}` }}>
                                      <Typography sx={{ fontSize: '0.72rem', color: ui.textSecondary }}>
                                        Tile: {feature.metadata.tile_name}
                                      </Typography>
                                    </Box>
                                  )}
                                  {feature.metadata?.year != null && (
                                    <Box sx={{ px: 0.8, py: 0.35, borderRadius: 999, backgroundColor: ui.buttonBg, border: `1px solid ${ui.border}` }}>
                                      <Typography sx={{ fontSize: '0.72rem', color: ui.textSecondary }}>
                                        Year: {feature.metadata.year}
                                      </Typography>
                                    </Box>
                                  )}
                                  {feature.metadata?.source && (
                                    <Box sx={{ px: 0.8, py: 0.35, borderRadius: 999, backgroundColor: ui.buttonBg, border: `1px solid ${ui.border}` }}>
                                      <Typography sx={{ fontSize: '0.72rem', color: ui.textSecondary }}>
                                        Source: {feature.metadata.source}
                                      </Typography>
                                    </Box>
                                  )}
                                  {feature.metadata?.sample_count != null && (
                                    <Box sx={{ px: 0.8, py: 0.35, borderRadius: 999, backgroundColor: ui.buttonBg, border: `1px solid ${ui.border}` }}>
                                      <Typography sx={{ fontSize: '0.72rem', color: ui.textSecondary }}>
                                        Samples: {feature.metadata.sample_count}
                                      </Typography>
                                    </Box>
                                  )}
                                  {feature.metadata?.total_length_m != null && (
                                    <Box sx={{ px: 0.8, py: 0.35, borderRadius: 999, backgroundColor: ui.buttonBg, border: `1px solid ${ui.border}` }}>
                                      <Typography sx={{ fontSize: '0.72rem', color: ui.textSecondary }}>
                                        Length: {Math.round(feature.metadata.total_length_m)} m
                                      </Typography>
                                    </Box>
                                  )}
                                  {feature.metadata?.satellite_snapshot_status && (
                                    <Box sx={{ px: 0.8, py: 0.35, borderRadius: 999, backgroundColor: ui.buttonBg, border: `1px solid ${ui.border}` }}>
                                      <Typography sx={{ fontSize: '0.72rem', color: ui.textSecondary }}>
                                        Satellite snapshot: {feature.metadata.satellite_snapshot_status}
                                      </Typography>
                                    </Box>
                                  )}
                                  {feature.metadata?.prediction_snapshot_status && (
                                    <Box sx={{ px: 0.8, py: 0.35, borderRadius: 999, backgroundColor: ui.buttonBg, border: `1px solid ${ui.border}` }}>
                                      <Typography sx={{ fontSize: '0.72rem', color: ui.textSecondary }}>
                                        Prediction snapshot: {feature.metadata.prediction_snapshot_status}
                                      </Typography>
                                    </Box>
                                  )}
                                </Box>
                                {feature.metadata?.satellite_snapshot_status === 'unavailable' && feature.metadata?.satellite_snapshot_error && (
                                  <Typography sx={{ mt: 0.45, fontSize: '0.68rem', color: ui.textMuted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                                    reason: {String(feature.metadata.satellite_snapshot_error)}
                                  </Typography>
                                )}
                                {feature.metadata?.prediction_snapshot_status === 'unavailable' && feature.metadata?.prediction_snapshot_error && (
                                  <Typography sx={{ mt: 0.45, fontSize: '0.68rem', color: ui.textMuted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                                    prediction reason: {String(feature.metadata.prediction_snapshot_error)}
                                  </Typography>
                                )}
                              </Box>
                            )}

                            {feature.metadata?.feature_properties && typeof feature.metadata.feature_properties === 'object' && (
                              <Box sx={{ mt: 1.1 }}>
                                {(() => {
                                  const propEntries = Object.entries(feature.metadata?.feature_properties ?? {});
                                  const isPropsExpanded = expandedSavedPropsId === feature.id;
                                  const compactEntries = isPropsExpanded ? propEntries : propEntries.slice(0, 8);
                                  return (
                                    <>
                                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
                                        <Typography sx={{ fontSize: '0.68rem', color: ui.textMuted, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                                          Feature Properties ({propEntries.length})
                                        </Typography>
                                        <Button
                                          size="small"
                                          variant="text"
                                          onClick={() => setExpandedSavedPropsId(isPropsExpanded ? null : feature.id)}
                                          endIcon={isPropsExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                                          sx={{ textTransform: 'none', minHeight: 0, py: 0.2, px: 0.5, color: ui.accent, fontSize: '0.72rem' }}
                                        >
                                          {isPropsExpanded ? 'Compact' : 'Expand'}
                                        </Button>
                                      </Box>
                                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.45 }}>
                                        {compactEntries.map(([key, value]) => (
                                          <Box
                                            key={key}
                                            sx={{
                                              display: 'grid',
                                              gridTemplateColumns: 'minmax(110px, 35%) 1fr',
                                              gap: 0.6,
                                              px: 0.65,
                                              py: 0.45,
                                              borderRadius: 1,
                                              backgroundColor: ui.buttonBg,
                                              border: `1px solid ${ui.border}`,
                                            }}
                                          >
                                            <Typography sx={{ fontSize: '0.7rem', color: ui.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                              {key}
                                            </Typography>
                                            <Typography
                                              sx={{
                                                fontSize: '0.72rem',
                                                color: ui.textSecondary,
                                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                              }}
                                              title={typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                            >
                                              {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                            </Typography>
                                          </Box>
                                        ))}
                                      </Box>
                                      {!isPropsExpanded && propEntries.length > compactEntries.length && (
                                        <Typography sx={{ mt: 0.45, fontSize: '0.7rem', color: ui.textMuted }}>
                                          +{propEntries.length - compactEntries.length} more properties
                                        </Typography>
                                      )}
                                    </>
                                  );
                                })()}
                              </Box>
                            )}

                            {feature.plot_data && (
                              <Box sx={{ mt: 1.1 }}>
                                <Typography sx={{ mb: 0.5, fontSize: '0.68rem', color: ui.textMuted, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                                  Plot View
                                </Typography>
                                {feature.geometry.type === 'Polygon'
                                  && (feature.metadata?.source === 'area_images'
                                    || (Array.isArray(feature.plot_data?.image_exports)
                                      && (feature.plot_data?.image_exports?.length ?? 0) > 0))
                                  && (() => {
                                    const exports = Array.isArray(feature.plot_data?.image_exports) ? feature.plot_data!.image_exports! : [];
                                    const hasGoogleSat = exports.some((e: any) => e?.layer_id === '_google_satellite');
                                    const hasEoxLayer = Array.isArray(feature.plot_data?.layer_specs)
                                      && feature.plot_data!.layer_specs!.some((s: any) => s?.layer_subtype === 's2cloudless_mosaic');
                                    const refreshing = refreshingAreaImagesId === feature.id;
                                    return (
                                      <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1, rowGap: 0 }}>
                                        <Tooltip title="Crop the polygon to a square on its shortest side before re-rendering. This permanently updates the saved geometry.">
                                          <FormControlLabel
                                            sx={{ ml: 0, mb: 0.25 }}
                                            control={
                                              <Checkbox
                                                size="small"
                                                checked={squareAreaFeatureIds.has(feature.id)}
                                                disabled={refreshing}
                                                onChange={(e) => {
                                                  const checked = e.target.checked;
                                                  setSquareAreaFeatureIds((prev) => {
                                                    const next = new Set(prev);
                                                    if (checked) next.add(feature.id);
                                                    else next.delete(feature.id);
                                                    return next;
                                                  });
                                                }}
                                                sx={{ py: 0.25, color: ui.textMuted, '&.Mui-checked': { color: ui.accent } }}
                                              />
                                            }
                                            label={
                                              <Typography sx={{ fontSize: '0.75rem', color: ui.textSecondary }}>
                                                Square
                                              </Typography>
                                            }
                                          />
                                        </Tooltip>
                                        {hasGoogleSat && (
                                          <Tooltip title="Burn a metric scale bar into the HD Google Satellite snapshot on re-render. Uncheck to render the snapshot bare.">
                                            <FormControlLabel
                                              sx={{ ml: 0, mb: 0.25 }}
                                              control={
                                                <Checkbox
                                                  size="small"
                                                  checked={!refreshSuppressSatBarIds.has(feature.id)}
                                                  disabled={refreshing}
                                                  onChange={(e) => {
                                                    const off = !e.target.checked;
                                                    setRefreshSuppressSatBarIds((prev) => {
                                                      const next = new Set(prev);
                                                      if (off) next.add(feature.id);
                                                      else next.delete(feature.id);
                                                      return next;
                                                    });
                                                  }}
                                                  sx={{ py: 0.25, color: ui.textMuted, '&.Mui-checked': { color: ui.accent } }}
                                                />
                                              }
                                              label={
                                                <Typography sx={{ fontSize: '0.75rem', color: ui.textSecondary }}>
                                                  Sat scale bar
                                                </Typography>
                                              }
                                            />
                                          </Tooltip>
                                        )}
                                        {hasEoxLayer && (
                                          <Tooltip title="Draw a metric scale bar on the EOX s2cloudless mosaic on re-render. Uncheck to render bare.">
                                            <FormControlLabel
                                              sx={{ ml: 0, mb: 0.25 }}
                                              control={
                                                <Checkbox
                                                  size="small"
                                                  checked={!refreshSuppressEoxBarIds.has(feature.id)}
                                                  disabled={refreshing}
                                                  onChange={(e) => {
                                                    const off = !e.target.checked;
                                                    setRefreshSuppressEoxBarIds((prev) => {
                                                      const next = new Set(prev);
                                                      if (off) next.add(feature.id);
                                                      else next.delete(feature.id);
                                                      return next;
                                                    });
                                                  }}
                                                  sx={{ py: 0.25, color: ui.textMuted, '&.Mui-checked': { color: ui.accent } }}
                                                />
                                              }
                                              label={
                                                <Typography sx={{ fontSize: '0.75rem', color: ui.textSecondary }}>
                                                  EOX scale bar
                                                </Typography>
                                              }
                                            />
                                          </Tooltip>
                                        )}
                                      </Box>
                                    );
                                  })()}
                                <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                                  <Button
                                    size="small"
                                    variant="outlined"
                                    startIcon={<OpenInFullIcon fontSize="small" />}
                                    onClick={() => openPlotViewer(feature)}
                                    sx={{
                                      textTransform: 'none',
                                      borderColor: ui.accentBorder,
                                      color: ui.accent,
                                      backgroundColor: ui.accentSoft,
                                      '&:hover': {
                                        borderColor: ui.accentBorder,
                                        backgroundColor: ui.buttonHover,
                                      },
                                    }}
                                  >
                                    View plots
                                  </Button>
                                  {/* Area-image polygons get an "Update" action that re-renders
                                       every saved image from the layer specs persisted at save
                                       time — same visualization parameters as the original. */}
                                  {feature.geometry.type === 'Polygon'
                                    && (feature.metadata?.source === 'area_images'
                                      || (Array.isArray(feature.plot_data?.image_exports)
                                        && (feature.plot_data?.image_exports?.length ?? 0) > 0))
                                    && (() => {
                                      const isRefreshing = refreshingAreaImagesId === feature.id;
                                      const failure = refreshAreaImagesError?.id === feature.id
                                        ? refreshAreaImagesError.message
                                        : null;
                                      return (
                                        <Tooltip
                                          title={
                                            failure
                                              ? `Last refresh failed: ${failure}`
                                              : 'Re-render every saved image for this polygon using the same visualization parameters it was originally saved with'
                                          }
                                        >
                                          <span>
                                            <Button
                                              size="small"
                                              variant="outlined"
                                              disabled={isRefreshing}
                                              startIcon={
                                                isRefreshing
                                                  ? <CircularProgress size={14} />
                                                  : <RefreshIcon fontSize="small" />
                                              }
                                              onClick={() => onRefreshAreaImages(feature, {
                                                square: squareAreaFeatureIds.has(feature.id),
                                                includeGoogleSatelliteScaleBar: !refreshSuppressSatBarIds.has(feature.id),
                                                includeEoxScaleBar: !refreshSuppressEoxBarIds.has(feature.id),
                                              })}
                                              sx={{
                                                textTransform: 'none',
                                                borderColor: failure ? 'error.main' : ui.accentBorder,
                                                color: failure ? 'error.main' : ui.accent,
                                                backgroundColor: ui.accentSoft,
                                                '&:hover': {
                                                  borderColor: failure ? 'error.main' : ui.accentBorder,
                                                  backgroundColor: ui.buttonHover,
                                                },
                                              }}
                                            >
                                              {isRefreshing ? 'Updating…' : 'Update'}
                                            </Button>
                                          </span>
                                        </Tooltip>
                                      );
                                    })()}
                                  {/* Only Point features carry an RH98 prediction snapshot; refreshing
                                       a transect would be a different (per-sample) operation, so hide
                                       the button for non-Point geometries. */}
                                  {feature.geometry.type === 'Point' && (() => {
                                    const isRefreshing = refreshingPredictionSnapshotId === feature.id;
                                    const failure = refreshPredictionSnapshotError?.id === feature.id
                                      ? refreshPredictionSnapshotError.message
                                      : null;
                                    return (
                                      <Tooltip
                                        title={
                                          failure
                                            ? `Last refresh failed: ${failure}`
                                            : 'Regenerate the RH98 prediction snapshot using the current map rescale/colormap'
                                        }
                                      >
                                        {/* span wrapper so Tooltip works on a disabled button */}
                                        <span>
                                          <Button
                                            size="small"
                                            variant="outlined"
                                            disabled={isRefreshing}
                                            startIcon={
                                              isRefreshing
                                                ? <CircularProgress size={14} />
                                                : <RefreshIcon fontSize="small" />
                                            }
                                            onClick={() => onRefreshPredictionSnapshot(feature)}
                                            sx={{
                                              textTransform: 'none',
                                              borderColor: failure ? 'error.main' : ui.accentBorder,
                                              color: failure ? 'error.main' : ui.accent,
                                              backgroundColor: ui.accentSoft,
                                              '&:hover': {
                                                borderColor: failure ? 'error.main' : ui.accentBorder,
                                                backgroundColor: ui.buttonHover,
                                              },
                                            }}
                                          >
                                            {isRefreshing ? 'Updating…' : 'Update'}
                                          </Button>
                                        </span>
                                      </Tooltip>
                                    );
                                  })()}
                                </Box>
                              </Box>
                            )}
                          </Box>
                        )}
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            )}

            {activePanel === 'export' && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                <PanelActionCard
                  icon={<CropFreeIcon fontSize="inherit" />}
                  label={drawingActive && drawingMode === 'figures' ? 'Figures On' : 'Figures'}
                  description={drawingActive && drawingMode === 'figures'
                    ? 'Drag a rectangle on the map to define the export area.'
                    : 'Drag a rectangle on the map to define the export area.'}
                  active={drawingActive && drawingMode === 'figures'}
                  onClick={onCreateFiguresDraw}
                  ui={ui}
                />

                <Box>
                  <SectionLabel ui={ui}>Output</SectionLabel>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <TextField
                      size="small"
                      fullWidth
                      value={figureOutputFolder}
                      onChange={(e) => onFigureOutputFolderChange(e.target.value)}
                      placeholder="/maps/projects/dereeco/data/gvs"
                      sx={{
                        '& .MuiOutlinedInput-root': {
                          backgroundColor: ui.fieldBg,
                          color: ui.fieldText,
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          fontSize: '0.82rem',
                        },
                      }}
                    />
                    <IconButton size="small" onClick={handleOpenBrowser} title="Browse folders" sx={{ color: ui.textMuted }}>
                      <FolderOpenIcon fontSize="small" />
                    </IconButton>
                  </Box>
                  <Collapse in={showFolderBrowser}>
                    <Box sx={{ mt: 0.75, border: `1px solid ${ui.border}`, borderRadius: 2, p: 0.75, backgroundColor: ui.panelBgAlt }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.75 }}>
                        <IconButton size="small" onClick={handleGoUp} title="Go up" sx={{ color: ui.textMuted }}>
                          <ArrowUpwardIcon fontSize="small" />
                        </IconButton>
                        <Typography variant="caption" sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: ui.textMuted }} title={browsingPath}>
                          {browsingPath || '/'}
                        </Typography>
                      </Box>
                      <Box sx={{ maxHeight: 180, overflowY: 'auto', border: `1px solid ${ui.border}`, borderRadius: 1.5 }}>
                        {loadingDirs ? (
                          <Box sx={{ display: 'flex', justifyContent: 'center', p: 1 }}><CircularProgress size={18} /></Box>
                        ) : dirEntries.length === 0 ? (
                          <Typography variant="caption" sx={{ p: 1, display: 'block', color: ui.textMuted }}>No subdirectories</Typography>
                        ) : (
                          <List dense disablePadding>
                            {dirEntries.map((dir) => (
                              <ListItemButton key={dir} onClick={() => handleSelectDir(dir)} sx={{ py: 0.35 }}>
                                <ListItemText primary={dir} primaryTypographyProps={{ variant: 'caption', color: ui.textPrimary }} />
                              </ListItemButton>
                            ))}
                          </List>
                        )}
                      </Box>
                      <Box sx={{ display: 'flex', gap: 0.5, mt: 0.75 }}>
                        <Button size="small" variant="contained" onClick={handleConfirmFolder} sx={{ flex: 1, textTransform: 'none', backgroundColor: ui.accent }}>
                          Select folder
                        </Button>
                        <IconButton size="small" onClick={() => { setShowNewFolder(!showNewFolder); }} title="New folder" sx={{ color: ui.textMuted }}>
                          <CreateNewFolderIcon fontSize="small" />
                        </IconButton>
                      </Box>
                      <Collapse in={showNewFolder}>
                        <Box sx={{ display: 'flex', gap: 0.5, mt: 0.75 }}>
                          <TextField
                            size="small"
                            placeholder="New folder name"
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            sx={{ flex: 1, '& .MuiOutlinedInput-root': { backgroundColor: ui.fieldBg, color: ui.fieldText } }}
                            inputProps={{ style: { fontSize: '0.75rem', padding: '6px 8px' } }}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); }}
                          />
                          <Button size="small" variant="outlined" onClick={handleCreateFolder} sx={{ textTransform: 'none', minWidth: 0, color: ui.textSecondary, borderColor: ui.borderStrong }}>
                            Create
                          </Button>
                        </Box>
                      </Collapse>
                    </Box>
                  </Collapse>
                </Box>

                <Box>
                  <SectionLabel ui={ui}>File name</SectionLabel>
                  <TextField
                    size="small"
                    fullWidth
                    value={figureFilenameStem}
                    onChange={(e) => onFigureFilenameStemChange(e.target.value)}
                    placeholder={suggestedFigureFilenameStem || 'layer_lat_lon…'}
                    helperText="Base name without extension; format is added automatically. Clear the field to use automatic names from layer + location."
                    FormHelperTextProps={{ sx: { color: ui.textMuted, fontSize: '0.68rem', mt: 0.35 } }}
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        backgroundColor: ui.fieldBg,
                        color: ui.fieldText,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: '0.82rem',
                      },
                    }}
                  />
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.35 }}>
                    <Button
                      size="small"
                      variant="text"
                      disabled={!suggestedFigureFilenameStem}
                      onClick={() => onFigureFilenameStemChange(suggestedFigureFilenameStem)}
                      sx={{ textTransform: 'none', fontSize: '0.72rem', color: ui.accent, minHeight: 0, py: 0.25 }}
                    >
                      Use default name
                    </Button>
                  </Box>
                </Box>

                <Box>
                  <SectionLabel ui={ui}>Format</SectionLabel>
                  <Box sx={{ display: 'flex', gap: 0.75 }}>
                    {(['pdf', 'png', 'jpg'] as const).map((format) => {
                      const active = figureFormat === format;
                      return (
                        <Box
                          key={format}
                          component="button"
                          type="button"
                          onClick={() => onFigureFormatChange(format)}
                          sx={{
                            flex: 1,
                            py: 0.9,
                            borderRadius: 1.75,
                            border: '1px solid',
                            borderColor: active ? ui.accentBorder : ui.border,
                            background: active ? ui.accentSoft : ui.fieldBg,
                            color: active ? ui.accent : ui.textSecondary,
                            fontSize: '0.82rem',
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            cursor: 'pointer',
                          }}
                        >
                          {format}
                        </Box>
                      );
                    })}
                  </Box>
                </Box>

                <Box>
                  <SectionLabel ui={ui}>Layers To Save</SectionLabel>
                  <Box sx={{ maxHeight: 380, overflowY: 'auto', border: `1px solid ${ui.border}`, borderRadius: 2, p: 1, backgroundColor: ui.panelBgAlt }}>
                    {availableFigureLayers.length === 0 ? (
                      <Typography variant="caption" sx={{ color: ui.textMuted }}>
                        No exportable layers found
                      </Typography>
                    ) : (
                      availableFigureLayers.map((layer) => {
                        const isChecked = selectedFigureLayerIds.includes(layer.id);
                        const isExpanded = expandedFigureLayer === layer.id;
                        const ovr = figureLayerOverrides[layer.id];
                        const hasBands = layer.bandNames && layer.bandNames.length > 1;
                        return (
                          <Box key={layer.id} sx={{ mb: 0.75, borderRadius: 1.5, border: `1px solid ${ui.border}`, backgroundColor: isChecked ? ui.accentSoft : ui.buttonBg }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', px: 0.5 }}>
                              <Checkbox
                                size="small"
                                checked={isChecked}
                                onChange={() => onToggleFigureLayer(layer.id)}
                                sx={{ color: ui.textMuted }}
                              />
                              <Typography
                                variant="caption"
                                sx={{ flex: 1, cursor: 'pointer', userSelect: 'none', color: ui.textPrimary }}
                                onClick={() => setExpandedFigureLayer(isExpanded ? null : layer.id)}
                              >
                                {layer.name}
                                {hasBands && ` (${layer.bandNames!.length} bands)`}
                              </Typography>
                              <IconButton size="small" onClick={() => setExpandedFigureLayer(isExpanded ? null : layer.id)} sx={{ color: ui.textMuted }}>
                                {isExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                              </IconButton>
                            </Box>
                            <Collapse in={isExpanded}>
                              <Box sx={{ pl: 1.75, pr: 1, pb: 1, display: 'flex', flexDirection: 'column', gap: 0.9 }}>
                                {hasBands && (
                                  <>
                                    <Typography variant="caption" sx={{ color: ui.textMuted }}>Bands</Typography>
                                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.25 }}>
                                      {layer.bandNames!.map((bname, idx) => {
                                        const bi = idx + 1;
                                        const selected = ovr?.selectedBands?.includes(bi) ?? false;
                                        return (
                                          <FormControlLabel
                                            key={bi}
                                            control={
                                              <Checkbox
                                                size="small"
                                                checked={selected}
                                                onChange={() => {
                                                  const prev = ovr?.selectedBands ?? [];
                                                  const next = selected ? prev.filter((b) => b !== bi) : [...prev, bi];
                                                  onUpdateFigureLayerOverride(layer.id, { selectedBands: next });
                                                }}
                                                sx={{ color: ui.textMuted }}
                                              />
                                            }
                                            label={<Typography variant="caption" sx={{ color: ui.textPrimary }}>{bname}</Typography>}
                                            sx={{ m: 0, mr: 0.5 }}
                                          />
                                        );
                                      })}
                                    </Box>
                                  </>
                                )}
                                <FormControl size="small" fullWidth>
                                  <InputLabel sx={{ color: ui.fieldLabel }}>Colormap</InputLabel>
                                  <Select
                                    value={ovr?.colormap ?? ''}
                                    label="Colormap"
                                    onChange={(e) => onUpdateFigureLayerOverride(layer.id, { colormap: e.target.value || undefined })}
                                    sx={{ backgroundColor: ui.fieldBg, color: ui.fieldText }}
                                  >
                                    <MenuItem value=""><em>Default</em></MenuItem>
                                    {COLORMAPS.map((cm) => (
                                      <MenuItem key={cm} value={cm}>{cm}</MenuItem>
                                    ))}
                                  </Select>
                                </FormControl>
                                <Box sx={{ display: 'flex', gap: 0.5 }}>
                                  <TextField
                                    label="Min"
                                    type="number"
                                    size="small"
                                    value={ovr?.rescaleMin ?? ''}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      onUpdateFigureLayerOverride(layer.id, { rescaleMin: v === '' ? undefined : parseFloat(v) });
                                    }}
                                    placeholder="auto"
                                    sx={{ flex: 1, '& .MuiOutlinedInput-root': { backgroundColor: ui.fieldBg, color: ui.fieldText }, '& .MuiInputLabel-root': { color: ui.fieldLabel } }}
                                    inputProps={{ step: 'any' }}
                                  />
                                  <TextField
                                    label="Max"
                                    type="number"
                                    size="small"
                                    value={ovr?.rescaleMax ?? ''}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      onUpdateFigureLayerOverride(layer.id, { rescaleMax: v === '' ? undefined : parseFloat(v) });
                                    }}
                                    placeholder="auto"
                                    sx={{ flex: 1, '& .MuiOutlinedInput-root': { backgroundColor: ui.fieldBg, color: ui.fieldText }, '& .MuiInputLabel-root': { color: ui.fieldLabel } }}
                                    inputProps={{ step: 'any' }}
                                  />
                                </Box>
                                {layer.layerType === 'prediction' && (
                                  <FormControlLabel
                                    sx={{ m: 0 }}
                                    control={
                                      <Checkbox
                                        size="small"
                                        checked={ovr?.includeColorbar !== false}
                                        onChange={(e) => onUpdateFigureLayerOverride(layer.id, { includeColorbar: e.target.checked })}
                                        sx={{ color: ui.textMuted }}
                                      />
                                    }
                                    label={<Typography variant="caption" sx={{ color: ui.textPrimary }}>Include colorbar</Typography>}
                                  />
                                )}
                                {(layer.layerSubType === 's2cloudless_mosaic' || layer.layerType === 'earthengine') && (
                                  <FormControlLabel
                                    sx={{ m: 0 }}
                                    control={
                                      <Checkbox
                                        size="small"
                                        checked={ovr?.includeScaleBar !== false}
                                        onChange={(e) => onUpdateFigureLayerOverride(layer.id, { includeScaleBar: e.target.checked })}
                                        sx={{ color: ui.textMuted }}
                                      />
                                    }
                                    label={<Typography variant="caption" sx={{ color: ui.textPrimary }}>Include scale bar</Typography>}
                                  />
                                )}
                              </Box>
                            </Collapse>
                          </Box>
                        );
                      })
                    )}
                  </Box>
                </Box>

                <FormControlLabel
                  sx={{ mt: 0.5, mb: -0.5 }}
                  control={
                    <Checkbox
                      size="small"
                      checked={includeGoogleSatellite}
                      onChange={(e) => onIncludeGoogleSatelliteChange(e.target.checked)}
                    />
                  }
                  label={
                    <Typography variant="body2" sx={{ color: ui.text }}>
                      Also save HD Google Satellite snapshot
                    </Typography>
                  }
                />
                <FormControlLabel
                  sx={{ ml: 2.5, mt: -0.25, mb: -0.5 }}
                  disabled={!includeGoogleSatellite}
                  control={
                    <Checkbox
                      size="small"
                      checked={includeGoogleSatelliteScaleBar}
                      onChange={(e) => onIncludeGoogleSatelliteScaleBarChange(e.target.checked)}
                    />
                  }
                  label={
                    <Typography variant="caption" sx={{ color: includeGoogleSatellite ? ui.text : ui.textMuted }}>
                      Include scale bar on satellite snapshot
                    </Typography>
                  }
                />

                {figureSaveError && <Alert severity="error">{figureSaveError}</Alert>}
                {figureSaveMessage && <Alert severity="success">{figureSaveMessage}</Alert>}

                <Button
                  variant="contained"
                  onClick={onSaveFigures}
                  disabled={savingFigures || !figureSelectionReady || (selectedFigureLayerIds.length === 0 && !includeGoogleSatellite)}
                  startIcon={savingFigures ? <CircularProgress size={18} color="inherit" /> : undefined}
                  sx={{
                    py: 1.1,
                    borderRadius: 2,
                    textTransform: 'none',
                    fontWeight: 800,
                    background: `linear-gradient(135deg, ${ui.accent} 0%, #a29bfe 100%)`,
                    color: '#fff',
                  }}
                >
                  {savingFigures ? 'Saving figures...' : 'Save figures'}
                </Button>
              </Box>
            )}
          </Box>
        </Box>
      )}

      {plotViewerFeature?.plot_data && (
        <Box
          sx={{
            position: 'fixed',
            inset: 0,
            zIndex: 1400,
            pointerEvents: 'none',
          }}
        >
          <Box
            ref={plotViewerPanelRef}
            sx={{
              position: 'absolute',
              left: plotViewerRect.x,
              top: plotViewerRect.y,
              width: plotViewerRect.width,
              height: plotViewerRect.height,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 3,
              overflow: 'hidden',
              background: plotViewerUi.panelBg,
              border: `1px solid ${plotViewerUi.accentBorder}`,
              boxShadow: plotViewerUi.shadow,
              pointerEvents: 'auto',
              minWidth: 480,
              minHeight: 360,
            }}
          >
            <Box
              onMouseDown={(event) => {
                if ((event.target as HTMLElement).closest('[data-plot-close="true"]')) return;
                plotViewerDragRef.current = {
                  mouseX: event.clientX,
                  mouseY: event.clientY,
                  rect: plotViewerRect,
                };
                document.body.style.userSelect = 'none';
                setPlotViewerDragMode('move');
              }}
              sx={{
                px: 2,
                py: 1.2,
                borderBottom: `1px solid ${plotViewerUi.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1,
                cursor: 'move',
                userSelect: 'none',
              }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: '0.95rem', fontWeight: 800, color: plotViewerUi.textPrimary }} noWrap>
                  {plotViewerFeature.name}
                </Typography>
                <Typography sx={{ mt: 0.15, fontSize: '0.78rem', color: plotViewerUi.textMuted }} noWrap>
                  {plotViewerFeature.geometry.type}
                  {plotViewerFeature.category ? ` · ${plotViewerFeature.category}` : ''}
                  {plotViewerFeature.metadata?.tile_name ? ` · Tile ${plotViewerFeature.metadata.tile_name}` : ''}
                  {plotViewerFeature.metadata?.year != null ? ` · ${plotViewerFeature.metadata.year}` : ''}
                </Typography>
              </Box>
              <IconButton
                data-plot-close="true"
                size="small"
                onClick={() => setPlotViewerFeature(null)}
                sx={{ color: plotViewerUi.textMuted }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>

            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                p: 2,
              }}
            >
              {(plotViewerFeature.metadata?.tile_name || plotViewerFeature.metadata?.year || plotViewerFeature.metadata?.source || plotViewerFeature.metadata?.sample_count || plotViewerFeature.metadata?.total_length_m) && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.6, mb: 1.25 }}>
                  {plotViewerFeature.metadata?.tile_name && (
                    <Box sx={{ px: 0.85, py: 0.4, borderRadius: 999, backgroundColor: plotViewerUi.buttonBg, border: `1px solid ${plotViewerUi.border}` }}>
                      <Typography sx={{ fontSize: '0.74rem', color: plotViewerUi.textSecondary }}>Tile: {plotViewerFeature.metadata.tile_name}</Typography>
                    </Box>
                  )}
                  {plotViewerFeature.metadata?.year != null && (
                    <Box sx={{ px: 0.85, py: 0.4, borderRadius: 999, backgroundColor: plotViewerUi.buttonBg, border: `1px solid ${plotViewerUi.border}` }}>
                      <Typography sx={{ fontSize: '0.74rem', color: plotViewerUi.textSecondary }}>Year: {plotViewerFeature.metadata.year}</Typography>
                    </Box>
                  )}
                  {plotViewerFeature.metadata?.source && (
                    <Box sx={{ px: 0.85, py: 0.4, borderRadius: 999, backgroundColor: plotViewerUi.buttonBg, border: `1px solid ${plotViewerUi.border}` }}>
                      <Typography sx={{ fontSize: '0.74rem', color: plotViewerUi.textSecondary }}>Source: {plotViewerFeature.metadata.source}</Typography>
                    </Box>
                  )}
                  {plotViewerFeature.metadata?.sample_count != null && (
                    <Box sx={{ px: 0.85, py: 0.4, borderRadius: 999, backgroundColor: plotViewerUi.buttonBg, border: `1px solid ${plotViewerUi.border}` }}>
                      <Typography sx={{ fontSize: '0.74rem', color: plotViewerUi.textSecondary }}>Samples: {plotViewerFeature.metadata.sample_count}</Typography>
                    </Box>
                  )}
                  {plotViewerFeature.metadata?.total_length_m != null && (
                    <Box sx={{ px: 0.85, py: 0.4, borderRadius: 999, backgroundColor: plotViewerUi.buttonBg, border: `1px solid ${plotViewerUi.border}` }}>
                      <Typography sx={{ fontSize: '0.74rem', color: plotViewerUi.textSecondary }}>Length: {Math.round(plotViewerFeature.metadata.total_length_m)} m</Typography>
                    </Box>
                  )}
                </Box>
              )}

              <SavedFeaturePlots
                plotData={plotViewerFeature.plot_data}
                featureName={plotViewerFeature.name}
              />
            </Box>

            <Box
              onMouseDown={(event) => {
                event.stopPropagation();
                plotViewerDragRef.current = {
                  mouseX: event.clientX,
                  mouseY: event.clientY,
                  rect: plotViewerRect,
                };
                document.body.style.userSelect = 'none';
                setPlotViewerDragMode('resize');
              }}
              sx={{
                position: 'absolute',
                right: 0,
                bottom: 0,
                width: 22,
                height: 22,
                cursor: 'nwse-resize',
                background: `linear-gradient(135deg, transparent 42%, ${plotViewerUi.textMuted} 44%, ${plotViewerUi.textMuted} 50%, transparent 52%)`,
              }}
            />
          </Box>
        </Box>
      )}
    </SidebarContainer>
  );
}
