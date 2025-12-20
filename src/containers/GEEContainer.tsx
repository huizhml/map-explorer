import React, { useState, useEffect } from 'react';
import type { Map } from '../components/Map';
import TileLayer from 'ol/layer/Tile';
import XYZ from 'ol/source/XYZ';
import { Box, Typography, Button, FormControl, Select, MenuItem, type SelectChangeEvent } from '@mui/material';
import { apiService, type BandCombination as ApiBandCombination } from '../services/api';

interface GEEContainerProps {
  map: Map | null;
}

// Available Sentinel-2 bands
const SENTINEL2_BANDS: Record<string, (string | null)[]> = {
  'Natural Color': ['B4', 'B3', 'B2'],
  'False Color Infrared': ['B8', 'B4', 'B3'],
  'Agriculture': ['B11', 'B8', 'B2'],
  'Vegetation Index': ['B8', 'B4', null],
};

type BandCombination = keyof typeof SENTINEL2_BANDS;

export function GEEContainer({ map }: GEEContainerProps) {
  const [geeLayer, setGeeLayer] = useState<TileLayer<XYZ> | null>(null);
  const [selectedBands, setSelectedBands] = useState<BandCombination>('Natural Color');
  const [isVisible, setIsVisible] = useState(true);
  const [availableBands, setAvailableBands] = useState<Array<{ id: string; name: string; resolution: string }>>([]);

  useEffect(() => {
    // Fetch available bands when component mounts
    apiService.getAvailableBands()
      .then(response => setAvailableBands(response.bands))
      .catch(error => console.error('Error fetching bands:', error));
  }, []);

  const updateLayer = async (bands: BandCombination) => {
    if (!map) return;

    try {
      const response = await apiService.getSentinel2Tiles({
        bands: SENTINEL2_BANDS[bands].filter((band): band is string => band !== null),
        min: 0,
        max: 3000,
      });

      // Remove existing layer
      if (geeLayer) {
        map.removeLayer(geeLayer);
      }

      // Create new layer with selected bands
      const layer = new TileLayer({
        source: new XYZ({
          url: response.tile_url,
          maxZoom: 14,
        }),
        visible: isVisible,
      });

      map.addLayer(layer);
      setGeeLayer(layer);
    } catch (error) {
      console.error('Error updating layer:', error);
    }
  };

  const handleBandChange = (event: SelectChangeEvent<BandCombination>) => {
    const newBands = event.target.value as BandCombination;
    setSelectedBands(newBands);
    updateLayer(newBands);
  };

  const toggleVisibility = () => {
    if (geeLayer) {
      const newVisibility = !isVisible;
      geeLayer.setVisible(newVisibility);
      setIsVisible(newVisibility);
    }
  };

  return (
    <Box sx={{ 
      position: 'absolute',
      top: 80,
      right: 20,
      backgroundColor: 'white',
      padding: 2,
      borderRadius: 1,
      boxShadow: 2,
      minWidth: 200,
      zIndex: 1000,
    }}>
      <Typography variant="h6" gutterBottom>
        Sentinel-2 Imagery
      </Typography>
      
      <FormControl fullWidth size="small" sx={{ mb: 2 }}>
        <Select
          value={selectedBands}
          onChange={handleBandChange}
          displayEmpty
        >
          {Object.keys(SENTINEL2_BANDS).map((band) => (
            <MenuItem key={band} value={band}>
              {band}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Button 
        variant="outlined" 
        onClick={toggleVisibility}
        fullWidth
      >
        {isVisible ? 'Hide Layer' : 'Show Layer'}
      </Button>
    </Box>
  );
} 