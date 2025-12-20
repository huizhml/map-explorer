import React from 'react';
import {
  Box,
  Typography,
  Paper,
  Button,
  Slider,
  Switch,
  FormControlLabel,
  Divider,
  styled,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  TextField,
  Alert,
  CircularProgress,
  IconButton,
} from '@mui/material';
import { Delete as DeleteIcon, Layers as LayersIcon, Palette as PaletteIcon, Link as LinkIcon, VisibilityOff, Add as AddIcon } from '@mui/icons-material';
import type { WebGLTileLayer } from './Map';

interface FgbInfo {
  type: string;
  featureCount: number;
  geometryTypes: string[];
  properties: string[];
  sampleProperties: Record<string, any>;
}

interface StyleOptions {
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  pointRadius: number;
  opacity: number;
  zIndex: number;
}

interface ConditionalStyle {
  property: string;
  operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains' | 'starts_with';
  value: string | number;
  style: Partial<StyleOptions>;
}

interface SidebarProps {
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  currentFileName: string | null;
  onRemoveLayer: () => void;
  opacity: number;
  onOpacityChange: (value: number) => void;
  visible: boolean;
  onVisibilityChange: (visible: boolean) => void;
  palette: PaletteName;
  onPaletteChange: (palette: PaletteName) => void;
  // FlatGeobuf props
  fgbUrl: string;
  onFGBUrlChange: (url: string) => void;
  onLoadFGB: () => void;
  onRemoveFGBLayer: () => void;
  fgbLoading: boolean;
  fgbError: string | null;
  fgbInfo: FgbInfo | null;
  fgbStyleOptions: StyleOptions;
  onFGBStyleChange: (property: keyof StyleOptions, value: any) => void;
  conditionalStyles: ConditionalStyle[];
  enableConditionalRendering: boolean;
  onEnableConditionalRendering: (enabled: boolean) => void;
  onAddConditionalStyle: () => void;
  onUpdateConditionalStyle: (index: number, field: keyof ConditionalStyle, value: any) => void;
  onRemoveConditionalStyle: (index: number) => void;
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

const FileInput = styled('input')({
  display: 'none',
});

export function Sidebar({
  onFileChange,
  currentFileName,
  onRemoveLayer,
  opacity,
  onOpacityChange,
  visible,
  onVisibilityChange,
  palette,
  onPaletteChange,
  fgbUrl,
  onFGBUrlChange,
  onLoadFGB,
  onRemoveFGBLayer,
  fgbLoading,
  fgbError,
  fgbInfo,
  fgbStyleOptions,
  onFGBStyleChange,
  conditionalStyles,
  enableConditionalRendering,
  onEnableConditionalRendering,
  onAddConditionalStyle,
  onUpdateConditionalStyle,
  onRemoveConditionalStyle,
}: SidebarProps) {
  return (
    <SidebarContainer>
      <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="h6" component="h1">
          Map Explorer
        </Typography>
      </Box>

      <Box sx={{ p: 2, flex: 1, overflowY: 'auto' }}>
        <Typography variant="h6" component="h2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <LayersIcon /> Layers
        </Typography>
        
        <Box sx={{ mt: 2 }}>
          <label htmlFor="cog-file-input">
            <FileInput
              id="cog-file-input"
              type="file"
              accept=".tif,.tiff,.geotiff"
              onChange={onFileChange}
            />
            <Button
              variant="contained"
              component="span"
              fullWidth
            >
              Add COG Layer
            </Button>
          </label>
        </Box>

        {currentFileName && (
          <Paper sx={{ mt: 2, p: 2 }} elevation={1}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="subtitle1" noWrap sx={{ flex: 1 }}>
                {currentFileName}
              </Typography>
              <Button
                size="small"
                color="error"
                onClick={onRemoveLayer}
                startIcon={<DeleteIcon />}
              />
            </Box>

            <Divider sx={{ my: 1 }} />

            <Box sx={{ mt: 2 }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={visible}
                    onChange={(e) => onVisibilityChange(e.target.checked)}
                  />
                }
                label="Visible"
              />
              
              <Box sx={{ px: 1 }}>
                <Typography id="opacity-slider" gutterBottom>
                  Opacity: {Math.round(opacity * 100)}%
                </Typography>
                <Slider
                  aria-labelledby="opacity-slider"
                  value={opacity}
                  onChange={(_, value) => onOpacityChange(value as number)}
                  step={0.01}
                  min={0}
                  max={1}
                />
              </Box>

              <Box sx={{ mt: 2 }}>
                <FormControl fullWidth size="small">
                  <InputLabel id="palette-select-label">
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <PaletteIcon fontSize="small" /> Color Palette
                    </Box>
                  </InputLabel>
                  <Select
                    labelId="palette-select-label"
                    value={palette}
                    label="Color Palette"
                    onChange={(e) => onPaletteChange(e.target.value as PaletteName)}
                  >
                    {Object.entries(PALETTES).map(([name, colors]) => (
                      <MenuItem key={name} value={name}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Box sx={{ 
                            width: 100, 
                            height: 20, 
                            background: `linear-gradient(to right, ${colors.join(',')})`
                          }} />
                          <Typography>{name}</Typography>
                        </Box>
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Box>
            </Box>
          </Paper>
        )}

        {/* FlatGeobuf Section */}
        <Box sx={{ mt: 3 }}>
          <Typography variant="h6" component="h2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <LinkIcon /> FlatGeobuf Layer
          </Typography>
          
          <Box sx={{ mt: 2 }}>
            <TextField
              fullWidth
              size="small"
              label="FlatGeobuf URL"
              value={fgbUrl}
              onChange={(e) => onFGBUrlChange(e.target.value)}
              placeholder="https://example.com/data.fgb"
              sx={{ mb: 1 }}
            />
            
            <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
              <Button
                variant="contained"
                onClick={onLoadFGB}
                disabled={fgbLoading || !fgbUrl.trim()}
                startIcon={<LinkIcon />}
                sx={{ flex: 1 }}
              >
                Load FlatGeobuf
              </Button>
              {fgbUrl && (
                <Button
                  variant="outlined"
                  color="error"
                  onClick={onRemoveFGBLayer}
                  startIcon={<DeleteIcon />}
                >
                  Remove
                </Button>
              )}
            </Box>
          </Box>

          {/* Loading State */}
          {fgbLoading && (
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
              <CircularProgress size={20} sx={{ mr: 1 }} />
              <Typography variant="body2">Loading FlatGeobuf...</Typography>
            </Box>
          )}

          {/* Error Display */}
          {fgbError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {fgbError}
            </Alert>
          )}

          {/* Style Options */}
          {fgbUrl && (
            <Paper sx={{ mt: 2, p: 2 }} elevation={1}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Style Options</Typography>
              
              <Box sx={{ mb: 1 }}>
                <Typography variant="caption">Fill Color</Typography>
                <TextField
                  fullWidth
                  size="small"
                  type="color"
                  value={fgbStyleOptions.fillColor}
                  onChange={(e) => onFGBStyleChange('fillColor', e.target.value)}
                  sx={{ mt: 0.5 }}
                />
              </Box>

              <Box sx={{ mb: 1 }}>
                <Typography variant="caption">Stroke Color</Typography>
                <TextField
                  fullWidth
                  size="small"
                  type="color"
                  value={fgbStyleOptions.strokeColor}
                  onChange={(e) => onFGBStyleChange('strokeColor', e.target.value)}
                  sx={{ mt: 0.5 }}
                />
              </Box>

              <Box sx={{ mb: 1 }}>
                <Typography variant="caption">Stroke Width: {fgbStyleOptions.strokeWidth}</Typography>
                <Slider
                  value={fgbStyleOptions.strokeWidth}
                  onChange={(_, value) => onFGBStyleChange('strokeWidth', value)}
                  min={1}
                  max={10}
                  step={1}
                />
              </Box>

              <Box sx={{ mb: 1 }}>
                <Typography variant="caption">Opacity: {Math.round((fgbStyleOptions.opacity || 0.7) * 100)}%</Typography>
                <Slider
                  value={fgbStyleOptions.opacity || 0.7}
                  onChange={(_, value) => onFGBStyleChange('opacity', value)}
                  min={0}
                  max={1}
                  step={0.01}
                />
              </Box>

              <Box sx={{ mb: 1 }}>
                <Typography variant="caption">Z-Index: {fgbStyleOptions.zIndex}</Typography>
                <Slider
                  value={fgbStyleOptions.zIndex || 100}
                  onChange={(_, value) => onFGBStyleChange('zIndex', value)}
                  min={0}
                  max={1000}
                  step={10}
                />
              </Box>
            </Paper>
          )}

          {/* Conditional Rendering Section */}
          {fgbUrl && fgbInfo && (
            <Paper sx={{ mt: 2, p: 2 }} elevation={1}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                  Conditional Rendering
                </Typography>
                <FormControlLabel
                  control={
                    <Switch
                      checked={enableConditionalRendering}
                      onChange={(e) => onEnableConditionalRendering(e.target.checked)}
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
                    onClick={onAddConditionalStyle}
                    startIcon={<AddIcon />}
                    fullWidth
                    sx={{ mb: 1 }}
                  >
                    Add Condition
                  </Button>

                  {conditionalStyles.map((style, index) => (
                    <Paper key={index} sx={{ p: 1.5, mb: 1, border: '1px solid #ddd' }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                        <Typography variant="caption" sx={{ fontWeight: 500 }}>
                          Condition {index + 1}
                        </Typography>
                        <IconButton
                          size="small"
                          onClick={() => onRemoveConditionalStyle(index)}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Box>

                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <FormControl size="small" fullWidth>
                          <InputLabel>Property</InputLabel>
                          <Select
                            value={style.property}
                            onChange={(e) => onUpdateConditionalStyle(index, 'property', e.target.value)}
                            label="Property"
                          >
                            {fgbInfo.properties?.map((prop: string) => (
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
                              onChange={(e) => onUpdateConditionalStyle(index, 'operator', e.target.value)}
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
                            onChange={(e) => onUpdateConditionalStyle(index, 'value', e.target.value)}
                            size="small"
                            sx={{ width: '50%' }}
                          />
                        </Box>

                        <Box sx={{ display: 'flex', gap: 1 }}>
                          <TextField
                            label="Fill"
                            type="color"
                            value={style.style.fillColor || '#00ff00'}
                            onChange={(e) => {
                              // Normalize to 6-char hex
                              const color = e.target.value.length === 9 ? e.target.value.slice(0, 7) : e.target.value;
                              onUpdateConditionalStyle(index, 'style', {
                                ...style.style,
                                fillColor: color
                              });
                            }}
                            size="small"
                            sx={{ width: '50%' }}
                          />
                          <TextField
                            label="Stroke"
                            type="color"
                            value={style.style.strokeColor || '#000000'}
                            onChange={(e) => {
                              // Normalize to 6-char hex
                              const color = e.target.value.length === 9 ? e.target.value.slice(0, 7) : e.target.value;
                              onUpdateConditionalStyle(index, 'style', {
                                ...style.style,
                                strokeColor: color
                              });
                            }}
                            size="small"
                            sx={{ width: '50%' }}
                          />
                        </Box>

                        <Box sx={{ display: 'flex', gap: 1 }}>
                          <TextField
                            label="Stroke Width"
                            type="number"
                            value={style.style.strokeWidth || 2}
                            onChange={(e) => onUpdateConditionalStyle(index, 'style', {
                              ...style.style,
                              strokeWidth: parseInt(e.target.value) || 2
                            })}
                            size="small"
                            inputProps={{ min: 1, max: 10 }}
                            sx={{ width: '50%' }}
                          />
                          <TextField
                            label="Opacity"
                            type="number"
                            value={style.style.opacity !== undefined ? Math.round((style.style.opacity || 0.7) * 100) : 70}
                            onChange={(e) => onUpdateConditionalStyle(index, 'style', {
                              ...style.style,
                              opacity: (parseInt(e.target.value) || 70) / 100
                            })}
                            size="small"
                            inputProps={{ min: 0, max: 100 }}
                            sx={{ width: '50%' }}
                          />
                        </Box>
                      </Box>
                    </Paper>
                  ))}
                </>
              )}
            </Paper>
          )}
        </Box>
      </Box>
    </SidebarContainer>
  );
} 