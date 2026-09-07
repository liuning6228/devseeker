/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 上下文前缀注入纯函数单测（T1/T2）
 *
 * 覆盖：
 * - buildCodeHintsBlock：包裹格式 / score 精度 / 行号标注 / 截断标注 / maxHits 限额 / 空 text 过滤
 * - 零注入语义：空 query / 空 hits / 全部 text 为空 → undefined
 * - buildKnowledgeHintsBlock：独立标签 / 默认 3 条 / 默认 300 字符截断
 */

import { describe, it, expect } from 'vitest';
import {
  buildCodeHintsBlock,
  buildKnowledgeHintsBlock,
  type HintHit,
} from '../../src/core/index/context-hints.js';

function hit(over: Partial<HintHit> = {}): HintHit {
  return {
    filePath: 'src/a.ts',
    startLine: 3,
    endLine: 5,
    score: 0.1234,
    text: 'const a = 1;',
    ...over,
  };
}

describe('buildCodeHintsBlock', () => {
  it('wraps hits in <code_hints> with score and line range', () => {
    const block = buildCodeHintsBlock('how does auth work', [
      hit({ filePath: 'src/auth.ts', startLine: 10, endLine: 12, score: 0.876543, text: 'export function login() {}' }),
      hit({ filePath: 'src/util.ts', startLine: 1, endLine: 2, score: 0.4, text: 'export const OK = 1;' }),
    ]);
    expect(block).toBeDefined();
    expect(block!.startsWith('<code_hints>\n')).toBe(true);
    expect(block!.endsWith('\n</code_hints>')).toBe(true);
    expect(block!).toContain('## 1. score=0.877 [src/auth.ts:10-12]');
    expect(block!).toContain('## 2. score=0.400 [src/util.ts:1-2]');
    expect(block!).toContain('export function login() {}');
  });

  it('truncates text beyond maxCharsPerHit with marker', () => {
    const long = 'x'.repeat(450);
    const block = buildCodeHintsBlock('q', [hit({ text: long })], { maxCharsPerHit: 400 });
    expect(block).toBeDefined();
    // 截断行为：保留前 400 字符，标注位于独立行（truncateText 自带 \n）
    expect(block).toMatch(/x{400}/);
    expect(block).toContain('\n… (截断)');
    expect(block).not.toMatch(/x{401}/);
  });

  it('respects maxHits limit', () => {
    const hits = Array.from({ length: 8 }, (_, i) => hit({ filePath: `f${i}.ts`, text: `body ${i}` }));
    const block = buildCodeHintsBlock('q', hits, { maxHits: 3 });
    expect(block!.match(/^## /gm)).toHaveLength(3);
  });

  it('filters out hits with empty text', () => {
    const hits = [
      hit({ filePath: 'keep.ts', text: 'real content here' }),
      hit({ filePath: 'empty.ts', text: '' }),
      hit({ filePath: 'ws.ts', text: '   ' }),
    ];
    const block = buildCodeHintsBlock('q', hits);
    expect(block).toBeDefined();
    expect(block).not.toContain('empty.ts');
    expect(block).not.toContain('ws.ts');
    expect(block).toContain('keep.ts');
  });

  it('returns undefined for empty query / empty hits / all-empty texts', () => {
    expect(buildCodeHintsBlock('', [hit()])).toBeUndefined();
    expect(buildCodeHintsBlock('   ', [hit()])).toBeUndefined();
    expect(buildCodeHintsBlock('q', [])).toBeUndefined();
    expect(buildCodeHintsBlock('q', [hit({ text: '' }), hit({ text: '' })])).toBeUndefined();
  });

  it('formats score with default 3 decimals', () => {
    const block = buildCodeHintsBlock('q', [hit({ score: 0.123456 })]);
    expect(block).toContain('score=0.123');
  });
});

describe('buildKnowledgeHintsBlock', () => {
  it('uses its own tag with default maxHits=3', () => {
    const hints = Array.from({ length: 5 }, (_, i) => hit({ filePath: `k${i}.md`, text: `doc ${i}` }));
    const block = buildKnowledgeHintsBlock('q', hints);
    expect(block!.startsWith('<knowledge_hints>\n')).toBe(true);
    expect(block!.endsWith('\n</knowledge_hints>')).toBe(true);
    expect(block!.match(/^## /gm)).toHaveLength(3);
    expect(block).not.toContain('<code_hints>');
  });

  it('truncates at default 300 chars per hit', () => {
    const long = 'y'.repeat(350);
    const block = buildKnowledgeHintsBlock('q', [hit({ text: long })]);
    expect(block).toContain('… (截断)');
  });

  it('returns undefined on empty inputs', () => {
    expect(buildKnowledgeHintsBlock('', [hit()])).toBeUndefined();
    expect(buildKnowledgeHintsBlock('q', [])).toBeUndefined();
  });
});