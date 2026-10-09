import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

/**
 * Where MapLibre's worker is.
 *
 * MapLibre 6 finds it at run time, next to its own module
 * (`new URL('./maplibre-gl-worker.mjs', import.meta.url)`). Vite cannot see a
 * dependency made of a string built at run time, so neither the dev server's
 * pre-bundle nor the production build carries the worker along, and the map
 * fails with "Worker failed to load". Importing it here makes it an asset Vite
 * knows about; the map is then told its URL.
 *
 * Imported once, by each page's entry module, before any map is created.
 */
setWorkerUrl(workerUrl);
