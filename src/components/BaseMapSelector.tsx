import { useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Divider,
} from '@mui/material';
import {
  Map as MapIcon,
  Satellite as SatelliteIcon,
  Terrain as TerrainIcon,
  Layers as LayersIcon,
} from '@mui/icons-material';
import type { Map } from 'maplibre-gl';
import { BASEMAP_ID, BASE_MAP_SOURCES, basemapSource } from '../map/basemaps';

interface BaseMapSelectorProps {
  map: Map | null;
  onBaseMapChange?: (baseMapId: string) => void;
}

const BASE_MAP_OPTIONS: Array<{
  id: string;
  name: string;
  icon: React.ReactNode;
  category: 'standard' | 'satellite' | 'terrain' | 'minimal';
}> = [
  {
    id: 'osm',
    name: 'OpenStreetMap',
    icon: <MapIcon />,
    category: 'standard',
  },
  {
    id: 'esriWorldImagery',
    name: 'Esri World Imagery',
    icon: <SatelliteIcon />,
    category: 'satellite',
  },
  {
    id: 'googleSatellite',
    name: 'Google Satellite',
    icon: <SatelliteIcon />,
    category: 'satellite',
  },
  {
    id: 'esriWorldTopo',
    name: 'Esri World Topo',
    icon: <TerrainIcon />,
    category: 'terrain',
  },
  {
    id: 'esriTerrain',
    name: 'Esri Terrain',
    icon: <TerrainIcon />,
    category: 'terrain',
  },
  {
    id: 'openTopoMap',
    name: 'OpenTopoMap',
    icon: <TerrainIcon />,
    category: 'terrain',
  },
  {
    id: 'cartoPositron',
    name: 'CartoDB Positron',
    icon: <LayersIcon />,
    category: 'minimal',
  },
  {
    id: 'cartoDarkMatter',
    name: 'CartoDB Dark Matter',
    icon: <LayersIcon />,
    category: 'minimal',
  },
];

export function BaseMapSelector({ map, onBaseMapChange }: BaseMapSelectorProps) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [selectedBaseMap, setSelectedBaseMap] = useState<string>('osm');
  const open = Boolean(anchorEl);

  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleBaseMapSelect = (baseMapId: string) => {
    if (!map) return;

    if (!BASE_MAP_SOURCES[baseMapId]) {
      console.error(`Base map source not found: ${baseMapId}`);
      return;
    }

    // A source's zoom range cannot be changed in place, so the base layer is
    // replaced — at the bottom, under whatever is above it.
    const above = map.getStyle().layers.find((l, i, all) => all[i - 1]?.id === BASEMAP_ID)?.id;
    if (map.getLayer(BASEMAP_ID)) map.removeLayer(BASEMAP_ID);
    if (map.getSource(BASEMAP_ID)) map.removeSource(BASEMAP_ID);
    map.addSource(BASEMAP_ID, basemapSource(baseMapId));
    map.addLayer({ id: BASEMAP_ID, type: 'raster', source: BASEMAP_ID }, above);
    setSelectedBaseMap(baseMapId);

    if (onBaseMapChange) {
      onBaseMapChange(baseMapId);
    }

    handleClose();
  };

  const selectedOption = BASE_MAP_OPTIONS.find(opt => opt.id === selectedBaseMap);

  // Group options by category
  const groupedOptions = BASE_MAP_OPTIONS.reduce((acc, option) => {
    if (!acc[option.category]) {
      acc[option.category] = [];
    }
    acc[option.category].push(option);
    return acc;
  }, {} as Record<string, typeof BASE_MAP_OPTIONS>);

  return (
    <Box
      sx={{
        position: 'absolute',
        bottom: 20,
        right: 20,
        zIndex: 1000,
      }}
    >
      <Paper
        elevation={3}
        sx={{
          display: 'flex',
          alignItems: 'center',
          borderRadius: 1,
          overflow: 'hidden',
        }}
      >
        <IconButton
          onClick={handleClick}
          sx={{
            color: 'primary.main',
            '&:hover': {
              bgcolor: 'action.hover',
            },
          }}
          title="Select base map"
        >
          {selectedOption?.icon || <LayersIcon />}
        </IconButton>
        <Box
          onClick={handleClick}
          sx={{
            px: 1.5,
            py: 0.5,
            cursor: 'pointer',
            borderLeft: '1px solid',
            borderColor: 'divider',
            '&:hover': {
              bgcolor: 'action.hover',
            },
          }}
        >
          <Typography variant="caption" sx={{ fontWeight: 500, fontSize: '0.75rem' }}>
            {selectedOption?.name || 'Base Map'}
          </Typography>
        </Box>
      </Paper>

      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'bottom',
          horizontal: 'right',
        }}
        PaperProps={{
          sx: {
            maxHeight: 400,
            width: 250,
          },
        }}
      >
        <MenuItem disabled>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            Select Base Map
          </Typography>
        </MenuItem>
        <Divider />
        
        {/* Standard Maps */}
        {groupedOptions.standard && groupedOptions.standard.length > 0 && [
          <MenuItem key="standard-header" disabled>
            <Typography variant="caption" color="text.secondary">
              Standard
            </Typography>
          </MenuItem>,
          ...groupedOptions.standard.map((option) => (
            <MenuItem
              key={option.id}
              selected={selectedBaseMap === option.id}
              onClick={() => handleBaseMapSelect(option.id)}
            >
              <ListItemIcon>{option.icon}</ListItemIcon>
              <ListItemText primary={option.name} />
            </MenuItem>
          )),
          <Divider key="standard-divider" />,
        ]}

        {/* Satellite Maps */}
        {groupedOptions.satellite && groupedOptions.satellite.length > 0 && [
          <MenuItem key="satellite-header" disabled>
            <Typography variant="caption" color="text.secondary">
              Satellite
            </Typography>
          </MenuItem>,
          ...groupedOptions.satellite.map((option) => (
            <MenuItem
              key={option.id}
              selected={selectedBaseMap === option.id}
              onClick={() => handleBaseMapSelect(option.id)}
            >
              <ListItemIcon>{option.icon}</ListItemIcon>
              <ListItemText primary={option.name} />
            </MenuItem>
          )),
          <Divider key="satellite-divider" />,
        ]}

        {/* Terrain Maps */}
        {groupedOptions.terrain && groupedOptions.terrain.length > 0 && [
          <MenuItem key="terrain-header" disabled>
            <Typography variant="caption" color="text.secondary">
              Terrain
            </Typography>
          </MenuItem>,
          ...groupedOptions.terrain.map((option) => (
            <MenuItem
              key={option.id}
              selected={selectedBaseMap === option.id}
              onClick={() => handleBaseMapSelect(option.id)}
            >
              <ListItemIcon>{option.icon}</ListItemIcon>
              <ListItemText primary={option.name} />
            </MenuItem>
          )),
          <Divider key="terrain-divider" />,
        ]}

        {/* Minimal Maps */}
        {groupedOptions.minimal && groupedOptions.minimal.length > 0 && [
          <MenuItem key="minimal-header" disabled>
            <Typography variant="caption" color="text.secondary">
              Minimal
            </Typography>
          </MenuItem>,
          ...groupedOptions.minimal.map((option) => (
            <MenuItem
              key={option.id}
              selected={selectedBaseMap === option.id}
              onClick={() => handleBaseMapSelect(option.id)}
            >
              <ListItemIcon>{option.icon}</ListItemIcon>
              <ListItemText primary={option.name} />
            </MenuItem>
          )),
        ]}
      </Menu>
    </Box>
  );
}

