import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Landing from './Landing';

// Like the story entry, and for the same reason: no 'ol/ol.css', no MUI, no
// index.css. The landing page must not carry the map's bundle — the map is one
// click away at explore.html, and paying for it here would defeat the point.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
