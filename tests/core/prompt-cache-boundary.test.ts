/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Prompt Cache Boundary 单测（W3.6 · DESIGN §M3.6）
 *
 * 核心断言：PromptBuilder 的 L0/L1/L2/L3 分层要实现「内层变化不影响外层前缀哈希」，
 * 这是 DeepSeek / Anthropic / OpenAI 等 Prompt Cache 前缀匹配命中的充要条件。
 *
 * 覆盖三组：
 *   1. L0 hash 对任意 ctx 恒等（identity 永不变）
 *   2. memory 变化只动 L2，不动 L0/L0L1
 *   3. mode 变化只动 L1（L0L1 哈希变），L0 不动
 */

import { describe, it, expect } from 'vitest';
import {
  PromptBuilder,
  computeLayerCacheKeys,
  type PromptBuildContext,
} from '../../src/core/prompts/index.js';
import type { Rule } from '../../src/core/rules/types.js';
import type { MemoryRecord } from '../../src/core/memory/types.js';
import type { Skill } from '../../src/core/skills/types.js';

// ────────── 样本工厂 ──────────

function memoryOf(id: string, title: string, content: string): MemoryRecord {
  return {
    id,
    title,
    content,
    category: 'user_behavior', // 硬约束类别：确保 renderMemoryOverview 一定输出
    keywords: ['k1', 'k2'],
    scope: 'workspace',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function ruleOf(name: string, kind: Rule['kind'], content: string): Rule {
  return {
    name,
    kind,
    globs: kind === 'glob' ? ['**/*.ts'] : [],
    priority: 0,
    content,
    filePath: `/fake/${name}.md`,
    source: 'workspace',
  };
}

function skillOf(name: string, description: string): Skill {
  return {
    name,
    description,
    content: `# ${name}\n\nbody`,
    filePath: `/fake/skills/${name}/SKILL.md`,
  };
}

const emptyCtx: PromptBuildContext = {
  mode: 'agent',
  skills: [],
  selectedRules: [],
  allRules: [],
  memories: [],
};

describe('PromptBuilder · L0 identity is stable across all ctx changes', () => {
  it('L0 hash 在 mode/skills/rules/memory 任意组合下恒等', () => {
    const p0 = PromptBuilder.build(emptyCtx);
    const p1 = PromptBuilder.build({ ...emptyCtx, mode: 'plan' });
    const p2 = PromptBuilder.build({ ...emptyCtx, mode: 'debug' });
    const p3 = PromptBuilder.build({
      ...emptyCtx,
      skills: [skillOf('commit', 'git commit helper')],
    });
    const p4 = PromptBuilder.build({
      ...emptyCtx,
      allRules: [ruleOf('r1', 'always_on', 'alpha')],
      selectedRules: [ruleOf('r1', 'always_on', 'alpha')],
    });
    const p5 = PromptBuilder.build({
      ...emptyCtx,
      memories: [memoryOf('m1', '简短回答', '回答不超过 3 句')],
    });

    const k0 = computeLayerCacheKeys(p0).L0;
    for (const p of [p1, p2, p3, p4, p5]) {
      expect(computeLayerCacheKeys(p).L0).toBe(k0);
    }
  });

  it('L0 字节级非空且包含 identity + web_research 关键标识', () => {
    const { L0 } = PromptBuilder.build(emptyCtx);
    expect(L0.length).toBeGreaterThan(1000); // 粗略下限
    expect(L0).toMatch(/You are DualMind/);
    expect(L0).toMatch(/search_web/); // 来自 WEB_RESEARCH_PROMPT_MODULE
  });
});

describe('PromptBuilder · L2 memory changes do NOT affect L0 / L0L1 prefix', () => {
  const baseCtx: PromptBuildContext = {
    ...emptyCtx,
    skills: [skillOf('commit', 'git commit helper')],
    allRules: [ruleOf('r1', 'always_on', 'alpha')],
    selectedRules: [ruleOf('r1', 'always_on', 'alpha')],
  };

  it('新增 memory 只改 L2 / full，不改 L0 / L0L1', () => {
    const before = PromptBuilder.build(baseCtx);
    const after = PromptBuilder.build({
      ...baseCtx,
      memories: [memoryOf('m1', '简短回答', '回答不超过 3 句')],
    });
    const kb = computeLayerCacheKeys(before);
    const ka = computeLayerCacheKeys(after);

    expect(ka.L0).toBe(kb.L0);
    expect(ka.L0L1).toBe(kb.L0L1);
    expect(ka.L0L1L2).not.toBe(kb.L0L1L2);
    expect(ka.full).not.toBe(kb.full);
  });

  it('修改既有 memory 内容（L2 段）同样只破坏 L2+，L0/L0L1 不变', () => {
    const ctxA: PromptBuildContext = {
      ...baseCtx,
      memories: [memoryOf('m1', '简短回答', '回答不超过 3 句')],
    };
    const ctxB: PromptBuildContext = {
      ...baseCtx,
      memories: [memoryOf('m1', '简短回答', '回答不超过 5 句')],
    };
    const ka = computeLayerCacheKeys(PromptBuilder.build(ctxA));
    const kb = computeLayerCacheKeys(PromptBuilder.build(ctxB));

    expect(ka.L0).toBe(kb.L0);
    expect(ka.L0L1).toBe(kb.L0L1);
    expect(ka.L0L1L2).not.toBe(kb.L0L1L2);
  });
});

describe('PromptBuilder · L1 mode change keeps L0 stable, invalidates L0L1', () => {
  it('切换 mode agent → plan：L0 不变，L0L1 变', () => {
    const agent = PromptBuilder.build({ ...emptyCtx, mode: 'agent' });
    const plan = PromptBuilder.build({ ...emptyCtx, mode: 'plan' });
    const ka = computeLayerCacheKeys(agent);
    const kp = computeLayerCacheKeys(plan);

    expect(ka.L0).toBe(kp.L0);
    expect(ka.L0L1).not.toBe(kp.L0L1);
  });

  it('同一 mode 下新增 skill：L0 不变，L0L1 变（skill 归 L1）', () => {
    const before = PromptBuilder.build({ ...emptyCtx, mode: 'agent' });
    const after = PromptBuilder.build({
      ...emptyCtx,
      mode: 'agent',
      skills: [skillOf('commit', 'git commit helper')],
    });
    const kb = computeLayerCacheKeys(before);
    const ka = computeLayerCacheKeys(after);

    expect(ka.L0).toBe(kb.L0);
    expect(ka.L0L1).not.toBe(kb.L0L1);
  });

  it('skills 顺序乱序 → PromptBuilder 自动排序，cache key 一致', () => {
    const s1 = skillOf('a-skill', 'A');
    const s2 = skillOf('b-skill', 'B');
    const s3 = skillOf('c-skill', 'C');
    const ordered = PromptBuilder.build({ ...emptyCtx, skills: [s1, s2, s3] });
    const shuffled = PromptBuilder.build({ ...emptyCtx, skills: [s3, s1, s2] });

    expect(computeLayerCacheKeys(ordered).L0L1).toBe(computeLayerCacheKeys(shuffled).L0L1);
  });
});
