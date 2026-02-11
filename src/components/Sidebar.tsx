import React from 'react';
import {
  Box,
  Typography,
  Button,
  styled,
  TextField,
  Alert,
  CircularProgress,
  List,
  ListItem,
  ListItemText,
} from '@mui/material';
import { Layers as LayersIcon, Link as LinkIcon, CropFree as CropFreeIcon } from '@mui/icons-material';

interface SidebarProps {
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  // FlatGeobuf props
  fgbUrl: string;
  onFGBUrlChange: (url: string) => void;
  onLoadFGB: () => void;
  onRemoveFGBLayer: () => void;
  fgbLoading: boolean;
  fgbError: string | null;
  // VSM auto-load props
  activeVSM: '2020' | '2024' | null;
  onToggleVSM: (year: '2020' | '2024') => void;
  // Drawing tools props
  drawingActive: boolean;
  onGetTiles: () => void;
  selectedTiles: string[];
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
  fgbUrl,
  onFGBUrlChange,
  onLoadFGB,
  fgbLoading,
  fgbError,
  activeVSM,
  onToggleVSM,
  drawingActive,
  onGetTiles,
  selectedTiles,
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
        </Box>

        {/* VSM Predictions Section */}
        <Box sx={{ mt: 3 }}>
          <Typography variant="h6" component="h2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <LayersIcon /> VSM Predictions
          </Typography>
          <Box sx={{ mt: 2, display: 'flex', gap: 1 }}>
            <Button
              variant={activeVSM === '2020' ? 'contained' : 'outlined'}
              color={activeVSM === '2020' ? 'success' : 'primary'}
              onClick={() => onToggleVSM('2020')}
              sx={{ flex: 1 }}
            >
              {activeVSM === '2020' ? 'VSM 2020 ✓' : 'Load VSM 2020'}
            </Button>
            <Button
              variant={activeVSM === '2024' ? 'contained' : 'outlined'}
              color={activeVSM === '2024' ? 'success' : 'primary'}
              onClick={() => onToggleVSM('2024')}
              sx={{ flex: 1 }}
            >
              {activeVSM === '2024' ? 'VSM 2024 ✓' : 'Load VSM 2024'}
            </Button>
          </Box>
          {activeVSM && (
            <Typography variant="caption" sx={{ mt: 1, display: 'block', color: 'text.secondary' }}>
              Auto-loading RH98 Q1 ({activeVSM}) for visible tiles{activeVSM === '2020' ? ' (local)' : ' (remote)'}
            </Typography>
          )}
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