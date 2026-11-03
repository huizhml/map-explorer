import viewerJs from 'virtual:cube-viewer-bundle';
import exploreCss from '../explore.css?raw';
import type { Cube } from './cubeData';
import type { Ground, GroundSource } from './groundImagery';
import { gzipBase64, type PageSnapshot, type SavedGround } from './pageSnapshot';

/**
 * "Save as page": one self-contained HTML file with the cube, the ground image,
 * the profile and the 3D viewer (three.js included). Opens without the backend
 * or a network connection, so it can be mailed or put on any static host.
 *
 * Loaded on demand: the viewer bundle (`virtual:cube-viewer-bundle`, built by
 * the plugin in vite.config.ts) is ~1 MB of script text.
 */

type Input = Omit<PageSnapshot, 'version' | 'created' | 'raw' | 'grounds' | 'meta'> & {
  cube: Cube;
  grounds: Partial<Record<Exclude<GroundSource, 'off'>, Ground>>;
};

function imageToDataUrl(img: CanvasImageSource & { width: number; height: number }): string {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.88);
}

/** Text that cannot end the <script> element it sits in. JSON: every "<" as \u003c (still valid JSON). */
const jsonSafe = (s: string) => s.replace(/</g, '\\u003c');
/** Script: "</script" only appears inside string literals, where "<\/" means the same. */
const jsSafe = (s: string) => s.replace(/<\/(script)/gi, '<\\/$1');

export async function exportCubePage(input: Input): Promise<void> {
  const { cube, grounds, ...rest } = input;
  const raw = new Uint8Array(cube.raw.buffer, cube.raw.byteOffset, cube.raw.byteLength);
  const snapshot: PageSnapshot = {
    ...rest,
    version: 1,
    created: new Date().toISOString(),
    meta: cube.meta,
    raw: await gzipBase64(raw),
    grounds: (Object.entries(grounds) as [SavedGround['source'], Ground][]).map(([source, g]) => ({
      source,
      image: imageToDataUrl(g.image),
      credit: g.credit,
      note: g.note,
      date: g.date,
    })),
  };

  const title = `VSM datacube · ${rest.place ?? `${rest.lat.toFixed(4)}, ${rest.lon.toFixed(4)}`}`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</title>
<style>${exploreCss}
/* explore.css locks the page for the full-screen map; this page scrolls to the profiles under the cube. */
html, body { overflow: auto; }
</style>
</head>
<body>
<div id="root"></div>
<script id="vsm-snapshot" type="application/json">${jsonSafe(JSON.stringify(snapshot))}</script>
<script>${jsSafe(viewerJs)}</script>
</body>
</html>
`;
  const name = `vsm-cube_${cube.meta.tile}_${rest.lat.toFixed(5)}_${rest.lon.toFixed(5)}.html`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
