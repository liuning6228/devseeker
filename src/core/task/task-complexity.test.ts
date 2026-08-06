/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * task-complexity 单测
 *
 * 覆盖：任务复杂度三级分类（vibe / plan / spec）
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateTaskComplexity,
  extractComplexitySignals,
} from './task-complexity.js';

describe('extractComplexitySignals', () => {
  it('Feature 级关键词命中', () => {
    const signals = extractComplexitySignals('实现一个新的用户认证模块');
    expect(signals.featureScopeHits).toBeGreaterThanOrEqual(1);
  });

  it('跨模块信号命中', () => {
    const signals = extractComplexitySignals('需要跨多个模块进行全局重构');
    expect(signals.crossModuleHits).toBeGreaterThanOrEqual(1);
  });

  it('需求模糊信号命中', () => {
    const signals = extractComplexitySignals('能不能优化一下用户体验');
    expect(signals.vagueRequirementHits).toBeGreaterThanOrEqual(1);
  });

  it('显式 Spec 意图', () => {
    const signals = extractComplexitySignals('走 spec 流程来实现这个功能');
    expect(signals.explicitSpecIntent).toBe(true);
  });

  it('显式 Plan 意图', () => {
    const signals = extractComplexitySignals('帮我设计认证模块的方案');
    expect(signals.explicitPlanIntent).toBe(true);
  });

  it('简单任务信号命中', () => {
    const signals = extractComplexitySignals('修复一个 bug，修改配置文件');
    expect(signals.simpleTaskHits).toBeGreaterThanOrEqual(1);
  });

  it('文件引用计数', () => {
    const signals = extractComplexitySignals('修改 src/auth.ts 和 src/user.ts 和 src/db.ts');
    expect(signals.fileRefCount).toBe(3);
  });

  it('空消息返回零信号', () => {
    const signals = extractComplexitySignals('');
    expect(signals.featureScopeHits).toBe(0);
    expect(signals.crossModuleHits).toBe(0);
    expect(signals.explicitSpecIntent).toBe(false);
    expect(signals.explicitPlanIntent).toBe(false);
    expect(signals.simpleTaskHits).toBe(0);
  });
});

describe('evaluateTaskComplexity', () => {
  // ── spec 级别 ──

  it('显式 Spec 意图 → spec (高置信度)', () => {
    const result = evaluateTaskComplexity('走 spec 流程来实现用户管理功能');
    expect(result.level).toBe('spec');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('Feature 级关键词 ≥ 2 → spec', () => {
    const result = evaluateTaskComplexity('实现新功能，搭建新系统');
    expect(result.level).toBe('spec');
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('Feature + 跨模块 → spec', () => {
    const result = evaluateTaskComplexity('实现新功能，需要跨多个服务集成');
    expect(result.level).toBe('spec');
  });

  it('Feature + 需求模糊 → spec', () => {
    const result = evaluateTaskComplexity('实现新功能，能不能做得好一点');
    expect(result.level).toBe('spec');
  });

  it('跨模块 ≥ 2 + 需求模糊 → spec', () => {
    const result = evaluateTaskComplexity('跨模块跨服务的全局优化，可能还需要改善体验');
    expect(result.level).toBe('spec');
  });

  // ── plan 级别 ──

  it('显式 Plan 意图 → plan', () => {
    const result = evaluateTaskComplexity('帮我设计认证模块');
    expect(result.level).toBe('plan');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('架构关键词 ≥ 3 → plan', () => {
    const result = evaluateTaskComplexity('需要重构架构，重新设计认证模块，迁移到新方案');
    expect(result.level).toBe('plan');
  });

  it('多文件引用 + 架构关键词 → plan', () => {
    const result = evaluateTaskComplexity(
      '修改 src/auth.ts, src/user.ts, src/db.ts, src/api.ts, src/config.ts 的架构设计',
    );
    expect(result.level).toBe('plan');
  });

  // ── vibe 级别 ──

  it('简单 bug fix → vibe', () => {
    const result = evaluateTaskComplexity('修复 README 的拼写错误');
    expect(result.level).toBe('vibe');
  });

  it('简单配置修改 → vibe', () => {
    const result = evaluateTaskComplexity('update the config file');
    expect(result.level).toBe('vibe');
  });

  it('简单重命名 → vibe', () => {
    const result = evaluateTaskComplexity('rename the function');
    expect(result.level).toBe('vibe');
  });

  it('默认短消息 → vibe', () => {
    const result = evaluateTaskComplexity('fix the test');
    expect(result.level).toBe('vibe');
  });

  // ── 边界情况 ──

  it('空消息 → vibe', () => {
    const result = evaluateTaskComplexity('');
    expect(result.level).toBe('vibe');
  });

  it('中文长消息但不涉及架构 → vibe', () => {
    const result = evaluateTaskComplexity('把这个函数的变量名改一下，然后加个注释说明一下');
    expect(result.level).toBe('vibe');
  });

  it('英文 Feature 级 → spec', () => {
    const result = evaluateTaskComplexity('Build a new authentication system from scratch with end-to-end testing');
    expect(result.level).toBe('spec');
  });

  it('需求梳理请求 → spec', () => {
    const result = evaluateTaskComplexity('先梳理需求，我们需要实现一个全新的支付模块');
    expect(result.level).toBe('spec');
  });
});
