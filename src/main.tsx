import React from 'react';
import { createRoot } from 'react-dom/client';
import { applyRememberedTheme } from './lib/theme';
import App from './ui/App';
import './ui/styles.css';

// Paint in the colours (and light / dark mode) chosen last time before React draws anything.
applyRememberedTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
