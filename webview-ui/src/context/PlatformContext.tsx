import React, { createContext, useContext } from 'react';

interface PlatformContextValue {
  /** 是否在 VSCode 独立窗口中打开 */
  isStandalone: boolean;
  /** 是否显示 Navbar（独立窗口可能不需要） */
  showNavbar: boolean;
}

const PlatformContext = createContext<PlatformContextValue>({
  isStandalone: false,
  showNavbar: true,
});

export function PlatformProvider({ children }: { children: React.ReactNode }) {
  // 通过 VSCode API 获取窗口模式
  // VSCode 在独立窗口中设置 data-vscode-webview-type 属性
  const isStandalone = document.body.dataset.vscodeWebviewType === 'default';
  // 独立窗口隐藏 Navbar（由 VSCode 自带导航）
  const showNavbar = !isStandalone;

  return (
    <PlatformContext.Provider value={{ isStandalone, showNavbar }}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform(): PlatformContextValue {
  return useContext(PlatformContext);
}
