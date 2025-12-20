import React, { useEffect, useMemo, useState } from 'react';
import { Box, Typography, Slider, Button, FormControlLabel, Switch, Paper } from '@mui/material';
import TileLayer from 'ol/layer/Tile';
import XYZ from 'ol/source/XYZ';
import type { Map } from '../components/Map';
import { apiService } from '../services/api';

interface RHContainerProps {
  map: Map | null;
}

export function RHContainer({ map }: RHContainerProps) {
  const [selectedRh, setSelectedRh] = useState<number>(98);
  const [available, setAvailable] = useState<number[]>([]);
  const [layer, setLayer] = useState<TileLayer<XYZ> | null>(null);
  const [visible, setVisible] = useState<boolean>(true);

  useEffect(() => {
    apiService.getAvailableRh()
      .then((r) => setAvailable(r.available))
      .catch(() => setAvailable([]));
  }, []);

  const disabledMarks = useMemo(() => new Set(available), [available]);

  const updateLayer = async (rh: number) => {
    if (!map) return;
    const { tile_url } = await apiService.getRHTileUrl(rh);

    if (layer) {
      map.removeLayer(layer);
    }

    const newLayer = new TileLayer({
      source: new XYZ({ url: tile_url, maxZoom: 14 }),
      visible: visible,
      opacity: 0.8,
    });

    map.addLayer(newLayer);
    setLayer(newLayer);
  };

  useEffect(() => {
    // initialize default layer
    updateLayer(selectedRh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  const handleChange = (_: Event, value: number | number[]) => {
    const rh = Array.isArray(value) ? value[0] : value;
    setSelectedRh(rh);
  };

  const applyChange = () => updateLayer(selectedRh);

  const toggleVisible = () => {
    const next = !visible;
    setVisible(next);
    if (layer) layer.setVisible(next);
  };

  return (
    <Box sx={{ position: 'absolute', top: 80, left: 340, zIndex: 1000 }}>
      <Paper sx={{ p: 2, minWidth: 260 }} elevation={2}>
        <Typography variant="h6" gutterBottom>
          RH Mosaic
        </Typography>
        <Typography variant="body2" gutterBottom>
          RH: {selectedRh}
        </Typography>
        <Slider
          value={selectedRh}
          onChange={handleChange as any}
          min={0}
          max={100}
          step={1}
          marks={[{ value: 0, label: '0' }, { value: 50, label: '50' }, { value: 100, label: '100' }]}
        />
        <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
          <Button variant="contained" onClick={applyChange} fullWidth>
            Apply
          </Button>
          <FormControlLabel control={<Switch checked={visible} onChange={toggleVisible} />} label="Visible" />
        </Box>
        <Typography variant="caption" display="block" sx={{ mt: 1 }}>
          Only tiles in the current view will load.
        </Typography>
      </Paper>
    </Box>
  );
}


