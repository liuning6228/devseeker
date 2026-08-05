/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Plan Orchestrator Spec 模式单测（P1）
 *
 * 覆盖：
 * - createOrchestratorState：spec 模式初始阶段为 requirement
 * - createOrchestratorState：plan 模式初始阶段为 explore
 * - advancePhase：spec 模式完整流转
 * - advancePhase：plan 模式完整流转（不受新阶段影响）
 * - applyFallback：spec 模式回退到 explore
 * - shouldFallback：回退次数限制
 * - buildRequirementPrompt：内容完整性
 * - buildTaskSplitPrompt：内容完整性
 */

import { describe, it, expect } from 'vitest';
import {
  createOrchestratorState,
  advancePhase,
  applyFallback,
  shouldFallback,
  buildRequirementPrompt,
  buildTaskSplitPrompt,
} from '../../src/core/task/plan-orchestrator.js';
import type { OrchestratorState } from '../../src/core/task/plan-orchestrator.js';

describe('createOrchestratorState', () => {
  it('spec mode starts at requirement', () => {
    const state = createOrchestratorState('spec');
    expect(state.phase).toBe('requirement');
    expect(state.mode).toBe('spec');
    expect(state.fallbackCount).toBe(0);
    expect(state.maxFallback).toBe(1);
  });

  it('plan mode starts at explore', () => {
    const state = createOrchestratorState('plan');
    expect(state.phase).toBe('explore');
    expect(state.mode).toBe('plan');
  });

  it('defaults to plan mode', () => {
    const state = createOrchestratorState();
    expect(state.mode).toBe('plan');
    expect(state.phase).toBe('explore');
  });
});

describe('advancePhase — spec mode', () => {
  it('follows requirement → explore → plan → task_split → verify → complete', () => {
    let state: OrchestratorState = createOrchestratorState('spec');
    const phases: string[] = [state.phase];

    while (state.phase !== 'complete') {
      state = advancePhase(state);
      phases.push(state.phase);
    }

    expect(phases).toEqual([
      'requirement',
      'explore',
      'plan',
      'task_split',
      'verify',
      'complete',
    ]);
  });

  it('complete stays at complete', () => {
    let state: OrchestratorState = createOrchestratorState('spec');
    // Advance to complete
    while (state.phase !== 'complete') {
      state = advancePhase(state);
    }
    const nextState = advancePhase(state);
    expect(nextState.phase).toBe('complete');
  });
});

describe('advancePhase — plan mode', () => {
  it('follows explore → plan → verify → complete (skips requirement/task_split)', () => {
    let state: OrchestratorState = createOrchestratorState('plan');
    const phases: string[] = [state.phase];

    while (state.phase !== 'complete') {
      state = advancePhase(state);
      phases.push(state.phase);
    }

    expect(phases).toEqual([
      'explore',
      'plan',
      'verify',
      'complete',
    ]);
  });
});

describe('applyFallback', () => {
  it('resets phase to explore and increments counter', () => {
    const state: OrchestratorState = {
      ...createOrchestratorState('spec'),
      phase: 'plan',
      fallbackCount: 0,
    };
    const fallback = applyFallback(state);
    expect(fallback.phase).toBe('explore');
    expect(fallback.fallbackCount).toBe(1);
    expect(fallback.mode).toBe('spec');
  });

  it('preserves mode during fallback', () => {
    const state: OrchestratorState = {
      ...createOrchestratorState('spec'),
      phase: 'task_split',
    };
    const fallback = applyFallback(state);
    expect(fallback.mode).toBe('spec');
  });
});

describe('shouldFallback', () => {
  it('allows fallback when under limit', () => {
    const state: OrchestratorState = {
      ...createOrchestratorState('spec'),
      fallbackCount: 0,
    };
    expect(shouldFallback(state)).toBe(true);
  });

  it('disallows fallback when at limit', () => {
    const state: OrchestratorState = {
      ...createOrchestratorState('spec'),
      fallbackCount: 1,
    };
    expect(shouldFallback(state)).toBe(false);
  });
});

describe('buildRequirementPrompt', () => {
  it('includes the goal', () => {
    const prompt = buildRequirementPrompt('Add user authentication');
    expect(prompt).toContain('Add user authentication');
  });

  it('includes AskUserQuestion instruction', () => {
    const prompt = buildRequirementPrompt('test');
    expect(prompt).toContain('AskUserQuestion');
  });

  it('includes output format guidance', () => {
    const prompt = buildRequirementPrompt('test');
    expect(prompt).toContain('验收条件');
    expect(prompt).toContain('边界情况');
  });
});

describe('buildTaskSplitPrompt', () => {
  it('includes feature name and summaries', () => {
    const prompt = buildTaskSplitPrompt('auth', 'Need login', 'Use JWT');
    expect(prompt).toContain('auth');
    expect(prompt).toContain('Need login');
    expect(prompt).toContain('Use JWT');
  });

  it('includes task split rules', () => {
    const prompt = buildTaskSplitPrompt('x', 'req', 'design');
    expect(prompt).toContain('1 个 Agent turn');
    expect(prompt).toContain('验收条件');
    expect(prompt).toContain('最多拆分 15');
  });

  it('includes output format', () => {
    const prompt = buildTaskSplitPrompt('x', 'r', 'd');
    expect(prompt).toContain('- [ ]');
    expect(prompt).toContain('受影响文件');
  });
});
