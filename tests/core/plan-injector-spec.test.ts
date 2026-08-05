/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Plan Injector Spec 扩展单测（P1）
 *
 * 覆盖：
 * - formatSpecXml：SpecDocument → XML 格式化
 * - formatSpecXml：超限裁剪
 * - formatSpecTasksXml：任务列表 → checklist XML
 * - formatSpecTasksXml：空任务返回空字符串
 * - appendSpecToSystemPrompt：拼接逻辑
 */

import { describe, it, expect } from 'vitest';
import {
  formatSpecXml,
  formatSpecTasksXml,
  appendSpecToSystemPrompt,
} from '../../src/core/task/plan-injector.js';
import type { SpecDocument } from '../../src/core/task/spec-manager.js';

function mkDoc(overrides: Partial<SpecDocument> = {}): SpecDocument {
  return {
    meta: { feature: 'test-feature', status: 'draft', created: '2026-08-05' },
    requirement: 'User needs authentication',
    design: 'Use JWT tokens with refresh',
    tasks: '- [ ] 1. Create login endpoint\n  - _验收条件: POST /login returns token_\n- [x] 2. Create logout endpoint\n- [ ] 3. Add middleware',
    raw: '',
    ...overrides,
  };
}

describe('formatSpecXml', () => {
  it('formats a spec document as XML', () => {
    const xml = formatSpecXml(mkDoc());
    expect(xml).toContain('<spec feature="test-feature" status="draft">');
    expect(xml).toContain('<requirement>');
    expect(xml).toContain('User needs authentication');
    expect(xml).toContain('<design>');
    expect(xml).toContain('Use JWT tokens');
    expect(xml).toContain('<tasks>');
    expect(xml).toContain('</spec>');
  });

  it('escapes XML special characters', () => {
    const doc = mkDoc({ requirement: 'Need <script> & "quotes"' });
    const xml = formatSpecXml(doc);
    expect(xml).toContain('&lt;script&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;quotes&quot;');
  });

  it('omits empty sections', () => {
    const doc = mkDoc({ requirement: '', design: '' });
    const xml = formatSpecXml(doc);
    expect(xml).not.toContain('<requirement>');
    expect(xml).not.toContain('<design>');
    expect(xml).toContain('<tasks>');
  });

  it('truncates long sections', () => {
    const longText = 'A'.repeat(2000);
    const doc = mkDoc({ requirement: longText });
    const xml = formatSpecXml(doc);
    // Should be truncated to 800 chars + ellipsis
    expect(xml.length).toBeLessThan(2000);
    expect(xml).toContain('...');
  });

  it('truncates entire XML if still over MAX_CHARS', () => {
    const longText = 'B'.repeat(3000);
    const doc = mkDoc({ requirement: longText, design: longText, tasks: longText });
    const xml = formatSpecXml(doc);
    expect(xml.length).toBeLessThanOrEqual(2000);
    expect(xml).toContain('...truncated');
    expect(xml).toContain('</spec>');
  });
});

describe('formatSpecTasksXml', () => {
  it('formats task checklist as XML', () => {
    const xml = formatSpecTasksXml(mkDoc());
    expect(xml).toContain('<spec_tasks feature="test-feature">');
    expect(xml).toContain('<task done="false">Create login endpoint</task>');
    expect(xml).toContain('<task done="true">Create logout endpoint</task>');
    expect(xml).toContain('<task done="false">Add middleware</task>');
    expect(xml).toContain('</spec_tasks>');
  });

  it('returns empty string when no tasks', () => {
    const doc = mkDoc({ tasks: '' });
    expect(formatSpecTasksXml(doc)).toBe('');
  });

  it('returns empty string when tasks have no checklist items', () => {
    const doc = mkDoc({ tasks: 'Just some text\nNo checklist here' });
    expect(formatSpecTasksXml(doc)).toBe('');
  });

  it('handles tasks without numbers', () => {
    const doc = mkDoc({ tasks: '- [ ] Implement login\n- [x] Write tests' });
    const xml = formatSpecTasksXml(doc);
    expect(xml).toContain('<task done="false">Implement login</task>');
    expect(xml).toContain('<task done="true">Write tests</task>');
  });
});

describe('appendSpecToSystemPrompt', () => {
  it('appends XML to system prompt', () => {
    const result = appendSpecToSystemPrompt('System prompt content', '<spec>data</spec>');
    expect(result).toContain('System prompt content');
    expect(result).toContain('<spec>data</spec>');
  });

  it('returns original prompt when XML is empty', () => {
    const result = appendSpecToSystemPrompt('System prompt', '');
    expect(result).toBe('System prompt');
  });
});
