/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C6 · Preview Panel（B-P1-1）纯函数单测
 *
 * 覆盖：
 *  - validatePreviewUrl：允许/拒绝的 URL 组合
 *  - buildPreviewPanelHtml：CSP frame-src、sandbox、iframe src escape
 *  - buildPreviewErrorHtml：错误 banner 渲染
 */

import { describe, it, expect } from 'vitest';
import {
  validatePreviewUrl,
  buildPreviewPanelHtml,
  buildPreviewErrorHtml,
  type PreviewPanelRenderInput,
} from '../../src/webview/panels/preview-panel.js';

const NONCE = 'TEST_NONCE_xyz';
const CSP = 'vscode-webview://abc';

function makeInput(overrides: Partial<PreviewPanelRenderInput> = {}): PreviewPanelRenderInput {
  return {
    url: 'http://localhost:5173/',
    origin: 'http://localhost:5173',
    name: 'localhost:5173',
    ...overrides,
  };
}

describe('validatePreviewUrl', () => {
  it('接受 http://localhost', () => {
    const r = validatePreviewUrl('http://localhost:5173/app');
    expect(r.ok).toBe(true);
    expect(r.origin).toBe('http://localhost:5173');
    expect(r.normalizedUrl).toContain('localhost');
  });

  it('接受 http://127.0.0.1', () => {
    const r = validatePreviewUrl('http://127.0.0.1:8080/');
    expect(r.ok).toBe(true);
    expect(r.origin).toBe('http://127.0.0.1:8080');
  });

  it('接受 https://localhost', () => {
    const r = validatePreviewUrl('https://localhost:443/');
    expect(r.ok).toBe(true);
  });

  it('接受 10.0.0.x 私网', () => {
    const r = validatePreviewUrl('http://10.0.0.12:3000/');
    expect(r.ok).toBe(true);
  });

  it('接受 192.168.1.x 私网', () => {
    const r = validatePreviewUrl('http://192.168.1.100:80/');
    expect(r.ok).toBe(true);
  });

  it('接受 172.16-31 私网', () => {
    const r = validatePreviewUrl('http://172.20.10.1:5000/');
    expect(r.ok).toBe(true);
  });

  it('拒绝 172.15 (不在 16-31)', () => {
    const r = validatePreviewUrl('http://172.15.0.1/');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not allowed/);
  });

  it('拒绝 172.32 (不在 16-31)', () => {
    const r = validatePreviewUrl('http://172.32.0.1/');
    expect(r.ok).toBe(false);
  });

  it('拒绝公网 IP', () => {
    const r = validatePreviewUrl('http://8.8.8.8/');
    expect(r.ok).toBe(false);
  });

  it('拒绝域名', () => {
    const r = validatePreviewUrl('https://example.com/');
    expect(r.ok).toBe(false);
  });

  it('拒绝 file://', () => {
    const r = validatePreviewUrl('file:///c:/tmp/a.html');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/http\(s\)/);
  });

  it('拒绝 javascript:', () => {
    const r = validatePreviewUrl('javascript:alert(1)');
    expect(r.ok).toBe(false);
  });

  it('拒绝空串', () => {
    const r = validatePreviewUrl('');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/empty/i);
  });

  it('拒绝格式错误的 URL', () => {
    const r = validatePreviewUrl('not a url');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Invalid URL/);
  });

  it('大小写不敏感的 host', () => {
    const r = validatePreviewUrl('http://LocalHost:5173/');
    expect(r.ok).toBe(true);
  });
});

describe('buildPreviewPanelHtml', () => {
  it('包含 DOCTYPE + title + nonce', () => {
    const html = buildPreviewPanelHtml(makeInput(), NONCE, CSP);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Preview · localhost:5173');
    expect(html).toContain(`nonce="${NONCE}"`);
  });

  it('CSP frame-src 放行目标 origin', () => {
    const html = buildPreviewPanelHtml(makeInput({ origin: 'http://localhost:5173' }), NONCE, CSP);
    expect(html).toMatch(/frame-src\s+http:\/\/localhost:5173/);
  });

  it('CSP default-src none 仍然锁死', () => {
    const html = buildPreviewPanelHtml(makeInput(), NONCE, CSP);
    expect(html).toContain("default-src 'none'");
  });

  it('iframe src 正确 escape', () => {
    const html = buildPreviewPanelHtml(
      makeInput({ url: 'http://localhost:5173/?q=<x>&amp=1' }),
      NONCE,
      CSP,
    );
    // 不应出现未转义的 < >
    expect(html).not.toMatch(/src="http:\/\/localhost:5173\/\?q=<x>/);
    expect(html).toContain('&lt;x&gt;');
  });

  it('iframe 含 sandbox 属性（不含 allow-top-navigation）', () => {
    const html = buildPreviewPanelHtml(makeInput(), NONCE, CSP);
    expect(html).toMatch(/sandbox="[^"]*allow-scripts[^"]*"/);
    expect(html).toMatch(/sandbox="[^"]*allow-same-origin[^"]*"/);
    expect(html).not.toMatch(/allow-top-navigation/);
  });

  it('工具条包含 Reload / Open External / Copy URL', () => {
    const html = buildPreviewPanelHtml(makeInput(), NONCE, CSP);
    expect(html).toContain('data-action="reload"');
    expect(html).toContain('data-action="openExternal"');
    expect(html).toContain('data-action="copyUrl"');
  });

  it('工具条 URL 属性被 escape', () => {
    const html = buildPreviewPanelHtml(
      makeInput({ url: 'http://localhost:5173/"onload=alert(1)' }),
      NONCE,
      CSP,
    );
    expect(html).not.toContain('"onload=alert(1)');
    expect(html).toContain('&quot;onload=alert(1)');
  });

  it('script 段带 nonce', () => {
    const html = buildPreviewPanelHtml(makeInput(), NONCE, CSP);
    expect(html).toMatch(new RegExp(`<script nonce="${NONCE}"`));
  });

  it('name 做 HTML escape', () => {
    const html = buildPreviewPanelHtml(makeInput({ name: '<b>pwn</b>' }), NONCE, CSP);
    expect(html).not.toContain('<b>pwn</b>');
    expect(html).toContain('&lt;b&gt;pwn&lt;/b&gt;');
  });
});

describe('buildPreviewErrorHtml', () => {
  it('渲染 err-banner', () => {
    const html = buildPreviewErrorHtml('bad url', NONCE, CSP);
    expect(html).toContain('err-banner');
    expect(html).toContain('bad url');
  });

  it('原因做 HTML escape', () => {
    const html = buildPreviewErrorHtml('<script>evil</script>', NONCE, CSP);
    expect(html).not.toMatch(/<script>evil<\/script>/);
    expect(html).toContain('&lt;script&gt;evil&lt;/script&gt;');
  });

  it('保留 CSP default-src none', () => {
    const html = buildPreviewErrorHtml('x', NONCE, CSP);
    expect(html).toContain("default-src 'none'");
  });
});
