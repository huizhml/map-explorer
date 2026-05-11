import { apiUrl } from '../utils/apiBase';

export type SavedFeatureGeometryType = 'Point' | 'LineString' | 'Polygon';

export type SavedFeatureGeometry = {
  type: SavedFeatureGeometryType;
  coordinates: [number, number] | [number, number][] | [number, number][][];
};

export type SavedFeatureMetadata = {
  /** Origin descriptor for the saved feature (e.g. "feature_popup", "area_images"). */
  source?: string;
  /** Prediction pipeline version ("original" | "blended" | "masked"). */
  version?: string;
  tile_name?: string;
  year?: number;
  q_index?: number;
  sample_count?: number;
  total_length_m?: number;
  feature_properties?: Record<string, unknown>;
  satellite_snapshot_status?: string;
  satellite_snapshot_error?: string;
  prediction_snapshot_status?: string;
  prediction_snapshot_error?: string;
  tags?: string[];
  sentinel2_layers?: Array<{
    id?: string;
    name?: string;
    url: string;
    tile_name?: string;
    datetime?: string;
    rgb_bands?: number[];
    rescale_min?: number;
    rescale_max?: number;
  }>;
};

export type SavedFeaturePlotData = {
  image_exports?: Array<{
    layer_id?: string;
    layer_name?: string;
    band_name?: string;
    filename: string;
    relative_path?: string;
    url?: string;
    format?: string;
    mime_type?: string;
  }>;
  image_session_dir?: string;
  layers?: Array<{
    id: string;
    name: string;
    type: string;
    visible: boolean;
    value?: unknown;
    error?: string;
  }>;
  vertical_profile?: Array<{ rh: number; value: number | null; missing?: boolean }>;
  vertical_profile_curve?: Array<{ z: number; value: number }>;
  profile_metrics?: {
    fhd?: number | null;
    enl1d?: number | null;
    enl2d?: number | null;
    cr?: number | null;
  };
  transect?: {
    sample_count?: number;
    total_length_m?: number;
    max_height?: number;
    heatmap_max_height?: number;
    line_coordinates?: Array<[number, number]>;
    samples?: Array<{
      index: number;
      distance_m: number;
      lon: number;
      lat: number;
      profile: Array<{ rh: number; value: number | null; missing?: boolean }>;
      vertical_profile_curve?: Array<{ z: number; value: number }>;
      fhd?: number | null;
      enl1d?: number | null;
      enl2d?: number | null;
      cr?: number | null;
      tile_name?: string;
    }>;
  };
};

export type SavedFeatureDraft = {
  geometry: SavedFeatureGeometry;
  metadata?: SavedFeatureMetadata;
  plot_data?: SavedFeaturePlotData;
};

export type SavedFeature = {
  id: number;
  name: string;
  description: string | null;
  category: string | null;
  geometry: SavedFeatureGeometry;
  metadata?: SavedFeatureMetadata | null;
  plot_data?: SavedFeaturePlotData | null;
  created_at: string;
};

export async function listSavedFeatures(): Promise<SavedFeature[]> {
  const response = await fetch(apiUrl('/saved-features'));
  if (!response.ok) {
    throw new Error(`Failed to load saved features (${response.status})`);
  }
  const data = (await response.json()) as { features?: SavedFeature[] };
  return Array.isArray(data.features) ? data.features : [];
}

export async function createSavedFeature(input: {
  name: string;
  description?: string;
  category?: string;
  geometry: SavedFeatureGeometry;
  metadata?: SavedFeatureMetadata;
  plot_data?: SavedFeaturePlotData;
}): Promise<SavedFeature> {
  const response = await fetch(apiUrl('/saved-features'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to save feature (${response.status})`);
  }
  const data = (await response.json()) as { feature?: SavedFeature };
  if (!data.feature) {
    throw new Error('API did not return saved feature');
  }
  return data.feature;
}

export async function deleteSavedFeature(id: number): Promise<void> {
  const response = await fetch(apiUrl(`/saved-features/${id}`), {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(`Failed to delete feature (${response.status})`);
  }
}

export async function updateSavedFeature(
  id: number,
  input: { name?: string; description?: string; tags?: string[] },
): Promise<SavedFeature> {
  const response = await fetch(apiUrl(`/saved-features/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to update feature (${response.status})`);
  }
  const data = (await response.json()) as { feature?: SavedFeature };
  if (!data.feature) {
    throw new Error('API did not return updated feature');
  }
  return data.feature;
}

/** Re-render the RH98 prediction snapshot for a saved Point feature.
 *  Optional `viz` overrides the rescale/colormap (defaults to the saved
 *  visualization, then the live-map defaults 0..500/inferno).
 *  Returns the refreshed feature; throws on transport errors. A successful
 *  response can still indicate the snapshot itself was unavailable —
 *  callers should check `feature.metadata?.prediction_snapshot_status`.
 */
export async function refreshPredictionSnapshot(
  id: number,
  viz?: {
    rescale_min?: number;
    rescale_max?: number;
    colormap?: string;
    year?: number;
    q_index?: number;
    version?: string;
  },
): Promise<SavedFeature> {
  const response = await fetch(apiUrl(`/saved-features/${id}/refresh-prediction-snapshot`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(viz ?? {}),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to refresh prediction snapshot (${response.status})`);
  }
  const data = (await response.json()) as { feature?: SavedFeature };
  if (!data.feature) {
    throw new Error('API did not return refreshed feature');
  }
  return data.feature;
}
