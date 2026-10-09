import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../map/maplibreWorker';
import SimpleApp from './SimpleApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SimpleApp />
  </StrictMode>,
);
