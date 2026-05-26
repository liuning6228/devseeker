import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ExtensionStateProvider } from './context/ExtensionStateContext.js';
import './styles/main.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in webview index.html');
}

createRoot(container).render(
  <StrictMode>
    <ExtensionStateProvider>
      <App />
    </ExtensionStateProvider>
  </StrictMode>,
);
