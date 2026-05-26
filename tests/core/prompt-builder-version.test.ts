/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PromptBuilder 版本化 + 调试快照（B-P3-2）
 *
 * 验证：
 *   1. LayeredPrompt 的 version 字段与 PROMPT_BUILDER_VERSION 一致
 *   2. build() 自动附加 cacheKeys，与 computeLayerCacheKeys(result) 等价
 *   3. dumpPromptSnapshot() 输出结构（不含原文）
 */

import { describe, it, expect } from 'vitest';
import {
  PromptBuilder,
  PROMPT_BUILDER_VERSION,
  dumpPromptSnapshot,
  computeLayerCacheKeys,
  type PromptBuildContext,
} from '../../src/core/prompts/index.js';

function makeCtx(): PromptBuildContext {
  return {
    mode: 'agent',
    skills: [],
    selectedRules: [],
    allRules: [],
    memories: [],
  };
}

describe('prompt-builder version & snapshot (B-P3-2)', () => {
  it('LayeredPrompt.version 与 PROMPT_BUILDER_VERSION 一致', () => {
    const p = PromptBuilder.build(makeCtx());
    expect(p.version).toBe(PROMPT_BUILDER_VERSION);
    // 形如 'YYYY-MM-DD'
    expect(PROMPT_BUILDER_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('build() 附带的 cacheKeys 与 computeLayerCacheKeys 等价', () => {
    const p = PromptBuilder.build(makeCtx());
    const recomputed = computeLayerCacheKeys(p);
    expect(p.cacheKeys).toEqual(recomputed);
  });

  it('cacheKeys 各字段是 16 位 hex', () => {
    const p = PromptBuilder.build(makeCtx());
    const hex16 = /^[0-9a-f]{16}$/;
    expect(p.cacheKeys.L0).toMatch(hex16);
    expect(p.cacheKeys.L0L1).toMatch(hex16);
    expect(p.cacheKeys.L0L1L2).toMatch(hex16);
    expect(p.cacheKeys.full).toMatch(hex16);
  });

  it('dumpPromptSnapshot 只含 length 摘要 + cacheKeys，不泄露原文', () => {
    const p = PromptBuilder.build(makeCtx());
    const snap = dumpPromptSnapshot(p);
    expect(snap.version).toBe(PROMPT_BUILDER_VERSION);
    expect(snap.lengths.L0).toBe(p.L0.length);
    expect(snap.lengths.L1).toBe(p.L1.length);
    expect(snap.lengths.L2).toBe(p.L2.length);
    expect(snap.lengths.L3).toBe(p.L3.length);
    expect(snap.lengths.full).toBe(p.full.length);
    expect(snap.cacheKeys).toEqual(p.cacheKeys);
    // 不得携带任何 L0/L1/L2/L3/full 文本字段
    expect((snap as unknown as Record<string, unknown>)['L0']).toBeUndefined();
    expect((snap as unknown as Record<string, unknown>)['full']).toBeUndefined();
  });

  it('dumpPromptSnapshot 对同输入的 build 结果输出恒等（不含时间戳）', () => {
    const a = dumpPromptSnapshot(PromptBuilder.build(makeCtx()));
    const b = dumpPromptSnapshot(PromptBuilder.build(makeCtx()));
    expect(a).toEqual(b);
  });
});
