const DEFAULT_API_BASE_URL = 'http://localhost:8006';

const configuredBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();

export const API_BASE_URL = (configuredBase && configuredBase.length > 0
  ? configuredBase
  : DEFAULT_API_BASE_URL
).replace(/\/+$/, '');

export const API_V1_BASE_URL = `${API_BASE_URL}/api/v1`;

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}
