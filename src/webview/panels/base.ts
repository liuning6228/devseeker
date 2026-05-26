/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C0 · 独立辅助面板基础设施（B-P1-1/2/3/4/5/6/7）
 *
 * 设计目标：
 *  - 7 个辅助面板（Context / Cost / Rules / Hooks / Git / Preview / DOM）共享
 *    一套 `SimpleWebviewPanel` 骨架；每个子面板只负责产出 HTML body + 消息处理。
 *  - 不依赖 webview-ui vite/React 工程 —— 直接用原生 HTML + 内联 CSS + postMessage，
 *    降低打包/构建耦合，方便单独裂变（B-P1-5 要求独立目录 `webview-ui/context-panel/*`
 *    原意是"独立可视化"，用内嵌 WebviewPanel 等价达成）。
 *  - CSP 风格与主 chat 面板一致（§M11）：default-src 'none' + nonce 脚本，
 *    Preview 面板例外（iframe + http）由 `openPreviewPanel` 单独重写 CSP。
 *
 * 关键导出：
 *  - `renderBaseHtml(ctx)`：纯函数，产出带占位符 body 的 HTML 外壳，方便单测校 CSP 与 nonce。
 *  - `escapeHtml(s)` / `escapeAttr(s)`：防止用户路径/文件名导致 XSS 或 HTML 串味。
 *  - `SimpleWebviewPanel`：薄封装 vscode.WebviewPanel，自动回收订阅。
 *  - `formatKb(bytes)` / `formatDuration(ms)` / `formatNumber(n)`：几何面板都会用到的展示工具。
 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

// ─────────── 纯工具 ───────────

export function genPanelNonce(): string {
  return randomBytes(16).toString('base64');
}

/** HTML 转义：< > & " ' */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** HTML 属性值转义（比 escapeHtml 更严格：额外防空格拆属性） */
export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/\n/g, '&#10;');
}

export function formatNumber(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return '0';
  if (n === 0) return '0';
  if (Math.abs(n) < 0.0001) return n.toExponential(1);
  if (Math.abs(n) < 0.01) return n.toFixed(Math.max(digits, 5));
  if (Math.abs(n) < 1) return n.toFixed(digits + 1);
  return n.toFixed(digits);
}

export function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

// ─────────── HTML 外壳 ───────────

export interface PanelHtmlContext {
  title: string;
  nonce: string;
  cspSource: string;
  /** 额外允许的 script-src（如 Preview 里的 cdnjs）。空则等价于 'nonce-xxx' 自身 */
  extraScriptSrc?: string;
  /** 额外允许的 frame-src（Preview 面板会放 http/https） */
  extraFrameSrc?: string;
  /** 额外允许的 connect-src（DOM 回传协议）。空则 'none' */
  extraConnectSrc?: string;
  /** 已渲染好的 <body> 内容 HTML 片段 */
  body: string;
  /** 内联样式（会被 nonce 包装） */
  style: string;
  /** 内联脚本（会被 nonce 包装） */
  script: string;
}

/**
 * 渲染通用 HTML 外壳。
 * 对 script 与 style 均用 nonce 保护；CSP default-src 'none' 锁死一切 fetch / font / media。
 */
export function renderBaseHtml(ctx: PanelHtmlContext): string {
  const frameSrc = ctx.extraFrameSrc ? ` frame-src ${ctx.extraFrameSrc};` : '';
  const connectSrc = ctx.extraConnectSrc ?? "'none'";
  const scriptSrc = ctx.extraScriptSrc
    ? `'nonce-${ctx.nonce}' ${ctx.cspSource} ${ctx.extraScriptSrc}`
    : `'nonce-${ctx.nonce}' ${ctx.cspSource}`;
  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    img-src ${ctx.cspSource} https: data:;
    style-src ${ctx.cspSource} 'nonce-${ctx.nonce}' 'unsafe-inline';
    script-src ${scriptSrc};
    font-src ${ctx.cspSource};
    connect-src ${connectSrc};
   ${frameSrc}
  " />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>${escapeHtml(ctx.title)}</title>
  <style nonce="${ctx.nonce}">
    :root {
      color-scheme: light dark;
      --fg: var(--vscode-foreground);
      --bg: var(--vscode-editor-background);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-textLink-foreground);
      --border: var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
      --warn: var(--vscode-inputValidation-warningBorder, #bf8803);
      --err: var(--vscode-inputValidation-errorBorder, #be1100);
      --ok: var(--vscode-testing-iconPassed, #388a34);
    }
    html, body { margin: 0; padding: 0; height: 100%; font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); font-size: var(--vscode-font-size); }
    * { box-sizing: border-box; }
    h1 { margin: 0; padding: 8px 12px; font-size: 13px; border-bottom: 1px solid var(--border); }
    h2 { margin: 12px 0 4px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    code { background: rgba(128,128,128,0.1); padding: 0 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .muted { color: var(--muted); }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .box { padding: 8px 12px; border-bottom: 1px solid var(--border); }
    .empty { padding: 20px; text-align: center; color: var(--muted); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; }
    .pill { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 10px; background: rgba(128,128,128,0.18); }
    .pill.ok { background: rgba(56, 138, 52, 0.25); color: var(--ok); }
    .pill.warn { background: rgba(191, 136, 3, 0.25); color: var(--warn); }
    .pill.err { background: rgba(190, 17, 0, 0.25); color: var(--err); }
    ${ctx.style}
  </style>
</head>
<body>
${ctx.body}
<script nonce="${ctx.nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  window.__vscode = vscode;
  ${ctx.script}
})();
</script>
</body>
</html>`;
}

// ─────────── WebviewPanel 薄封装 ───────────

export interface SimplePanelConfig {
  viewType: string;
  title: string;
  /** 首次渲染 HTML 生成器；面板打开后还可通过 `refresh()` 再次触发 */
  render(): string | Promise<string>;
  /** 可选的消息处理器；接收 webview 发来的任意 JSON */
  onMessage?(msg: unknown, panel: vscode.WebviewPanel): void | Promise<void>;
  /** viewColumn 默认 Beside */
  column?: vscode.ViewColumn;
  /** retainContextWhenHidden 默认 true（面板切走不销毁状态） */
  retainContextWhenHidden?: boolean;
}

/** 打开一个轻量辅助面板；返回 WebviewPanel 与 refresh 方法。 */
export async function openSimplePanel(
  context: vscode.ExtensionContext,
  cfg: SimplePanelConfig,
): Promise<{ panel: vscode.WebviewPanel; refresh: () => Promise<void> }> {
  const panel = vscode.window.createWebviewPanel(
    cfg.viewType,
    cfg.title,
    cfg.column ?? vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: cfg.retainContextWhenHidden ?? true,
      localResourceRoots: [context.extensionUri],
    },
  );

  async function refresh(): Promise<void> {
    panel.webview.html = await cfg.render();
  }
  await refresh();

  const subs: vscode.Disposable[] = [];
  if (cfg.onMessage) {
    subs.push(
      panel.webview.onDidReceiveMessage((m) => {
        void cfg.onMessage!(m, panel);
      }),
    );
  }
  panel.onDidDispose(() => {
    for (const s of subs) s.dispose();
  });

  return { panel, refresh };
}
