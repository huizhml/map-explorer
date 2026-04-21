import { apiUrl } from './apiBase';

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
  source?: string;
  fhd?: number | null;
  enl1d?: number | null;
  enl2d?: number | null;
  cr?: number | null;
};

/** Vertical profile uses original COGs for 2020; remote year uses blended URL layout. */
export async function fetchVerticalProfile(
  lon: number,
  lat: number,
  year: number,
): Promise<VerticalProfileResponse> {
  const res = await fetch(apiUrl('/predictions/vertical-profile'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lon,
      lat,
      year,
      source: year === 2020 ? 'original' : 'blended',
      q_index: 1,
    }),
  });
  const data = (await res.json()) as VerticalProfileResponse;
  if (!res.ok && !data.error) {
    return { success: false, error: `HTTP ${res.status}` };
  }
  return data;
}
