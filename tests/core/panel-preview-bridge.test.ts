/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C7 · Preview Bridge 协议单测（B-P1-2）
 */

import { describe, it, expect } from 'vitest';
import {
  BRIDGE_SOURCE,
  parseIncomingBridgeMessage,
  formatDomPickedForChat,
  genBridgeNonce,
  type DomPickedPayload,
} from '../../src/webview/panels/preview-bridge-protocol.js';

const ORIGIN = 'http://localhost:5173';

function makeReady(): unknown {
  return { source: BRIDGE_SOURCE, type: 'ready' };
}

function makePicked(overrides: Partial<DomPickedPayload> = {}, nonce = 'n1'): unknown {
  const payload: DomPickedPayload = {
    selector: 'div.btn.primary',
    tag: 'button',
    outerHTML: '<button class="btn primary">Save</button>',
    pageUrl: 'http://localhost:5173/app',
    ...overrides,
  };
  return { source: BRIDGE_SOURCE, type: 'inspect:picked', nonce, payload };
}

describe('parseIncomingBridgeMessage · origin 校验', () => {
  it('origin 不匹配 → null', () => {
    expect(parseIncomingBridgeMessage('http://evil.com', makeReady(), ORIGIN)).toBeNull();
  });
  it('origin 空串 → null', () => {
    expect(parseIncomingBridgeMessage('', makeReady(), ORIGIN)).toBeNull();
  });
  it('origin 匹配时 ready 通过', () => {
    const r = parseIncomingBridgeMessage(ORIGIN, makeReady(), ORIGIN);
    expect(r?.type).toBe('ready');
  });
});

describe('parseIncomingBridgeMessage · schema 校验', () => {
  it('非对象 data → null', () => {
    expect(parseIncomingBridgeMessage(ORIGIN, 'hello', ORIGIN)).toBeNull();
    expect(parseIncomingBridgeMessage(ORIGIN, null, ORIGIN)).toBeNull();
    expect(parseIncomingBridgeMessage(ORIGIN, 42, ORIGIN)).toBeNull();
  });

  it('source 不对 → null', () => {
    expect(
      parseIncomingBridgeMessage(ORIGIN, { source: 'other', type: 'ready' }, ORIGIN),
    ).toBeNull();
  });

  it('type 未知 → null', () => {
    expect(
      parseIncomingBridgeMessage(ORIGIN, { source: BRIDGE_SOURCE, type: 'evil' }, ORIGIN),
    ).toBeNull();
  });

  it('type 非字符串 → null', () => {
    expect(
      parseIncomingBridgeMessage(ORIGIN, { source: BRIDGE_SOURCE, type: 123 }, ORIGIN),
    ).toBeNull();
  });
});

describe('parseIncomingBridgeMessage · inspect:picked', () => {
  it('完整 payload 通过', () => {
    const r = parseIncomingBridgeMessage(ORIGIN, makePicked(), ORIGIN);
    expect(r?.type).toBe('inspect:picked');
    expect(r?.payload?.selector).toBe('div.btn.primary');
    expect(r?.payload?.tag).toBe('button');
  });

  it('缺 payload → null', () => {
    expect(
      parseIncomingBridgeMessage(
        ORIGIN,
        { source: BRIDGE_SOURCE, type: 'inspect:picked', nonce: 'n1' },
        ORIGIN,
      ),
    ).toBeNull();
  });

  it('payload 缺 selector → null', () => {
    const bad: Record<string, unknown> = {
      source: BRIDGE_SOURCE,
      type: 'inspect:picked',
      nonce: 'n1',
      payload: { tag: 'div', outerHTML: '<div/>', pageUrl: 'http://x/' },
    };
    expect(parseIncomingBridgeMessage(ORIGIN, bad, ORIGIN)).toBeNull();
  });

  it('selector 过长被截断到 512', () => {
    const long = 'a'.repeat(2000);
    const r = parseIncomingBridgeMessage(ORIGIN, makePicked({ selector: long }), ORIGIN);
    expect(r?.payload?.selector.length).toBe(512);
  });

  it('outerHTML 过长被截断到 4096', () => {
    const long = 'b'.repeat(10_000);
    const r = parseIncomingBridgeMessage(ORIGIN, makePicked({ outerHTML: long }), ORIGIN);
    expect(r?.payload?.outerHTML.length).toBe(4 * 1024);
  });

  it('rect 部分字段缺失 → 丢弃 rect 字段', () => {
    const r = parseIncomingBridgeMessage(
      ORIGIN,
      makePicked({ rect: { x: 1, y: 2, w: 3 } as unknown as DomPickedPayload['rect'] }),
      ORIGIN,
    );
    expect(r?.payload?.rect).toBeUndefined();
  });

  it('rect 完整时保留', () => {
    const r = parseIncomingBridgeMessage(
      ORIGIN,
      makePicked({ rect: { x: 1, y: 2, w: 3, h: 4 } }),
      ORIGIN,
    );
    expect(r?.payload?.rect).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it('保留 nonce', () => {
    const r = parseIncomingBridgeMessage(ORIGIN, makePicked({}, 'abc123'), ORIGIN);
    expect(r?.nonce).toBe('abc123');
  });
});

describe('formatDomPickedForChat', () => {
  it('包含 selector / tag / pageUrl', () => {
    const s = formatDomPickedForChat({
      selector: 'button.save',
      tag: 'button',
      outerHTML: '<button>X</button>',
      pageUrl: 'http://localhost:5173/a',
    });
    expect(s).toContain('selector: `button.save`');
    expect(s).toContain('tag: `button`');
    expect(s).toContain('http://localhost:5173/a');
  });

  it('含 rect 时渲染 rect 行', () => {
    const s = formatDomPickedForChat({
      selector: 's',
      tag: 'div',
      outerHTML: '<div/>',
      pageUrl: 'http://x/',
      rect: { x: 1, y: 2, w: 30, h: 40 },
    });
    expect(s).toContain('rect=[x=1,y=2,w=30,h=40]');
  });

  it('含 text 时渲染文本代码块', () => {
    const s = formatDomPickedForChat({
      selector: 's',
      tag: 'p',
      outerHTML: '<p>hi</p>',
      pageUrl: 'http://x/',
      text: 'hi',
    });
    expect(s).toContain('内部文本');
    expect(s).toMatch(/```\nhi\n```/);
  });

  it('outerHTML 放入 ```html 代码块', () => {
    const s = formatDomPickedForChat({
      selector: 's',
      tag: 'p',
      outerHTML: '<p>hi</p>',
      pageUrl: 'http://x/',
    });
    expect(s).toMatch(/```html\n<p>hi<\/p>\n```/);
  });
});

describe('genBridgeNonce', () => {
  it('生成 32 字符 hex', () => {
    const n = genBridgeNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
  });

  it('两次不一致', () => {
    const a = genBridgeNonce();
    const b = genBridgeNonce();
    expect(a).not.toBe(b);
  });
});
