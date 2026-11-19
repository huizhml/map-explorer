import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Docs from './Docs';

// Its own entry, like the landing page: no map bundle, no MUI, no index.css.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Docs />
  </StrictMode>,
);
