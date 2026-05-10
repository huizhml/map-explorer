import { create } from 'zustand';
import type { Map } from 'ol';
import type { WebGLTileLayer } from '../components/Map';
import VectorLayer from 'ol/layer/Vector';
import { Geometry } from 'ol/geom';
import { LayerManager } from '../utils/LayerManager';
import type { Layer } from '../components/LayerControl';
import type { VsmLayerEntry, VsmQChoice } from '../constants/predictions';
import { getVsmLayerId } from '../constants/predictions';
import type { InspectLayerRow } from '../utils/inspectPoint';
import { API_BASE_URL } from '../utils/apiBase';
import type { SavedFeature, SavedFeatureDraft, SavedFeatureGeometry, SavedFeatureGeometryType } from '../services/savedFeaturesApi';
import { DEFAULT_DIVERSITY_HEIGHT_BIN_M, DIVERSITY_HEIGHT_BIN_OPTIONS } from '../constants/diversityMetrics';

const DIVERSITY_HEIGHT_BIN_STORAGE_KEY = 'map-explorer-diversity-height-bin-m';

function readStoredDiversityHeightBin(): number {
  if (typeof window === 'undefined') return DEFAULT_DIVERSITY_HEIGHT_BIN_M;
  try {
    const raw = window.localStorage.getItem(DIVERSITY_HEIGHT_BIN_STORAGE_KEY);
    if (raw == null) return DEFAULT_DIVERSITY_HEIGHT_BIN_M;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && (DIVERSITY_HEIGHT_BIN_OPTIONS as readonly number[]).includes(n)) return n;
  } catch {
    /* ignore */
  }
  return DEFAULT_DIVERSITY_HEIGHT_BIN_M;
}

export type VerticalProfilePoint = {
  rh: number;
  value: number | null;
  missing?: boolean;
};

export type VerticalProfileLineSample = {
  index: number;
  distance_m: number;
  lon: number;
  lat: number;
  profile: VerticalProfilePoint[];
  vertical_profile_curve?: Array<{ z: number; value: number }>;
  fhd?: number | null;
  enl1d?: number | null;
  enl2d?: number | null;
  cr?: number | null;
  tile_name?: string;
};

export type SavedGediPoint = {
  id: string;
  lon: number;
  lat: number;
  coordinate: number[];
  properties: Record<string, any>;
  savedAt: number;
};

export type SavedMapFeature = SavedFeature;
export type SavedMapFeatureGeometry = SavedFeatureGeometry;
export type SavedMapFeatureDraft = SavedFeatureDraft;

export type InspectPanelState = {
  lon: number;
  lat: number;
  loading: boolean;
  layers: InspectLayerRow[];
  /** New click in flight; displayed coords/values stay on last sample until resolved */
  pendingSample?: { lon: number; lat: number };
  kind: 'layers' | 'vertical_profile' | 'vertical_profile_line';
  verticalProfile?: VerticalProfilePoint[];
  verticalProfileCurve?: Array<{ z: number; value: number }>;
  profileMetrics?: {
    fhd?: number | null;
    enl1d?: number | null;
    enl2d?: number | null;
    cr?: number | null;
  };
  profileMeta?: {
    tileName: string;
    year: number;
    qIndex: number;
    source?: string;
    /** Diversity / histogram domain (m); from API `max_height`. */
    maxHeight?: number;
    /** Transect heatmap y-axis top (m); from API `heatmap_max_height`. */
    heatmapMaxHeight?: number;
    fhdInterval?: number;
  };
  transectProfile?: {
    lineCoordinates: Array<[number, number]>;
    sampleCount: number;
    totalLengthMeters: number;
    samples: VerticalProfileLineSample[];
  };
  inspectError?: string | null;
};

// Types
export interface FgbInfo {
  type: string;
  featureCount: number;
  geometryTypes: string[];
  properties: string[];
  sampleProperties: Record<string, any>;
  numericPropertyRanges?: Record<string, { min: number; max: number }>;
  discretePropertyValues?: Record<string, string[]>;
}

