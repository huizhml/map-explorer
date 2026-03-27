import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Paper,
  Typography,
  IconButton,
  Box,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
  Button,
  TextField,
  CircularProgress,
  Collapse,
  Checkbox,
  FormControlLabel,
  Tooltip,
  Menu,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
} from '@mui/material';
import { Close as CloseIcon, Search as SearchIcon, MoreVert as MoreVertIcon } from '@mui/icons-material';
import { Geometry } from 'ol/geom';
import { transform } from 'ol/proj';
// @ts-ignore - Material React Table needs to be installed: npm install material-react-table @tanstack/react-table
import { MaterialReactTable, useMaterialReactTable, type MRT_ColumnDef } from 'material-react-table';

interface Sentinel2Image {
  id: string;
  datetime: string;
  cloud_cover: number;
  'nodata percentage'?: number;
  preview_url?: string;
  visual_url?: string;
  bbox?: number[];
  mgrs_tile?: string;
  assets?: any;
  [key: string]: any;
}

interface FeaturePopupProps {
  properties: Record<string, any> | null;
  onClose: () => void;
  position: { x: number; y: number } | null;
  geometry?: Geometry | null;
  coordinates?: { lon: number; lat: number } | null;
  onLoadSentinel2Image?: (image: Sentinel2Image, tileName?: string) => void;
  onLoadPredictionCOG?: (predictionData: {
    url: string;
    tile_name: string;
    rh_index: number;
    q_index: number;
    year: number;
  }) => void;
  onLoadAuxiliaryLayer?: (data: {
    url: string;
    tile_name: string;
    layer_type: string;
    metric?: 'entropy' | 'enl1d' | 'enl2d';
  }) => void;
  onLoadGEDIPoints?: (data: {
    buffer: Uint8Array;
    tile_name: string;
    sampled_count: number;
    total_count: number;
    sample_size: number;
  }) => void;
}

