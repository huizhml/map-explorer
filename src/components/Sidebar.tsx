import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Box,
  Typography,
  Button,
  styled,
  TextField,
  List,
  ListItem,
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
} from '@mui/icons-material';
import type { VsmQChoice } from '../constants/predictions';
import type { FigureLayerOverrides } from '../containers/SidebarContainer';
import { apiUrl } from '../utils/apiBase';

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
  drawingMode: 'tiles' | 'figures';
  onGetTiles: () => void;
  onCreateFiguresDraw: () => void;
  selectedTiles: string[];
  figureSelectionReady: boolean;
  figureFormat: 'jpg' | 'png' | 'pdf';
  onFigureFormatChange: (format: 'jpg' | 'png' | 'pdf') => void;
  figureOutputFolder: string;
  onFigureOutputFolderChange: (folder: string) => void;
  availableFigureLayers: Array<{
    id: string;
    name: string;
    bandNames?: string[];
    defaultColormap?: string;
    defaultRescaleMin?: number;
    defaultRescaleMax?: number;
    defaultSelectedBand?: number;
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
  inspectKind: 'layers' | 'vertical_profile';
  onInspectModeChange: (active: boolean) => void;
  onVerticalProfileClick: () => void;
  // File upload
  onUploadFile: (file: File) => Promise<void>;
  uploadingFile: boolean;
}

// Common palettes for visualization
export const PALETTES = {
  'Grayscale': ['#000000', '#FFFFFF'],
  'Viridis': ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],
  'Magma': ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'],
  'RdYlBu': ['#313695', '#74add1', '#fed976', '#feb24c', '#fd8d3c', '#f03b20'],
  'Terrain': ['#333399', '#79b3d4', '#a3e0b2', '#cde49c', '#e7d19a', '#c4a173'],
  'Spectral': ['#9e0142', '#f46d43', '#fee08b', '#90ed7d', '#5e4fa2'],
};

export type PaletteName = keyof typeof PALETTES;

