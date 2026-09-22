/**
 * 主题变量兜底（Webview 宿主未注入 --vscode-* 时的降级方案）
 *
 * 背景：webview 的全部配色依赖宿主注入的 --vscode-* 变量。当 UI 不在 VS Code
 * webview 中运行（浏览器内预览/调试）或宿主未注入时，CSS 里为深色主题写的
 * fallback 会与浏览器默认黑字组合成"黑底黑字"（弹窗完全不可读）。
 *
 * 策略：
 * 1. 启动时探测 --vscode-editor-background 是否可用；宿主已注入 → 直接返回（VS Code 正常场景零改动）
 * 2. 缺失 → 按系统深浅色偏好注入一套最小可用主题变量（覆盖背景/前景/输入/按钮/列表/徽标等）
 * 3. 1s 后复查：宿主若已接管主题（出现真实变量）→ 撤销自注入值；
 *    系统深浅色切换时若无宿主主题 → 以新配色重建兜底
 */

const LIGHT_THEME: Record<string, string> = {
  '--vscode-editor-background': '#ffffff',
  '--vscode-editor-foreground': '#1f1f1f',
  '--vscode-foreground': '#1f1f1f',
  '--vscode-descriptionForeground': '#616161',
  '--vscode-sidebar-background': '#f5f5f5',
  '--vscode-panel-border': '#d4d4d4',
  '--vscode-widget-border': '#d4d4d4',
  '--vscode-editorWidget-background': '#ffffff',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-foreground': '#1f1f1f',
  '--vscode-input-border': '#cecece',
  '--vscode-input-placeholderForeground': '#767676',
  '--vscode-button-background': '#005fb8',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-button-hoverBackground': '#0258a8',
  '--vscode-button-secondaryBackground': '#e5e5e5',
  '--vscode-button-secondaryForeground': '#1f1f1f',
  '--vscode-button-secondaryHoverBackground': '#cccccc',
  '--vscode-textLink-foreground': '#005fb8',
  '--vscode-textBlockQuote-background': '#f2f2f2',
  '--vscode-textCodeBlock-background': '#f2f2f2',
  '--vscode-badge-background': '#c4c4c4',
  '--vscode-badge-foreground': '#333333',
  '--vscode-list-hoverBackground': '#f2f2f2',
  '--vscode-list-activeSelectionBackground': '#0060c0',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-focusBorder': '#005fb8',
  '--vscode-errorForeground': '#b5200d',
  '--vscode-editorInfo-background': 'rgba(0, 120, 212, 0.08)',
  '--vscode-progressBar-background': '#005fb8',
  '--vscode-scrollbarSlider-background': 'rgba(100, 100, 100, 0.4)',
  '--vscode-toolbar-hoverBackground': 'rgba(0, 0, 0, 0.06)',
  '--vscode-dropdown-background': '#ffffff',
  '--vscode-dropdown-foreground': '#1f1f1f',
  '--vscode-dropdown-border': '#cecece',
  '--vscode-menu-background': '#ffffff',
  '--vscode-menu-foreground': '#1f1f1f',
  '--vscode-menu-border': '#d4d4d4',
  '--vscode-menu-selectionBackground': '#0060c0',
  '--vscode-menu-separatorBackground': '#d4d4d4',
  '--vscode-statusBar-background': '#f8f8f8',
  '--vscode-statusBar-foreground': '#1f1f1f',
  '--vscode-settings-headerForeground': '#1f1f1f',
  '--vscode-inputValidation-errorBorder': '#b5200d',
  '--vscode-inputValidation-errorBackground': 'rgba(181, 32, 13, 0.1)',
  '--vscode-testing-iconPassed': '#388a34',
  '--vscode-testing-iconFailed': '#cd3131',
  '--vscode-testing-iconErrored': '#cd3131',
  '--vscode-testing-iconActionRetry': '#005fb8',
  '--vscode-terminal-ansiRed': '#cd3131',
  '--vscode-terminal-ansiGreen': '#00bc00',
  '--vscode-terminal-ansiYellow': '#949800',
  '--vscode-terminal-ansiBrightCyan': '#29b8db',
  '--vscode-editor-font-family': "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  '--vscode-font-family': "-apple-system, 'Segoe UI', 'Ubuntu', 'Helvetica Neue', sans-serif",
  '--vscode-font-size': '13px',
};

