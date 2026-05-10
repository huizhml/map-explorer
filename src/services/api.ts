import { API_V1_BASE_URL } from '../utils/apiBase';

export interface BandCombination {
    bands: string[];
    min?: number;
    max?: number;
}

export interface DateRange {
    start_date: string;
    end_date: string;
}

export interface Region {
    type: string;
    coordinates: number[][][];
}

class ApiService {
    private token: string | null = null;

    setToken(token: string) {
        this.token = token;
    }

    private async request(endpoint: string, options: RequestInit = {}) {
        const headers = {
            'Content-Type': 'application/json',
            ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {}),
            ...options.headers,
        };

        const response = await fetch(`${API_V1_BASE_URL}${endpoint}`, {
            ...options,
            headers,
        });

        if (!response.ok) {
            let detail = response.statusText;
            try {
                const j = await response.json();
                if (j?.detail !== undefined) {
                    detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
                }
            } catch {
                /* ignore */
            }
            throw new Error(`API request failed (${response.status}): ${detail}`);
        }

        return response.json();
    }

    async getSentinel2Tiles(bandCombination: BandCombination) {
        return this.request('/sentinel2/tiles', {
            method: 'POST',
            body: JSON.stringify(bandCombination),
        });
    }

    async getSentinel2Timeseries(dateRange: DateRange, region: Region) {
        return this.request('/sentinel2/timeseries', {
            method: 'POST',
            body: JSON.stringify({ ...dateRange, region }),
        });
    }

    async getAvailableBands() {
        return this.request('/sentinel2/available-bands');
    }

    async getRegionStatistics(dateRange: DateRange, region: Region, bands: string[]) {
        return this.request('/sentinel2/statistics', {
            method: 'POST',
            body: JSON.stringify({ ...dateRange, region, bands }),
        });
    }

    async getRHTileUrl(rh: number): Promise<{ tile_url: string }> {
        return this.request(`/rh/${rh}/tile-url`);
    }

    async getAvailableRh(): Promise<{ available: number[] }> {
        return this.request('/rh/available');
    }

    async getXarrayTileUrl(params: {
        url: string;
        variable: string;
        lon?: string;
        lat?: string;
        rescale?: string;
        colormap_name?: string;
    }): Promise<{ tile_url: string }> {
        const search = new URLSearchParams();
        search.set('url', params.url);
        search.set('variable', params.variable);
        if (params.lon) search.set('lon', params.lon);
        if (params.lat) search.set('lat', params.lat);
        if (params.rescale) search.set('rescale', params.rescale);
        if (params.colormap_name) search.set('colormap_name', params.colormap_name);
        return this.request(`/xarray/tile-url?${search.toString()}`);
    }

    async getEarthEngineStatus(): Promise<{
        ee_import_ok: boolean;
        credentials_path_set: boolean;
        credentials_file_exists: boolean;
    }> {
        return this.request('/earthengine/status');
    }

    async getEarthEngineTileUrl(body: {
        asset_id: string;
        asset_kind?: 'image' | 'image_collection';
        reduce_collection?: 'mosaic' | 'median' | 'first';
        band?: string;
        mask_self?: boolean;
        vis?: { min?: number; max?: number; palette?: string[] };
    }): Promise<{ tile_url: string; asset_id: string; band?: string | null }> {
        return this.request('/earthengine/tile-url', {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }
}

export const apiService = new ApiService(); 