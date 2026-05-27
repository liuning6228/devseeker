/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Webview HTML 生成器
 *
 * 加载 Vite 构建产物（out/webview/main.js + main.css）
 * CSP 关键约束（DESIGN §M11）：
 * - default-src 'none'
 * - script-src 仅允许 nonce + webview 源
 * - style-src 允许 nonce + 'unsafe-inline'（Vite 注入的 inline style） + webview 源
 * - img-src 允许 webview 资源 + data:（头像 / 图标）
 * - 不允许 eval / inline script（除 nonce 标记）
 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export function genNonce(): string {
  return randomBytes(16).toString('base64');
}

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  nonce: string,
): string {
  const jsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'main.js'),
  );
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'main.css'),
  );
  const cspSource = webview.cspSource;
  // W-UI2 · 破缓存：用 mtime 做指纹，避免 VSCode webview 缓存旧 bundle
  //   （不用进程启动时间，避免开发期 reload window 后没换成新 bundle）
  let assetVer = Date.now().toString(36);
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const jsPath = vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'main.js').fsPath;
    assetVer = fs.statSync(jsPath).mtimeMs.toString(36);
  } catch {
    /* ignore, fallback 到进程启动时间戳 */
  }
  const jsUrl = `${jsUri.toString()}?v=${assetVer}`;
  const cssUrl = `${cssUri.toString()}?v=${assetVer}`;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    img-src ${cspSource} https: data:;
    style-src ${cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}' ${cspSource};
    font-src ${cspSource};
    connect-src 'none';
  " />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>DevSeeker</title>
  <link rel="stylesheet" href="${cssUrl}" />
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    // 主动注销残留 Service Worker，避免 VS Code webview 的 SW 注册失败错误
    // Ref: https://github.com/microsoft/vscode/issues/247035
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(function(regs) {
        for (var i = 0; i < regs.length; i++) { regs[i].unregister(); }
      }).catch(function() {});
    }
  </script>
  <script type="module" nonce="${nonce}" src="${jsUrl}"></script>
</body>
</html>`;
}
