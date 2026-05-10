import type { Map as OLMap } from 'ol';
import type BaseLayer from 'ol/layer/Base';
import { transformExtent } from 'ol/proj';

// Use global Map to avoid conflict with OpenLayers Map
type LayerMap = globalThis.Map<string, ManagedLayer>;

export type LayerType = 'cog' | 'fgb' | 'sentinel2' | 'prediction' | 'vector' | 'earthengine';

export interface ManagedLayer {
  id: string;
  name: string;
  type: LayerType;
  layer: BaseLayer;
  visible: boolean;
  opacity: number;
  zIndex: number;
  metadata?: Record<string, any>;
}

/**
 * LayerManager class to manage all map layers with unified visibility and opacity control
 */
export class LayerManager {
  private map: OLMap | null = null;
  private layers: LayerMap = new globalThis.Map<string, ManagedLayer>();

  constructor(map: OLMap | null) {
    this.map = map;
  }

  /**
   * Update the map instance
   */
  setMap(map: OLMap | null) {
    this.map = map;
  }

  /**
   * Add a layer to the manager
   */
  addLayer(
    id: string,
    name: string,
    type: LayerType,
    layer: BaseLayer,
    metadata?: Record<string, any>
  ): void {
    if (!this.map) {
      console.warn('Cannot add layer: map is not initialized');
      return;
    }

    // Get current visibility and opacity from the layer
    const visible = layer.getVisible() !== false;
    const opacity = layer.getOpacity() !== undefined ? layer.getOpacity() : 1;
    const zIndex = layer.getZIndex() !== undefined ? (layer.getZIndex() as number) : 0;

    const managedLayer: ManagedLayer = {
      id,
      name,
      type,
      layer,
      visible,
      opacity,
      zIndex,
      metadata,
    };

    this.layers.set(id, managedLayer);
    
    // Ensure layer is added to map if not already
    if (!this.map.getLayers().getArray().includes(layer)) {
      this.map.addLayer(layer);
    }

    // Sync layer properties
    this.syncLayerProperties(id);
  }

  /**
   * Remove a layer from the manager and map
   */
  removeLayer(id: string): boolean {
    const managedLayer = this.layers.get(id);
    if (!managedLayer) {
      return false;
    }

    if (this.map) {
      this.map.removeLayer(managedLayer.layer);
    }

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
   * Sync layer properties from the actual OpenLayers layer
   */
  syncLayerProperties(id: string): void {
    const managedLayer = this.layers.get(id);
    if (!managedLayer) {
      return;
    }

    managedLayer.visible = managedLayer.layer.getVisible() !== false;
    const layerOpacity = managedLayer.layer.getOpacity();
    managedLayer.opacity = layerOpacity !== undefined ? layerOpacity : 1;
    const layerZIndex = managedLayer.layer.getZIndex();
    managedLayer.zIndex = layerZIndex !== undefined ? (layerZIndex as number) : 0;
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
    if (this.map) {
      this.layers.forEach((managedLayer: ManagedLayer) => {
        this.map!.removeLayer(managedLayer.layer);
      });
    }
    this.layers.clear();
  }

  /**
   * Get layer count
   */
  getCount(): number {
    return this.layers.size;
  }

  /**
   * Get layer extent for zooming/fitting
   * Returns extent in EPSG:3857 (Web Mercator) coordinates
   */
  getLayerExtent(id: string): number[] | null {
    const managedLayer = this.layers.get(id);
    if (!managedLayer || !this.map) {
      return null;
    }

    const layer = managedLayer.layer;
    
    // First, try to get extent from metadata (most reliable)
    if (managedLayer.metadata) {
      const metadata = managedLayer.metadata;
      // Check for extent (already in Web Mercator)
      if (metadata.extent && Array.isArray(metadata.extent) && metadata.extent.length === 4) {
        const extent = metadata.extent;
        if (extent.every((val: number) => isFinite(val) && !isNaN(val))) {
          return extent;
        }
      }
      // Check for bbox (may be in EPSG:4326, needs transformation)
      if (metadata.bbox && Array.isArray(metadata.bbox) && metadata.bbox.length === 4) {
        const bbox = metadata.bbox;
        // Check if it's in lat/lon (EPSG:4326) or already in Web Mercator
        const isLatLon = Math.abs(bbox[0]) <= 180 && Math.abs(bbox[1]) <= 90;
        if (isLatLon) {
          // Transform from EPSG:4326 to EPSG:3857
          try {
            const transformed = transformExtent(bbox, 'EPSG:4326', 'EPSG:3857');
            if (transformed && transformed.every((val: number) => isFinite(val) && !isNaN(val))) {
              return transformed;
            }
          } catch (e) {
            console.warn('Could not transform bbox:', e);
          }
        } else {
          // Assume it's already in Web Mercator
          if (bbox.every((val: number) => isFinite(val) && !isNaN(val))) {
            return bbox;
          }
        }
      }
    }
    
    // Try to get extent from layer directly
    try {
      const layerExtent = layer.getExtent();
      if (layerExtent && layerExtent.length === 4) {
        if (layerExtent.every((val: number) => isFinite(val) && !isNaN(val))) {
          return layerExtent;
        }
      }
    } catch (e) {
      // Ignore errors
    }

    // For Vector layers, try to get extent from source
    try {
      const source = (layer as any).getSource?.();
      if (source && typeof source.getExtent === 'function') {
        const sourceExtent = source.getExtent();
        if (sourceExtent && sourceExtent.length === 4) {
          if (sourceExtent.every((val: number) => isFinite(val) && !isNaN(val))) {
            return sourceExtent;
          }
        }
      }
    } catch (e) {
      // Ignore errors
    }

    return null;
  }

  /**
   * Get the actual OpenLayers layer instance
   */
  getOpenLayersLayer(id: string): BaseLayer | null {
    const managedLayer = this.layers.get(id);
    return managedLayer ? managedLayer.layer : null;
  }
}

