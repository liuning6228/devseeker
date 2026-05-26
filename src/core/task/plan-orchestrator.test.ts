/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * plan-orchestrator 单测
 *
 * 覆盖：E5, E6
 */

import { describe, it, expect } from 'vitest';
import {
  createOrchestratorState,
  advancePhase,
  shouldFallback,
  applyFallback,
  buildExplorePrompt,
  buildVerifyPrompt,
} from './plan-orchestrator.js';

describe('OrchestratorState', () => {
  it('初始状态为 explore', () => {
    const state = createOrchestratorState();
    expect(state.phase).toBe('explore');
    expect(state.fallbackCount).toBe(0);
  });

  it('阶段推进: explore → plan → verify → complete', () => {
    const s1 = advancePhase(createOrchestratorState());
    expect(s1.phase).toBe('plan');
    const s2 = advancePhase(s1);
    expect(s2.phase).toBe('verify');
    const s3 = advancePhase(s2);
    expect(s3.phase).toBe('complete');
    const s4 = advancePhase(s3);
    expect(s4.phase).toBe('complete');
  });

  it('回退不超过 maxFallback 次', () => {
    let state = createOrchestratorState();
    expect(shouldFallback(state)).toBe(true);
    state = applyFallback(state);
    expect(state.phase).toBe('explore');
    expect(state.fallbackCount).toBe(1);
    expect(shouldFallback(state)).toBe(false);
  });
});

describe('buildExplorePrompt', () => {
  it('包含探索目标和产出格式要求', () => {
    const prompt = buildExplorePrompt('重构认证模块');
    expect(prompt).toContain('重构认证模块');
    expect(prompt).toContain('不要修改');
    expect(prompt).toContain('## 受影响文件');
  });
});

describe('buildVerifyPrompt', () => {
  it('包含需要验证的文件列表', () => {
    const prompt = buildVerifyPrompt('plan_auth_123', ['src/auth.ts', 'src/user.ts']);
    expect(prompt).toContain('plan_auth_123');
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('src/user.ts');
  });
});
