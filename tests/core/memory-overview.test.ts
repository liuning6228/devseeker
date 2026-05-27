/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W7d1 · renderMemoryOverview() 单测
 *
 * 覆盖：
 * - 空输入返回空串
 * - 仅硬约束（user_communication/user_behavior）→ 完整 content 注入
 * - 仅软记忆 → 只列 title | keywords
 * - 混合 → 两段都渲染，硬约束在前
 * - 多行 content flatten 为单行
 * - keywords 空时不输出 `| keywords:` 后缀
 * - 同一分类多条按稳定顺序列出
 */

import { describe, it, expect } from 'vitest';
import { renderMemoryOverview } from '../../src/core/memory/overview.js';
import type { MemoryRecord } from '../../src/core/memory/types.js';

function rec(partial: Partial<MemoryRecord> & Pick<MemoryRecord, 'title' | 'category'>): MemoryRecord {
  const now = Date.now();
  return {
    id: partial.id ?? `mem_${Math.random().toString(36).slice(2, 8)}`,
    title: partial.title,
    content: partial.content ?? '',
    category: partial.category,
    keywords: partial.keywords ?? [],
    scope: partial.scope ?? 'workspace',
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

describe('renderMemoryOverview', () => {
  it('空数组返回空串', () => {
    expect(renderMemoryOverview([])).toBe('');
  });

  it('仅 user_communication：Active preferences 段含完整 content', () => {
    const out = renderMemoryOverview([
      rec({
        title: '简短回答',
        category: 'user_communication',
        content: '回答不超过 3 句，不要解释太多。',
        keywords: ['简短', '短答'],
      }),
    ]);
    expect(out).toContain('<memory_overview>');
    expect(out).toContain('## Active preferences (MUST follow immediately)');
    expect(out).toContain('- [user_communication] 简短回答');
    expect(out).toContain('content: 回答不超过 3 句，不要解释太多。');
    expect(out).toContain('</memory_overview>');
    // 硬约束不进 Other memories
    expect(out).not.toContain('## Other memories');
  });

  it('user_behavior 也视为硬约束', () => {
    const out = renderMemoryOverview([
      rec({
        title: '关键决策先问',
        category: 'user_behavior',
        content: '做架构决策前先征询用户意见。',
      }),
    ]);
    expect(out).toContain('## Active preferences');
    expect(out).toContain('- [user_behavior] 关键决策先问');
    expect(out).toContain('content: 做架构决策前先征询用户意见。');
  });

  it('仅软记忆：只列 title + keywords，不输出 content', () => {
    const out = renderMemoryOverview([
      rec({
        title: 'TS enum 经验',
        category: 'expert_experience',
        content: '一段很长的经验描述...',
        keywords: ['typescript', 'enum'],
      }),
    ]);
    expect(out).not.toContain('## Active preferences');
    expect(out).toContain('## Other memories (call search_memory to fetch full content)');
    expect(out).toContain('### expert_experience (1)');
    expect(out).toContain('- TS enum 经验 | keywords: typescript,enum');
    expect(out).not.toContain('一段很长的经验描述');
  });

  it('混合：Active preferences 在前，Other memories 在后', () => {
    const out = renderMemoryOverview([
      rec({
        title: '项目栈 React',
        category: 'project_tech_stack',
        keywords: ['react', 'vite'],
      }),
      rec({
        title: '简短回答',
        category: 'user_communication',
        content: '≤3 句。',
      }),
      rec({
        title: '别自动 commit',
        category: 'user_behavior',
        content: '涉及 git 写操作必须先问用户。',
      }),
    ]);
    const idxActive = out.indexOf('## Active preferences');
    const idxOther = out.indexOf('## Other memories');
    expect(idxActive).toBeGreaterThanOrEqual(0);
    expect(idxOther).toBeGreaterThan(idxActive);
    // 硬约束两条都在
    expect(out).toContain('- [user_communication] 简短回答');
    expect(out).toContain('- [user_behavior] 别自动 commit');
    // 软记忆一条
    expect(out).toContain('### project_tech_stack (1)');
    expect(out).toContain('- 项目栈 React | keywords: react,vite');
  });

  it('多行 content flatten 为单行，避免污染 overview 结构', () => {
    const out = renderMemoryOverview([
      rec({
        title: 'multiline',
        category: 'user_communication',
        content: 'line1\n\nline2\n\t  line3',
      }),
    ]);
    expect(out).toContain('content: line1 line2 line3');
    // 不应包含换行进入 content 行
    const contentLine = out.split('\n').find((l) => l.startsWith('  content: '));
    expect(contentLine).toBeDefined();
    expect(contentLine!.includes('\n')).toBe(false);
  });

  it('keywords 为空时不输出 "| keywords:" 后缀', () => {
    const out = renderMemoryOverview([
      rec({
        title: '无关键词条目',
        category: 'project_introduction',
        keywords: [],
      }),
    ]);
    expect(out).toContain('- 无关键词条目');
    expect(out).not.toContain('无关键词条目 | keywords');
  });

  it('软记忆同一分类多条：按传入顺序列出，count 正确', () => {
    const out = renderMemoryOverview([
      rec({ title: 'A', category: 'expert_experience', keywords: ['a'] }),
      rec({ title: 'B', category: 'expert_experience', keywords: ['b'] }),
      rec({ title: 'C', category: 'expert_experience' }),
    ]);
    expect(out).toContain('### expert_experience (3)');
    const aIdx = out.indexOf('- A');
    const bIdx = out.indexOf('- B');
    const cIdx = out.indexOf('- C');
    expect(aIdx).toBeGreaterThan(0);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
  });

  it('多软记忆分类按字母序稳定输出', () => {
    const out = renderMemoryOverview([
      rec({ title: 'z-one', category: 'project_tech_stack' }),
      rec({ title: 'a-one', category: 'expert_experience' }),
      rec({ title: 'm-one', category: 'learned_skill_experience' }),
    ]);
    const idxExpert = out.indexOf('### expert_experience');
    const idxLearned = out.indexOf('### learned_skill_experience');
    const idxProject = out.indexOf('### project_tech_stack');
    expect(idxExpert).toBeGreaterThan(0);
    expect(idxLearned).toBeGreaterThan(idxExpert);
    expect(idxProject).toBeGreaterThan(idxLearned);
  });

  it('超长 content 截断至 400 字符', () => {
    const longContent = 'a'.repeat(500);
    const out = renderMemoryOverview([
      rec({ title: 'long', category: 'user_communication', content: longContent }),
    ]);
    const contentLine = out.split('\n').find((l) => l.startsWith('  content: '));
    expect(contentLine).toBeDefined();
    // "  content: " prefix = 11 chars，剩下应是 400
    expect(contentLine!.length).toBe(11 + 400);
  });
});