export interface StyleOptions {
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  pointRadius: number;
  opacity: number;
  zIndex: number;
  clusterPoints: boolean;
  colorByProperty: string;
  colorPalette: string;
  colorScaleType: 'continuous' | 'discrete';
  colorRangeMin: number | null;
  colorRangeMax: number | null;
}

export interface ConditionalStyle {
  property: string;
  operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains' | 'starts_with' | 'between' | 'color_gradient';
  value: string | number;
  value2?: string | number; // For 'between' operator
  style: Partial<StyleOptions>;
  // For color gradient
  minValue?: number;
  maxValue?: number;
  colorPalette?: string; // Palette name (e.g., 'Viridis', 'Magma', etc.)
  minColor?: string; // Deprecated - kept for backward compatibility
  maxColor?: string; // Deprecated - kept for backward compatibility
}

export type ConditionalLogicMode = 'any' | 'all';

export interface Sentinel2Layer {
  layer: WebGLTileLayer;
  id: string;
  imageId: string;
  tileName?: string;
  datetime?: string;
}

export interface PredictionLayer {
  layer: any; // Can be TileLayer or WebGLTileLayer
  id: string;
  tileName: string;
  rhIndex: number;
  qIndex: number;
  year: number;
  url: string;
}

interface MapStore {
  // Map instance
  map: Map | null;
  setMap: (map: Map | null) => void;

  // COG Layer
  cogLayer: WebGLTileLayer | null;
  setCogLayer: (layer: WebGLTileLayer | null) => void;
  currentFileName: string | null;
  setCurrentFileName: (fileName: string | null) => void;
  cogOpacity: number;
  setCogOpacity: (opacity: number) => void;
  cogVisible: boolean;
  setCogVisible: (visible: boolean) => void;
  palette: string;
  setPalette: (palette: string) => void;

  // FlatGeobuf Layer
  fgbLayer: any | null;
  setFgbLayer: (layer: any | null) => void;
  fgbUrl: string;
  setFgbUrl: (url: string) => void;
  fgbLoading: boolean;
  setFgbLoading: (loading: boolean) => void;
  fgbError: string | null;
  setFgbError: (error: string | null) => void;
  fgbInfo: FgbInfo | null;
  setFgbInfo: (info: FgbInfo | null) => void;
  fgbStyleOptions: StyleOptions;
  setFgbStyleOptions: (options: StyleOptions | ((prev: StyleOptions) => StyleOptions)) => void;
  conditionalStyles: ConditionalStyle[];
  setConditionalStyles: (styles: ConditionalStyle[] | ((prev: ConditionalStyle[]) => ConditionalStyle[])) => void;
  conditionalLogicMode: ConditionalLogicMode;
  setConditionalLogicMode: (mode: ConditionalLogicMode) => void;
  enableConditionalRendering: boolean;
  setEnableConditionalRendering: (enabled: boolean) => void;
  hasAutoLoadedFgb: boolean;
  setHasAutoLoadedFgb: (loaded: boolean) => void;

  // Layers management
  layers: Layer[];
  setLayers: (layers: Layer[]) => void;
  layerManager: LayerManager | null;
  setLayerManager: (manager: LayerManager | null) => void;

  /** Transect heatmap: column index (sample along line) to show on the map; null hides the marker. */
  transectHeatmapSampleIndex: number | null;
  setTransectHeatmapSampleIndex: (index: number | null) => void;

  // Sentinel-2 layers
  sentinel2Layers: Sentinel2Layer[];
  setSentinel2Layers: (layers: Sentinel2Layer[] | ((prev: Sentinel2Layer[]) => Sentinel2Layer[])) => void;

  // Prediction layers
  predictionLayers: PredictionLayer[];
  setPredictionLayers: (layers: PredictionLayer[] | ((prev: PredictionLayer[]) => PredictionLayer[])) => void;

