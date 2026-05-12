import React, { useState, useMemo } from 'react';
import {
  Box,
  Paper,
  Typography,
  Switch,
  Slider,
  IconButton,
  Collapse,
  List,
  ListItem,
  ListItemText,
  Divider,
  TextField,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormControlLabel,
  Tooltip,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Radio,
  RadioGroup,
} from '@mui/material';
import { ColorPicker } from 'antd';
import type { ColorPickerProps, GetProp } from 'antd';
import {
  Layers as LayersIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
  Info as InfoIcon,
  Palette as PaletteIcon,
  FilterList as FilterListIcon,
  Delete as DeleteIcon,
  Add as AddIcon,
  DragIndicator as DragIndicatorIcon,
  MyLocation as MyLocationIcon,
} from '@mui/icons-material';
import { useMapStore, type ConditionalStyle } from '../stores/mapStore';
import { PALETTES, type PaletteName } from '../constants/palettes';
import { COLORMAPS } from '../constants/colormaps';
import { getDefaultRescaleForRh } from '../constants/predictions';
import {
  DIVERSITY_INDICES_BAND_NAMES,
  DIVERSITY_INDICES_DEFAULT_COLORMAP,
  getDiversityBandRange,
  getDiversityRgbRanges,
} from '../constants/layerRanges';
import type { DiversityBandConfig } from '../hooks/useLayerLoaders';

type Color = GetProp<ColorPickerProps, 'value'>;
export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  zIndex: number;
  type: 'cog' | 'fgb' | 'sentinel2' | 'prediction' | 'vector' | 'earthengine';
  metadata?: Record<string, any>;
}

export interface LayerControlProps {
  layers: Layer[];
  onToggleVisibility: (layerId: string) => void;
  onChangeOpacity: (layerId: string, opacity: number) => void;
  onChangeZIndex: (layerId: string, zIndex: number) => void;
  onReorderLayers: (fromIndex: number, toIndex: number) => void;
  onRemoveLayer?: (layerId: string) => void;
  onLocateLayer?: (layerId: string) => void;
  onChangePredictionRescale?: (layerId: string, min: number, max: number) => void;
  onChangePredictionColormap?: (layerId: string, colormap: string) => void;
  onChangeDiversityBandConfig?: (layerId: string, config: Partial<DiversityBandConfig>) => void;
  onHighlightFeature?: (layerId: string, featureIndex: number | null) => void;
  onRemoveFeature?: (layerId: string, featureIndex: number) => void;
  vectorFeatures?: Record<string, { name: string; index: number }[]>;
}

function normalizeDiversityBandNames(bandNames?: string[]): string[] {
  if (!Array.isArray(bandNames) || bandNames.length === 0) return [...DIVERSITY_INDICES_BAND_NAMES];
  if (bandNames.includes('CR')) return bandNames;
  if (bandNames.length === 3) return [...bandNames, 'CR'];
  return bandNames;
}

