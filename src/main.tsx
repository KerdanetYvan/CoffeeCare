import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from "react-router-dom";

import './index.css';
import App from './App.tsx';
import { installTauriApi } from './lib/tauriApi';

installTauriApi();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)