  // VSM layers: form state (year, RH, Q) and list of added layers (each gets a global layer)
  vsmYear: number;
  setVsmYear: (year: number) => void;
  vsmRhIndex: number;
  setVsmRhIndex: (rh: number) => void;
  vsmQChoice: VsmQChoice;
  setVsmQChoice: (q: VsmQChoice) => void;
  addedVsmLayers: VsmLayerEntry[];
  addVsmLayer: (entry: VsmLayerEntry) => void;
  removeVsmLayerByLayerId: (layerId: string) => void;

  // Drawing tools
  drawingActive: boolean;
  setDrawingActive: (active: boolean) => void;
  drawingMode: 'tiles' | 'figures' | 'figures_db';
  setDrawingMode: (mode: 'tiles' | 'figures' | 'figures_db') => void;
  selectedTiles: string[];
  setSelectedTiles: (tiles: string[]) => void;
  figureSelectionExtent: [number, number, number, number] | null;
  setFigureSelectionExtent: (extent: [number, number, number, number] | null) => void;

  /** When true, map clicks open the inspect panel (layer sample or vertical RH profile) */
  inspectMode: boolean;
  setInspectMode: (active: boolean) => void;
  inspectKind: 'layers' | 'vertical_profile' | 'vertical_profile_line';
  setInspectKind: (k: 'layers' | 'vertical_profile' | 'vertical_profile_line') => void;
  inspectPanel: InspectPanelState | null;
  setInspectPanel: (panel: InspectPanelState | null | ((prev: InspectPanelState | null) => InspectPanelState | null)) => void;

  /** Height histogram bin width (m) for FHD / ENL / CR — must match API `fhd_interval`. */
  diversityHeightBinM: number;
  setDiversityHeightBinM: (m: number) => void;

  // Popup state
  popupProperties: Record<string, any> | null;
  setPopupProperties: (properties: Record<string, any> | null) => void;
  popupPosition: { x: number; y: number } | null;
  setPopupPosition: (position: { x: number; y: number } | null) => void;
  popupGeometry: Geometry | null;
  setPopupGeometry: (geometry: Geometry | null) => void;
  popupCoordinates: { lon: number; lat: number } | null;
  setPopupCoordinates: (coordinates: { lon: number; lat: number } | null) => void;

  // Saved GEDI points
  savedGediPoints: SavedGediPoint[];
  addSavedGediPoint: (point: Omit<SavedGediPoint, 'id' | 'savedAt'>) => void;
  removeSavedGediPoint: (id: string) => void;
  clearSavedGediPoints: () => void;

  // Saved map features (persisted in backend database)
  savedMapFeatures: SavedMapFeature[];
  setSavedMapFeatures: (features: SavedMapFeature[] | ((prev: SavedMapFeature[]) => SavedMapFeature[])) => void;
  addSavedMapFeature: (feature: SavedMapFeature) => void;
  removeSavedMapFeature: (id: number) => void;
  featureCaptureType: SavedFeatureGeometryType | null;
  setFeatureCaptureType: (captureType: SavedFeatureGeometryType | null) => void;
  featureDraft: SavedMapFeatureDraft | null;
  setFeatureDraft: (draft: SavedMapFeatureDraft | null) => void;

  // Highlight layer
  highlightLayer: VectorLayer<any> | null;
  setHighlightLayer: (layer: VectorLayer<any> | null) => void;

  // Actions
  closePopup: () => void;
  updateFgbStyleOption: (newStyle: Partial<StyleOptions>) => void;
  addConditionalStyle: () => void;
  updateConditionalStyle: (index: number, field: keyof ConditionalStyle, value: any) => void;
  removeConditionalStyle: (index: number) => void;
}

const defaultFgbStyleOptions: StyleOptions = {
  fillColor: '#ff000000',
  strokeColor: '#000000',
  strokeWidth: 2,
  pointRadius: 5,
  opacity: 1,
  zIndex: 100,
  clusterPoints: true,
  colorByProperty: '',
  colorPalette: 'Viridis',
  colorScaleType: 'continuous',
  colorRangeMin: null,
  colorRangeMax: null,
};

