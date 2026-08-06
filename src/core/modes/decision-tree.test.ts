/**
 * Copyright (c) 2026 DevSeeker Contributors
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

  // ── P1 补齐 · Spec 级别决策 ──

  it('显式 Spec 意图 → auto_spec', () => {
    expect(doesTaskNeedPlanning('走 spec 流程来实现用户管理')).toBe('auto_spec');
    expect(doesTaskNeedPlanning('写个 spec，先梳理需求')).toBe('auto_spec');
  });

  it('Feature 级任务 → auto_spec', () => {
    const result = doesTaskNeedPlanning('实现一个全新的支付模块，搭建完整的系统');
    expect(result).toBe('auto_spec');
  });

  it('Feature + 跨模块 → auto_spec', () => {
    const result = doesTaskNeedPlanning('实现新功能，需要跨多个服务集成');
    expect(result).toBe('auto_spec');
  });

  it('需求梳理请求 → auto_spec', () => {
    const result = doesTaskNeedPlanning('先梳理需求，我们需要实现一个全新的支付模块');
    expect(result).toBe('auto_spec');
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
