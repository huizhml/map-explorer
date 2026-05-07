import { apiUrl } from '../utils/apiBase';

export type SavedFeatureGeometryType = 'Point' | 'LineString' | 'Polygon';

export type SavedFeatureGeometry = {
  type: SavedFeatureGeometryType;
  coordinates: [number, number] | [number, number][] | [number, number][][];
};

export type SavedFeatureMetadata = {
  source?: string;
  tile_name?: string;
  year?: number;
  q_index?: number;
  sample_count?: number;
  total_length_m?: number;
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
