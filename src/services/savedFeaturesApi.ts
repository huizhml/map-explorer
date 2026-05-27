import { apiUrl } from '../utils/apiBase';
import type { VerticalProfileCurvePoint } from '../stores/mapStore';

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
    preview_filename?: string;
    preview_relative_path?: string;
    preview_url?: string;
    preview_mime_type?: string;
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
  vertical_profile_curve?: VerticalProfileCurvePoint[];
  /** Fixed vertical-profile-curve y-axis bounds (m); curve is trimmed to data extent. */
  profile_y_min?: number;
  profile_y_max?: number;
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
      vertical_profile_curve?: VerticalProfileCurvePoint[];
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
  /** Stable hash of the geometry alone. Used to prefill the save dialog when
   *  the user revisits a previously-saved area/point. */
  geom_uid?: string | null;
  /** Stable hash of (geometry, name, category). Same triple → same uid even
   *  across re-saves. */
  feature_uid?: string | null;
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
  tags?: string[];
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

/** All distinct tags seen across saved features (case-insensitive dedupe,
 *  first-seen casing preserved). Used by the save dialog's tag autocomplete.
 */
export async function listSavedFeatureTags(): Promise<string[]> {
  const response = await fetch(apiUrl('/saved-features/tags'));
  if (!response.ok) {
    throw new Error(`Failed to load tag list (${response.status})`);
  }
  const data = (await response.json()) as { tags?: string[] };
  return Array.isArray(data.tags) ? data.tags : [];
}

/** Look up the most-recent saved feature with the same geometry (geom_uid).
 *  Used to prefill name / category / description / tags so the user doesn't
 *  retype them when saving the same area or popup again. Returns `null` when
 *  there's no prior save for this geometry.
 */
export async function lookupSavedFeatureByGeometry(
  geometry: SavedFeatureGeometry,
): Promise<{ geom_uid: string; feature: SavedFeature | null }> {
  const response = await fetch(apiUrl('/saved-features/lookup-by-geometry'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ geometry }),
  });
  if (!response.ok) {
    throw new Error(`Failed to look up feature by geometry (${response.status})`);
  }
  const data = (await response.json()) as { geom_uid?: string; feature?: SavedFeature | null };
  return {
    geom_uid: typeof data.geom_uid === 'string' ? data.geom_uid : '',
    feature: data.feature ?? null,
  };
}

/** Layer descriptor used by the area-images endpoints; mirrors the backend's
 *  `FigureLayerSpec`. Includes whatever visualization params the caller wants
 *  to render with (colormap / rescale / per-band overrides). */
export type AreaImageLayerSpec = {
  layer_id: string;
  name: string;
  layer_type?: string;
  layer_subtype?: string;
  url: string;
  rgb_bands?: number[];
  colormap?: string;
  rescale_min?: number;
  rescale_max?: number;
  year?: number;
  /** Burn a metric scale bar into the rendered image. Currently honoured only
   *  by EOX s2cloudless mosaic layers; other layer types ignore it. */
  include_scale_bar?: boolean;
  bands?: Array<{
    band_index: number;
    band_name?: string;
    colormap?: string;
    rescale_min?: number;
    rescale_max?: number;
  }>;
};

/** Re-render every image attached to a saved area_images polygon feature.
 *  By default the backend reproduces the original export from the layer specs
 *  persisted at save time (same visualization parameters). All request fields
 *  are optional overrides for that stored state. */
export async function refreshAreaImages(
  id: number,
  request: {
    layers?: AreaImageLayerSpec[];
    format?: 'png' | 'jpg' | 'pdf';
    include_google_satellite?: boolean;
    google_satellite_max_width_px?: number;
    include_google_satellite_scale_bar?: boolean;
    extent_3857?: number[];
    /** Crop the polygon to a square on its shortest side and rewrite the
     *  saved geometry to match before re-rendering. */
    square?: boolean;
  } = {},
): Promise<{ feature: SavedFeature; errors: Array<{ layer_id?: string; name?: string; error?: string }> }> {
  const response = await fetch(apiUrl(`/saved-features/${id}/refresh-area-images`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to refresh area images (${response.status})`);
  }
  const data = (await response.json()) as { feature?: SavedFeature; errors?: Array<{ layer_id?: string; name?: string; error?: string }> };
  if (!data.feature) {
    throw new Error('API did not return refreshed feature');
  }
  return { feature: data.feature, errors: Array.isArray(data.errors) ? data.errors : [] };
}

/** Re-render exactly one layer attached to a saved area_images polygon with
 *  new visualization parameters (rescale/colormap/decorations). Other images
 *  on the feature are left untouched, and the override is persisted back to
 *  the stored layer_specs so a later full refresh reproduces it. */
export async function refreshAreaImageLayer(
  id: number,
  patch: {
    layer_id: string;
    rescale_min?: number;
    rescale_max?: number;
    colormap?: string;
    include_colorbar?: boolean;
    include_scale_bar?: boolean;
  },
): Promise<{ feature: SavedFeature; errors: Array<{ layer_id?: string; name?: string; error?: string }> }> {
  const response = await fetch(apiUrl(`/saved-features/${id}/refresh-area-image-layer`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to update image layer (${response.status})`);
  }
  const data = (await response.json()) as { feature?: SavedFeature; errors?: Array<{ layer_id?: string; name?: string; error?: string }> };
  if (!data.feature) {
    throw new Error('API did not return updated feature');
  }
  return { feature: data.feature, errors: Array.isArray(data.errors) ? data.errors : [] };
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
