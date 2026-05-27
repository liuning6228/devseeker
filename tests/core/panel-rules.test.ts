/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C3 · Rules Panel（B-P1-7）纯函数单测
 */

import { describe, it, expect } from 'vitest';
import {
  buildRulesPanelHtml,
  type RulesPanelInput,
} from '../../src/webview/panels/rules-panel.js';

function makeInput(overrides: Partial<RulesPanelInput> = {}): RulesPanelInput {
  const base: RulesPanelInput = {
    workspaceRoot: '/ws',
    globalRulesDir: '/home/u/.devseeker/rules',
    workspaceRulesDir: '/ws/.devseeker/rules',
    rules: [],
    errors: [],
    counts: {
      total: 0,
      alwaysOn: 0,
      glob: 0,
      modelDecision: 0,
      bySource: { global: 0, workspace: 0, nested: 0 },
    },
    generatedAt: '2026-05-02T10:00:00.000Z',
  };
  return { ...base, ...overrides };
}

describe('buildRulesPanelHtml', () => {
  it('CSP nonce + cspSource + default-src none', () => {
    const html = buildRulesPanelHtml(makeInput(), 'NX', 'vscode-webview://Z');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('nonce-NX');
    expect(html).toContain('vscode-webview://Z');
  });

  it('空状态：展示 no rules loaded 提示', () => {
    const html = buildRulesPanelHtml(makeInput(), 'N', 'C');
    expect(html).toContain('Rules (0)');
    expect(html).toContain('No rules loaded');
  });

  it('无 workspace 时 workspaceRulesDir 显示 (n/a)', () => {
    const html = buildRulesPanelHtml(
      makeInput({ workspaceRoot: undefined, workspaceRulesDir: undefined }),
      'N',
      'C',
    );
    expect(html).toContain('(n/a)');
    expect(html).toContain('(none)');
  });

  it('rules 表展示所有列 + openFile 动作 data-path', () => {
    const html = buildRulesPanelHtml(
      makeInput({
        rules: [
          {
            name: 'my-rule',
            kind: 'glob',
            source: 'workspace',
            priority: 10,
            description: 'test rule',
            globs: ['**/*.ts', 'src/**'],
            filePath: '/ws/.devseeker/rules/my-rule.md',
            contentChars: 256,
          },
        ],
        counts: {
          total: 1,
          alwaysOn: 0,
          glob: 1,
          modelDecision: 0,
          bySource: { global: 0, workspace: 1, nested: 0 },
        },
      }),
      'N',
      'C',
    );
    expect(html).toContain('Rules (1)');
    expect(html).toContain('my-rule');
    expect(html).toContain('**/*.ts');
    expect(html).toContain('256');
    expect(html).toContain('data-action="openFile"');
    expect(html).toContain('data-path="/ws/.devseeker/rules/my-rule.md"');
  });

  it('rule name / description / filePath 含 HTML 被 escape', () => {
    const html = buildRulesPanelHtml(
      makeInput({
        rules: [
          {
            name: '<bad>',
            kind: 'always_on',
            source: 'global',
            priority: 0,
            description: 'a & b',
            globs: [],
            filePath: '/tmp/"quoted".md',
            contentChars: 10,
          },
        ],
        counts: {
          total: 1,
          alwaysOn: 1,
          glob: 0,
          modelDecision: 0,
          bySource: { global: 1, workspace: 0, nested: 0 },
        },
      }),
      'N',
      'C',
    );
    expect(html).not.toContain('<bad>'); // rendered as text
    expect(html).toContain('&lt;bad&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('&quot;quoted&quot;');
  });

  it('errors 列表非空时渲染 + escape', () => {
    const html = buildRulesPanelHtml(
      makeInput({
        errors: [
          { file: '/ws/.devseeker/rules/bad.md', message: 'YAML: <syntax>' },
        ],
      }),
      'N',
      'C',
    );
    expect(html).toContain('Parse Errors (1)');
    expect(html).toContain('&lt;syntax&gt;');
    expect(html).toContain('data-path="/ws/.devseeker/rules/bad.md"');
  });

  it('stat pills 反映 counts', () => {
    const html = buildRulesPanelHtml(
      makeInput({
        counts: {
          total: 5,
          alwaysOn: 2,
          glob: 2,
          modelDecision: 1,
          bySource: { global: 3, workspace: 2, nested: 0 },
        },
      }),
      'N',
      'C',
    );
    expect(html).toContain('total 5');
    expect(html).toContain('always_on 2');
    expect(html).toContain('glob 2');
    expect(html).toContain('model_decision 1');
    expect(html).toContain('global 3');
    expect(html).toContain('workspace 2');
    expect(html).not.toContain('nested'); // count=0 时不渲染
  });
});
