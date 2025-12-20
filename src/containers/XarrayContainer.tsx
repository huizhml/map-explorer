import React, { useEffect, useState } from 'react';
import { Box, Paper, Typography, TextField, Button, FormControlLabel, Switch } from '@mui/material';
import TileLayer from 'ol/layer/Tile';
import XYZ from 'ol/source/XYZ';
import type { Map } from '../components/Map';
import { apiService } from '../services/api';

interface XarrayContainerProps {
  map: Map | null;
}

export function XarrayContainer({ map }: XarrayContainerProps) {
  const [path, setPath] = useState<string>('');
  const [variable, setVariable] = useState<string>('');
  const [lon, setLon] = useState<string>('lon');
  const [lat, setLat] = useState<string>('lat');
  const [rescale, setRescale] = useState<string>('');
  const [colormap, setColormap] = useState<string>('');
  const [layer, setLayer] = useState<TileLayer<XYZ> | null>(null);
  const [visible, setVisible] = useState<boolean>(true);

  useEffect(() => {
    return () => {
      if (map && layer) map.removeLayer(layer);
    };
  }, [map, layer]);

  const apply = async () => {
    if (!map || !path || !variable) return;
    const { tile_url } = await apiService.getXarrayTileUrl({
      url: path,
      variable,
      lon: lon || undefined,
      lat: lat || undefined,
      rescale: rescale || undefined,
      colormap_name: colormap || undefined,
    });

    if (layer) map.removeLayer(layer);

    const newLayer = new TileLayer({
      source: new XYZ({ url: tile_url, maxZoom: 14 }),
      visible,
      opacity: 0.9,
    });
    map.addLayer(newLayer);
    setLayer(newLayer);
  };

  const toggle = () => {
    const next = !visible;
    setVisible(next);
    if (layer) layer.setVisible(next);
  };

  return (
    <Box sx={{ position: 'absolute', top: 80, left: 620, zIndex: 1000 }}>
      <Paper sx={{ p: 2, minWidth: 360 }} elevation={2}>
        <Typography variant="h6" gutterBottom>
          Xarray HDF5/NetCDF Layer
        </Typography>
        <TextField label="Path or URL" value={path} onChange={(e) => setPath(e.target.value)} fullWidth size="small" sx={{ mb: 1 }} />
        <TextField label="Variable" value={variable} onChange={(e) => setVariable(e.target.value)} fullWidth size="small" sx={{ mb: 1 }} />
        <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
          <TextField label="Lon name" value={lon} onChange={(e) => setLon(e.target.value)} size="small" fullWidth />
          <TextField label="Lat name" value={lat} onChange={(e) => setLat(e.target.value)} size="small" fullWidth />
        </Box>
        <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
          <TextField label="Rescale (min,max)" value={rescale} onChange={(e) => setRescale(e.target.value)} size="small" fullWidth />
          <TextField label="Colormap" value={colormap} onChange={(e) => setColormap(e.target.value)} size="small" fullWidth />
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Button variant="contained" onClick={apply}>Apply</Button>
          <FormControlLabel control={<Switch checked={visible} onChange={toggle} />} label="Visible" />
        </Box>
      </Paper>
    </Box>
  );
}


