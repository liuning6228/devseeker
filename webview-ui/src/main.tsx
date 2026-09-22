import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ExtensionStateProvider } from './context/ExtensionStateContext.js';
import { ensureThemeVariables } from './lib/theme-fallback.js';
import './styles/main.css';

// 宿主未注入 --vscode-*（浏览器预览/宿主异常）时注入兜底主题，避免"黑底黑字"
ensureThemeVariables();

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
