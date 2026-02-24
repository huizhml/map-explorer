import { create } from 'zustand';
import type { Map } from 'ol';
import type { WebGLTileLayer } from '../components/Map';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Geometry } from 'ol/geom';
import { LayerManager } from '../utils/LayerManager';
import type { Layer } from '../components/LayerControl';
import type { VsmLayerEntry } from '../constants/predictions';
import { getVsmLayerId } from '../constants/predictions';

// Types
export interface FgbInfo {
  type: string;
  featureCount: number;
  geometryTypes: string[];
  properties: string[];
  sampleProperties: Record<string, any>;
}

export interface StyleOptions {
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  pointRadius: number;
  opacity: number;
  zIndex: number;
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
  fgbLayer: VectorLayer<VectorSource> | null;
  setFgbLayer: (layer: VectorLayer<VectorSource> | null) => void;
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
  enableConditionalRendering: boolean;
  setEnableConditionalRendering: (enabled: boolean) => void;
  hasAutoLoadedFgb: boolean;
  setHasAutoLoadedFgb: (loaded: boolean) => void;

  // Layers management
  layers: Layer[];
  setLayers: (layers: Layer[]) => void;
  layerManager: LayerManager | null;
  setLayerManager: (manager: LayerManager | null) => void;

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
  vsmQChoice: '5%' | 'median' | '95%';
  setVsmQChoice: (q: '5%' | 'median' | '95%') => void;
  addedVsmLayers: VsmLayerEntry[];
  addVsmLayer: (entry: VsmLayerEntry) => void;
  removeVsmLayerByLayerId: (layerId: string) => void;

  // Drawing tools
  drawingActive: boolean;
  setDrawingActive: (active: boolean) => void;
  selectedTiles: string[];
  setSelectedTiles: (tiles: string[]) => void;

  // Popup state
  popupProperties: Record<string, any> | null;
  setPopupProperties: (properties: Record<string, any> | null) => void;
  popupPosition: { x: number; y: number } | null;
  setPopupPosition: (position: { x: number; y: number } | null) => void;
  popupGeometry: Geometry | null;
  setPopupGeometry: (geometry: Geometry | null) => void;
  popupCoordinates: { lon: number; lat: number } | null;
  setPopupCoordinates: (coordinates: { lon: number; lat: number } | null) => void;

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
  fgbUrl: 'http://localhost:8000/fgb/local',
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
  enableConditionalRendering: false,
  setEnableConditionalRendering: (enabled) => set({ enableConditionalRendering: enabled }),
  hasAutoLoadedFgb: false,
  setHasAutoLoadedFgb: (loaded) => set({ hasAutoLoadedFgb: loaded }),

  // Layers management
  layers: [],
  setLayers: (layers) => set({ layers }),
  layerManager: null,
  setLayerManager: (manager) => set({ layerManager: manager }),

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
  selectedTiles: [],
  setSelectedTiles: (tiles) => set({ selectedTiles: tiles }),

  // Popup state
  popupProperties: null,
  setPopupProperties: (properties) => set({ popupProperties: properties }),
  popupPosition: null,
  setPopupPosition: (position) => set({ popupPosition: position }),
  popupGeometry: null,
  setPopupGeometry: (geometry) => set({ popupGeometry: geometry }),
  popupCoordinates: null,
  setPopupCoordinates: (coordinates) => set({ popupCoordinates: coordinates }),

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

