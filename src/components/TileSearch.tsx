import { useState } from 'react';
import {
  Box,
  TextField,
  IconButton,
  Paper,
  CircularProgress,
  Typography,
} from '@mui/material';
import { Search as SearchIcon, Close as CloseIcon } from '@mui/icons-material';
import type { Map } from 'ol';
import { fromLonLat } from 'ol/proj';
import { apiUrl } from '../utils/apiBase';

interface TileSearchProps {
  map: Map | null;
}

// Parse lat/lon from input string
const parseCoordinates = (input: string): { lat: number; lon: number } | null => {
  // Try to match patterns like:
  // "40.7128, -74.0060" (comma separated)
  // "40.7128 -74.0060" (space separated)
  // "40.7128,-74.0060" (comma without space)
  const patterns = [
    /^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/,  // comma separated
    /^(-?\d+\.?\d*)\s+(-?\d+\.?\d*)$/,       // space separated
  ];
  
  for (const pattern of patterns) {
    const match = input.trim().match(pattern);
    if (match) {
      const lat = parseFloat(match[1]);
      const lon = parseFloat(match[2]);
      
      // Validate ranges
      if (isNaN(lat) || isNaN(lon)) return null;
      if (lat < -90 || lat > 90) return null;
      if (lon < -180 || lon > 180) return null;
      
      return { lat, lon };
    }
  }
  
  return null;
};

// Get coordinates from tile name
const getTileCoordinates = async (
  tileName: string
): Promise<{ lon: number; lat: number } | { error: string }> => {
  try {
    // Call backend to get tile coordinates
    const response = await fetch(apiUrl(`/sentinel2/tile-coordinates/${tileName.toUpperCase()}`));
    if (!response.ok) {
      return { error: `Request failed (HTTP ${response.status})` };
    }
    const data = await response.json();
    // Backend returns { error: "..." } with HTTP 200 on lookup failures / STAC timeouts,
    // so we must check the body, not just response.ok.
    if (data && typeof data.error === 'string') {
      return { error: data.error };
    }
    const lon = Number(data?.longitude);
    const lat = Number(data?.latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return { error: 'Backend returned invalid coordinates' };
    }
    return { lon, lat };
  } catch (error: any) {
    console.error('Error fetching tile coordinates:', error);
    return { error: error?.message || 'Network error' };
  }
};

// Validate and get coordinates from lat/lon input
const getGeolocationCoordinates = async (lat: number, lon: number): Promise<{ lon: number; lat: number } | null> => {
  try {
    // Call backend to validate coordinates
    const response = await fetch(
      apiUrl(`/geolocation/search?latitude=${lat}&longitude=${lon}`)
    );
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Invalid coordinates');
    }
    
    const data = await response.json();
    if (data.success) {
      return { lon: data.longitude, lat: data.latitude };
    }
    
    return null;
  } catch (error) {
    console.error('Error validating coordinates:', error);
    return null;
  }
};

export function TileSearch({ map }: TileSearchProps) {
  const [searchValue, setSearchValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!map || !searchValue.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const input = searchValue.trim();
      let coords: { lon: number; lat: number } | null = null;

      // Check if input is coordinates (lat, lon)
      const parsedCoords = parseCoordinates(input);
      if (parsedCoords) {
        // Validate coordinates via backend
        coords = await getGeolocationCoordinates(parsedCoords.lat, parsedCoords.lon);
        if (!coords) {
          setError('Invalid coordinates. Latitude must be -90 to 90, Longitude must be -180 to 180');
          return;
        }
      } else {
        // Try as tile name
        const result = await getTileCoordinates(input);
        if ('error' in result) {
          setError(
            `${result.error}\n\nTry:\n• Tile name (e.g., 32TMS, 33UUP)\n• Coordinates (e.g., 40.7128, -74.0060)`
          );
          return;
        }
        coords = result;
      }

      if (coords) {
        // Navigate to location
        const center = fromLonLat([coords.lon, coords.lat]);
        map.getView().animate({
          center: center,
          zoom: parsedCoords ? 17 : 10,
          duration: 1000,
        });
        setError(null);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to find location');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handleClear = () => {
    setSearchValue('');
    setError(null);
  };

  return (
    <Box
      sx={{
        position: 'absolute',
        top: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        width: 400,
      }}
    >
      <Paper
        elevation={3}
        sx={{
          display: 'flex',
          alignItems: 'center',
          p: 0.5,
          backgroundColor: 'white',
        }}
      >
        <TextField
          fullWidth
          size="small"
          placeholder="Search tile (e.g., 32TMS) or coordinates (e.g., 40.7128, -74.0060)"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          onKeyPress={handleKeyPress}
          variant="outlined"
          disabled={loading}
          sx={{
            '& .MuiOutlinedInput-root': {
              '& fieldset': {
                border: 'none',
              },
            },
          }}
        />
        
        {searchValue && (
          <IconButton
            size="small"
            onClick={handleClear}
            disabled={loading}
            sx={{ mr: 0.5 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        )}
        
        <IconButton
          color="primary"
          onClick={handleSearch}
          disabled={loading || !searchValue.trim()}
        >
          {loading ? (
            <CircularProgress size={24} />
          ) : (
            <SearchIcon />
          )}
        </IconButton>
      </Paper>
      
      {error && (
        <Paper
          sx={{
            mt: 1,
            p: 1,
            backgroundColor: '#ffebee',
          }}
        >
          <Typography variant="caption" color="error" sx={{ whiteSpace: 'pre-line' }}>
            {error}
          </Typography>
        </Paper>
      )}
    </Box>
  );
}