function DiversityIndicesStylePanel({ layer, onChangeOpacity, onChangeDiversityBandConfig }: {
  layer: Layer;
  onChangeOpacity: (layerId: string, opacity: number) => void;
  onChangeDiversityBandConfig?: (layerId: string, config: Partial<DiversityBandConfig>) => void;
}) {
  const meta = layer.metadata ?? {};
  const bandNames: string[] = normalizeDiversityBandNames(meta.bandNames);
  const bandMode: 'grayscale' | 'rgb' = meta.bandMode ?? 'grayscale';
  const selectedBand: number = meta.selectedBand ?? 1;
  const rgbBands: [number, number, number] = meta.rgbBands ?? [1, 2, 3];
  const selectedBandDefaults = getDiversityBandRange(selectedBand);
  const rescaleMin: number = meta.rescaleMin ?? selectedBandDefaults[0];
  const rescaleMax: number = meta.rescaleMax ?? selectedBandDefaults[1];
  const rgbRescales: [number, number][] = meta.rgbRescales ?? getDiversityRgbRanges(rgbBands);
  const colormap: string = meta.colormap ?? DIVERSITY_INDICES_DEFAULT_COLORMAP;
  const gamma: number = meta.gamma ?? 1.0;

  const fire = (cfg: Partial<DiversityBandConfig>) =>
    onChangeDiversityBandConfig?.(layer.id, cfg);

  const handleBandModeChange = (mode: 'grayscale' | 'rgb') => {
    if (mode === 'grayscale') {
      const defaults = getDiversityBandRange(selectedBand);
      fire({ bandMode: mode, rescaleMin: defaults[0], rescaleMax: defaults[1], colormap });
    } else {
      fire({ bandMode: mode, rgbBands, rgbRescales });
    }
  };

  const handleGrayscaleBandChange = (band: number) => {
    const defaults = getDiversityBandRange(band);
    fire({ selectedBand: band, rescaleMin: defaults[0], rescaleMax: defaults[1] });
  };

  const handleRGBBandChange = (channel: 0 | 1 | 2, band: number) => {
    const newBands: [number, number, number] = [...rgbBands] as [number, number, number];
    newBands[channel] = band;
    const newRescales = [...rgbRescales];
    newRescales[channel] = getDiversityBandRange(band);
    fire({ rgbBands: newBands, rgbRescales: newRescales });
  };

  const channelLabels = ['Red', 'Green', 'Blue'] as const;
  const channelColors = ['#d32f2f', '#388e3c', '#1976d2'] as const;

  return (
    <Box sx={{ mt: 2, p: 1.5, bgcolor: 'grey.50', borderRadius: 1 }}>
      <Typography variant="subtitle2" gutterBottom sx={{ fontWeight: 600 }}>
        Band Visualization
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {/* Band mode radio */}
        <RadioGroup
          row
          value={bandMode}
          onChange={(e) => handleBandModeChange(e.target.value as 'grayscale' | 'rgb')}
        >
          <FormControlLabel
            value="grayscale"
            control={<Radio size="small" />}
            label={<Typography variant="caption">1 band (Grayscale)</Typography>}
          />
          <FormControlLabel
            value="rgb"
            control={<Radio size="small" />}
            label={<Typography variant="caption">3 bands (RGB)</Typography>}
          />
        </RadioGroup>

        {/* Band selectors */}
        {bandMode === 'grayscale' ? (
          <FormControl size="small" fullWidth>
            <InputLabel>Band</InputLabel>
            <Select
              value={selectedBand}
              label="Band"
              onChange={(e) => handleGrayscaleBandChange(Number(e.target.value))}
            >
              {bandNames.map((name, i) => (
                <MenuItem key={i + 1} value={i + 1}>{name}</MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : (
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            {([0, 1, 2] as const).map((ch) => (
              <FormControl key={ch} size="small" sx={{ flex: 1 }}>
                <InputLabel sx={{ color: channelColors[ch], fontWeight: 600 }}>
                  {channelLabels[ch]}
                </InputLabel>
                <Select
                  value={rgbBands[ch]}
                  label={channelLabels[ch]}
                  onChange={(e) => handleRGBBandChange(ch, Number(e.target.value))}
                  sx={{ '& .MuiSelect-select': { fontSize: '0.8rem' } }}
                >
                  {bandNames.map((name, i) => (
                    <MenuItem key={i + 1} value={i + 1}>{name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            ))}
          </Box>
        )}

        {/* Range */}
        {bandMode === 'grayscale' ? (
          <Box>
            <Typography variant="caption" color="text.secondary" gutterBottom sx={{ display: 'block' }}>
              Range
            </Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                label="Min"
                type="number"
                value={rescaleMin}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) fire({ rescaleMin: val });
                }}
                size="small"
                inputProps={{ step: 0.1 }}
                sx={{ flex: 1 }}
              />
              <TextField
                label="Max"
                type="number"
                value={rescaleMax}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) fire({ rescaleMax: val });
                }}
                size="small"
                inputProps={{ step: 0.1 }}
                sx={{ flex: 1 }}
              />
            </Box>
          </Box>
        ) : (
          <Box>
            <Typography variant="caption" color="text.secondary" gutterBottom sx={{ display: 'block' }}>
              Range (per band)
            </Typography>
            {([0, 1, 2] as const).map((ch) => (
              <Box key={ch} sx={{ display: 'flex', gap: 1, mb: 0.5, alignItems: 'center' }}>
                {(() => {
                  const channelDefaults = getDiversityBandRange(rgbBands[ch]);
                  return (
                    <>
                <Typography variant="caption" sx={{ color: channelColors[ch], fontWeight: 600, width: 16 }}>
                  {channelLabels[ch][0]}
                </Typography>
                <TextField
                  type="number"
                  value={rgbRescales[ch]?.[0] ?? channelDefaults[0]}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (isNaN(val)) return;
                    const newRescales = [...rgbRescales] as [number, number][];
                    newRescales[ch] = [val, newRescales[ch]?.[1] ?? channelDefaults[1]];
                    fire({ rgbRescales: newRescales });
                  }}
                  size="small"
                  inputProps={{ step: 0.1 }}
                  sx={{ flex: 1, '& input': { py: 0.5, fontSize: '0.8rem' } }}
                />
                <Typography variant="caption" color="text.secondary">-</Typography>
                <TextField
                  type="number"
                  value={rgbRescales[ch]?.[1] ?? channelDefaults[1]}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (isNaN(val)) return;
                    const newRescales = [...rgbRescales] as [number, number][];
                    newRescales[ch] = [newRescales[ch]?.[0] ?? channelDefaults[0], val];
                    fire({ rgbRescales: newRescales });
                  }}
                  size="small"
                  inputProps={{ step: 0.1 }}
                  sx={{ flex: 1, '& input': { py: 0.5, fontSize: '0.8rem' } }}
                />
                    </>
                  );
                })()}
              </Box>
            ))}
          </Box>
        )}

        {/* Colormap (grayscale only) */}
        {bandMode === 'grayscale' && (
          <FormControl size="small" fullWidth>
            <InputLabel>Colormap</InputLabel>
            <Select
              value={colormap}
              label="Colormap"
              onChange={(e) => fire({ colormap: e.target.value })}
            >
              {COLORMAPS.map((cm) => (
                <MenuItem key={cm} value={cm}>{cm}</MenuItem>
              ))}
            </Select>
          </FormControl>
        )}

        {/* Opacity */}
        <Box>
          <Typography variant="caption" color="text.secondary" gutterBottom>
            Opacity: {Math.round(layer.opacity * 100)}%
          </Typography>
          <Slider
            value={layer.opacity}
            onChange={(_, value) => onChangeOpacity(layer.id, value as number)}
            min={0}
            max={1}
            step={0.05}
            size="small"
            valueLabelDisplay="auto"
            valueLabelFormat={(value) => `${Math.round(value * 100)}%`}
          />
        </Box>

        {/* Gamma */}
        <Box>
          <Typography variant="caption" color="text.secondary" gutterBottom>
            Gamma: {gamma.toFixed(2)}
          </Typography>
          <Slider
            value={gamma}
            onChange={(_, value) => fire({ gamma: value as number })}
            min={0.1}
            max={3.0}
            step={0.05}
            size="small"
            valueLabelDisplay="auto"
          />
        </Box>
      </Box>
    </Box>
  );
}