const SidebarContainer = styled(Box)(({ theme }) => ({
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: '320px',
  backgroundColor: '#fff',
  boxShadow: theme.shadows[3],
  zIndex: 1000,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden'
}));

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
  selectedTiles,
  figureSelectionReady,
  figureFormat,
  onFigureFormatChange,
  figureOutputFolder,
  onFigureOutputFolderChange,
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
  onUploadFile,
  uploadingFile,
}: SidebarProps) {
  const [showAddedInfo, setShowAddedInfo] = useState(true);
  const [expandedFigureLayer, setExpandedFigureLayer] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [browsingPath, setBrowsingPath] = useState('');
  const [dirEntries, setDirEntries] = useState<string[]>([]);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);

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

  return (
    <SidebarContainer>
      <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="h6" component="h1">
          Map Explorer
        </Typography>
      </Box>

      <Box sx={{ p: 2, flex: 1, overflowY: 'auto' }}>

        {/* VSM Predictions Section */}
        <Box sx={{ mt: 3 }}>
          <Typography variant="h6" component="h2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <LayersIcon />Explore VSM
          </Typography>
          <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              <TextField
                label="Year"
                type="number"
                value={vsmYear}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  if (!isNaN(v)) onVsmYearChange(v);
                }}
                size="small"
                sx={{ width: 80 }}
                inputProps={{ min: 2015, max: 2030 }}
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
                sx={{ width: 90 }}
              />
            </Box>
            <Box>
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 0.5 }}>
                Quantiles
              </Typography>
              <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
                <FormControlLabel
                  control={<Checkbox size="small" checked={vsmQChoice === '5%'} onChange={() => onVsmQChoiceChange('5%')} />}
                  label={<Typography variant="caption">5%</Typography>}
                />
                <FormControlLabel
                  control={<Checkbox size="small" checked={vsmQChoice === 'median'} onChange={() => onVsmQChoiceChange('median')} />}
                  label={<Typography variant="caption">median</Typography>}
                />
                <FormControlLabel
                  control={<Checkbox size="small" checked={vsmQChoice === '95%'} onChange={() => onVsmQChoiceChange('95%')} />}
                  label={<Typography variant="caption">95%</Typography>}
                />
              </Box>
            </Box>
            <Box>
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 0.5 }}>
                Intervals
              </Typography>
              <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
                <FormControlLabel
                  control={<Checkbox size="small" checked={vsmQChoice === '95%-5%'} onChange={() => onVsmQChoiceChange('95%-5%')} />}
                  label={<Typography variant="caption">95%-5%</Typography>}
                />
                <FormControlLabel
                  control={<Checkbox size="small" checked={vsmQChoice === '95%-50%'} onChange={() => onVsmQChoiceChange('95%-50%')} />}
                  label={<Typography variant="caption">95%-50%</Typography>}
                />
                <FormControlLabel
                  control={<Checkbox size="small" checked={vsmQChoice === '50%-5%'} onChange={() => onVsmQChoiceChange('50%-5%')} />}
                  label={<Typography variant="caption">50%-5%</Typography>}
                />
              </Box>
            </Box>
            <Box>
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 0.5 }}>
                Skewness
              </Typography>
              <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
                <FormControlLabel
                  control={<Checkbox size="small" checked={vsmQChoice === 'skewness'} onChange={() => onVsmQChoiceChange('skewness')} />}
                  label={
                    <Typography variant="caption" component="span">
                      (Q<sub>0.95</sub> − Q<sub>0.50</sub>) − (Q<sub>0.50</sub> − Q<sub>0.05</sub>)
                    </Typography>
                  }
                />
              </Box>
            </Box>
          </Box>
          <Box sx={{ mt: 1 }}>
            <Button variant="outlined" color="primary" onClick={onAddLayer} fullWidth>
              Add layer
            </Button>
          </Box>
          {addedVsmLayers.length > 0 && showAddedInfo && (
            <Box sx={{ mt: 1, display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
              <Typography variant="caption" sx={{ flex: 1, color: 'text.secondary' }}>
                Added: {addedVsmLayers.map((e) => `${e.year} (RH${e.rhIndex}, ${e.qChoice})`).join('; ')}
              </Typography>
              <IconButton size="small" onClick={() => setShowAddedInfo(false)} aria-label="Dismiss" sx={{ mt: -0.5, mr: -0.5 }}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          )}
        </Box>

        {/* Inspect Section */}
        <Box sx={{ mt: 3 }}>
          <Button
            variant={inspectMode && inspectKind === 'layers' ? 'contained' : 'outlined'}
            color="secondary"
            onClick={() => onInspectModeChange(!inspectMode || inspectKind !== 'layers')}
            fullWidth
            startIcon={<SearchIcon />}
          >
            {inspectMode && inspectKind === 'layers' ? 'Inspect (on)' : 'Inspect'}
          </Button>
          <Typography variant="caption" sx={{ mt: 0.5, display: 'block', color: 'text.secondary' }}>
            {inspectMode && inspectKind === 'layers'
              ? 'Click the map — all raster values in the panel bottom-right (visible + hidden)'
              : 'Sample all COG layers at the clicked point (visible + hidden)'}
          </Typography>
          <Button
            variant={inspectMode && inspectKind === 'vertical_profile' ? 'contained' : 'outlined'}
            color="secondary"
            onClick={onVerticalProfileClick}
            fullWidth
            startIcon={<ShowChartIcon />}
            sx={{ mt: 1.5 }}
          >
            {inspectMode && inspectKind === 'vertical_profile'
              ? 'Inspect vertical profile (on)'
              : 'Inspect vertical profile'}
          </Button>
          <Typography variant="caption" sx={{ mt: 0.5, display: 'block', color: 'text.secondary' }}>
            {inspectMode && inspectKind === 'vertical_profile'
              ? `Click the map — original RH0–RH100 (Q1) for year ${vsmYear}`
              : 'Original prediction COGs (Q1); year from above; click again to turn off'}
          </Typography>
        </Box>

        {/* Upload File Section */}
        <Box sx={{ mt: 3 }}>
          <Typography variant="h6" component="h2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <UploadFileIcon /> Upload File
          </Typography>
          <Box sx={{ mt: 1.5 }}>
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
            <Button
              variant="outlined"
              color="primary"
              fullWidth
              startIcon={uploadingFile ? <CircularProgress size={18} /> : <UploadFileIcon />}
              disabled={uploadingFile}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadingFile ? 'Loading…' : 'Upload file'}
            </Button>
            <Typography variant="caption" sx={{ mt: 0.5, display: 'block', color: 'text.secondary' }}>
              CSV, GeoJSON, FlatGeobuf, or Shapefile (zipped)
            </Typography>
          </Box>
        </Box>

        {/* Drawing Tools Section */}
        <Box sx={{ mt: 3 }}>
          <Typography variant="h6" component="h2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CropFreeIcon /> Drawing Tools
          </Typography>
          <Box sx={{ mt: 2 }}>
            <Button
              variant={drawingActive && drawingMode === 'tiles' ? 'contained' : 'outlined'}
              color={drawingActive && drawingMode === 'tiles' ? 'warning' : 'primary'}
              onClick={onGetTiles}
              fullWidth
              startIcon={<CropFreeIcon />}
            >
              {drawingActive && drawingMode === 'tiles' ? 'Drawing... (click to cancel)' : 'Get Tiles'}
            </Button>
            {drawingActive && drawingMode === 'tiles' && (
              <Typography variant="caption" sx={{ mt: 1, display: 'block', color: 'text.secondary' }}>
                Draw a rectangle on the map to select tiles
              </Typography>
            )}
            <Button
              variant={drawingActive && drawingMode === 'figures' ? 'contained' : 'outlined'}
              color={drawingActive && drawingMode === 'figures' ? 'warning' : 'secondary'}
              onClick={onCreateFiguresDraw}
              fullWidth
              startIcon={<CropFreeIcon />}
              sx={{ mt: 1 }}
            >
              {drawingActive && drawingMode === 'figures' ? 'Drawing figure area... (click to cancel)' : 'Create figures'}
            </Button>
            <Typography variant="caption" sx={{ mt: 1, display: 'block', color: 'text.secondary' }}>
              Draw a rectangle, choose layers, format, and output folder
            </Typography>
            {figureSelectionReady && (
              <Typography variant="caption" sx={{ mt: 0.5, display: 'block', color: 'success.main' }}>
                Figure area selected
              </Typography>
            )}
          </Box>
          {selectedTiles.length > 0 && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="body2" sx={{ fontWeight: 500, mb: 1 }}>
                Selected tiles ({selectedTiles.length}):
              </Typography>
              <Box sx={{ maxHeight: 200, overflowY: 'auto' }}>
                <List dense disablePadding>
                  {selectedTiles.map((tile) => (
                    <ListItem key={tile} disablePadding sx={{ py: 0.25 }}>
                      <ListItemText
                        primary={tile}
                        primaryTypographyProps={{ variant: 'body2', fontFamily: 'monospace' }}
                      />
                    </ListItem>
                  ))}
                </List>
              </Box>
            </Box>
          )}
          <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <TextField
                  label="Output folder"
                  size="small"
                  fullWidth
                  value={figureOutputFolder}
                  onChange={(e) => onFigureOutputFolderChange(e.target.value)}
                  placeholder="/maps/projects/dereeco/data/gvs"
                />
                <IconButton size="small" onClick={handleOpenBrowser} title="Browse folders">
                  <FolderOpenIcon fontSize="small" />
                </IconButton>
              </Box>
              <Collapse in={showFolderBrowser}>
                <Box sx={{ mt: 0.5, border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 0.5 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
                    <IconButton size="small" onClick={handleGoUp} title="Go up">
                      <ArrowUpwardIcon fontSize="small" />
                    </IconButton>
                    <Typography variant="caption" sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={browsingPath}>
                      {browsingPath || '/'}
                    </Typography>
                  </Box>
                  <Box sx={{ maxHeight: 180, overflowY: 'auto', border: '1px solid', borderColor: 'grey.200', borderRadius: 0.5 }}>
                    {loadingDirs ? (
                      <Box sx={{ display: 'flex', justifyContent: 'center', p: 1 }}><CircularProgress size={18} /></Box>
                    ) : dirEntries.length === 0 ? (
                      <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>No subdirectories</Typography>
                    ) : (
                      <List dense disablePadding>
                        {dirEntries.map((dir) => (
                          <ListItemButton key={dir} onClick={() => handleSelectDir(dir)} sx={{ py: 0.25 }}>
                            <ListItemText primary={dir} primaryTypographyProps={{ variant: 'caption' }} />
                          </ListItemButton>
                        ))}
                      </List>
                    )}
                  </Box>
                  <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
                    <Button size="small" variant="contained" onClick={handleConfirmFolder} sx={{ flex: 1, textTransform: 'none', fontSize: '0.7rem' }}>
                      Select this folder
                    </Button>
                    <IconButton size="small" onClick={() => { setShowNewFolder(!showNewFolder); }} title="New folder">
                      <CreateNewFolderIcon fontSize="small" />
                    </IconButton>
                  </Box>
                  <Collapse in={showNewFolder}>
                    <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
                      <TextField
                        size="small"
                        placeholder="New folder name"
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        sx={{ flex: 1 }}
                        inputProps={{ style: { fontSize: '0.75rem', padding: '4px 8px' } }}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); }}
                      />
                      <Button size="small" variant="outlined" onClick={handleCreateFolder} sx={{ textTransform: 'none', fontSize: '0.7rem', minWidth: 0 }}>
                        Create
                      </Button>
                    </Box>
                  </Collapse>
                </Box>
              </Collapse>
            </Box>
            <FormControl size="small" fullWidth>
              <InputLabel>Figure format</InputLabel>
              <Select
                value={figureFormat}
                label="Figure format"
                onChange={(e) => onFigureFormatChange(e.target.value as 'jpg' | 'png' | 'pdf')}
              >
                <MenuItem value="png">PNG</MenuItem>
                <MenuItem value="jpg">JPG</MenuItem>
                <MenuItem value="pdf">PDF</MenuItem>
              </Select>
            </FormControl>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              Layers to save:
            </Typography>
            <Box sx={{ maxHeight: 400, overflowY: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
              {availableFigureLayers.length === 0 ? (
                <Typography variant="caption" color="text.secondary">
                  No exportable layers found
                </Typography>
              ) : (
                availableFigureLayers.map((layer) => {
                  const isChecked = selectedFigureLayerIds.includes(layer.id);
                  const isExpanded = expandedFigureLayer === layer.id;
                  const ovr = figureLayerOverrides[layer.id];
                  const hasBands = layer.bandNames && layer.bandNames.length > 1;
                  return (
                    <Box key={layer.id} sx={{ mb: 0.5 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        <Checkbox
                          size="small"
                          checked={isChecked}
                          onChange={() => onToggleFigureLayer(layer.id)}
                        />
                        <Typography
                          variant="caption"
                          sx={{ flex: 1, cursor: 'pointer', userSelect: 'none' }}
                          onClick={() => setExpandedFigureLayer(isExpanded ? null : layer.id)}
                        >
                          {layer.name}
                          {hasBands && ` (${layer.bandNames!.length} bands)`}
                        </Typography>
                        <IconButton size="small" onClick={() => setExpandedFigureLayer(isExpanded ? null : layer.id)}>
                          {isExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                        </IconButton>
                      </Box>
                      <Collapse in={isExpanded}>
                        <Box sx={{ pl: 4, pr: 1, pb: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                          {hasBands && (
                            <>
                              <Typography variant="caption" color="text.secondary">Bands:</Typography>
                              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0 }}>
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
                                        />
                                      }
                                      label={<Typography variant="caption">{bname}</Typography>}
                                      sx={{ m: 0, mr: 0.5 }}
                                    />
                                  );
                                })}
                              </Box>
                            </>
                          )}
                          <FormControl size="small" fullWidth>
                            <InputLabel>Colormap</InputLabel>
                            <Select
                              value={ovr?.colormap ?? ''}
                              label="Colormap"
                              onChange={(e) => onUpdateFigureLayerOverride(layer.id, { colormap: e.target.value || undefined })}
                            >
                              <MenuItem value=""><em>Default</em></MenuItem>
                              {['viridis','inferno','magma','plasma','cividis','greens','blues','reds','greys',
                                'ylgn','ylgnbu','gnbu','bugn','pubu','rdylgn','spectral','rdbu','oranges',
                                'ylgn_r','spectral_r','rdbu_r'].map((cm) => (
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
                              sx={{ flex: 1 }}
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
                              sx={{ flex: 1 }}
                              inputProps={{ step: 'any' }}
                            />
                          </Box>
                        </Box>
                      </Collapse>
                    </Box>
                  );
                })
              )}
            </Box>
            {figureSaveError && <Alert severity="error">{figureSaveError}</Alert>}
            {figureSaveMessage && <Alert severity="success">{figureSaveMessage}</Alert>}
            <Button
              variant="contained"
              color="secondary"
              onClick={onSaveFigures}
              disabled={savingFigures || !figureSelectionReady || selectedFigureLayerIds.length === 0}
              startIcon={savingFigures ? <CircularProgress size={18} color="inherit" /> : undefined}
            >
              {savingFigures ? 'Saving figures...' : 'Save figures'}
            </Button>
          </Box>
        </Box>
      </Box>
    </SidebarContainer>
  );
} 