export function FeaturePopup({ properties, onClose, position, geometry, coordinates, onLoadSentinel2Image, onLoadPredictionCOG, onLoadAuxiliaryLayer, onLoadGEDIPoints }: FeaturePopupProps) {
  const [year, setYear] = useState<string>('2020');
  const [maxCloudCover, setMaxCloudCover] = useState<string>('50');
  const [loading, setLoading] = useState(false);
  const [predLoading, setPredLoading] = useState(false);
  const [sentinel2Images, setSentinel2Images] = useState<Sentinel2Image[]>([]);
  const [showImages, setShowImages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [predError, setPredError] = useState<string | null>(null);
  const [predResult, setPredResult] = useState<any | null>(null);
  const [useGrowingMonths, setUseGrowingMonths] = useState(false);
  const [predSource, setPredSource] = useState<'blended' | 'original'>('blended');
  const [rhIndex, setRhIndex] = useState<string>('98');
  const [qChoice, setQChoice] = useState<'5%' | 'median' | '95%'>('median');
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [selectedImageForMenu, setSelectedImageForMenu] = useState<Sentinel2Image | null>(null);
  const [offsetLoading, setOffsetLoading] = useState(false);
  const [offsetResult, setOffsetResult] = useState<any | null>(null);
  const [offsetError, setOffsetError] = useState<string | null>(null);
  const [distMapLoading, setDistMapLoading] = useState(false);
  const [distMapError, setDistMapError] = useState<string | null>(null);
  const [distMapResult, setDistMapResult] = useState<any | null>(null);
  const [crLoading, setCrLoading] = useState(false);
  const [crError, setCrError] = useState<string | null>(null);
  const [crResult, setCrResult] = useState<any | null>(null);
  const [entropyLoading, setEntropyLoading] = useState(false);
  const [entropyError, setEntropyError] = useState<string | null>(null);
  const [entropyResult, setEntropyResult] = useState<any | null>(null);
  const [entropyMetric, setEntropyMetric] = useState<'entropy' | 'enl1d' | 'enl2d'>('entropy');
  const [alsLoading, setAlsLoading] = useState(false);
  const [alsError, setAlsError] = useState<string | null>(null);
  const [alsResult, setAlsResult] = useState<any | null>(null);
  const [gediLoading, setGediLoading] = useState(false);
  const [gediError, setGediError] = useState<string | null>(null);
  const [gediResult, setGediResult] = useState<any | null>(null);

  // Draggable state
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });

  // Menu handlers
  const handleMenuOpen = useCallback((event: React.MouseEvent<HTMLElement>, image: Sentinel2Image) => {
    event.stopPropagation(); // Prevent row click
    setMenuAnchor(event.currentTarget);
    setSelectedImageForMenu(image);
  }, []);

  const handleMenuClose = useCallback(() => {
    setMenuAnchor(null);
    setSelectedImageForMenu(null);
  }, []);

  const handleCopyDate = useCallback(() => {
    if (selectedImageForMenu?.datetime) {
      navigator.clipboard.writeText(selectedImageForMenu.datetime)
        .then(() => {
          console.log('Date copied to clipboard:', selectedImageForMenu.datetime);
        })
        .catch(err => {
          console.error('Failed to copy date:', err);
        });
    }
    handleMenuClose();
  }, [selectedImageForMenu, handleMenuClose]);

  // Drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Only allow dragging from the header
    if ((e.target as HTMLElement).closest('.popup-header')) {
      setIsDragging(true);
      setDragOffset({
        x: e.clientX - dragPosition.x,
        y: e.clientY - dragPosition.y,
      });
    }
  }, [dragPosition]);

  // Reset drag position when position changes (new click)
  useEffect(() => {
    setDragPosition({ x: 0, y: 0 });
  }, [position]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        setDragPosition({
          x: e.clientX - dragOffset.x,
          y: e.clientY - dragOffset.y,
        });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  // Parse growing months - supports multiple formats:
  // "[ 9  6  7  8]" - array string format (can be unsorted)
  // "4-10" - range format
  // "4,5,6,7,8,9,10" - comma-separated format
  const parseGrowingMonths = (monthsStr: string): number[] => {
    if (!monthsStr) return [];
    
    const trimmed = monthsStr.trim();
    let months: number[] = [];
    
    // Handle array string format: "[ 9  6  7  8]"
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const content = trimmed.slice(1, -1).trim();
      // Split by whitespace and parse numbers
      months = content
        .split(/\s+/)
        .map(s => parseInt(s.trim()))
        .filter(n => !isNaN(n) && n >= 1 && n <= 12);
    }
    // Handle range format (e.g., "4-10")
    else if (trimmed.includes('-') && !trimmed.startsWith('[')) {
      const [start, end] = trimmed.split('-').map(s => parseInt(s.trim()));
      for (let i = start; i <= end; i++) {
        months.push(i);
      }
    }
    // Handle comma-separated format (e.g., "4,5,6,7,8,9,10")
    else {
      months = trimmed.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= 1 && n <= 12);
    }
    
    // Sort the months and remove duplicates
    return [...new Set(months)].sort((a, b) => a - b);
  };

  // Extract growing_months from feature properties
  const growingMonths = properties?.growing_months;
  const hasGrowingMonths = growingMonths && growingMonths.trim() !== '';
  
  // Format growing months for display
  const formatGrowingMonths = (monthsStr: string): string => {
    if (!monthsStr) return '';
    const months = parseGrowingMonths(monthsStr);
    if (months.length === 0) return monthsStr;
    
    // Check if it's a continuous range
    const isRange = months.length > 2 && 
      months.every((month, idx) => idx === 0 || month === months[idx - 1] + 1);
    
    if (isRange) {
      return `${months[0]}-${months[months.length - 1]}`;
    }
    
    return months.join(', ');
  };
  
  const displayGrowingMonths = hasGrowingMonths ? formatGrowingMonths(growingMonths) : '';

  // Filter images by growing months if enabled
  let filteredImages = useGrowingMonths && hasGrowingMonths
    ? sentinel2Images.filter(image => {
        const imageDate = new Date(image.datetime);
        const imageMonth = imageDate.getMonth() + 1; // getMonth() returns 0-11
        const allowedMonths = parseGrowingMonths(growingMonths);
        return allowedMonths.includes(imageMonth);
      })
    : sentinel2Images;

  // Filter images by cloud cover if specified
  if (maxCloudCover.trim() !== '') {
    const maxCloudValue = parseFloat(maxCloudCover);
    if (!isNaN(maxCloudValue)) {
      filteredImages = filteredImages.filter(image => {
        const cloudValue = typeof image.cloud_cover === 'string' 
          ? parseFloat(image.cloud_cover) || 0 
          : typeof image.cloud_cover === 'number' 
            ? image.cloud_cover 
            : 0;
        return cloudValue <= maxCloudValue;
      });
    }
  }

  // Define columns for Material React Table
  const columns = useMemo<MRT_ColumnDef<Sentinel2Image>[]>(() => [
    {
      id: 'actions',
      header: '',
      size: 40,
      Cell: ({ row }) => (
        <IconButton
          size="small"
          onClick={(e) => handleMenuOpen(e, row.original)}
          sx={{ padding: '4px' }}
        >
          <MoreVertIcon fontSize="small" />
        </IconButton>
      ),
      enableSorting: false,
    },
    {
      id: 'index',
      header: '#',
      size: 40,
      Cell: ({ row }) => row.index + 1,
      enableSorting: false,
    },
    {
      accessorKey: 'datetime',
      header: 'Date/Time',
      size: 100,
      Cell: ({ cell }) => new Date(cell.getValue<string>()).toLocaleString(),
    //   sortingFn: (rowA, rowB) => {
    //     const a = new Date(rowA.original.datetime).getTime();
    //     const b = new Date(rowB.original.datetime).getTime();
    //     return a < b ? -1 : a > b ? 1 : 0;
    //   },
    },
    {
      accessorKey: 'cloud_cover',
      header: 'Cloud %',
      size: 70,
      Cell: ({ cell }) => {
        const value = cell.getValue<number | string | undefined>();
        if (value === undefined || value === null) return '0%';
        const numValue = typeof value === 'number' ? value : parseFloat(String(value)) || 0;
        return numValue.toFixed(1) + '%';
      },
      accessorFn: (row) => {
        const value = row.cloud_cover;
        return typeof value === 'number' ? value : parseFloat(String(value)) || 0;
      },
    },
    {
      id: 'nodata_percentage',
      accessorFn: (row) => {
        const value = row['nodata percentage'];
        return typeof value === 'number' ? value : parseFloat(String(value)) || 0;
      },
      header: 'NoData %',
      size: 70,
    //   Cell: ({ cell }) => {
    //     const value = cell.getValue<number | undefined>();
    //     return value !== undefined ? value.toFixed(1) + '%' : 'N/A';
    //   },
    },
    {
      accessorKey: 'platform',
      header: 'Platform',
      size: 90,
      Cell: ({ cell }) => cell.getValue<string>() || 'N/A',
      sortingFn: (rowA, rowB) => {
        const a = String(rowA.original.platform || '').toLowerCase();
        const b = String(rowB.original.platform || '').toLowerCase();
        return a < b ? -1 : a > b ? 1 : 0;
      },
    },
    {
      accessorKey: 'constellation',
      header: 'Constellation',
      size: 80,
      Cell: ({ cell }) => cell.getValue<string>() || 'N/A',
      sortingFn: (rowA, rowB) => {
        const a = String(rowA.original.constellation || '').toLowerCase();
        const b = String(rowB.original.constellation || '').toLowerCase();
        return a < b ? -1 : a > b ? 1 : 0;
      },
    },
    {
      accessorKey: 'instruments',
      header: 'Instruments',
      size: 80,
      Cell: ({ cell }) => {
        const instruments = cell.getValue<string[]>();
        return Array.isArray(instruments) ? instruments.join(', ') : 'N/A';
      },
      enableSorting: false,
    },
    {
      accessorKey: 'gsd',
      header: 'GSD (m)',
      size: 60,
      Cell: ({ cell }) => cell.getValue<string>() || 'N/A',
      sortingFn: (rowA, rowB) => {
        const a = typeof rowA.original.gsd === 'string' ? parseFloat(rowA.original.gsd) || 0 : typeof rowA.original.gsd === 'number' ? rowA.original.gsd : 0;
        const b = typeof rowB.original.gsd === 'string' ? parseFloat(rowB.original.gsd) || 0 : typeof rowB.original.gsd === 'number' ? rowB.original.gsd : 0;
        return a < b ? -1 : a > b ? 1 : 0;
      },
    },
    {
      accessorKey: 'proj_epsg',
      header: 'EPSG',
      size: 70,
      Cell: ({ cell }) => cell.getValue<string>() || 'N/A',
      enableSorting: false,
    },
    {
      accessorKey: 'id',
      header: 'ID',
      size: 250,
      Cell: ({ cell }) => cell.getValue<string>() || 'N/A',
      sortingFn: (rowA, rowB) => {
        const a = String(rowA.original.id || '').toLowerCase();
        const b = String(rowB.original.id || '').toLowerCase();
        return a < b ? -1 : a > b ? 1 : 0;
      },
    },
  ], [handleMenuOpen]);

  const table = useMaterialReactTable({
    columns,
    data: filteredImages,
    enableColumnResizing: false,
    enableColumnOrdering: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    enableGlobalFilter: false,
    enableHiding: false,
    enablePagination: false,
    enableMultiSort: true,
    maxMultiSortColCount: 10, // Allow multiple columns to be sorted
    manualSorting: false, // Use client-side sorting
    enableStickyHeader: true,
    muiTableContainerProps: {
      sx: {
        maxHeight: 400,
      },
    },
    muiTablePaperProps: {
      elevation: 0,
    },
    muiTableBodyRowProps: ({ row }) => ({
      onClick: () => {
        if (onLoadSentinel2Image && row.original.id) {
          const tileName = properties?.Name || row.original.mgrs_tile;
          onLoadSentinel2Image(row.original, tileName);
        }
      },
      sx: {
        cursor: onLoadSentinel2Image ? 'pointer' : 'default',
        '&:hover': {
          backgroundColor: '#e3f2fd',
        },
      },
    }),
    initialState: {
      sorting: [
        { id: 'nodata_percentage', desc: false },
        { id: 'cloud_cover', desc: false },
      ],
    },
  });

  const handleQuerySentinel2 = async () => {
    // Use tile name from FlatGeobuf properties - no need for geometry extent
    if (!properties?.Name) {
      setError('No tile name (Name property) available in FlatGeobuf feature');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Query using only tile name from FlatGeobuf - extent is now optional
      // The backend will use tile name as primary filter
      const response = await fetch('http://localhost:8000/sentinel2/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          year: parseInt(year),
          mgrs_tile: properties.Name,
          // Extent is optional - tile name is sufficient for query
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data.success === false || data.error) {
        throw new Error(data.error || 'Failed to query Sentinel-2 images');
      }

      setSentinel2Images(data.images || []);
      setShowImages(true);
    } catch (err: any) {
      setError(err.message || 'Failed to query Sentinel-2 images');
      console.error('Error querying Sentinel-2:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadPrediction = async () => {
    if (!properties?.Name) {
      setPredError('No tile name (Name property) available in FlatGeobuf feature');
      return;
    }
    const qIndexMap: Record<string, number> = { '5%': 2, 'median': 1, '95%': 0 };
    const q_index = qIndexMap[qChoice];
    const rh_index = parseInt(rhIndex);
    if (isNaN(rh_index)) {
      setPredError('Invalid RH index');
      return;
    }

    setPredLoading(true);
    setPredError(null);
    setPredResult(null);
    try {
      console.log('Loading prediction for year:', year);
      const response = await fetch('http://localhost:8000/predictions/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          year: parseInt(year),
          tile_name: properties.Name,
          rh_index,
          q_index,
          source: predSource,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      if (data.success === false || data.error) {
        throw new Error(data.error || 'Failed to load predictions');
      }
      setPredResult(data);
      
      // Load the COG layer via TiTiler
      if (onLoadPredictionCOG && data.url) {
        onLoadPredictionCOG({
          url: data.url,
          tile_name: properties.Name,
          rh_index,
          q_index,
          year: parseInt(year),
        });
      }
    } catch (err: any) {
      setPredError(err.message || 'Failed to load predictions');
      console.error('Error loading predictions:', err);
    } finally {
      setPredLoading(false);
    }
  };

  const handleLoadDistanceMap = async () => {
    if (!properties?.Name) {
      setDistMapError('No tile name available');
      return;
    }
    setDistMapLoading(true);
    setDistMapError(null);
    setDistMapResult(null);
    try {
      const response = await fetch('http://localhost:8000/auxiliary/distance-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tile_name: properties.Name }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      if (data.success === false || data.error) {
        throw new Error(data.error || 'Failed to load distance map');
      }
      setDistMapResult(data);
      if (onLoadAuxiliaryLayer && data.url) {
        onLoadAuxiliaryLayer({
          url: data.url,
          tile_name: properties.Name,
          layer_type: data.layer_type,
        });
      }
    } catch (err: any) {
      setDistMapError(err.message || 'Failed to load distance map');
      console.error('Error loading distance map:', err);
    } finally {
      setDistMapLoading(false);
    }
  };

  const handleLoadCR = async () => {
    if (!properties?.Name) {
      setCrError('No tile name available');
      return;
    }
    setCrLoading(true);
    setCrError(null);
    setCrResult(null);
    try {
      const yearNum = parseInt(year, 10);
      if (isNaN(yearNum)) {
        throw new Error('Invalid year');
      }
      const response = await fetch('http://localhost:8000/auxiliary/cr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tile_name: properties.Name, year: yearNum }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      if (data.success === false || data.error) {
        throw new Error(data.error || 'Failed to load or compute CR');
      }
      setCrResult(data);
      if (onLoadAuxiliaryLayer && data.url) {
        onLoadAuxiliaryLayer({
          url: data.url,
          tile_name: data.tile_name,
          layer_type: data.layer_type,
          metric: (data.metric as 'entropy' | 'enl1d' | 'enl2d') || entropyMetric,
        });
      }
    } catch (err: any) {
      setCrError(err.message || 'Failed to load CR');
      console.error('Load CR error:', err);
    } finally {
      setCrLoading(false);
    }
  };

  const handleLoadProfileEntropy = async () => {
    if (!properties?.Name) {
      setEntropyError('No tile name available');
      return;
    }
    setEntropyLoading(true);
    setEntropyError(null);
    setEntropyResult(null);
    try {
      const yearNum = parseInt(year, 10);
      if (isNaN(yearNum)) {
        throw new Error('Invalid year');
      }
      const response = await fetch('http://localhost:8000/auxiliary/profile-entropy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tile_name: properties.Name, year: yearNum, metric: entropyMetric }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      if (data.success === false || data.error) {
        throw new Error(data.error || 'Failed to load or compute profile entropy');
      }
      setEntropyResult(data);
      if (onLoadAuxiliaryLayer && data.url) {
        onLoadAuxiliaryLayer({
          url: data.url,
          tile_name: data.tile_name,
          layer_type: data.layer_type,
          metric: (data.metric as 'entropy' | 'enl1d' | 'enl2d') || entropyMetric,
        });
      }
    } catch (err: any) {
      setEntropyError(err.message || 'Failed to load profile entropy');
      console.error('Load profile entropy error:', err);
    } finally {
      setEntropyLoading(false);
    }
  };

  const handleLoadALS = async () => {
    if (!properties?.Name) {
      setAlsError('No tile name available');
      return;
    }
    setAlsLoading(true);
    setAlsError(null);
    setAlsResult(null);
    try {
      const response = await fetch('http://localhost:8000/auxiliary/als', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tile_name: properties.Name }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      if (data.success === false || data.error) {
        throw new Error(data.error || 'Failed to load ALS');
      }
      setAlsResult(data);
      if (onLoadAuxiliaryLayer && data.url) {
        onLoadAuxiliaryLayer({
          url: data.url,
          tile_name: data.tile_name,
          layer_type: data.layer_type,
        });
      }
    } catch (err: any) {
      setAlsError(err.message || 'Failed to load ALS');
      console.error('Load ALS error:', err);
    } finally {
      setAlsLoading(false);
    }
  };

  const handleLoadGEDI = async () => {
    if (!properties?.Name) {
      setGediError('No tile name available');
      return;
    }
    setGediLoading(true);
    setGediError(null);
    setGediResult(null);
    try {
      const response = await fetch('http://localhost:8000/auxiliary/gedi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tile_name: properties.Name, year: parseInt(year), sample_size: 5000 }),
      });
      if (!response.ok && response.status !== 204) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const sampled_count = parseInt(response.headers.get('X-Sampled-Count') || '0', 10);
      const total_count = parseInt(response.headers.get('X-Total-Count') || '0', 10);
      const sample_size = parseInt(response.headers.get('X-Sample-Size') || '10000', 10);
      const tile_name = response.headers.get('X-Tile-Name') || properties.Name;
      const contentType = response.headers.get('Content-Type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to load GEDI points');
      }
      const data = {
        tile_name,
        sampled_count,
        total_count,
        sample_size,
      };
      setGediResult(data);
      if (onLoadGEDIPoints && response.status !== 204 && sampled_count > 0) {
        const buffer = new Uint8Array(await response.arrayBuffer());
        onLoadGEDIPoints({
          buffer,
          tile_name,
          sampled_count,
          total_count,
          sample_size,
        });
      }
    } catch (err: any) {
      setGediError(err.message || 'Failed to load GEDI points');
      console.error('Load GEDI error:', err);
    } finally {
      setGediLoading(false);
    }
  };

  const handleGetXYOffset = async () => {
    if (!properties?.Name) {
      setOffsetError('No tile name (Name property) available in FlatGeobuf feature');
      return;
    }
    
    if (!coordinates) {
      setOffsetError('No coordinates available for clicked point');
      return;
    }

    setOffsetLoading(true);
    setOffsetError(null);
    setOffsetResult(null);

    try {
      // Extract geometry coordinates if available
      let geometryCoords: number[][][] | null = null;
      if (geometry) {
        try {
          // Get coordinates from OpenLayers geometry
          const geomType = geometry.getType();
          if (geomType === 'Polygon') {
            const coords = (geometry as any).getCoordinates();
            // OpenLayers Polygon coordinates format: [[[x, y], [x, y], ...]] in EPSG:3857
            // Transform to EPSG:4326 (lat/lon) for backend
            if (coords && coords.length > 0 && coords[0].length > 0) {
              geometryCoords = coords.map((ring: number[][]) => 
                ring.map((coord: number[]) => {
                  // Transform from EPSG:3857 to EPSG:4326
                  const [lon, lat] = transform(coord, 'EPSG:3857', 'EPSG:4326');
                  return [lon, lat];
                })
              );
            }
          }
        } catch (e) {
          console.warn('Could not extract geometry coordinates:', e);
        }
      }

      const response = await fetch('http://localhost:8000/tile/offset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tile_name: properties.Name,
          latitude: coordinates.lat,
          longitude: coordinates.lon,
          geometry_coordinates: geometryCoords,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      if (data.success === false || data.error) {
        throw new Error(data.error || 'Failed to calculate offset');
      }

      setOffsetResult(data);
    } catch (err: any) {
      setOffsetError(err.message || 'Failed to calculate offset');
      console.error('Error calculating offset:', err);
    } finally {
      setOffsetLoading(false);
    }
  };

  if (!properties || !position) return null;

  // Calculate final position with drag offset
  const finalX = position.x + dragPosition.x;
  const finalY = position.y + dragPosition.y;

  return (
    <Box
      sx={{
        position: 'absolute',
        left: finalX,
        top: finalY,
        transform: 'translate(-50%, 0)',
        marginTop: '5px',
        zIndex: 2000,
      }}
      onMouseDown={handleMouseDown}
    >
      <Paper
        sx={{
          width: 500,
          maxHeight: 600,
          boxShadow: 4,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
      {/* Header */}
      <Box
        className="popup-header"
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          p: 1.5,
          bgcolor: 'primary.main',
          color: 'white',
          cursor: isDragging ? 'grabbing' : 'grab',
          userSelect: 'none',
          position: 'sticky',
          top: 0,
          zIndex: 1,
        }}
      >
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            Feature Properties
          </Typography>
          {coordinates && (
            <Typography variant="caption" sx={{ fontSize: '0.75rem', opacity: 0.9 }}>
              {coordinates.lat.toFixed(6)}°, {coordinates.lon.toFixed(6)}°
            </Typography>
          )}
        </Box>
        <IconButton size="small" onClick={onClose} sx={{ color: 'white' }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Scrollable Content Area */}
      <Box sx={{ overflow: 'auto', flex: 1 }}>
        {/* Properties Table - Single Row */}
        <Box sx={{ p: 1, overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              {Object.entries(properties)
                .filter(([key]) => key !== 'geometry')
                .map(([key]) => (
                  <TableCell 
                    key={key}
                    sx={{ 
                      fontWeight: 600, 
                      fontSize: '0.7rem',
                      whiteSpace: 'nowrap',
                      backgroundColor: '#f5f5f5',
                      borderBottom: '2px solid #ddd',
                      position: 'sticky',
                      top: 0,
                      zIndex: 1,
                    }}
                  >
                    {key}
                  </TableCell>
                ))}
            </TableRow>
          </TableHead>
          <TableBody>
            <TableRow>
              {Object.entries(properties)
                .filter(([key]) => key !== 'geometry')
                .map(([key, value]) => (
                  <TableCell 
                    key={key}
                    sx={{ 
                      fontSize: '0.75rem',
                      whiteSpace: 'nowrap',
                      maxWidth: 200,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={value === null || value === undefined 
                      ? 'null'
                      : typeof value === 'object'
                      ? JSON.stringify(value)
                      : String(value)
                    }
                  >
                    {value === null || value === undefined 
                      ? <em style={{ color: '#999' }}>null</em>
                      : typeof value === 'object'
                      ? JSON.stringify(value)
                      : String(value)
                    }
                  </TableCell>
                ))}
            </TableRow>
          </TableBody>
        </Table>
      </Box>

      {/* Get XY Offset Section */}
      <Box sx={{ p: 2, borderTop: '1px solid #e0e0e0' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            Tile Offset
          </Typography>
          <Button
            variant="outlined"
            size="small"
            onClick={handleGetXYOffset}
            disabled={offsetLoading || !properties?.Name || !coordinates}
            startIcon={offsetLoading ? <CircularProgress size={16} /> : null}
          >
            {offsetLoading ? 'Calculating...' : 'Get xy offset'}
          </Button>
        </Box>
        
        {offsetError && (
          <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>
            {offsetError}
          </Typography>
        )}
        
        {offsetResult && offsetResult.success && (
          <Box sx={{ mt: 1, p: 1.5, bgcolor: '#f5f5f5', borderRadius: 1 }}>
            <Typography variant="caption" sx={{ display: 'block', fontWeight: 600, mb: 0.5 }}>
              Column & Row Offset:
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', fontSize: '0.75rem' }}>
              Column: {offsetResult.offset.column_pixels.toFixed(2)} pixels ({offsetResult.offset.column_normalized.toFixed(4)} normalized)
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', fontSize: '0.75rem' }}>
              Row: {offsetResult.offset.row_pixels.toFixed(2)} pixels ({offsetResult.offset.row_normalized.toFixed(4)} normalized)
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#999', fontSize: '0.7rem', mt: 1, fontStyle: 'italic' }}>
              * Pixel offsets estimated at 10m resolution (10980 x 10980 pixels per tile)
            </Typography>
          </Box>
        )}
      </Box>

      {/* Year Selection */}
      <Box sx={{ px: 2, pt: 2, borderTop: '1px solid #e0e0e0' }}>
        <TextField
          label="Year"
          type="number"
          value={year}
          onChange={(e) => setYear(e.target.value)}
          size="small"
          sx={{ width: 100 }}
          inputProps={{ min: 2015, max: new Date().getFullYear() }}
        />
      </Box>

      {/* Sentinel-2 Query Section */}
      <Box sx={{ p: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          Query Sentinel-2 Images
        </Typography>
        
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <TextField
            label="Max Cloud %"
            type="number"
            value={maxCloudCover}
            onChange={(e) => setMaxCloudCover(e.target.value)}
            size="small"
            sx={{ width: 120 }}
            placeholder="Any"
            inputProps={{ min: 0, max: 100, step: 0.1 }}
          />
          <Button
            variant="contained"
            size="small"
            startIcon={loading ? <CircularProgress size={16} /> : <SearchIcon />}
            onClick={handleQuerySentinel2}
            disabled={loading || !geometry}
          >
            {loading ? 'Querying...' : 'Query'}
          </Button>
        </Box>

        {/* Growing Months Filter */}
        {hasGrowingMonths && (
          <Box sx={{ mt: 1 }}>
            <Tooltip 
              title={`Filter images to only show those captured during months: ${displayGrowingMonths}`}
              placement="top"
            >
              <FormControlLabel
                control={
                  <Checkbox
                    checked={useGrowingMonths}
                    onChange={(e) => setUseGrowingMonths(e.target.checked)}
                    size="small"
                  />
                }
                label={
                  <Typography variant="caption" sx={{ fontSize: '0.75rem' }}>
                    Filter by growing months ({displayGrowingMonths})
                  </Typography>
                }
              />
            </Tooltip>
          </Box>
        )}

        {error && (
          <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>
            {error}
          </Typography>
        )}

        {/* Results Table */}
        <Collapse in={showImages && sentinel2Images.length > 0}>
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
              {(() => {
                const hasFilters = filteredImages.length !== sentinel2Images.length;
                if (hasFilters) {
                  const activeFilters = [];
                  if (maxCloudCover.trim() !== '' && !isNaN(parseFloat(maxCloudCover))) {
                    activeFilters.push(`cloud cover ≤ ${maxCloudCover}%`);
                  }
                  if (useGrowingMonths && hasGrowingMonths) {
                    activeFilters.push('growing months');
                  }
                  return `Showing ${filteredImages.length} of ${sentinel2Images.length} images (filtered by ${activeFilters.join(', ')})`;
                }
                return `Found ${sentinel2Images.length} images`;
              })()}
            </Typography>
            <MaterialReactTable table={table} />
          </Box>
        </Collapse>

        {showImages && filteredImages.length === 0 && !loading && !error && (
          <Typography variant="caption" sx={{ mt: 1, display: 'block', color: '#666' }}>
            {sentinel2Images.length === 0 
              ? 'No images found for the specified year.'
              : (() => {
                  const activeFilters = [];
                  if (maxCloudCover.trim() !== '' && !isNaN(parseFloat(maxCloudCover))) {
                    activeFilters.push(`cloud cover ≤ ${maxCloudCover}%`);
                  }
                  if (useGrowingMonths && hasGrowingMonths) {
                    activeFilters.push('growing months');
                  }
                  return activeFilters.length > 0
                    ? `No images found matching filters: ${activeFilters.join(', ')}. Try adjusting the filters.`
                    : 'No images found.';
                })()
            }
          </Typography>
        )}
      </Box>

      {/* Check Predictions Section */}
      <Box sx={{ p: 2, borderTop: '1px solid #e0e0e0' }}>
        <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          Check predictions
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <FormControl size="small" sx={{ minWidth: 110 }}>
            <InputLabel>Source</InputLabel>
            <Select
              value={predSource}
              label="Source"
              onChange={(e) => setPredSource(e.target.value as 'blended' | 'original')}
              MenuProps={{ sx: { zIndex: 2100 } }}
            >
              <MenuItem value="blended">blended</MenuItem>
              <MenuItem value="original">original</MenuItem>
            </Select>
          </FormControl>
          <TextField
            label="RH index"
            type="number"
            value={rhIndex}
            onChange={(e) => setRhIndex(e.target.value)}
            size="small"
            sx={{ width: 100 }}
          />
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <FormControlLabel
              control={<Checkbox size="small" checked={qChoice === '5%'} onChange={() => setQChoice('5%')} />}
              label={<Typography variant="caption">5%</Typography>}
            />
            <FormControlLabel
              control={<Checkbox size="small" checked={qChoice === 'median'} onChange={() => setQChoice('median')} />}
              label={<Typography variant="caption">median</Typography>}
            />
            <FormControlLabel
              control={<Checkbox size="small" checked={qChoice === '95%'} onChange={() => setQChoice('95%')} />}
              label={<Typography variant="caption">95%</Typography>}
            />
          </Box>
          <Button
            variant="contained"
            size="small"
            onClick={handleLoadPrediction}
            disabled={predLoading}
          >
            {predLoading ? 'Loading...' : 'Load'}
          </Button>
        </Box>
        {predError && (
          <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>
            {predError}
          </Typography>
        )}
        {predResult && (
          <Box sx={{ mt: 1, p: 1, bgcolor: '#f5f5f5', borderRadius: 1 }}>
            <Typography variant="caption" sx={{ display: 'block', color: 'success.main', fontWeight: 600 }}>
              ✓ Prediction COG loaded successfully
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', mt: 0.5 }}>
              Tile: {predResult.tile_name} | Year: {predResult.year || year}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', fontSize: '0.7rem', mt: 0.5 }}>
              URL: {predResult.url}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#999', fontSize: '0.7rem', mt: 0.5, fontStyle: 'italic' }}>
              Layer added to map - use Layer Control to manage visibility
            </Typography>
          </Box>
        )}
      </Box>

      {/* Check Auxiliary Data Section */}
      <Box sx={{ p: 2, borderTop: '1px solid #e0e0e0' }}>
        <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          Check auxiliary data
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Button
              variant="contained"
              size="small"
              onClick={handleLoadDistanceMap}
              disabled={distMapLoading}
            >
              {distMapLoading ? 'Loading...' : 'Load distance map'}
            </Button>
            <Button
              variant="contained"
              size="small"
              onClick={handleLoadCR}
              disabled={crLoading}
            >
              {crLoading ? 'Loading...' : 'Load CR'}
            </Button>
            <Button
              variant="contained"
              size="small"
              onClick={handleLoadProfileEntropy}
              disabled={entropyLoading}
            >
              {entropyLoading ? 'Loading...' : 'Load Profile Entropy'}
            </Button>
            <Button
              variant="contained"
              size="small"
              onClick={handleLoadALS}
              disabled={alsLoading}
            >
              {alsLoading ? 'Loading...' : 'Load ALS'}
            </Button>
            <Button
              variant="contained"
              size="small"
              onClick={handleLoadGEDI}
              disabled={gediLoading}
            >
              {gediLoading ? 'Loading...' : 'Load GEDI'}
            </Button>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <FormControl size="small" sx={{ minWidth: 180 }}>
              <InputLabel>Profile entropy metric</InputLabel>
              <Select
                value={entropyMetric}
                label="Profile entropy metric"
                onChange={(e) => setEntropyMetric(e.target.value as 'entropy' | 'enl1d' | 'enl2d')}
                MenuProps={{ sx: { zIndex: 2100 } }}
              >
                <MenuItem value="entropy">FHD</MenuItem>
                <MenuItem value="enl1d">1D ENL</MenuItem>
                <MenuItem value="enl2d">2D ENL</MenuItem>
              </Select>
            </FormControl>
          </Box>
        </Box>
        {distMapError && (
          <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>
            {distMapError}
          </Typography>
        )}
        {crError && (
          <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>
            {crError}
          </Typography>
        )}
        {entropyError && (
          <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>
            {entropyError}
          </Typography>
        )}
        {alsError && (
          <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>
            {alsError}
          </Typography>
        )}
        {gediError && (
          <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>
            {gediError}
          </Typography>
        )}
        {distMapResult && (
          <Box sx={{ mt: 1, p: 1, bgcolor: '#f5f5f5', borderRadius: 1 }}>
            <Typography variant="caption" sx={{ display: 'block', color: 'success.main', fontWeight: 600 }}>
              ✓ Distance map loaded successfully
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', mt: 0.5 }}>
              Tile: {distMapResult.tile_name}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', fontSize: '0.7rem', mt: 0.5 }}>
              URL: {distMapResult.url}
            </Typography>
          </Box>
        )}
        {crResult && (
          <Box sx={{ mt: 1, p: 1, bgcolor: '#f5f5f5', borderRadius: 1 }}>
            <Typography variant="caption" sx={{ display: 'block', color: 'success.main', fontWeight: 600 }}>
              ✓ CR loaded successfully
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', mt: 0.5 }}>
              Tile: {crResult.tile_name}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', fontSize: '0.7rem', mt: 0.5 }}>
              URL: {crResult.url}
            </Typography>
          </Box>
        )}
        {entropyResult && (
          <Box sx={{ mt: 1, p: 1, bgcolor: '#f5f5f5', borderRadius: 1 }}>
            <Typography variant="caption" sx={{ display: 'block', color: 'success.main', fontWeight: 600 }}>
              ✓ Profile entropy loaded successfully
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', mt: 0.5 }}>
              Tile: {entropyResult.tile_name}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', mt: 0.5 }}>
              Metric: {entropyMetric === 'entropy' ? 'FHD' : entropyMetric === 'enl1d' ? '1D ENL' : '2D ENL'}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', fontSize: '0.7rem', mt: 0.5 }}>
              URL: {entropyResult.url}
            </Typography>
          </Box>
        )}
        {alsResult && (
          <Box sx={{ mt: 1, p: 1, bgcolor: '#f5f5f5', borderRadius: 1 }}>
            <Typography variant="caption" sx={{ display: 'block', color: 'success.main', fontWeight: 600 }}>
              ✓ ALS loaded successfully
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', mt: 0.5 }}>
              Tile: {alsResult.tile_name}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', fontSize: '0.7rem', mt: 0.5 }}>
              URL: {alsResult.url}
            </Typography>
          </Box>
        )}
        {gediResult && (
          <Box sx={{ mt: 1, p: 1, bgcolor: '#f5f5f5', borderRadius: 1 }}>
            <Typography variant="caption" sx={{ display: 'block', color: 'success.main', fontWeight: 600 }}>
              ✓ GEDI points loaded successfully
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', mt: 0.5 }}>
              Tile: {gediResult.tile_name}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#666', mt: 0.5 }}>
              Sampled: {gediResult.sampled_count} / {gediResult.total_count}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#999', fontSize: '0.7rem', mt: 0.5, fontStyle: 'italic' }}>
              Layer added to map as sampled points
            </Typography>
          </Box>
        )}
      </Box>
      </Box>

      {/* Options Menu */}
      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={handleMenuClose}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
        sx={{
          zIndex: 2100,
        }}
      >
        <MenuItem onClick={handleCopyDate}>
          Copy date
        </MenuItem>
      </Menu>
    </Paper>
    
    {/* Pointer/Arrow pointing up */}
    <Box
      sx={{
        position: 'absolute',
        top: -10,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 0,
        height: 0,
        borderLeft: '10px solid transparent',
        borderRight: '10px solid transparent',
        borderBottom: '10px solid white',
        filter: 'drop-shadow(0px -2px 2px rgba(0,0,0,0.2))',
      }}
    />
  </Box>
  );
}