export function LayerControl({
  layers,
  onToggleVisibility,
  onChangeOpacity,
  onReorderLayers,
  onRemoveLayer,
  onLocateLayer,
  onChangePredictionRescale,
  onChangePredictionColormap,
  onChangeDiversityBandConfig,
  onHighlightFeature,
  onRemoveFeature: _onRemoveFeature,
  vectorFeatures,
}: LayerControlProps) {
  void _onRemoveFeature;
  // Zustand store
  const {
    fgbInfo,
    fgbStyleOptions,
    conditionalStyles,
    conditionalLogicMode,
    enableConditionalRendering,
    updateFgbStyleOption,
    setEnableConditionalRendering,
    setConditionalLogicMode,
    addConditionalStyle,
    updateConditionalStyle,
    removeConditionalStyle,
  } = useMapStore();
  const [expanded, setExpanded] = useState(true);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showStyle, setShowStyle] = useState(false);
  const [showConditional, setShowConditional] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [featureListLayerId, setFeatureListLayerId] = useState<string | null>(null);

  // Extract RH index from prediction layer ID
  // Format: prediction-${tile_name}-RH${rh_index}-${qLabel}-${year}-${timestamp}
  const extractRhIndex = (layerId: string): number | null => {
    const match = layerId.match(/-RH(\d+)-/);
    return match ? parseInt(match[1], 10) : null;
  };

  // Group layers by type and RH index
  const groupedLayers = useMemo(() => {
    const groups: {
      other: Layer[];
      sentinel2: Layer[];
      earthengine: Layer[];
      predictions: Record<number, Layer[]>;
      vector: Layer[];
    } = {
      other: [],
      sentinel2: [],
      earthengine: [],
      predictions: {},
      vector: [],
    };

    layers.forEach((layer) => {
      if (layer.type === 'prediction') {
        const rhIndex = extractRhIndex(layer.id);
        if (rhIndex !== null) {
          if (!groups.predictions[rhIndex]) {
            groups.predictions[rhIndex] = [];
          }
          groups.predictions[rhIndex].push(layer);
        } else {
          groups.other.push(layer);
        }
      } else if (layer.type === 'sentinel2') {
        groups.sentinel2.push(layer);
      } else if (layer.type === 'earthengine') {
        groups.earthengine.push(layer);
      } else if (layer.type === 'vector') {
        groups.vector.push(layer);
      } else {
        groups.other.push(layer);
      }
    });

    return groups;
  }, [layers]);

  const handleGroupToggle = (groupKey: string) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [groupKey]: !prev[groupKey],
    }));
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDragEnd = () => {
    if (draggedIndex !== null && dragOverIndex !== null && draggedIndex !== dragOverIndex) {
      onReorderLayers(draggedIndex, dragOverIndex);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  // Helper function to render a single layer item
  const renderLayerItem = (layer: Layer, index: number) => {
  return (
                <React.Fragment key={layer.id}>
                  <ListItem
                    draggable
                    onDragStart={(e) => handleDragStart(e, index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDragEnd={handleDragEnd}
                    onDragLeave={handleDragLeave}
                    sx={{
                      flexDirection: 'column',
                      alignItems: 'stretch',
                      p: 2,
                      bgcolor: dragOverIndex === index 
                        ? 'primary.light' 
                        : selectedLayer === layer.id 
                        ? 'action.selected' 
                        : 'transparent',
                      opacity: draggedIndex === index ? 0.5 : 1,
                      '&:hover': { bgcolor: 'action.hover' },
                      cursor: 'grab',
                      '&:active': { cursor: 'grabbing' },
                      transition: 'all 0.2s ease',
                      border: dragOverIndex === index ? '2px dashed' : 'none',
                      borderColor: 'primary.main',
                    }}
                  >
                    {/* Layer Name and Controls */}
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                      <Tooltip title="Drag to reorder">
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            cursor: 'grab',
                            color: 'text.secondary',
                            mr: 1,
                            '&:active': { cursor: 'grabbing' },
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <DragIndicatorIcon fontSize="small" />
                        </Box>
                      </Tooltip>
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleVisibility(layer.id);
                        }}
                        sx={{ mr: 1 }}
                      >
                        {layer.visible ? <VisibilityIcon /> : <VisibilityOffIcon />}
                      </IconButton>
                      {onLocateLayer && (
                        <Tooltip title="Locate layer on map">
                          <IconButton
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              onLocateLayer!(layer.id);
                            }}
                            sx={{ mr: 1 }}
                          >
                            <MyLocationIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                      <Typography 
                        variant="body1" 
                        sx={{ 
                          flexGrow: 1, 
                          fontWeight: 500,
                          cursor: 'pointer',
                          userSelect: 'none',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedLayer(selectedLayer === layer.id ? null : layer.id);
                        }}
                      >
                        {layer.name}
                      </Typography>
                      
                      {/* Layer-specific controls */}
                      <Box sx={{ display: 'flex', gap: 0.5 }}>
                        {layer.type === 'fgb' && fgbInfo && (
                          <>
                            <Tooltip title="Layer Info">
                              <IconButton
                                size="small"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setShowInfo(!showInfo);
                                  // Only expand if not already selected
                                  if (selectedLayer !== layer.id) {
                                    setSelectedLayer(layer.id);
                                  }
                                }}
                                color={showInfo ? 'primary' : 'default'}
                              >
                                <InfoIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </>
                        )}
                        
                        {/* Style button for all layers */}
                        <Tooltip title="Style Options">
                          <IconButton
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowStyle(!showStyle);
                              // Only expand if not already selected
                              if (selectedLayer !== layer.id) {
                                setSelectedLayer(layer.id);
                              }
                            }}
                            color={showStyle ? 'primary' : 'default'}
                          >
                            <PaletteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        
                        {layer.type === 'fgb' && fgbInfo && (
                          <Tooltip title="Conditional Rendering">
                            <IconButton
                              size="small"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowConditional(!showConditional);
                                // Only expand if not already selected
                                if (selectedLayer !== layer.id) {
                                  setSelectedLayer(layer.id);
                                }
                              }}
                              color={showConditional ? 'primary' : 'default'}
                            >
                              <FilterListIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                        
                        {/* Delete button for removable layers */}
                        {onRemoveLayer && (
                          <Tooltip title="Remove Layer">
                            <IconButton
                              size="small"
                              onClick={(e) => {
                                e.stopPropagation();
                                onRemoveLayer(layer.id);
                              }}
                              color="error"
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Box>
                    </Box>

                    {/* Expanded Controls */}
                    <Collapse in={selectedLayer === layer.id}>
                      <Box sx={{ mt: 1, pl: 1 }}>
              {renderLayerControls(layer)}
            </Box>
          </Collapse>
        </ListItem>
      </React.Fragment>
    );
  };

  // Helper function to render layer controls
  const renderLayerControls = (layer: Layer) => {
    return (
      <>
                        {/* COG/GeoTIFF Style Options */}
                        {layer.type === 'cog' && (
                          <Collapse in={showStyle}>
                            <Box sx={{ mt: 2, p: 1.5, bgcolor: 'grey.50', borderRadius: 1 }}>
                              <Typography variant="subtitle2" gutterBottom sx={{ fontWeight: 600 }}>
                                🎨 Style Options
                              </Typography>
                              <Box>
                                <Typography variant="caption" color="text.secondary" gutterBottom>
                                  Layer Opacity: {Math.round(layer.opacity * 100)}%
                                </Typography>
                                <Slider
                                  value={layer.opacity}
                                  onChange={(_, value) => onChangeOpacity(layer.id, value as number)}
                                  min={0}
                                  max={1}
                                  step={0.1}
                                  size="small"
                                  valueLabelDisplay="auto"
                                  valueLabelFormat={(value) => `${Math.round(value * 100)}%`}
                                />
                              </Box>
                            </Box>
                          </Collapse>
                        )}

                        {/* Sentinel-2 Style Options */}
                        {layer.type === 'sentinel2' && (
                          <Collapse in={showStyle}>
                            <Box sx={{ mt: 2, p: 1.5, bgcolor: 'grey.50', borderRadius: 1 }}>
                              <Typography variant="subtitle2" gutterBottom sx={{ fontWeight: 600 }}>
                                🎨 Style Options
                              </Typography>
                              <Box>
                                <Typography variant="caption" color="text.secondary" gutterBottom>
                                  Layer Opacity: {Math.round(layer.opacity * 100)}%
                                </Typography>
                                <Slider
                                  value={layer.opacity}
                                  onChange={(_, value) => onChangeOpacity(layer.id, value as number)}
                                  min={0}
                                  max={1}
                                  step={0.1}
                                  size="small"
                                  valueLabelDisplay="auto"
                                  valueLabelFormat={(value) => `${Math.round(value * 100)}%`}
                                />
                              </Box>
                            </Box>
                          </Collapse>
                        )}

                        {/* Earth Engine raster */}
                        {layer.type === 'earthengine' && (
                          <Collapse in={showStyle}>
                            <Box sx={{ mt: 2, p: 1.5, bgcolor: 'grey.50', borderRadius: 1 }}>
                              <Typography variant="subtitle2" gutterBottom sx={{ fontWeight: 600 }}>
                                Style Options
                              </Typography>
                              <Box>
                                <Typography variant="caption" color="text.secondary" gutterBottom>
                                  Layer Opacity: {Math.round(layer.opacity * 100)}%
                                </Typography>
                                <Slider
                                  value={layer.opacity}
                                  onChange={(_, value) => onChangeOpacity(layer.id, value as number)}
                                  min={0}
                                  max={1}
                                  step={0.05}
                                  size="small"
                                  valueLabelDisplay="auto"
                                  valueLabelFormat={(value) => `${Math.round(value * 100)}%`}
                                />
                              </Box>
                            </Box>
                          </Collapse>
                        )}

                        {/* Diversity Indices Style Options */}
                        {layer.type === 'prediction' && layer.metadata?.layerType === 'diversity_indices' && (
                          <Collapse in={showStyle}>
                            <DiversityIndicesStylePanel
                              layer={layer}
                              onChangeOpacity={onChangeOpacity}
                              onChangeDiversityBandConfig={onChangeDiversityBandConfig}
                            />
                          </Collapse>
                        )}

                        {/* Prediction Style Options (non-diversity) */}
                        {layer.type === 'prediction' && layer.metadata?.layerType !== 'diversity_indices' && (
                          <Collapse in={showStyle}>
                            <Box sx={{ mt: 2, p: 1.5, bgcolor: 'grey.50', borderRadius: 1 }}>
                              <Typography variant="subtitle2" gutterBottom sx={{ fontWeight: 600 }}>
                                Style Options
                              </Typography>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                              <Box>
                                <Typography variant="caption" color="text.secondary" gutterBottom>
                                  Layer Opacity: {Math.round(layer.opacity * 100)}%
                                </Typography>
                                <Slider
                                  value={layer.opacity}
                                  onChange={(_, value) => onChangeOpacity(layer.id, value as number)}
                                  min={0}
                                  max={1}
                                  step={0.1}
                                  size="small"
                                  valueLabelDisplay="auto"
                                  valueLabelFormat={(value) => `${Math.round(value * 100)}%`}
                                />
                </Box>
                {onChangePredictionRescale && (
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    {(() => {
                      const rh = layer.metadata?.rhIndex as number | undefined;
                      const defaultRescale = rh != null ? getDefaultRescaleForRh(rh) : { min: 0, max: 500 };
                      const defaultMax = defaultRescale.max;
                      return (
                        <>
                          <TextField
                            label="Min"
                            type="number"
                            value={layer.metadata?.rescaleMin ?? defaultRescale.min}
                            onChange={(e) => {
                              const min = parseFloat(e.target.value);
                              const max = layer.metadata?.rescaleMax ?? defaultMax;
                              if (!isNaN(min) && onChangePredictionRescale) {
                                onChangePredictionRescale(layer.id, min, max);
                              }
                            }}
                            size="small"
                            inputProps={{ step: 1 }}
                            sx={{ width: '50%' }}
                          />
                          <TextField
                            label="Max"
                            type="number"
                            value={layer.metadata?.rescaleMax ?? defaultMax}
                            onChange={(e) => {
                              const max = parseFloat(e.target.value);
                              const min = layer.metadata?.rescaleMin ?? defaultRescale.min;
                              if (!isNaN(max) && onChangePredictionRescale) {
                                onChangePredictionRescale(layer.id, min, max);
                              }
                            }}
                            size="small"
                            inputProps={{ step: 1 }}
                            sx={{ width: '50%' }}
                          />
                        </>
                      );
                    })()}
                  </Box>
                )}
                {onChangePredictionColormap && (
                  <FormControl size="small" fullWidth>
                    <InputLabel>Colormap</InputLabel>
                    <Select
                      value={String(layer.metadata?.colormap ?? 'inferno')}
                      label="Colormap"
                      onChange={(e) => onChangePredictionColormap(layer.id, String(e.target.value))}
                    >
                      {COLORMAPS.map((cm) => (
                        <MenuItem key={cm} value={cm}>{cm}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}
                              </Box>
                            </Box>
                          </Collapse>
                        )}

                        {/* FlatGeobuf Info Panel */}
                        {layer.type === 'fgb' && fgbInfo && (
                          <Collapse in={showInfo}>
                            <Box sx={{ mt: 2, p: 1.5, bgcolor: 'grey.50', borderRadius: 1 }}>
                              <Typography variant="subtitle2" gutterBottom sx={{ fontWeight: 600 }}>
                                📊 Layer Information
                              </Typography>
                              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, fontSize: '0.75rem' }}>
                                <Typography variant="caption">
                                  Type: <strong>{fgbInfo.type}</strong>
                                </Typography>
                                <Typography variant="caption">
                                  Features: <strong>{fgbInfo.featureCount}</strong>
                                </Typography>
                                <Typography variant="caption">
                                  Geometry: <strong>{fgbInfo.geometryTypes?.join(', ') || 'N/A'}</strong>
                                </Typography>
                                <Typography variant="caption" sx={{ mt: 0.5 }}>
                                  Properties:
                                </Typography>
                                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                                  {fgbInfo.properties?.slice(0, 5).map((prop: string) => (
                                    <Chip key={prop} label={prop} size="small" sx={{ height: 20, fontSize: '0.65rem' }} />
                                  ))}
                                  {fgbInfo.properties && fgbInfo.properties.length > 5 && (
                                    <Chip label={`+${fgbInfo.properties.length - 5}`} size="small" sx={{ height: 20, fontSize: '0.65rem' }} />
                                  )}
                                </Box>
                              </Box>
                            </Box>
                          </Collapse>
                        )}

                        {/* Style Options Panel */}
                        {layer.type === 'fgb' && (
                          <Collapse in={showStyle}>
                            <Box sx={{ mt: 2, p: 1.5, bgcolor: 'grey.50', borderRadius: 1 }}>
                              <Typography variant="subtitle2" gutterBottom sx={{ fontWeight: 600 }}>
                                🎨 Style Options
                              </Typography>
                              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                                {/* Layer Opacity Slider */}
                                <Box>
                                  <Typography variant="caption" color="text.secondary" gutterBottom>
                                    Layer Opacity: {Math.round(layer.opacity * 100)}%
                                  </Typography>
                                  <Slider
                                    value={layer.opacity}
                                    onChange={(_, value) => onChangeOpacity(layer.id, value as number)}
                                    min={0}
                                    max={1}
                                    step={0.1}
                                    size="small"
                                    valueLabelDisplay="auto"
                                    valueLabelFormat={(value) => `${Math.round(value * 100)}%`}
                                  />
                                </Box>

                                <Box sx={{ display: 'flex', gap: 1 }}>
                  <Box sx={{ width: '100%' }}>
                    <Box sx={{ display: 'flex', gap: 1, mb: 1, alignItems: 'center' }}>
                      <Box sx={{ flex: 1 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                          Fill
                        </Typography>
                        <ColorPicker
                          value={fgbStyleOptions.fillColor || '#ff0000ff'}
                          onChange={(color: Color) => {
                            if (typeof color === 'string') {
                              updateFgbStyleOption({ fillColor: color });
                            } else if (color && typeof color === 'object' && 'toHexString' in color && 'toRgb' in color) {
                              const hex = (color as any).toHexString();
                              const rgb = (color as any).toRgb();
                              const alpha = Math.round(rgb.a * 255).toString(16).padStart(2, '0');
                              updateFgbStyleOption({ fillColor: hex + alpha });
                            }
                          }}
                          showText
                          format="hex"
                          presets={[
                            {
                              label: 'Recommended',
                              colors: [
                                '#ff0000ff', '#00ff00ff', '#0000ffff', '#ffff00ff',
                                '#ff00ffff', '#00ffffff', '#000000ff', '#ffffff00',
                              ],
                            },
                          ]}
                        />
                      </Box>
                      <Box sx={{ flex: 1 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                          Stroke
                        </Typography>
                        <ColorPicker
                          value={fgbStyleOptions.strokeColor || '#000000'}
                          onChange={(color: Color) => {
                            if (typeof color === 'string') {
                              updateFgbStyleOption({ strokeColor: color });
                            } else if (color && typeof color === 'object' && 'toHexString' in color) {
                              updateFgbStyleOption({ strokeColor: (color as any).toHexString() });
                            }
                          }}
                          showText
                          format="hex"
                        />
                      </Box>
                    </Box>
                  </Box>
                                </Box>
                                <Box sx={{ display: 'flex', gap: 1 }}>
                                  <TextField
                                    label="Stroke Width"
                                    type="number"
                                    value={fgbStyleOptions.strokeWidth}
                                    onChange={(e) => updateFgbStyleOption({ strokeWidth: parseInt(e.target.value) })}
                                    size="small"
                                    inputProps={{ min: 1, max: 10 }}
                                    sx={{ width: '50%' }}
                                  />
                                  <TextField
                                    label="Point Radius"
                                    type="number"
                                    value={fgbStyleOptions.pointRadius}
                                    onChange={(e) => updateFgbStyleOption({ pointRadius: parseInt(e.target.value) })}
                                    size="small"
                                    inputProps={{ min: 1, max: 20 }}
                                    sx={{ width: '50%' }}
                                  />
                                </Box>

                                <FormControlLabel
                                  control={(
                                    <Switch
                                      size="small"
                                      checked={Boolean(fgbStyleOptions.clusterPoints)}
                                      onChange={(e) => updateFgbStyleOption({ clusterPoints: e.target.checked })}
                                    />
                                  )}
                                  label={<Typography variant="caption">Cluster points (recommended for large datasets)</Typography>}
                                />

                                <FormControl size="small" fullWidth>
                                  <InputLabel>Color by column</InputLabel>
                                  <Select
                                    value={fgbStyleOptions.colorByProperty || ''}
                                    label="Color by column"
                                    onChange={(e) => {
                                      const prop = String(e.target.value);
                                      const range = prop ? fgbInfo?.numericPropertyRanges?.[prop] : undefined;
                                      updateFgbStyleOption({
                                        colorByProperty: prop,
                                        colorScaleType: 'continuous',
                                        colorRangeMin: range?.min ?? null,
                                        colorRangeMax: range?.max ?? null,
                                      });
                                    }}
                                  >
                                    <MenuItem value="">
                                      <em>None</em>
                                    </MenuItem>
                                    {fgbInfo?.properties?.map((prop: string) => (
                                      <MenuItem key={prop} value={prop}>{prop}</MenuItem>
                                    ))}
                                  </Select>
                                </FormControl>

                                {fgbStyleOptions.colorByProperty && (
                                  <>
                                    <FormControl size="small" fullWidth>
                                      <InputLabel>Color scale</InputLabel>
                                      <Select
                                        value={fgbStyleOptions.colorScaleType || 'continuous'}
                                        label="Color scale"
                                        onChange={(e) => {
                                          const scaleType = String(e.target.value) as 'continuous' | 'discrete';
                                          const prop = fgbStyleOptions.colorByProperty;
                                          const range = prop ? fgbInfo?.numericPropertyRanges?.[prop] : undefined;
                                          updateFgbStyleOption({
                                            colorScaleType: scaleType,
                                            colorRangeMin: scaleType === 'continuous' ? (range?.min ?? fgbStyleOptions.colorRangeMin) : null,
                                            colorRangeMax: scaleType === 'continuous' ? (range?.max ?? fgbStyleOptions.colorRangeMax) : null,
                                          });
                                        }}
                                      >
                                        <MenuItem value="continuous">Continuous</MenuItem>
                                        <MenuItem value="discrete">Discrete</MenuItem>
                                      </Select>
                                    </FormControl>

                                    <FormControl size="small" fullWidth>
                                      <InputLabel>Palette</InputLabel>
                                      <Select
                                        value={fgbStyleOptions.colorPalette || 'Viridis'}
                                        label="Palette"
                                        onChange={(e) => updateFgbStyleOption({ colorPalette: String(e.target.value) })}
                                      >
                                        {Object.keys(PALETTES).map((paletteName) => (
                                          <MenuItem key={paletteName} value={paletteName}>{paletteName}</MenuItem>
                                        ))}
                                      </Select>
                                    </FormControl>
                                    {fgbStyleOptions.colorScaleType !== 'discrete' ? (
                                      <>
                                        <Box sx={{ display: 'flex', gap: 1 }}>
                                          <TextField
                                            label="Color min"
                                            type="number"
                                            size="small"
                                            value={fgbStyleOptions.colorRangeMin ?? ''}
                                            onChange={(e) => {
                                              const v = e.target.value;
                                              updateFgbStyleOption({ colorRangeMin: v === '' ? null : Number(v) });
                                            }}
                                            sx={{ width: '50%' }}
                                          />
                                          <TextField
                                            label="Color max"
                                            type="number"
                                            size="small"
                                            value={fgbStyleOptions.colorRangeMax ?? ''}
                                            onChange={(e) => {
                                              const v = e.target.value;
                                              updateFgbStyleOption({ colorRangeMax: v === '' ? null : Number(v) });
                                            }}
                                            sx={{ width: '50%' }}
                                          />
                                        </Box>
                                        <Button
                                          size="small"
                                          variant="outlined"
                                          onClick={() => {
                                            const prop = fgbStyleOptions.colorByProperty;
                                            if (!prop) return;
                                            const range = fgbInfo?.numericPropertyRanges?.[prop];
                                            if (range) {
                                              updateFgbStyleOption({
                                                colorRangeMin: range.min,
                                                colorRangeMax: range.max,
                                              });
                                            }
                                          }}
                                        >
                                          Reset range to data min/max
                                        </Button>
                                      </>
                                    ) : (
                                      <Typography variant="caption" color="text.secondary">
                                        Discrete mode maps each unique value in the selected column to a palette color.
                                      </Typography>
                                    )}
                                  </>
                                )}
                              </Box>
                            </Box>
                          </Collapse>
                        )}

                        {/* Conditional Rendering Panel */}
                        {layer.type === 'fgb' && fgbInfo && (
                          <Collapse in={showConditional}>
                            <Box sx={{ mt: 2, p: 1.5, bgcolor: 'grey.50', borderRadius: 1 }}>
                              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                                  🎯 Conditional Rendering
                                </Typography>
                                <FormControlLabel
                                  control={
                                    <Switch
                                      checked={enableConditionalRendering}
                                      onChange={(e) => setEnableConditionalRendering(e.target.checked)}
                                      size="small"
                                    />
                                  }
                                  label={<Typography variant="caption">Enable</Typography>}
                                />
                              </Box>

                              {enableConditionalRendering && (
                                <>
                                  <FormControl size="small" fullWidth sx={{ mb: 1 }}>
                                    <InputLabel>Match</InputLabel>
                                    <Select
                                      value={conditionalLogicMode}
                                      onChange={(e) => setConditionalLogicMode(e.target.value as 'any' | 'all')}
                                      label="Match"
                                    >
                                      <MenuItem value="any">ANY (OR)</MenuItem>
                                      <MenuItem value="all">ALL (AND)</MenuItem>
                                    </Select>
                                  </FormControl>

                                  <Button
                                    variant="outlined"
                                    size="small"
                                    onClick={addConditionalStyle}
                                    startIcon={<AddIcon />}
                                    fullWidth
                                    sx={{ mb: 1 }}
                                  >
                                    Add Condition
                                  </Button>

                                  {conditionalStyles.map((style: ConditionalStyle, index: number) => (
                                    <Paper key={index} sx={{ p: 1, mb: 1, border: '1px solid #ddd' }}>
                                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                                        <Typography variant="caption" sx={{ fontWeight: 500 }}>
                                          Condition {index + 1}
                                        </Typography>
                                        <IconButton
                                          size="small"
                                          onClick={() => removeConditionalStyle(index)}
                                        >
                                          <DeleteIcon fontSize="small" />
                                        </IconButton>
                                      </Box>

                                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                        <FormControl size="small" fullWidth>
                                          <InputLabel>Property</InputLabel>
                                          <Select
                                            value={style.property}
                                            onChange={(e) => updateConditionalStyle(index, 'property', e.target.value)}
                                            label="Property"
                                          >
                                            {fgbInfo && fgbInfo.properties?.map((prop: string) => (
                                              <MenuItem key={prop} value={prop}>
                                                {prop}
                                              </MenuItem>
                                            )) || []}
                                          </Select>
                                        </FormControl>

                                        <Box sx={{ display: 'flex', gap: 1 }}>
                                          <FormControl size="small" sx={{ width: '50%' }}>
                                            <InputLabel>Operator</InputLabel>
                                            <Select
                                              value={style.operator}
                                              onChange={(e) => updateConditionalStyle(index, 'operator', e.target.value)}
                                              label="Operator"
                                            >
                                              <MenuItem value="equals">=</MenuItem>
                                              <MenuItem value="not_equals">≠</MenuItem>
                                              <MenuItem value="greater_than">&gt;</MenuItem>
                                              <MenuItem value="less_than">&lt;</MenuItem>
                              <MenuItem value="between">Between</MenuItem>
                                              <MenuItem value="contains">⊃</MenuItem>
                                              <MenuItem value="starts_with">^</MenuItem>
                              <MenuItem value="color_gradient">Color Gradient (numeric)</MenuItem>
                                            </Select>
                                          </FormControl>

                          {style.operator === 'between' ? (
                            <>
                                          <TextField
                                label="Min"
                                type="number"
                                            value={style.value}
                                onChange={(e) => updateConditionalStyle(index, 'value', parseFloat(e.target.value) || 0)}
                                            size="small"
                                            sx={{ width: '50%' }}
                                          />
                                          <TextField
                                label="Max"
                                type="number"
                                value={style.value2}
                                onChange={(e) => updateConditionalStyle(index, 'value2', parseFloat(e.target.value) || 0)}
                                            size="small"
                                            sx={{ width: '50%' }}
                                          />
                            </>
                          ) : style.operator === 'color_gradient' ? (
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, width: '100%' }}>
                              <Box sx={{ display: 'flex', gap: 1 }}>
                                <TextField
                                  label="Min Value"
                                  type="number"
                                  value={style.minValue ?? ''}
                                  onChange={(e) => updateConditionalStyle(index, 'minValue', parseFloat(e.target.value) || 0)}
                                  size="small"
                                  sx={{ flex: 1 }}
                                />
                                <TextField
                                  label="Max Value"
                                  type="number"
                                  value={style.maxValue ?? ''}
                                  onChange={(e) => updateConditionalStyle(index, 'maxValue', parseFloat(e.target.value) || 0)}
                                  size="small"
                                  sx={{ flex: 1 }}
                                />
                              </Box>
                              <FormControl size="small" fullWidth>
                                <InputLabel>Color Palette</InputLabel>
                                <Select
                                  value={style.colorPalette || 'Viridis'}
                                  onChange={(e) => updateConditionalStyle(index, 'colorPalette', e.target.value)}
                                  label="Color Palette"
                                >
                                  {Object.keys(PALETTES).map((paletteName) => (
                                    <MenuItem key={paletteName} value={paletteName}>
                                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <Box
                                          sx={{
                                            display: 'flex',
                                            width: 120,
                                            height: 20,
                                            borderRadius: 0.5,
                                            overflow: 'hidden',
                                            border: '1px solid #ddd',
                                          }}
                                        >
                                          {PALETTES[paletteName as PaletteName].map((color, idx) => (
                                            <Box
                                              key={idx}
                                              sx={{
                                                flex: 1,
                                                backgroundColor: color,
                                              }}
                                            />
                                          ))}
                                        </Box>
                                        <Typography variant="body2">{paletteName}</Typography>
                                      </Box>
                                    </MenuItem>
                                  ))}
                                </Select>
                              </FormControl>
                            </Box>
                          ) : (
                            <TextField
                              label="Value"
                              value={style.value}
                              onChange={(e) => {
                                const val = style.operator === 'greater_than' || style.operator === 'less_than' 
                                  ? (parseFloat(e.target.value) || 0)
                                  : e.target.value;
                                updateConditionalStyle(index, 'value', val);
                              }}
                              type={style.operator === 'greater_than' || style.operator === 'less_than' ? 'number' : 'text'}
                              size="small"
                              sx={{ width: '50%' }}
                            />
                          )}
                        </Box>

                        {style.operator !== 'color_gradient' && (
                          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                            <Box sx={{ flex: 1 }}>
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                                Fill
                              </Typography>
                              <ColorPicker
                                value={style.style.fillColor || '#00ff00'}
                                onChangeComplete={(color: Color) => {
                                  if (typeof color === 'string') {
                                    updateConditionalStyle(index, 'style', {
                                      ...style.style,
                                      fillColor: color
                                    });
                                  } else if (color && typeof color === 'object' && 'toHexString' in color && 'toRgb' in color) {
                                    const hex = (color as any).toHexString();
                                    const rgb = (color as any).toRgb();
                                    const alpha = Math.round(rgb.a * 255).toString(16).padStart(2, '0');
                                    updateConditionalStyle(index, 'style', {
                                      ...style.style,
                                      fillColor: hex + alpha
                                    });
                                  }
                                }}
                                showText
                                format="hex"
                              />
                            </Box>
                            <Box sx={{ flex: 1 }}>
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                                Stroke
                              </Typography>
                              <ColorPicker
                                value={style.style.strokeColor || '#000000'}
                                onChangeComplete={(color: Color) => {
                                  if (typeof color === 'string') {
                                    updateConditionalStyle(index, 'style', {
                                      ...style.style,
                                      strokeColor: color
                                    });
                                  } else if (color && typeof color === 'object' && 'toHexString' in color) {
                                    updateConditionalStyle(index, 'style', {
                                      ...style.style,
                                      strokeColor: (color as any).toHexString()
                                    });
                                  }
                                }}
                                showText
                                format="hex"
                              />
                            </Box>
                          </Box>
                        )}
                      </Box>
                    </Paper>
                  ))}
                </>
                        )}
                      </Box>
                    </Collapse>
        )}
      </>
    );
  };

  return (
    <Paper
      sx={{
        position: 'absolute',
        top: 80,
        right: 10,
        minWidth: 280,
        maxWidth: 400,
        width: 'auto',
        maxHeight: '70vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 1000,
        boxShadow: 3,
      }}
    >
      {/* Header */}
      <Box
        sx={{
          p: 1.5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'primary.main',
          color: 'white',
          cursor: 'pointer',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <LayersIcon />
          <Typography variant="h6" component="div">
            Layers
          </Typography>
        </Box>
        <IconButton size="small" sx={{ color: 'white' }}>
          {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        </IconButton>
      </Box>

      {/* Layer List */}
      <Collapse in={expanded}>
        <Box sx={{ maxHeight: 'calc(70vh - 60px)', overflow: 'auto' }}>
          {layers.length === 0 ? (
          <List sx={{ p: 0 }}>
              <ListItem>
                <ListItemText
                  primary="No layers"
                  secondary="Load a GeoTIFF or FlatGeobuf to see layers"
                  primaryTypographyProps={{ color: 'text.secondary' }}
                />
                  </ListItem>
            </List>
          ) : (
            <Box sx={{ p: 0 }}>
              {/* Other layers (COG, FGB) */}
              {groupedLayers.other.length > 0 && (
                <Box>
                  {groupedLayers.other.map((layer, index) => {
                    const globalIndex = layers.findIndex((l) => l.id === layer.id);
                    return (
                      <React.Fragment key={layer.id}>
                        {index > 0 && <Divider />}
                        {renderLayerItem(layer, globalIndex)}
                      </React.Fragment>
                    );
                  })}
                </Box>
              )}

              {/* Sentinel-2 Group */}
              {groupedLayers.sentinel2.length > 0 && (
                <>
                  {groupedLayers.other.length > 0 && <Divider sx={{ my: 1 }} />}
                  <Accordion
                    expanded={expandedGroups['sentinel2'] !== false}
                    onChange={() => handleGroupToggle('sentinel2')}
                    sx={{ boxShadow: 'none', '&:before': { display: 'none' } }}
                  >
                    <AccordionSummary
                      expandIcon={<ExpandMoreIcon />}
                      sx={{
                        minHeight: 48,
                        '&.Mui-expanded': { minHeight: 48 },
                        bgcolor: 'grey.100',
                        px: 1.5,
                      }}
                    >
                      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                        Sentinel-2 Images ({groupedLayers.sentinel2.length})
                      </Typography>
                    </AccordionSummary>
                    <AccordionDetails sx={{ p: 0 }}>
                      {groupedLayers.sentinel2.map((layer, index) => {
                        const globalIndex = layers.findIndex((l) => l.id === layer.id);
                        return (
                          <React.Fragment key={layer.id}>
                            {index > 0 && <Divider />}
                            {renderLayerItem(layer, globalIndex)}
                          </React.Fragment>
                        );
                      })}
                    </AccordionDetails>
                  </Accordion>
                </>
              )}

              {/* Earth Engine */}
              {groupedLayers.earthengine.length > 0 && (
                <>
                  {(groupedLayers.other.length > 0 || groupedLayers.sentinel2.length > 0) && (
                    <Divider sx={{ my: 1 }} />
                  )}
                  <Accordion
                    expanded={expandedGroups['earthengine'] !== false}
                    onChange={() => handleGroupToggle('earthengine')}
                    sx={{ boxShadow: 'none', '&:before': { display: 'none' } }}
                  >
                    <AccordionSummary
                      expandIcon={<ExpandMoreIcon />}
                      sx={{
                        minHeight: 48,
                        '&.Mui-expanded': { minHeight: 48 },
                        bgcolor: 'grey.100',
                        px: 1.5,
                      }}
                    >
                      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                        Earth Engine ({groupedLayers.earthengine.length})
                      </Typography>
                    </AccordionSummary>
                    <AccordionDetails sx={{ p: 0 }}>
                      {groupedLayers.earthengine.map((layer, index) => {
                        const globalIndex = layers.findIndex((l) => l.id === layer.id);
                        return (
                          <React.Fragment key={layer.id}>
                            {index > 0 && <Divider />}
                            {renderLayerItem(layer, globalIndex)}
                          </React.Fragment>
                        );
                      })}
                    </AccordionDetails>
                  </Accordion>
                </>
              )}

              {/* Prediction Groups by RH Index */}
              {Object.keys(groupedLayers.predictions).length > 0 && (
                <>
                  {(groupedLayers.other.length > 0 ||
                    groupedLayers.sentinel2.length > 0 ||
                    groupedLayers.earthengine.length > 0) && (
                    <Divider sx={{ my: 1 }} />
                  )}
                  {Object.entries(groupedLayers.predictions)
                    .sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10))
                    .map(([rhIndex, predictionLayers]) => {
                      const groupKey = `prediction-rh${rhIndex}`;
                      return (
                        <Accordion
                          key={groupKey}
                          expanded={expandedGroups[groupKey] !== false}
                          onChange={() => handleGroupToggle(groupKey)}
                          sx={{ boxShadow: 'none', '&:before': { display: 'none' }, mb: 0.5 }}
                        >
                          <AccordionSummary
                            expandIcon={<ExpandMoreIcon />}
                            sx={{
                              minHeight: 48,
                              '&.Mui-expanded': { minHeight: 48 },
                              bgcolor: 'grey.100',
                              px: 1.5,
                            }}
                          >
                            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                              Predictions RH{rhIndex} ({predictionLayers.length})
                            </Typography>
                          </AccordionSummary>
                          <AccordionDetails sx={{ p: 0 }}>
                            {predictionLayers.map((layer, index) => {
                              const globalIndex = layers.findIndex((l) => l.id === layer.id);
                              return (
                <React.Fragment key={layer.id}>
                  {index > 0 && <Divider />}
                                  {renderLayerItem(layer, globalIndex)}
                </React.Fragment>
                              );
                            })}
                          </AccordionDetails>
                        </Accordion>
                      );
                    })}
                </>
              )}

              {/* Vector Layers Group */}
              {groupedLayers.vector.length > 0 && (
                <>
                  {(groupedLayers.other.length > 0 ||
                    groupedLayers.sentinel2.length > 0 ||
                    groupedLayers.earthengine.length > 0 ||
                    Object.keys(groupedLayers.predictions).length > 0) && (
                    <Divider sx={{ my: 1 }} />
                  )}
                  <Accordion
                    expanded={expandedGroups['vector'] !== false}
                    onChange={() => handleGroupToggle('vector')}
                    sx={{ boxShadow: 'none', '&:before': { display: 'none' }, mb: 0.5 }}
                  >
                    <AccordionSummary
                      expandIcon={<ExpandMoreIcon />}
                      sx={{
                        minHeight: 48,
                        '&.Mui-expanded': { minHeight: 48 },
                        bgcolor: 'grey.100',
                        px: 1.5,
                      }}
                    >
                      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                        Vector Layers ({groupedLayers.vector.length})
                      </Typography>
                    </AccordionSummary>
                    <AccordionDetails sx={{ p: 0 }}>
                      {groupedLayers.vector.map((layer, index) => {
                        const globalIndex = layers.findIndex((l) => l.id === layer.id);
                        const features = vectorFeatures?.[layer.id] || [];
                        const featureCount = layer.metadata?.featureCount ?? features.length;
                        const canBrowseFeatures = !layer.metadata?.skipFeatureList && features.length > 0;
                        return (
                          <React.Fragment key={layer.id}>
                            {index > 0 && <Divider />}
                            {renderLayerItem(layer, globalIndex)}
                            <Box
                              sx={{
                                px: 2,
                                pb: 1,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 1,
                                cursor: canBrowseFeatures ? 'pointer' : 'default',
                                ...(canBrowseFeatures ? { '&:hover': { bgcolor: 'action.hover' } } : {}),
                              }}
                              onClick={() => {
                                if (!canBrowseFeatures) return;
                                setFeatureListLayerId(
                                  featureListLayerId === layer.id ? null : layer.id
                                );
                              }}
                            >
                              <FilterListIcon fontSize="small" color="action" />
                              <Typography variant="body2" color={canBrowseFeatures ? 'primary' : 'text.secondary'} sx={{ fontWeight: 500 }}>
                                {featureCount} features
                              </Typography>
                              {canBrowseFeatures && featureListLayerId === layer.id ? (
                                <ExpandLessIcon fontSize="small" />
                              ) : canBrowseFeatures ? (
                                <ExpandMoreIcon fontSize="small" />
                              ) : null}
                              {layer.metadata?.sampledCount && layer.metadata?.totalCount && (
                                <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                                  sampled {layer.metadata.sampledCount}/{layer.metadata.totalCount}
                                </Typography>
                              )}
                            </Box>
                            {/* Feature list slide-in panel */}
                            <Collapse in={canBrowseFeatures && featureListLayerId === layer.id}>
                              <Box sx={{ maxHeight: 300, overflowY: 'auto', bgcolor: 'grey.50' }}>
                                <List dense disablePadding>
                                  {features.map((feat) => (
                                    <ListItem
                                      key={feat.index}
                                      sx={{
                                        py: 0.5,
                                        px: 2,
                                        '&:hover': { bgcolor: 'action.hover' },
                                        cursor: 'pointer',
                                      }}
                                      onMouseEnter={() => onHighlightFeature?.(layer.id, feat.index)}
                                      onMouseLeave={() => onHighlightFeature?.(layer.id, null)}
                                    >
                                      <ListItemText
                                        primary={feat.name}
                                        primaryTypographyProps={{
                                          variant: 'body2',
                                          fontFamily: 'monospace',
                                          fontWeight: 500,
                                        }}
                                      />
                                    </ListItem>
                                  ))}
                                </List>
                              </Box>
                            </Collapse>
                          </React.Fragment>
                        );
                      })}
                    </AccordionDetails>
                  </Accordion>
                </>
              )}
            </Box>
          )}
        </Box>
      </Collapse>
    </Paper>
  );
}
