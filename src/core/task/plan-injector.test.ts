/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * plan-injector 单测
 *
 * 覆盖：E3, E4
 */

import { describe, it, expect } from 'vitest';
import { appendPlanToSystemPrompt, formatApprovedPlanXml } from './plan-injector.js';

describe('appendPlanToSystemPrompt', () => {
  it('空 planXml 返回原 prompt', () => {
    const prompt = 'L0\n\nL1\n\nL2';
    expect(appendPlanToSystemPrompt(prompt, '')).toBe(prompt);
  });

  it('非空 planXml 追加到末尾', () => {
    const prompt = 'L0\n\nL1\n\nL2';
    const xml = '<approved_plan plan_id="test"></approved_plan>';
    const result = appendPlanToSystemPrompt(prompt, xml);
    expect(result).toContain(xml);
    expect(result).toContain('L0');
    expect(result).toContain('L2');
  });
});

describe('formatApprovedPlanXml', () => {
  it('文件不存在返回空字符串', async () => {
    const result = await formatApprovedPlanXml('nonexistent_plan', '/tmp');
    expect(result).toBe('');
  });
});
