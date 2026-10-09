import type { Map as MlMap } from 'maplibre-gl';
import type { MapLayer } from '../map/layers';
import { bboxFromMercator, isFiniteBBox, type BBox } from '../map/proj';

// Use global Map to avoid conflict with the map library's Map
type LayerMap = globalThis.Map<string, ManagedLayer>;

export type LayerType = 'cog' | 'fgb' | 'sentinel2' | 'prediction' | 'vector' | 'earthengine';

export interface ManagedLayer {
  id: string;
  name: string;
  type: LayerType;
  layer: MapLayer;
  visible: boolean;
  opacity: number;
  zIndex: number;
  metadata?: Record<string, any>;
}

/**
 * LayerManager class to manage all map layers with unified visibility and opacity control
 */
export class LayerManager {
  private map: MlMap | null = null;
  private layers: LayerMap = new globalThis.Map<string, ManagedLayer>();

  constructor(map: MlMap | null) {
    this.map = map;
  }

  /**
   * Update the map instance
   */
  setMap(map: MlMap | null) {
    this.map = map;
  }

  /**
   * Add a layer to the manager
   */
  addLayer(
    id: string,
    name: string,
    type: LayerType,
    layer: MapLayer,
    metadata?: Record<string, any>
  ): void {
    if (!this.map) {
      console.warn('Cannot add layer: map is not initialized');
      return;
    }

    const managedLayer: ManagedLayer = {
      id,
      name,
      type,
      layer,
      visible: layer.getVisible(),
      opacity: layer.getOpacity(),
      zIndex: layer.getZIndex(),
      metadata,
    };

    this.layers.set(id, managedLayer);

    // Ensure layer is added to map if not already
    if (!layer.isAttached()) layer.attach(this.map);
  }

  /**
   * Remove a layer from the manager and map
   */
  removeLayer(id: string): boolean {
    const managedLayer = this.layers.get(id);
    if (!managedLayer) {
      return false;
    }

    managedLayer.layer.detach();
    this.layers.delete(id);
    return true;
  }

  /**
   * Toggle layer visibility
   */
  toggleVisibility(id: string): boolean {
    const managedLayer = this.layers.get(id);
    if (!managedLayer) {
      return false;
    }

    const newVisible = !managedLayer.visible;
    managedLayer.visible = newVisible;
    managedLayer.layer.setVisible(newVisible);

    return newVisible;
  }

  /**
   * Set layer visibility
   */
  setVisibility(id: string, visible: boolean): boolean {
    const managedLayer = this.layers.get(id);
    if (!managedLayer) {
      return false;
    }

    managedLayer.visible = visible;
    managedLayer.layer.setVisible(visible);
    return true;
  }

  /**
   * Set layer opacity
   */
  setOpacity(id: string, opacity: number): boolean {
    const managedLayer = this.layers.get(id);
    if (!managedLayer) {
      return false;
    }

    managedLayer.opacity = opacity;
    managedLayer.layer.setOpacity(opacity);
    return true;
  }

  /**
   * Set layer z-index
   */
  setZIndex(id: string, zIndex: number): boolean {
    const managedLayer = this.layers.get(id);
    if (!managedLayer) {
      return false;
    }

    managedLayer.zIndex = zIndex;
    managedLayer.layer.setZIndex(zIndex);
    return true;
  }

  /**
   * Get a layer by ID
   */
  getLayer(id: string): ManagedLayer | undefined {
    return this.layers.get(id);
  }

  /**
   * Get all layers
   */
  getAllLayers(): ManagedLayer[] {
    return Array.from(this.layers.values()) as ManagedLayer[];
  }

  /**
   * Get layers by type
   */
  getLayersByType(type: LayerType): ManagedLayer[] {
    const allLayers = Array.from(this.layers.values());
    return allLayers.filter((l) => l.type === type);
  }

  /**
   * Sync layer properties from the actual map layer
   */
  syncLayerProperties(id: string): void {
    const managedLayer = this.layers.get(id);
    if (!managedLayer) {
      return;
    }

    managedLayer.visible = managedLayer.layer.getVisible();
    managedLayer.opacity = managedLayer.layer.getOpacity();
    managedLayer.zIndex = managedLayer.layer.getZIndex();
  }

  /**
   * Sync all layer properties
   */
  syncAllProperties(): void {
    this.layers.forEach((_managedLayer: ManagedLayer, id: string) => {
      this.syncLayerProperties(id);
    });
  }

  /**
   * Reorder layers
   */
  reorderLayers(fromIndex: number, toIndex: number): boolean {
    const layersArray = Array.from(this.layers.values());

    if (fromIndex < 0 || fromIndex >= layersArray.length ||
        toIndex < 0 || toIndex >= layersArray.length) {
      return false;
    }

    const [movedLayer] = layersArray.splice(fromIndex, 1);
    layersArray.splice(toIndex, 0, movedLayer);

    // Update z-index based on new order
    layersArray.forEach((layer, index) => {
      const baseZIndex = 100; // Base z-index for managed layers
      const newZIndex = baseZIndex + index;
      this.setZIndex(layer.id, newZIndex);
    });

    return true;
  }

  /**
   * Clear all layers
   */
  clear(): void {
    this.layers.forEach((managedLayer: ManagedLayer) => managedLayer.layer.detach());
    this.layers.clear();
  }

  /**
   * Get layer count
   */
  getCount(): number {
    return this.layers.size;
  }

  /**
   * Where a layer's data is, for zooming to it — [west, south, east, north] in
   * degrees.
   */
  getLayerExtent(id: string): BBox | null {
    const managedLayer = this.layers.get(id);
    if (!managedLayer) {
      return null;
    }

    // First, try metadata (most reliable)
    const metadata = managedLayer.metadata;
    if (metadata) {
      // `extent` is Web Mercator, as the layer loaders record it.
      if (isFiniteBBox(metadata.extent)) {
        return bboxFromMercator(metadata.extent);
      }
      // `bbox` is lat/lon, unless it is too large to be.
      if (isFiniteBBox(metadata.bbox)) {
        const b = metadata.bbox;
        const isLatLon = Math.abs(b[0]) <= 180 && Math.abs(b[1]) <= 90;
        return isLatLon ? b : bboxFromMercator(b);
      }
    }

    // Otherwise the layer's own idea of where its data is.
    const own = managedLayer.layer.getBounds();
    return isFiniteBBox(own) ? own : null;
  }
}
