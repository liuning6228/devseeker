/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C6 · 真 Preview WebView（B-P1-1）
 *
 * 目标：取代先前"仅 PreviewBanner + openExternal"的虚标实现——
 *   在 VSCode 内部用真实 iframe 嵌入本机 dev server 页面，
 *   为 C7（DOM 回传）提供载体。
 *
 * 安全：
 *   - 仅允许 http/https；仅允许 localhost / 127.0.0.1 / ::1 / 0.0.0.0 / 10.x / 172.16-31.x / 192.168.x
 *   - CSP frame-src 白名单目标 origin；sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
 *   - 不使用 retainContextWhenHidden: false 仅为 host HTML，iframe 自成沙箱
 *
 * 工具条：Reload / Open External / Copy URL
 */

import * as vscode from 'vscode';
import {
  renderBaseHtml,
  genPanelNonce,
  escapeHtml,
  escapeAttr,
} from './base.js';
import {
  BRIDGE_SOURCE,
  type DomPickedPayload,
} from './preview-bridge-protocol.js';

// ─────────── URL 验证（纯函数）───────────

export interface PreviewUrlValidation {
  ok: boolean;
  normalizedUrl?: string;
  origin?: string;
  reason?: string;
}

const ALLOWED_HOST_SET = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const PRIVATE_HOST_PATTERNS = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
];

export function validatePreviewUrl(raw: string): PreviewUrlValidation {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, reason: 'URL is empty.' };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: `Invalid URL: ${raw}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `Only http(s) allowed, got "${u.protocol}".` };
  }
  const host = u.hostname.toLowerCase();
  const isLocal =
    ALLOWED_HOST_SET.has(host) ||
    PRIVATE_HOST_PATTERNS.some((r) => r.test(host));
  if (!isLocal) {
    return {
      ok: false,
      reason: `Host "${host}" not allowed. Only localhost / private-network IPs are permitted.`,
    };
  }
  return { ok: true, normalizedUrl: u.toString(), origin: u.origin };
}

// ─────────── HTML 渲染 ───────────

export interface PreviewPanelRenderInput {
  url: string;
  origin: string;
  name: string;
}

const STYLE = `
html, body { width: 100%; height: 100%; overflow: hidden; }
.toolbar { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 12px; }
.toolbar .url { flex: 1; font-family: var(--vscode-editor-font-family, monospace); color: var(--muted); word-break: break-all; font-size: 11px; }
.toolbar button { font-size: 11px; }
iframe.preview { border: 0; width: 100%; height: calc(100vh - 34px); background: white; }
.err-banner { background: rgba(190, 17, 0, 0.15); color: var(--err); padding: 8px 12px; border-bottom: 1px solid var(--err); font-size: 12px; }
`;

const SCRIPT = `
const state = { inspectNonce: null, expectedOrigin: __EXPECTED_ORIGIN__, bridgeReady: false };
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const action = t.dataset.action;
  if (!action) return;
  if (action === 'reload') {
    const ifr = document.getElementById('preview');
    if (ifr instanceof HTMLIFrameElement) {
      // 仅通过替换 src 刷新，避免 window.location.reload 跨 origin 限制
      const src = ifr.src;
      ifr.src = 'about:blank';
      setTimeout(() => { ifr.src = src; }, 0);
    }
    return;
  }
  if (action === 'inspect:start' || action === 'inspect:stop') {
    const ifr = document.getElementById('preview');
    if (!(ifr instanceof HTMLIFrameElement) || !ifr.contentWindow) return;
    if (action === 'inspect:start') {
      state.inspectNonce = '__INITIAL_NONCE__' + Date.now();
      ifr.contentWindow.postMessage({ source: '__BRIDGE_SOURCE__', type: 'inspect:start', nonce: state.inspectNonce }, state.expectedOrigin);
      document.getElementById('inspect-status').textContent = 'inspect ON (等待 dev server bridge 响应)';
    } else {
      ifr.contentWindow.postMessage({ source: '__BRIDGE_SOURCE__', type: 'inspect:stop', nonce: state.inspectNonce }, state.expectedOrigin);
      state.inspectNonce = null;
      document.getElementById('inspect-status').textContent = 'inspect off';
    }
    return;
  }
  window.__vscode.postMessage({ type: action, url: t.dataset.url });
});
// iframe -> parent webview 桥接
window.addEventListener('message', (ev) => {
  if (ev.origin !== state.expectedOrigin) return;
  const d = ev.data;
  if (!d || typeof d !== 'object' || d.source !== '__BRIDGE_SOURCE__') return;
  if (d.type === 'ready') {
    state.bridgeReady = true;
    document.getElementById('inspect-status').textContent = 'bridge ready';
    return;
  }
  if (d.type === 'inspect:picked') {
    if (!state.inspectNonce || d.nonce !== state.inspectNonce) return;
    window.__vscode.postMessage({ type: 'domPicked', payload: d.payload });
    document.getElementById('inspect-status').textContent = 'picked: ' + (d.payload && d.payload.selector || '?');
    return;
  }
  if (d.type === 'inspect:cancelled') {
    document.getElementById('inspect-status').textContent = 'inspect cancelled';
    state.inspectNonce = null;
    return;
  }
});
`;

export function buildPreviewPanelHtml(
  input: PreviewPanelRenderInput,
  nonce: string,
  cspSource: string,
): string {
  const url = input.url;
  const script = SCRIPT.replace(/__EXPECTED_ORIGIN__/g, JSON.stringify(input.origin))
    .replace(/__BRIDGE_SOURCE__/g, BRIDGE_SOURCE)
    .replace(/__INITIAL_NONCE__/g, 'n');
  return renderBaseHtml({
    title: `Preview · ${input.name}`,
    nonce,
    cspSource,
    // 放宽 frame-src 到目标 origin；其他 src 保持 none
    extraFrameSrc: `${input.origin}`,
    style: STYLE,
    script,
    body: `