const DARK_THEME: Record<string, string> = {
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-sidebar-background': '#181818',
  '--vscode-panel-border': '#313131',
  '--vscode-widget-border': '#313131',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-input-placeholderForeground': '#989898',
  '--vscode-button-background': '#0078d4',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-button-hoverBackground': '#026ec1',
  '--vscode-button-secondaryBackground': '#313131',
  '--vscode-button-secondaryForeground': '#cccccc',
  '--vscode-button-secondaryHoverBackground': '#3c3c3c',
  '--vscode-textLink-foreground': '#4daafc',
  '--vscode-textBlockQuote-background': '#202020',
  '--vscode-textCodeBlock-background': '#202020',
  '--vscode-badge-background': '#616161',
  '--vscode-badge-foreground': '#f8f8f8',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-list-activeSelectionBackground': '#04395e',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-errorForeground': '#f85149',
  '--vscode-editorInfo-background': 'rgba(0, 120, 212, 0.15)',
  '--vscode-progressBar-background': '#0078d4',
  '--vscode-scrollbarSlider-background': 'rgba(121, 121, 121, 0.4)',
  '--vscode-toolbar-hoverBackground': 'rgba(90, 93, 94, 0.31)',
  '--vscode-dropdown-background': '#313131',
  '--vscode-dropdown-foreground': '#cccccc',
  '--vscode-dropdown-border': '#3c3c3c',
  '--vscode-menu-background': '#1f1f1f',
  '--vscode-menu-foreground': '#cccccc',
  '--vscode-menu-border': '#454545',
  '--vscode-menu-selectionBackground': '#0078d4',
  '--vscode-menu-separatorBackground': '#454545',
  '--vscode-statusBar-background': '#181818',
  '--vscode-statusBar-foreground': '#cccccc',
  '--vscode-settings-headerForeground': '#ffffff',
  '--vscode-inputValidation-errorBorder': '#f85149',
  '--vscode-inputValidation-errorBackground': 'rgba(248, 81, 73, 0.1)',
  '--vscode-testing-iconPassed': '#73c991',
  '--vscode-testing-iconFailed': '#f14c4c',
  '--vscode-testing-iconErrored': '#f14c4c',
  '--vscode-testing-iconActionRetry': '#4daafc',
  '--vscode-terminal-ansiRed': '#f14c4c',
  '--vscode-terminal-ansiGreen': '#23d81b',
  '--vscode-terminal-ansiYellow': '#e5e510',
  '--vscode-terminal-ansiBrightCyan': '#9aedfe',
  '--vscode-editor-font-family': "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  '--vscode-font-family': "-apple-system, 'Segoe UI', 'Ubuntu', 'Helvetica Neue', sans-serif",
  '--vscode-font-size': '13px',
};

/** 已自注入的变量名（用于撤销/重建兜底） */
let applied: string[] = [];

function prefersDark(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

function applyFallback(): void {
  const root = document.documentElement;
  applied = [];
  for (const [name, value] of Object.entries(prefersDark() ? DARK_THEME : LIGHT_THEME)) {
    root.style.setProperty(name, value);
    applied.push(name);
  }
}

function removeFallback(): void {
  const root = document.documentElement;
  for (const name of applied) root.style.removeProperty(name);
  applied = [];
}

/** 宿主是否注入了主题变量（读取时临时移除自注入值，避免误判） */
function hostProvidesTheme(): boolean {
  const root = document.documentElement;
  const hadFallback = applied.length > 0;
  if (hadFallback) removeFallback();
  const provided =
    getComputedStyle(root).getPropertyValue('--vscode-editor-background').trim().length > 0;
  if (!provided && hadFallback) applyFallback();
  return provided;
}

export function ensureThemeVariables(): void {
  // VS Code 正常场景：宿主已注入 --vscode-* → 零改动
  if (hostProvidesTheme()) return;

  applyFallback();

  // 宿主可能在稍后接管主题 → 出现真实变量时撤销兜底
  window.setTimeout(() => {
    if (hostProvidesTheme()) removeFallback();
  }, 1000);

  // 系统深浅色切换：仅当我们仍在兜底时同步重建
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  mq?.addEventListener?.('change', () => {
    if (applied.length === 0) return;
    removeFallback();
    applyFallback();
  });
}
