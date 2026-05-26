/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C1 · Context 可视化面板（B-P1-5）纯函数单测
 *
 * 覆盖点：
 *   1. buildContextPanelHtml 注入 nonce + cspSource，返回合法 HTML 骨架
 *   2. skill/rule/memory 名中若含 HTML 特殊字符会被 escape
 *   3. 空数据兜底：skills/rules/memories 皆 0 时展示 empty-note，不崩
 *   4. selectedRules 子集会被标 "L2" pill（与 all 集比对）
 *   5. L0/L1/L2/L3 四层的 chars + hash 都出现
 *
 * 注：不导入 vscode；`context-panel.ts` 的 collect/open 函数依赖 vscode，
 * 但 `buildContextPanelHtml` 本身只用纯数据 + 纯工具函数。
 */

import { describe, it, expect } from 'vitest';
import {
  buildContextPanelHtml,
  type ContextPanelInput,
} from '../../src/webview/panels/context-panel.js';

function makeInput(overrides: Partial<ContextPanelInput> = {}): ContextPanelInput {
  const base: ContextPanelInput = {
    workspaceRoot: '/workspace/proj',
    mode: 'agent',
    skills: [],
    allRules: [],
    selectedRules: [],
    memories: [],
    snapshot: {
      version: '2026-05-01',
      lengths: { L0: 4500, L1: 1200, L2: 340, L3: 0, full: 6040 },
      cacheKeys: {
        L0: 'aaaaaaaaaaaaaaaa',
        L0L1: 'bbbbbbbbbbbbbbbb',
        L0L1L2: 'cccccccccccccccc',
        full: 'dddddddddddddddd',
      },
    },
    tokens: { L0: 1125, L1: 300, L2: 85, L3: 0, full: 1510 },
    warnings: [],
    generatedAt: '2026-05-02T10:00:00.000Z',
  };
  return { ...base, ...overrides };
}

describe('buildContextPanelHtml · CSP 与骨架', () => {
  it('包含 nonce + cspSource + Content-Security-Policy', () => {
    const html = buildContextPanelHtml(makeInput(), 'NONCE123', 'vscode-webview://X');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("nonce-NONCE123");
    expect(html).toContain('vscode-webview://X');
    // <script nonce="..."> 必须存在
    expect(html).toMatch(/<script nonce="NONCE123">/);
  });

  it('展示 workspaceRoot (none) 兜底', () => {
    const html = buildContextPanelHtml(
      makeInput({ workspaceRoot: undefined }),
      'N',
      'C',
    );
    expect(html).toContain('(none)');
  });

  it('PromptBuilder version + 生成时间都展示', () => {
    const html = buildContextPanelHtml(makeInput(), 'N', 'C');
    expect(html).toContain('v2026-05-01');
  });
});

describe('buildContextPanelHtml · 四层呈现', () => {
  it('四层 chars + tokens + hash 都出现', () => {
    const html = buildContextPanelHtml(makeInput(), 'N', 'C');
    // chars
    expect(html).toContain('4,500'.replace(/,/g, '')); // formatNumber(n, 0) -> "4500"
    expect(html).toContain('4500');
    expect(html).toContain('1200');
    expect(html).toContain('340');
    // tokens
    expect(html).toContain('1125');
    expect(html).toContain('300');
    // hash（每个层显示各自的前缀哈希）
    expect(html).toContain('aaaaaaaaaaaaaaaa'); // L0
    expect(html).toContain('bbbbbbbbbbbbbbbb'); // L0L1
    expect(html).toContain('cccccccccccccccc'); // L0L1L2
    expect(html).toContain('dddddddddddddddd'); // full
  });
});

describe('buildContextPanelHtml · 空状态兜底', () => {
  it('无 skills/rules/memories 时展示 empty-note 且不抛', () => {
    const html = buildContextPanelHtml(makeInput(), 'N', 'C');
    expect(html).toContain('Skills (0)');
    expect(html).toContain('Rules (0)');
    expect(html).toContain('Memories (0)');
    expect(html).toContain('no skills discovered');
    expect(html).toContain('no rules loaded');
    expect(html).toContain('store is empty');
  });

  it('warnings 为空时不渲染 Warnings 段', () => {
    const html = buildContextPanelHtml(makeInput({ warnings: [] }), 'N', 'C');
    expect(html).not.toContain('<h2>Warnings</h2>');
  });

  it('warnings 非空时渲染并 escape', () => {
    const html = buildContextPanelHtml(
      makeInput({ warnings: ['rules: <boom>', 'memories: ok'] }),
      'N',
      'C',
    );
    expect(html).toContain('<h2>Warnings</h2>');
    expect(html).toContain('rules: &lt;boom&gt;');
    expect(html).toContain('memories: ok');
  });
});

describe('buildContextPanelHtml · escape 与 selected 标记', () => {
  it('skill name 含 HTML 特殊字符被转义', () => {
    const html = buildContextPanelHtml(
      makeInput({
        skills: [
          { name: '<script>evil', description: 'A & B "quote"', contentChars: 123 },
        ],
      }),
      'N',
      'C',
    );
    expect(html).not.toContain('<script>evil');
    expect(html).toContain('&lt;script&gt;evil');
    expect(html).toContain('A &amp; B &quot;quote&quot;');
    expect(html).toContain('Skills (1)');
  });

  it('selectedRules 的子集在 all 列表里被标 L2 pill', () => {
    const all = [
      makeRule('alpha', 'always_on', 'workspace', 10, 80),
      makeRule('beta', 'glob', 'global', 5, 40),
      makeRule('gamma', 'model_decision', 'workspace', 0, 20),
    ];
    const selected = [all[0]!, all[2]!]; // alpha + gamma 命中，beta 不命中
    const html = buildContextPanelHtml(
      makeInput({ allRules: all, selectedRules: selected }),
      'N',
      'C',
    );
    expect(html).toContain('Rules (3 total · 2 in L2)');
    // 找到 alpha / beta / gamma 三行；alpha + gamma 带 class="pill ok"
    // 粗略断言：pill ok 出现 2 次
    const okPillCount = (html.match(/pill ok/g) ?? []).length;
    expect(okPillCount).toBe(2);
  });

  it('memory title 含 HTML 被 escape; 超过 50 条截断', () => {
    const many = Array.from({ length: 55 }, (_, i) => ({
      id: `m${i}`,
      title: i === 0 ? '<b>bad</b>' : `mem-${i}`,
      category: 'user_info',
      scope: 'workspace',
      contentChars: 10 + i,
    }));
    const html = buildContextPanelHtml(makeInput({ memories: many }), 'N', 'C');
    expect(html).toContain('Memories (55)');
    expect(html).not.toContain('<b>bad</b>');
    expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;');
    expect(html).toContain('truncated to 50 of 55');
  });
});

// ────────── helpers ──────────

function makeRule(
  name: string,
  kind: string,
  source: string,
  priority: number,
  contentChars: number,
): ContextPanelInput['allRules'][number] {
  return {
    name,
    kind,
    source,
    priority,
    descriptionChars: 0,
    contentChars,
  };
}
