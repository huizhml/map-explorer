import type { CubeMeta } from './cubeData';
import type { CameraState } from './CubeScene';
import type { CubeView } from './CubePanel';
import type { GroundSource } from './groundImagery';

/**
 * Everything a saved page needs, embedded in the HTML as JSON
 * (<script id="vsm-snapshot">). Written by exportPage.ts, read by standalone.tsx.
 */
export type PageSnapshot = {
  version: 1;
  /** ISO time the page was saved. */
  created: string;
  place: string | null;
  /** The pin, i.e. the pixel the profile shows. */
  lon: number;
  lat: number;
  meta: CubeMeta;
  /** base64 of gzip(int16 LE [rh][row][col]) — the cube exactly as the backend sent it. */
  raw: string;
  probe: { row: number; col: number } | null;
  view: CubeView | null;
  camera: CameraState | null;
  /** Every ground image saved with the page (Sentinel-2 and Esri when both loaded). */
  grounds: SavedGround[];
  /** The one under the cube when the page was saved. */
  groundChoice: GroundSource;
  ymax: number;
  rhIndexes: number[];
  /** Link back to the live explorer at the same place and view. */
  explorerUrl: string | null;
};

export type SavedGround = {
  source: Exclude<GroundSource, 'off'>;
  /** JPEG data URL. */
  image: string;
  credit: string;
  note?: string;
  date?: string;
};

export async function gzipBase64(bytes: Uint8Array): Promise<string> {
  const zipped = new Uint8Array(
    await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
  );
  let s = '';
  for (let i = 0; i < zipped.length; i += 0x8000) s += String.fromCharCode(...zipped.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function gunzipBase64(b64: string): Promise<ArrayBuffer> {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
