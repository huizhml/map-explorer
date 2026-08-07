import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Story from './Story';

// No 'ol/ol.css', no MUI, no index.css — the story entry deliberately imports
// nothing from the map app, so its bundle stays small.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Story />
  </StrictMode>,
);