export const useMapStore = create<MapStore>((set, get) => ({
  // Map instance
  map: null,
  setMap: (map) => set({ map }),

  // COG Layer
  cogLayer: null,
  setCogLayer: (layer) => set({ cogLayer: layer }),
  currentFileName: null,
  setCurrentFileName: (fileName) => set({ currentFileName: fileName }),
  cogOpacity: 1,
  setCogOpacity: (opacity) => set({ cogOpacity: opacity }),
  cogVisible: true,
  setCogVisible: (visible) => set({ cogVisible: visible }),
  palette: 'Viridis',
  setPalette: (palette) => set({ palette }),

  // FlatGeobuf Layer
  fgbLayer: null,
  setFgbLayer: (layer) => set({ fgbLayer: layer }),
  fgbUrl: `${API_BASE_URL}/fgb/local`,
  setFgbUrl: (url) => set({ fgbUrl: url }),
  fgbLoading: false,
  setFgbLoading: (loading) => set({ fgbLoading: loading }),
  fgbError: null,
  setFgbError: (error) => set({ fgbError: error }),
  fgbInfo: null,
  setFgbInfo: (info) => set({ fgbInfo: info }),
  fgbStyleOptions: defaultFgbStyleOptions,
  setFgbStyleOptions: (options) =>
    set((state) => ({
      fgbStyleOptions: typeof options === 'function' ? options(state.fgbStyleOptions) : options,
    })),
  conditionalStyles: [],
  setConditionalStyles: (styles) =>
    set((state) => ({
      conditionalStyles: typeof styles === 'function' ? styles(state.conditionalStyles) : styles,
    })),
  conditionalLogicMode: 'any',
  setConditionalLogicMode: (mode) => set({ conditionalLogicMode: mode }),
  enableConditionalRendering: false,
  setEnableConditionalRendering: (enabled) => set({ enableConditionalRendering: enabled }),
  hasAutoLoadedFgb: false,
  setHasAutoLoadedFgb: (loaded) => set({ hasAutoLoadedFgb: loaded }),

  // Layers management
  layers: [],
  setLayers: (layers) => set({ layers }),
  layerManager: null,
  setLayerManager: (manager) => set({ layerManager: manager }),

  transectHeatmapSampleIndex: null,
  setTransectHeatmapSampleIndex: (index) => set({ transectHeatmapSampleIndex: index }),

  // Sentinel-2 layers
  sentinel2Layers: [],
  setSentinel2Layers: (layers) =>
    set((state) => ({
      sentinel2Layers: typeof layers === 'function' ? layers(state.sentinel2Layers) : layers,
    })),

  // Prediction layers
  predictionLayers: [],
  setPredictionLayers: (layers) =>
    set((state) => ({
      predictionLayers: typeof layers === 'function' ? layers(state.predictionLayers) : layers,
    })),

  // VSM layers
  vsmYear: 2020,
  setVsmYear: (year) => set({ vsmYear: year }),
  vsmRhIndex: 98,
  setVsmRhIndex: (rh) => set({ vsmRhIndex: rh }),
  vsmQChoice: 'median',
  setVsmQChoice: (q) => set({ vsmQChoice: q }),
  addedVsmLayers: [],
  addVsmLayer: (entry) =>
    set((state) => ({
      addedVsmLayers: [...state.addedVsmLayers, entry],
    })),
  removeVsmLayerByLayerId: (layerId) =>
    set((state) => ({
      addedVsmLayers: state.addedVsmLayers.filter((e) => getVsmLayerId(e) !== layerId),
    })),

  // Drawing tools
  drawingActive: false,
  setDrawingActive: (active) => set({ drawingActive: active }),
  drawingMode: 'tiles',
  setDrawingMode: (mode) => set({ drawingMode: mode }),
  selectedTiles: [],
  setSelectedTiles: (tiles) => set({ selectedTiles: tiles }),
  figureSelectionExtent: null,
  setFigureSelectionExtent: (extent) => set({ figureSelectionExtent: extent }),

  inspectMode: false,
  setInspectMode: (active) =>
    set((s) => ({
      inspectMode: active,
      inspectKind: active ? s.inspectKind : 'layers',
    })),
  inspectKind: 'layers' as 'layers' | 'vertical_profile' | 'vertical_profile_line',
  setInspectKind: (k) => set({ inspectKind: k }),
  inspectPanel: null,
  setInspectPanel: (panel) =>
    set((state) => ({
      inspectPanel: typeof panel === 'function' ? panel(state.inspectPanel) : panel,
    })),

  diversityHeightBinM: readStoredDiversityHeightBin(),
  setDiversityHeightBinM: (m) => {
    try {
      window.localStorage.setItem(DIVERSITY_HEIGHT_BIN_STORAGE_KEY, String(m));
    } catch {
      /* ignore */
    }
    set({ diversityHeightBinM: m });
  },

  // Popup state
  popupProperties: null,
  setPopupProperties: (properties) => set({ popupProperties: properties }),
  popupPosition: null,
  setPopupPosition: (position) => set({ popupPosition: position }),
  popupGeometry: null,
  setPopupGeometry: (geometry) => set({ popupGeometry: geometry }),
  popupCoordinates: null,
  setPopupCoordinates: (coordinates) => set({ popupCoordinates: coordinates }),

  // Saved GEDI points
  savedGediPoints: [],
  addSavedGediPoint: (point) =>
    set((state) => ({
      savedGediPoints: [
        ...state.savedGediPoints,
        { ...point, id: `gedi-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, savedAt: Date.now() },
      ],
    })),
  removeSavedGediPoint: (id) =>
    set((state) => ({
      savedGediPoints: state.savedGediPoints.filter((p) => p.id !== id),
    })),
  clearSavedGediPoints: () => set({ savedGediPoints: [] }),

  savedMapFeatures: [],
  setSavedMapFeatures: (features) =>
    set((state) => ({
      savedMapFeatures: typeof features === 'function' ? features(state.savedMapFeatures) : features,
    })),
  addSavedMapFeature: (feature) =>
    set((state) => ({
      savedMapFeatures: [feature, ...state.savedMapFeatures.filter((f) => f.id !== feature.id)],
    })),
  removeSavedMapFeature: (id) =>
    set((state) => ({
      savedMapFeatures: state.savedMapFeatures.filter((feature) => feature.id !== id),
    })),
  featureCaptureType: null,
  setFeatureCaptureType: (captureType) => set({ featureCaptureType: captureType }),
  featureDraft: null,
  setFeatureDraft: (draft) => set({ featureDraft: draft }),

  // Highlight layer
  highlightLayer: null,
  setHighlightLayer: (layer) => set({ highlightLayer: layer }),

  // Actions
  closePopup: () =>
    set({
      popupProperties: null,
      popupPosition: null,
      popupGeometry: null,
      popupCoordinates: null,
    }),

  updateFgbStyleOption: (newStyle: Partial<StyleOptions>) => {
    const state = get();
    state.setFgbStyleOptions({
      ...state.fgbStyleOptions,
      ...newStyle,
    });
  },

  addConditionalStyle: () => {
    const state = get();
    const newStyle: ConditionalStyle = {
      property: '',
      operator: 'equals',
      value: '',
      style: {
        fillColor: '#00ff00',
        strokeColor: '#000000',
        strokeWidth: 2,
        pointRadius: 5,
        opacity: 0.8,
      },
    };
    state.setConditionalStyles([...state.conditionalStyles, newStyle]);
  },

  updateConditionalStyle: (index, field, value) => {
    const state = get();
    const updated = [...state.conditionalStyles];
    updated[index] = { ...updated[index], [field]: value };
    state.setConditionalStyles(updated);
  },

  removeConditionalStyle: (index) => {
    const state = get();
    state.setConditionalStyles(state.conditionalStyles.filter((_, i) => i !== index));
  },
}));
