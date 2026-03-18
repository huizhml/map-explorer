import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Button,
  styled,
  TextField,
  List,
  ListItem,
  ListItemText,
  Checkbox,
  FormControlLabel,
  IconButton,
} from '@mui/material';
import {
  Layers as LayersIcon,
  CropFree as CropFreeIcon,
  Close as CloseIcon,
  Search as SearchIcon,
  ShowChart as ShowChartIcon,
} from '@mui/icons-material';
import type { VsmQChoice } from '../constants/predictions';

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
  onGetTiles: () => void;
  selectedTiles: string[];
  /** Inspect mode: map clicks sample rasters; bottom-right panel shows values */
  inspectMode: boolean;
  inspectKind: 'layers' | 'vertical_profile';
  onInspectModeChange: (active: boolean) => void;
  onVerticalProfileClick: () => void;
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
  onGetTiles,
  selectedTiles,
  inspectMode,
  inspectKind,
  onInspectModeChange,
  onVerticalProfileClick,
}: SidebarProps) {
  const [showAddedInfo, setShowAddedInfo] = useState(true);

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
              ? 'Click the map — visible raster values in the panel bottom-right'
              : 'Sample visible COG layers at the clicked point'}
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

        {/* Drawing Tools Section */}
        <Box sx={{ mt: 3 }}>
          <Typography variant="h6" component="h2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CropFreeIcon /> Drawing Tools
          </Typography>
          <Box sx={{ mt: 2 }}>
            <Button
              variant={drawingActive ? 'contained' : 'outlined'}
              color={drawingActive ? 'warning' : 'primary'}
              onClick={onGetTiles}
              fullWidth
              startIcon={<CropFreeIcon />}
            >
              {drawingActive ? 'Drawing... (click to cancel)' : 'Get Tiles'}
            </Button>
            {drawingActive && (
              <Typography variant="caption" sx={{ mt: 1, display: 'block', color: 'text.secondary' }}>
                Draw a rectangle on the map to select tiles
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
        </Box>
      </Box>
    </SidebarContainer>
  );
} 