<div class="toolbar">
  <strong>${escapeHtml(input.name)}</strong>
  <span class="url">${escapeHtml(url)}</span>
  <button data-action="inspect:start" title="向 dev server bridge 发送 inspect:start">Inspect</button>
  <button data-action="inspect:stop" title="停止拾取">Stop</button>
  <button data-action="reload">Reload</button>
  <button data-action="openExternal" data-url="${escapeAttr(url)}">Open External</button>
  <button data-action="copyUrl" data-url="${escapeAttr(url)}">Copy URL</button>
  <span id="inspect-status" class="muted" style="font-size:11px">idle</span>
</div>
<iframe
  id="preview"
  class="preview"
  src="${escapeAttr(url)}"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
  referrerpolicy="no-referrer"
  allow="clipboard-read; clipboard-write"
></iframe>
    `,
  });
}

export function buildPreviewErrorHtml(
  reason: string,
  nonce: string,
  cspSource: string,
): string {
  return renderBaseHtml({
    title: 'Preview · Error',
    nonce,
    cspSource,
    style: '',
    script: '',
    body: `<div class="err-banner">❌ ${escapeHtml(reason)}</div>`,
  });
}

// ─────────── 命令胶水 ───────────

export interface OpenPreviewPanelOptions {
  url: string;
  /** 展示名；默认从 URL host 派生 */
  name?: string;
  /** 是否 reveal 已存在的同 viewType 面板（默认 true） */
  reveal?: boolean;
  /** C7 · DOM 拾取回调；iframe bridge 推广 inspect:picked 时触发 */
  onDomPicked?: (payload: DomPickedPayload) => void | Promise<void>;
}

const activePanels = new Map<string, vscode.WebviewPanel>();

export function openPreviewPanel(
  context: vscode.ExtensionContext,
  opts: OpenPreviewPanelOptions,
): vscode.WebviewPanel {
  const v = validatePreviewUrl(opts.url);
  const key = opts.url;
  const existing = activePanels.get(key);
  if (existing && (opts.reveal ?? true)) {
    existing.reveal(vscode.ViewColumn.Beside, true);
    return existing;
  }

  const panel = vscode.window.createWebviewPanel(
    'dualMind.previewPanel',
    `Preview · ${opts.name ?? deriveName(opts.url)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    },
  );
  activePanels.set(key, panel);
  panel.onDidDispose(() => {
    activePanels.delete(key);
    sub.dispose();
  });

  const nonce = genPanelNonce();
  const cspSource = panel.webview.cspSource;
  if (!v.ok) {
    panel.webview.html = buildPreviewErrorHtml(v.reason ?? 'invalid URL', nonce, cspSource);
  } else {
    panel.webview.html = buildPreviewPanelHtml(
      { url: v.normalizedUrl!, origin: v.origin!, name: opts.name ?? deriveName(v.normalizedUrl!) },
      nonce,
      cspSource,
    );
  }

  const sub = panel.webview.onDidReceiveMessage(async (msg) => {
    const m = msg as { type?: string; url?: string; payload?: DomPickedPayload } | undefined;
    if (!m || !m.type) return;
    if (m.type === 'openExternal' && m.url) {
      try {
        await vscode.env.openExternal(vscode.Uri.parse(m.url));
      } catch (e) {
        void vscode.window.showWarningMessage(`Open external failed: ${(e as Error).message}`);
      }
    } else if (m.type === 'copyUrl' && m.url) {
      try {
        await vscode.env.clipboard.writeText(m.url);
        void vscode.window.setStatusBarMessage(`URL 已复制：${m.url}`, 2000);
      } catch (e) {
        void vscode.window.showWarningMessage(`Copy failed: ${(e as Error).message}`);
      }
    } else if (m.type === 'domPicked' && m.payload && opts.onDomPicked) {
      try {
        await opts.onDomPicked(m.payload);
      } catch (e) {
        void vscode.window.showWarningMessage(`DOM picked handler failed: ${(e as Error).message}`);
      }
    }
  });

  return panel;
}

function deriveName(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url.slice(0, 40);
  }
}

/** 命令入口：若 url 未提供则用 InputBox 让用户输入 */
export async function openPreviewPanelInteractive(
  context: vscode.ExtensionContext,
  presetUrl?: string,
  onDomPicked?: (payload: DomPickedPayload) => void | Promise<void>,
): Promise<vscode.WebviewPanel | undefined> {
  let url = presetUrl;
  if (!url) {
    const input = await vscode.window.showInputBox({
      prompt: '输入要预览的本机 URL（例如 http://localhost:5173）',
      placeHolder: 'http://localhost:5173',
      validateInput: (v) => {
        const r = validatePreviewUrl(v);
        return r.ok ? null : r.reason ?? 'invalid';
      },
    });
    if (!input) return undefined;
    url = input;
  }
  const v = validatePreviewUrl(url);
  if (!v.ok) {
    void vscode.window.showErrorMessage(`Preview 无法打开：${v.reason}`);
    return undefined;
  }
  return openPreviewPanel(context, { url: v.normalizedUrl!, onDomPicked });
}
