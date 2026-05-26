/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Web 模块单测（W6b3）
 *
 * 覆盖：
 * - url-guard：scheme / localhost / 私有 IPv4/IPv6 / blocklist / 格式非法
 * - selector：中文比例判定 + pickProviders（lang 提示 / defaultProvider / 不可用兜底）
 */

import { describe, it, expect } from 'vitest';
import { validateUrl } from '../../src/core/web/url-guard.js';
import { chineseCharRatio, pickProviders } from '../../src/core/web/selector.js';
import type {
  ISearchProvider,
  SearchProviderId,
  SearchWebArgs,
  SearchWebResult,
  ProbeResult,
} from '../../src/core/web/types.js';

// ──────────────── url-guard ────────────────

describe('validateUrl', () => {
  it('accepts regular http/https urls', () => {
    expect(validateUrl('https://example.com').ok).toBe(true);
    expect(validateUrl('http://example.com/path?q=1').ok).toBe(true);
  });

  it('rejects non http(s) schemes', () => {
    expect(validateUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateUrl('ftp://example.com').ok).toBe(false);
    expect(validateUrl('data:text/html,hi').ok).toBe(false);
  });

  it('rejects localhost variants', () => {
    expect(validateUrl('http://localhost:8080').ok).toBe(false);
    expect(validateUrl('http://foo.localhost').ok).toBe(false);
  });

  it('rejects private IPv4 ranges', () => {
    expect(validateUrl('http://127.0.0.1').ok).toBe(false);
    expect(validateUrl('http://127.1.2.3').ok).toBe(false);
    expect(validateUrl('http://10.0.0.1').ok).toBe(false);
    expect(validateUrl('http://172.16.0.1').ok).toBe(false);
    expect(validateUrl('http://172.31.255.255').ok).toBe(false);
    expect(validateUrl('http://192.168.1.1').ok).toBe(false);
    expect(validateUrl('http://169.254.169.254').ok).toBe(false); // AWS metadata
    expect(validateUrl('http://0.0.0.0').ok).toBe(false);
  });

  it('allows public IPv4', () => {
    expect(validateUrl('http://8.8.8.8').ok).toBe(true);
    expect(validateUrl('http://172.32.0.1').ok).toBe(true); // 出了 172.16-31 就是公网
  });

  it('rejects private IPv6', () => {
    expect(validateUrl('http://[::1]').ok).toBe(false);
    expect(validateUrl('http://[fe80::1]').ok).toBe(false);
    expect(validateUrl('http://[fc00::1]').ok).toBe(false);
    expect(validateUrl('http://[fd00::1]').ok).toBe(false);
    expect(validateUrl('http://[::ffff:127.0.0.1]').ok).toBe(false);
  });

  it('rejects blocklist entries', () => {
    const opts = { blocklist: ['*.internal.example.com', 'bad.example.com'] };
    expect(validateUrl('https://service.internal.example.com', opts).ok).toBe(false);
    expect(validateUrl('https://bad.example.com', opts).ok).toBe(false);
    expect(validateUrl('https://ok.example.com', opts).ok).toBe(true);
  });

  it('rejects invalid / empty url', () => {
    expect(validateUrl('').ok).toBe(false);
    expect(validateUrl('not a url').ok).toBe(false);
    // @ts-expect-error 非 string
    expect(validateUrl(null).ok).toBe(false);
  });
});

// ──────────────── selector ────────────────

describe('chineseCharRatio', () => {
  it('returns 0 for empty / pure ascii', () => {
    expect(chineseCharRatio('')).toBe(0);
    expect(chineseCharRatio('hello world')).toBe(0);
  });

  it('returns correct ratio for mixed input', () => {
    // "介绍 React 官方文档" → 非空白 9 chars，CJK 7
    const r = chineseCharRatio('介绍 React 官方文档');
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThanOrEqual(1);
  });

  it('returns 1 for pure chinese', () => {
    expect(chineseCharRatio('你好世界')).toBe(1);
  });
});

function makeStubProvider(id: SearchProviderId): ISearchProvider {
  return {
    id,
    requiresKey: true,
    async search(_args: SearchWebArgs): Promise<SearchWebResult> {
      return { results: [], provider: id, tookMs: 0 };
    },
    async probe(): Promise<ProbeResult> {
      return { ok: true };
    },
  };
}

describe('pickProviders', () => {
  it('prefers bocha for chinese query (auto)', () => {
    const providers = new Map<SearchProviderId, ISearchProvider>([
      ['tavily', makeStubProvider('tavily')],
      ['bocha', makeStubProvider('bocha')],
    ]);
    const ordered = pickProviders({ query: '鸿蒙 HarmonyOS 最新文档' }, { providers });
    expect(ordered.map((p) => p.id)).toEqual(['bocha', 'tavily']);
  });

  it('prefers tavily for english query (auto)', () => {
    const providers = new Map<SearchProviderId, ISearchProvider>([
      ['tavily', makeStubProvider('tavily')],
      ['bocha', makeStubProvider('bocha')],
    ]);
    const ordered = pickProviders({ query: 'nextjs official docs app router' }, { providers });
    expect(ordered.map((p) => p.id)).toEqual(['tavily', 'bocha']);
  });

  it('respects explicit language=zh', () => {
    const providers = new Map<SearchProviderId, ISearchProvider>([
      ['tavily', makeStubProvider('tavily')],
      ['bocha', makeStubProvider('bocha')],
    ]);
    const ordered = pickProviders({ query: 'react hooks', language: 'zh' }, { providers });
    expect(ordered[0]!.id).toBe('bocha');
  });

  it('respects explicit defaultProvider override', () => {
    const providers = new Map<SearchProviderId, ISearchProvider>([
      ['tavily', makeStubProvider('tavily')],
      ['bocha', makeStubProvider('bocha')],
    ]);
    const ordered = pickProviders(
      { query: '你好' },
      { providers, defaultProvider: 'tavily' },
    );
    expect(ordered[0]!.id).toBe('tavily');
  });

  it('returns empty array when no providers registered', () => {
    const ordered = pickProviders({ query: 'anything' }, { providers: new Map() });
    expect(ordered).toEqual([]);
  });

  it('only returns registered providers even if language hints otherwise', () => {
    const providers = new Map<SearchProviderId, ISearchProvider>([
      ['tavily', makeStubProvider('tavily')],
    ]);
    const ordered = pickProviders({ query: '中文' }, { providers });
    expect(ordered.map((p) => p.id)).toEqual(['tavily']);
  });
});
