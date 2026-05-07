import { useState, useEffect } from 'react';
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
import type { Map } from 'ol';
import TileLayer from 'ol/layer/Tile';
import XYZ from 'ol/source/XYZ';
import OSM from 'ol/source/OSM';

export interface BaseMapOption {
  id: string;
  name: string;
  icon: React.ReactNode;
  source: XYZ | OSM;
}

interface BaseMapSelectorProps {
  map: Map | null;
  onBaseMapChange?: (baseMapId: string) => void;
}

// Define base map sources
const createBaseMapSources = (): Record<string, XYZ | OSM> => {
  return {
    osm: new OSM(),
    esriWorldImagery: new XYZ({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attributions: '© Esri',
      crossOrigin: 'anonymous',
      maxZoom: 19,
    }),
    googleSatellite: new XYZ({
      urls: [
        'https://mt0.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
        'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
        'https://mt2.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
        'https://mt3.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
      ],
      attributions: '© Google',
      crossOrigin: 'anonymous',
      maxZoom: 20,
    }),
    esriWorldTopo: new XYZ({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
      attributions: '© Esri',
      crossOrigin: 'anonymous',
      maxZoom: 19,
    }),
    esriTerrain: new XYZ({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}',
      attributions: '© Esri',
      crossOrigin: 'anonymous',
      maxZoom: 19,
    }),
    openTopoMap: new XYZ({
      url: 'https://{a-c}.tile.opentopomap.org/{z}/{x}/{y}.png',
      attributions: '© OpenTopoMap',
      crossOrigin: 'anonymous',
      maxZoom: 17,
    }),
    cartoPositron: new XYZ({
      url: 'https://{a-c}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      attributions: '© CARTO',
      crossOrigin: 'anonymous',
      maxZoom: 20,
    }),
    cartoDarkMatter: new XYZ({
      url: 'https://{a-c}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      attributions: '© CARTO',
      crossOrigin: 'anonymous',
      maxZoom: 20,
    }),
  };
};

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
  const [baseLayer, setBaseLayer] = useState<TileLayer<XYZ | OSM> | null>(null);
  const open = Boolean(anchorEl);

  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleBaseMapSelect = (baseMapId: string) => {
    if (!map) return;

    const sources = createBaseMapSources();
    const source = sources[baseMapId];
    
    if (!source) {
      console.error(`Base map source not found: ${baseMapId}`);
      return;
    }

    // Find and remove existing base layer (OSM or any layer at zIndex 0)
    const layers = map.getLayers();
    const layersArray = layers.getArray();
    
    // Find the base layer (first tile layer or layer with zIndex 0)
    let existingBaseLayer: TileLayer<XYZ | OSM> | null = null;
    for (let i = 0; i < layersArray.length; i++) {
      const layer = layersArray[i];
      if (layer instanceof TileLayer) {
        const layerSource = layer.getSource();
        if (layerSource instanceof OSM || layerSource instanceof XYZ) {
          // Check if it's likely a base layer (first layer or has zIndex 0)
          if (i === 0 || layer.getZIndex() === 0) {
            existingBaseLayer = layer;
            break;
          }
        }
      }
    }

    // Remove existing base layer if found
    if (existingBaseLayer) {
      map.removeLayer(existingBaseLayer);
    }

    // Create new base layer
    const newBaseLayer = new TileLayer({
      source: source,
      zIndex: 0, // Base layer should be at the bottom
    });

    // Add new base layer at index 0 (bottom)
    map.getLayers().insertAt(0, newBaseLayer);
    setBaseLayer(newBaseLayer);
    setSelectedBaseMap(baseMapId);
    
    if (onBaseMapChange) {
      onBaseMapChange(baseMapId);
    }

    handleClose();
  };

  // Initialize base layer on mount or when map changes
  useEffect(() => {
    if (map && !baseLayer) {
      // Find existing base layer (OSM or any tile layer at index 0)
      const layers = map.getLayers().getArray();
      const existingBaseLayer = layers.find(
        (layer) => {
          if (layer instanceof TileLayer) {
            const source = layer.getSource();
            return source instanceof OSM || source instanceof XYZ;
          }
          return false;
        }
      ) as TileLayer<XYZ | OSM> | undefined;

      if (existingBaseLayer) {
        setBaseLayer(existingBaseLayer);
        // Check if it's OSM
        if (existingBaseLayer.getSource() instanceof OSM) {
          setSelectedBaseMap('osm');
        } else {
          // Try to identify which base map it is by checking the source URL
          const source = existingBaseLayer.getSource() as XYZ;
          const url = source.getUrls()?.[0] || '';
          if (url.includes('arcgisonline.com') && url.includes('World_Imagery')) {
            setSelectedBaseMap('esriWorldImagery');
          } else if (url.includes('google.com') && url.includes('lyrs=s')) {
            setSelectedBaseMap('googleSatellite');
          } else if (url.includes('arcgisonline.com') && url.includes('World_Topo_Map')) {
            setSelectedBaseMap('esriWorldTopo');
          } else if (url.includes('arcgisonline.com') && url.includes('World_Terrain_Base')) {
            setSelectedBaseMap('esriTerrain');
          } else if (url.includes('opentopomap.org')) {
            setSelectedBaseMap('openTopoMap');
          } else if (url.includes('cartocdn.com') && url.includes('light_all')) {
            setSelectedBaseMap('cartoPositron');
          } else if (url.includes('cartocdn.com') && url.includes('dark_all')) {
            setSelectedBaseMap('cartoDarkMatter');
          }
        }
      }
    }
  }, [map, baseLayer]);

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

