/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Mode 基础设施单测（W6b1）
 *
 * 覆盖：
 * - ModeManager：初始态 / setMode 幂等 / history 追加 / snapshot / setPlanDoc
 * - isToolAllowedInMode：4 mode × 5 safetyLevel + switch_mode 特例
 * - renderModePromptSection：四种 mode 均返回含 Mode 名称的字符串
 */

import { describe, it, expect } from 'vitest';
import {
  ModeManager,
  DEFAULT_MODE,
  ALL_MODES,
  MODE_INFO,
  isToolAllowedInMode,
  renderModePromptSection,
  type Mode,
} from '../../src/core/modes/index.js';
import type { ToolSafetyLevel } from '../../src/core/tools/types.js';

function fakeTool(name: string, safetyLevel: ToolSafetyLevel) {
  return { name, safetyLevel };
}

describe('ModeManager', () => {
  it('defaults to agent with initial history entry', () => {
    const mm = new ModeManager();
    expect(mm.getCurrent()).toBe(DEFAULT_MODE);
    expect(DEFAULT_MODE).toBe('agent');

    const snap = mm.snapshot();
    expect(snap.current).toBe('agent');
    expect(snap.history).toHaveLength(1);
    expect(snap.history[0]).toMatchObject({ mode: 'agent', reason: 'initial' });
    expect(snap.planDoc).toBeUndefined();
  });

  it('accepts non-default initial mode', () => {
    const mm = new ModeManager('plan');
    expect(mm.getCurrent()).toBe('plan');
    expect(mm.snapshot().history[0]).toMatchObject({ mode: 'plan', reason: 'initial' });
  });

  it('setMode appends history and returns true on change', () => {
    const mm = new ModeManager();
    const changed = mm.setMode('plan', 'user_selected');
    expect(changed).toBe(true);
    expect(mm.getCurrent()).toBe('plan');

    const snap = mm.snapshot();
    expect(snap.history).toHaveLength(2);
    expect(snap.history[1]).toMatchObject({ mode: 'plan', reason: 'user_selected' });
    expect(typeof snap.history[1].enteredAt).toBe('number');
  });

  it('setMode is idempotent: same target returns false and does not append', () => {
    const mm = new ModeManager();
    const changed = mm.setMode('agent', 'noop');
    expect(changed).toBe(false);
    expect(mm.snapshot().history).toHaveLength(1);
  });

  it('setPlanDoc updates snapshot', () => {
    const mm = new ModeManager();
    expect(mm.snapshot().planDoc).toBeUndefined();
    mm.setPlanDoc('/tmp/plan.md');
    expect(mm.snapshot().planDoc).toBe('/tmp/plan.md');
    mm.setPlanDoc(undefined);
    expect(mm.snapshot().planDoc).toBeUndefined();
  });

  it('snapshot history is a copy (caller cannot mutate internal state)', () => {
    const mm = new ModeManager();
    const snap = mm.snapshot();
    snap.history.push({ mode: 'ask', enteredAt: 0, reason: 'tamper' });
    expect(mm.snapshot().history).toHaveLength(1);
  });
});

describe('isToolAllowedInMode', () => {
  const levels: ToolSafetyLevel[] = [
    'read_only',
    'workspace_write',
    'destructive',
    'network',
    'external',
  ];

  it('Agent / Debug allow every regular tool', () => {
    for (const lvl of levels) {
      const t = fakeTool(`t_${lvl}`, lvl);
      expect(isToolAllowedInMode(t, 'agent')).toBe(true);
      expect(isToolAllowedInMode(t, 'debug')).toBe(true);
    }
  });

  it('Plan allows read_only + network + create_plan (extra)', () => {
    expect(isToolAllowedInMode(fakeTool('read_file', 'read_only'), 'plan')).toBe(true);
    expect(isToolAllowedInMode(fakeTool('create_plan', 'workspace_write'), 'plan')).toBe(true);
    // W6b3：联网工具在 Plan 允许（DESIGN §M12.8 鼓励 Plan 联网）
    expect(isToolAllowedInMode(fakeTool('fetch_content', 'network'), 'plan')).toBe(true);

    expect(isToolAllowedInMode(fakeTool('write_file', 'workspace_write'), 'plan')).toBe(false);
    expect(isToolAllowedInMode(fakeTool('bash', 'destructive'), 'plan')).toBe(false);
    expect(isToolAllowedInMode(fakeTool('skill', 'external'), 'plan')).toBe(false);
  });

  it('Ask allows read_only + network (no create_plan, no switch_mode)', () => {
    expect(isToolAllowedInMode(fakeTool('read_file', 'read_only'), 'ask')).toBe(true);
    // W6b3：联网工具在 Ask 允许（需要查资料才能回答）
    expect(isToolAllowedInMode(fakeTool('fetch_content', 'network'), 'ask')).toBe(true);

    expect(isToolAllowedInMode(fakeTool('create_plan', 'workspace_write'), 'ask')).toBe(false);
    expect(isToolAllowedInMode(fakeTool('write_file', 'workspace_write'), 'ask')).toBe(false);
    expect(isToolAllowedInMode(fakeTool('bash', 'destructive'), 'ask')).toBe(false);
  });

  it('switch_mode is visible only in agent / debug', () => {
    const sm = fakeTool('switch_mode', 'read_only');
    expect(isToolAllowedInMode(sm, 'agent')).toBe(true);
    expect(isToolAllowedInMode(sm, 'debug')).toBe(true);
    expect(isToolAllowedInMode(sm, 'plan')).toBe(false);
    expect(isToolAllowedInMode(sm, 'ask')).toBe(false);
  });
});

describe('renderModePromptSection', () => {
  it('includes the mode label for every mode', () => {
    for (const m of ALL_MODES) {
      const s = renderModePromptSection(m);
      expect(s).toContain(MODE_INFO[m].label);
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it('plan section explicitly marks read-only', () => {
    expect(renderModePromptSection('plan')).toMatch(/READ-ONLY/i);
  });

  it('ask section explicitly marks read-only', () => {
    expect(renderModePromptSection('ask')).toMatch(/READ-ONLY/i);
  });

  it('agent section mentions switch_mode hint', () => {
    expect(renderModePromptSection('agent')).toContain('switch_mode');
  });

  it('debug section contains the 5-step troubleshooting loop', () => {
    const s = renderModePromptSection('debug');
    expect(s).toContain('Step 1');
    expect(s).toContain('REPRODUCE');
    expect(s).toContain('Step 2');
    expect(s).toContain('COLLECT EVIDENCE');
    expect(s).toContain('Step 3');
    expect(s).toContain('LOCATE ROOT CAUSE');
    expect(s).toContain('Step 4');
    expect(s).toContain('FIX');
    expect(s).toContain('Step 5');
    expect(s).toContain('VERIFY');
  });

  it('debug section forbids editing before seeing error output', () => {
    const s = renderModePromptSection('debug');
    expect(s).toMatch(/NEVER edit code before seeing the actual error output/i);
  });

  it('debug section mandates the verify step', () => {
    const s = renderModePromptSection('debug');
    expect(s).toMatch(/NEVER skip the VERIFY step/i);
  });
});

describe('ALL_MODES / MODE_INFO consistency', () => {
  it('MODE_INFO covers every mode with non-empty label/description', () => {
    for (const m of ALL_MODES) {
      const info = MODE_INFO[m as Mode];
      expect(info.id).toBe(m);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
    }
  });
});
