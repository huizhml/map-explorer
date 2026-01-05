import React, { useState } from 'react';
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
} from '@mui/material';
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

interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  zIndex: number;
  type: 'cog' | 'fgb' | 'sentinel2' | 'prediction';
}

interface LayerControlProps {
  layers: Layer[];
  onToggleVisibility: (layerId: string) => void;
  onChangeOpacity: (layerId: string, opacity: number) => void;
  onChangeZIndex: (layerId: string, zIndex: number) => void;
  onReorderLayers: (fromIndex: number, toIndex: number) => void;
  onRemoveLayer?: (layerId: string) => void;
  onLocateLayer?: (layerId: string) => void;
}

export function LayerControl({
  layers,
  onToggleVisibility,
  onChangeOpacity,
  onReorderLayers,
  onRemoveLayer,
  onLocateLayer,
}: LayerControlProps) {
  // Zustand store
  const {
    fgbInfo,
    fgbStyleOptions,
    conditionalStyles,
    enableConditionalRendering,
    updateFgbStyleOption,
    setEnableConditionalRendering,
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
  console.log('--------------------------------fgbInfo', fgbInfo);

  return (
    <Paper
      sx={{
        position: 'absolute',
        top: 80,
        right: 10,
        width: 280,
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
          <List sx={{ p: 0 }}>
            {layers.length === 0 ? (
              <ListItem>
                <ListItemText
                  primary="No layers"
                  secondary="Load a GeoTIFF or FlatGeobuf to see layers"
                  primaryTypographyProps={{ color: 'text.secondary' }}
                />
              </ListItem>
            ) : (
              layers.map((layer, index) => (
                <React.Fragment key={layer.id}>
                  {index > 0 && <Divider />}
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

                        {/* Prediction Style Options */}
                        {layer.type === 'prediction' && (
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
                                  <TextField
                                    label="Fill"
                                    type="color"
                                    value={fgbStyleOptions.fillColor}
                                    onChange={(e) => updateFgbStyleOption('fillColor', e.target.value)}
                                    size="small"
                                    sx={{ width: '50%' }}
                                  />
                                  <TextField
                                    label="Stroke"
                                    type="color"
                                    value={fgbStyleOptions.strokeColor}
                                    onChange={(e) => updateFgbStyleOption('strokeColor', e.target.value)}
                                    size="small"
                                    sx={{ width: '50%' }}
                                  />
                                </Box>
                                <Box sx={{ display: 'flex', gap: 1 }}>
                                  <TextField
                                    label="Stroke Width"
                                    type="number"
                                    value={fgbStyleOptions.strokeWidth}
                                    onChange={(e) => updateFgbStyleOption('strokeWidth', parseInt(e.target.value))}
                                    size="small"
                                    inputProps={{ min: 1, max: 10 }}
                                    sx={{ width: '50%' }}
                                  />
                                  <TextField
                                    label="Point Radius"
                                    type="number"
                                    value={fgbStyleOptions.pointRadius}
                                    onChange={(e) => updateFgbStyleOption('pointRadius', parseInt(e.target.value))}
                                    size="small"
                                    inputProps={{ min: 1, max: 20 }}
                                    sx={{ width: '50%' }}
                                  />
                                </Box>
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
                                              <MenuItem value="contains">⊃</MenuItem>
                                              <MenuItem value="starts_with">^</MenuItem>
                                            </Select>
                                          </FormControl>

                                          <TextField
                                            label="Value"
                                            value={style.value}
                                            onChange={(e) => updateConditionalStyle(index, 'value', e.target.value)}
                                            size="small"
                                            sx={{ width: '50%' }}
                                          />
                                        </Box>

                                        <Box sx={{ display: 'flex', gap: 1 }}>
                                          <TextField
                                            label="Fill"
                                            type="color"
                                            value={style.style.fillColor || '#00ff00'}
                                            onChange={(e) => updateConditionalStyle(index, 'style', {
                                              ...style.style,
                                              fillColor: e.target.value
                                            })}
                                            size="small"
                                            sx={{ width: '50%' }}
                                          />
                                          <TextField
                                            label="Stroke"
                                            type="color"
                                            value={style.style.strokeColor || '#000000'}
                                            onChange={(e) => updateConditionalStyle(index, 'style', {
                                              ...style.style,
                                              strokeColor: e.target.value
                                            })}
                                            size="small"
                                            sx={{ width: '50%' }}
                                          />
                                        </Box>
                                      </Box>
                                    </Paper>
                                  ))}
                                </>
                              )}
                            </Box>
                          </Collapse>
                        )}
                      </Box>
                    </Collapse>
                  </ListItem>
                </React.Fragment>
              ))
            )}
          </List>
        </Box>
      </Collapse>
    </Paper>
  );
}

export type { Layer, LayerControlProps };

