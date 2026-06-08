/**
 * 安全获取 VS Code Webview API（防重复调用）。
 *
 * `acquireVsCodeApi()` 在每个 webview 生命周期内只允许调用一次。
 * React StrictMode 的二次挂载、或多个组件各自调用，都会触发
 * "An instance of the VS Code API has already been acquired" 报错导致白屏。
 *
 * 本模块统一使用 window 缓存确保全局只调一次 acquireVsCodeApi()。
 */
import type { WebviewInboundMessage } from './protocol';

let _vsc: ReturnType<typeof acquireVsCodeApi>;

// 模块加载时立即尝试获取；若失败（已被其他模块调用过），从 window 缓存恢复
try {
  _vsc = acquireVsCodeApi();
  (window as any).__VSCODE_API__ = _vsc;
} catch {
  _vsc = (window as any).__VSCODE_API__;
  if (!_vsc) {
    // 极端降级：哑代理，避免白屏
    _vsc = {
      postMessage: () => {},
      getState: () => null,
      setState: () => {},
    } as any;
  }
}

/** 获取缓存的 VSCode API 实例 */
export function getVsCodeApi(): ReturnType<typeof acquireVsCodeApi> {
  return _vsc;
}

/** 向 extension host 发消息，带 try-catch 保护 */
export function postToHost(msg: WebviewInboundMessage): void {
  try {
    _vsc.postMessage(msg);
  } catch {
    // webview 已销毁，静默
  }
}
