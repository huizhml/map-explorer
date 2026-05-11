import { apiUrl } from './apiBase';
import { DEFAULT_DIVERSITY_HEIGHT_BIN_M } from '../constants/diversityMetrics';
import { DEFAULT_VSM_VERSION, type VsmVersion } from '../constants/predictions';

export type VerticalProfileResponse = {
  success: boolean;
  error?: string;
  tile_name?: string;
  year?: number;
  q_index?: number;
  lon?: number;
  lat?: number;
  profile?: Array<{ rh: number; value: number | null; missing?: boolean }>;
  vertical_profile_curve?: Array<{ z: number; value: number }>;
  version?: VsmVersion;
  fhd?: number | null;
  enl1d?: number | null;
  enl2d?: number | null;
  cr?: number | null;
  max_height?: number;
  /** Y-axis top (m) for transect RH heatmap; diversity uses `max_height`. */
  heatmap_max_height?: number;
  fhd_interval?: number;
};

export type VerticalProfileLineSample = {
  index: number;
  distance_m: number;
  lon: number;
  lat: number;
  vertical_profile_curve?: Array<{ z: number; value: number }>;
  fhd?: number | null;
  enl1d?: number | null;
  enl2d?: number | null;
  cr?: number | null;
  tile_name?: string;
};

export type VerticalProfileLineResponse = {
  success: boolean;
  error?: string;
  year?: number;
  version?: VsmVersion;
  q_index?: number;
  sample_count?: number;
  total_length_m?: number;
  line_coordinates?: Array<[number, number]>;
  rh_profile?: Array<Array<number | null>>;
  vertical_profile?: Array<Array<number | null>>;
  samples?: VerticalProfileLineSample[];
  max_height?: number;
  heatmap_max_height?: number;
  fhd_interval?: number;
};

/**
 * Vertical profile is only versioned for year==2020 (the only year with on-disk
 * original/blended/masked tiles). For other years the backend ignores `version`.
 */
export async function fetchVerticalProfile(
  lon: number,
  lat: number,
  year: number,
  fhdInterval: number = DEFAULT_DIVERSITY_HEIGHT_BIN_M,
  version: VsmVersion = DEFAULT_VSM_VERSION,
): Promise<VerticalProfileResponse> {
  const res = await fetch(apiUrl('/predictions/vertical-profile'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lon,
      lat,
      year,
      version,
      q_index: 1,
      fhd_interval: fhdInterval,
    }),
  });
  const data = (await res.json()) as VerticalProfileResponse;
  if (!res.ok && !data.error) {
    return { success: false, error: `HTTP ${res.status}` };
  }
  return data;
}

export async function fetchVerticalProfileLine(
  lineCoordinates: Array<[number, number]>,
  year: number,
  fhdInterval: number = DEFAULT_DIVERSITY_HEIGHT_BIN_M,
  version: VsmVersion = DEFAULT_VSM_VERSION,
): Promise<VerticalProfileLineResponse> {
  const body: {
    line_coordinates: Array<[number, number]>;
    year: number;
    version: VsmVersion;
    q_index: number;
    fhd_interval: number;
  } = {
    line_coordinates: lineCoordinates,
    year,
    version,
    q_index: 1,
    fhd_interval: fhdInterval,
  };

  const res = await fetch(apiUrl('/predictions/vertical-profile-line'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as VerticalProfileLineResponse;
  if (!res.ok && !data.error) {
    return { success: false, error: `HTTP ${res.status}` };
  }
  return data;
}
