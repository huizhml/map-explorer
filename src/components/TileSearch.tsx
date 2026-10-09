import { useEffect, useRef, useState } from 'react';
import {
  Box,
  TextField,
  IconButton,
  Paper,
  CircularProgress,
  Typography,
  Tooltip,
} from '@mui/material';
import { Search as SearchIcon, Close as CloseIcon, NearMe as NearMeIcon } from '@mui/icons-material';
import type { Map, Marker } from 'maplibre-gl';
import { apiUrl } from '../utils/apiBase';
import { searchPlace } from '../utils/reverseGeocode';
import { createPositionMarker, getPosition, showPosition } from '../utils/geolocate';

interface TileSearchProps {
  map: Map | null;
}

// MGRS 100 km square: zone 1-60, latitude band (I and O unused), then the square.
// Anything else that is not coordinates is looked up as a place name.
const TILE_RE = /^\d{1,2}[C-HJ-NP-X][A-Z]{2}$/i;

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
  const [locating, setLocating] = useState(false);
  const markerRef = useRef<Marker | null>(null);

  useEffect(() => {
    if (!map) return;
    markerRef.current = createPositionMarker();
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, [map]);

  // Go to the reader's own position, with a blue dot on it.
  const handleLocate = async () => {
    if (!map || locating) return;
    setLocating(true);
    setError(null);
    try {
      const { lon, lat } = await getPosition();
      // MapLibre zoom 14: as close as the 10 m predictions stay sharp.
      if (markerRef.current) showPosition(map, markerRef.current, lon, lat, 14);
    } catch (err: any) {
      setError(err?.message || 'Could not find your location.');
    } finally {
      setLocating(false);
    }
  };

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
      } else if (!TILE_RE.test(input)) {
        // A place name, via Nominatim — the same lookup the explore page uses.
        const place = await searchPlace(input);
        if (!place) {
          setError(
            `Nothing found for "${input}".\n\nTry:\n• Place name (e.g., Copenhagen)\n• Tile name (e.g., 32TMS, 33UUP)\n• Coordinates (e.g., 40.7128, -74.0060)`
          );
          return;
        }
        // Frame the place's box when it has one, so a country is framed whole
        // and a village is not zoomed past the data's resolution.
        if (place.bbox) {
          map.fitBounds(place.bbox, { padding: 60, maxZoom: 14, duration: 1000 });
        } else {
          map.easeTo({ center: [place.lon, place.lat], zoom: 10, duration: 1000 });
        }
        return;
      } else {
        // Try as tile name
        const result = await getTileCoordinates(input);
        if ('error' in result) {
          setError(
            `${result.error}\n\nTry:\n• Place name (e.g., Copenhagen)\n• Tile name (e.g., 32TMS, 33UUP)\n• Coordinates (e.g., 40.7128, -74.0060)`
          );
          return;
        }
        coords = result;
      }

      if (coords) {
        // Navigate to location
        // MapLibre zoom levels: OpenLayers' 17 and 10, less one.
        map.easeTo({
          center: [coords.lon, coords.lat],
          zoom: parsedCoords ? 16 : 9,
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
          placeholder="Search a place, tile (e.g., 32TMS) or coordinates (lat, lon)"
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
        
        <Tooltip title="Go to my location">
          <span>
            <IconButton
              onClick={handleLocate}
              disabled={!map || locating}
              aria-label="Go to my location"
            >
              {locating ? <CircularProgress size={22} /> : <NearMeIcon />}
            </IconButton>
          </span>
        </Tooltip>

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

