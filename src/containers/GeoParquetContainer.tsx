import React, { useState } from 'react';
import { Map } from 'ol';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import { Style, Fill, Stroke, Circle as CircleStyle } from 'ol/style';
import { Button, Box, Typography, Alert, CircularProgress } from '@mui/material';
import { Upload as UploadIcon } from '@mui/icons-material';

interface GeoParquetContainerProps {
  map: Map | null;
}

interface GeoParquetInfo {
  crs: string | null;
  bounds: number[];
  count: number;
  columns: string[];
  geometry_types: string[];
  memory_usage: number;
}

export function GeoParquetContainer({ map }: GeoParquetContainerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileInfo, setFileInfo] = useState<GeoParquetInfo | null>(null);
  const [vectorLayer, setVectorLayer] = useState<VectorLayer<VectorSource> | null>(null);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !map) return;

    setLoading(true);
    setError(null);

    try {
      // Create a temporary file path (in a real app, you'd upload to server)
      const filePath = `/tmp/${file.name}`;
      
      // Get file info
      const infoResponse = await fetch('http://localhost:8000/geoparquet/info', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file_path: filePath }),
      });

      if (!infoResponse.ok) {
        throw new Error('Failed to get file info');
      }

      const info = await infoResponse.json();
      setFileInfo(info);

      // Get GeoJSON data (limited for performance)
      const geojsonResponse = await fetch('http://localhost:8000/geoparquet/geojson', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          file_path: filePath, 
          limit: 1000 // Limit features for performance
        }),
      });

      if (!geojsonResponse.ok) {
        throw new Error('Failed to convert to GeoJSON');
      }

      const geojsonData = await geojsonResponse.json();

      // Remove existing vector layer
      if (vectorLayer) {
        map.removeLayer(vectorLayer);
      }

      // Create vector source and layer
      const vectorSource = new VectorSource({
        features: new GeoJSON().readFeatures(geojsonData, {
          featureProjection: 'EPSG:3857',
        }),
      });

      const newVectorLayer = new VectorLayer({
        source: vectorSource,
        style: new Style({
          fill: new Fill({
            color: 'rgba(255, 0, 0, 0.3)',
          }),
          stroke: new Stroke({
            color: '#ff0000',
            width: 2,
          }),
          image: new CircleStyle({
            radius: 5,
            fill: new Fill({
              color: '#ff0000',
            }),
          }),
        }),
      });

      map.addLayer(newVectorLayer);
      setVectorLayer(newVectorLayer);

      // Fit map to features
      const extent = vectorSource.getExtent();
      map.getView().fit(extent, { padding: [50, 50, 50, 50] });

    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveLayer = () => {
    if (vectorLayer && map) {
      map.removeLayer(vectorLayer);
      setVectorLayer(null);
      setFileInfo(null);
    }
  };

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        GeoParquet Visualization
      </Typography>
      
      <Box sx={{ mb: 2 }}>
        <input
          accept=".parquet"
          style={{ display: 'none' }}
          id="geoparquet-file-input"
          type="file"
          onChange={handleFileUpload}
        />
        <label htmlFor="geoparquet-file-input">
          <Button
            variant="contained"
            component="span"
            startIcon={<UploadIcon />}
            disabled={loading}
            sx={{ mr: 1 }}
          >
            Load GeoParquet
          </Button>
        </label>
        
        {vectorLayer && (
          <Button
            variant="outlined"
            onClick={handleRemoveLayer}
            disabled={loading}
          >
            Remove Layer
          </Button>
        )}
      </Box>

      {loading && (
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
          <CircularProgress size={20} sx={{ mr: 1 }} />
          <Typography variant="body2">Loading GeoParquet file...</Typography>
        </Box>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {fileInfo && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            File Information:
          </Typography>
          <Typography variant="body2">
            <strong>Features:</strong> {fileInfo.count.toLocaleString()}
          </Typography>
          <Typography variant="body2">
            <strong>CRS:</strong> {fileInfo.crs || 'Unknown'}
          </Typography>
          <Typography variant="body2">
            <strong>Geometry Types:</strong> {fileInfo.geometry_types.join(', ')}
          </Typography>
          <Typography variant="body2">
            <strong>Columns:</strong> {fileInfo.columns.length}
          </Typography>
          <Typography variant="body2">
            <strong>Memory Usage:</strong> {(fileInfo.memory_usage / 1024 / 1024).toFixed(2)} MB
          </Typography>
        </Box>
      )}
    </Box>
  );
}
