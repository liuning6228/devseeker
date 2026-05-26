/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * decision-tree 单测
 *
 * 覆盖：D1, D2, D3
 */

import { describe, it, expect } from 'vitest';
import { doesTaskNeedPlanning, extractFeatures } from './decision-tree.js';

describe('doesTaskNeedPlanning', () => {
  it('显式规划意图 → auto_plan', () => {
    expect(doesTaskNeedPlanning('帮我设计认证模块')).toBe('auto_plan');
    expect(doesTaskNeedPlanning('帮我规划数据库迁移方案')).toBe('auto_plan');
  });

  it('架构关键词 ≥ 3 → auto_plan', () => {
    expect(doesTaskNeedPlanning('需要重构架构，重新设计认证模块，迁移到新方案')).toBe('auto_plan');
  });

  it('修复简单 bug → no_plan', () => {
    expect(doesTaskNeedPlanning('修复 README 的拼写错误')).toBe('no_plan');
    expect(doesTaskNeedPlanning('Fix the typo in the comment')).toBe('no_plan');
  });

  it('架构性关键词≥3 → auto_plan', () => {
    const result = doesTaskNeedPlanning('需要重构架构，重新设计认证模块并规划迁移方案');
    expect(['auto_plan']).toContain(result);
  });

  it('"what approach" → auto_plan（含显式规划意图）', () => {
    const result = doesTaskNeedPlanning('Database has N+1 problem, what approach should I take?');
    expect(result).toBe('auto_plan');
  });
});

describe('extractFeatures', () => {
  it('简单请求特征值低', () => {
    const f = extractFeatures('修复拼写错误');
    expect(f.hasExplicitPlanIntent).toBe(false);
    expect(f.keywordHits).toBe(0);
  });

  it('架构请求特征值高', () => {
    const f = extractFeatures('帮我设计一个认证模块的架构方案，需要重构现有实现');
    expect(f.keywordHits).toBeGreaterThanOrEqual(2);
  });

  it('文件引用计数正确', () => {
    const f = extractFeatures('修改 src/auth.ts:10 和 src/user.ts:20');
    expect(f.fileRefCount).toBe(2);
  });
});
