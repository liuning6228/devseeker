/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C4 · Hooks Panel（B-P1-3）纯函数单测
 */

import { describe, it, expect } from 'vitest';
import {
  buildHooksPanelHtml,
  collectHooksPanelInput,
  type HooksPanelInput,
  type HooksPanelHook,
} from '../../src/webview/panels/hooks-panel.js';
import type { HookEvent } from '../../src/core/hooks/types.js';

function emptyByEvent(): Record<HookEvent, number> {
  return {
    pre_task: 0,
    post_task: 0,
    pre_tool_call: 0,
    post_tool_call: 0,
    on_error: 0,
  };
}

function makeInput(overrides: Partial<HooksPanelInput> = {}): HooksPanelInput {
  const base: HooksPanelInput = {
    workspaceRoot: '/ws',
    configPath: '/ws/.devseeker/hooks.json',
    configExists: true,
    parseError: undefined,
    hooks: [],
    counts: {
      total: 0,
      byEvent: emptyByEvent(),
      denying: 0,
      withMatch: 0,
      fromRuntime: 0,
    },
    generatedAt: '2026-05-02T10:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function makeHook(o: Partial<HooksPanelHook> = {}): HooksPanelHook {
  return {
    source: 'config',
    event: 'pre_tool_call',
    name: 'h',
    match: '*',
    deny: false,
    timeoutMs: 15000,
    cwd: '/ws',
    command: 'echo hi',
    ...o,
  };
}

describe('buildHooksPanelHtml', () => {
  it('CSP nonce + cspSource + default-src none', () => {
    const html = buildHooksPanelHtml(makeInput(), 'NX', 'vscode-webview://Z');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('nonce-NX');
    expect(html).toContain('vscode-webview://Z');
  });

  it('空状态：展示 no hooks configured 提示', () => {
    const html = buildHooksPanelHtml(makeInput(), 'N', 'C');
    expect(html).toContain('Hooks (0)');
    expect(html).toContain('No hooks configured');
  });

  it('无 workspace + 无配置：workspace 显示 (none)', () => {
    const html = buildHooksPanelHtml(
      makeInput({ workspaceRoot: undefined, configPath: undefined, configExists: false }),
      'N',
      'C',
    );
    expect(html).toContain('(none)');
    expect(html).toContain('(n/a)');
    // 没有 workspace 时不显示 warn banner（因为没有地方可创建）
    expect(html).not.toContain('⚠️');
  });

  it('有 workspace 但 configExists=false：展示 create template banner', () => {
    const html = buildHooksPanelHtml(
      makeInput({ configExists: false }),
      'N',
      'C',
    );
    expect(html).toContain('⚠️');
    expect(html).toContain('Create template');
    expect(html).toContain('data-action="createConfig"');
    expect(html).toContain('create &amp; open');
  });

  it('parseError 非空：展示红色 err-banner + escape', () => {
    const html = buildHooksPanelHtml(
      makeInput({ parseError: 'JSON parse failed: <bad>' }),
      'N',
      'C',
    );
    expect(html).toContain('err-banner');
    expect(html).toContain('❌');
    expect(html).toContain('&lt;bad&gt;');
  });

  it('hooks 表展示所有列 + deny/observe/source pills', () => {
    const byEvent = emptyByEvent();
    byEvent.pre_tool_call = 1;
    byEvent.on_error = 1;
    const html = buildHooksPanelHtml(
      makeInput({
        hooks: [
          makeHook({
            source: 'config',
            event: 'pre_tool_call',
            name: 'block-writes',
            match: 'tool=apply_patch safety=workspace_write',
            deny: true,
            timeoutMs: 5000,
            command: 'node check.js',
          }),
          makeHook({
            source: 'runtime',
            event: 'on_error',
            name: 'approval-gate',
            deny: false,
            command: '/* internal */',
          }),
        ],
        counts: {
          total: 2,
          byEvent,
          denying: 1,
          withMatch: 1,
          fromRuntime: 1,
        },
      }),
      'N',
      'C',
    );
    expect(html).toContain('Hooks (2)');
    expect(html).toContain('block-writes');
    expect(html).toContain('approval-gate');
    expect(html).toContain('tool=apply_patch safety=workspace_write');
    expect(html).toContain('5.0s'); // formatDuration(5000)
    expect(html).toContain('>deny<');
    expect(html).toContain('>observe<');
    expect(html).toContain('>runtime<');
    expect(html).toContain('>config<');
  });

  it('command / name 含 HTML 被 escape', () => {
    const byEvent = emptyByEvent();
    byEvent.pre_task = 1;
    const html = buildHooksPanelHtml(
      makeInput({
        hooks: [
          makeHook({
            event: 'pre_task',
            name: '<bad>',
            command: 'echo "hi" & ls',
          }),
        ],
        counts: { total: 1, byEvent, denying: 0, withMatch: 0, fromRuntime: 0 },
      }),
      'N',
      'C',
    );
    expect(html).not.toContain('<bad>');
    expect(html).toContain('&lt;bad&gt;');
    expect(html).toContain('&quot;hi&quot;');
    expect(html).toContain('&amp;');
  });

  it('stat pills 反映 counts', () => {
    const byEvent = emptyByEvent();
    byEvent.pre_tool_call = 3;
    byEvent.post_tool_call = 2;
    const html = buildHooksPanelHtml(
      makeInput({
        counts: { total: 5, byEvent, denying: 2, withMatch: 4, fromRuntime: 1 },
      }),
      'N',
      'C',
    );
    expect(html).toContain('total 5');
    expect(html).toContain('pre_tool_call 3');
    expect(html).toContain('post_tool_call 2');
    expect(html).not.toContain('pre_task'); // count=0 时不渲染
    expect(html).toContain('deny 2');
    expect(html).toContain('matchers 4');
    expect(html).toContain('runtime 1');
  });
});

describe('collectHooksPanelInput', () => {
  it('workspaceRoot 为空 → 空配置 + configPath undefined', async () => {
    const input = await collectHooksPanelInput({ workspaceRoot: undefined });
    expect(input.configPath).toBeUndefined();
    expect(input.configExists).toBe(false);
    expect(input.parseError).toBeUndefined();
    expect(input.hooks).toEqual([]);
    expect(input.counts.total).toBe(0);
  });

  it('workspace 指向不存在目录 → configExists=false + hooks=[]', async () => {
    const input = await collectHooksPanelInput({
      workspaceRoot: '/not/exist/xyz123',
    });
    expect(input.configPath).toBe('/not/exist/xyz123/.devseeker/hooks.json'.replace(/\//g, require('path').sep));
    expect(input.configExists).toBe(false);
    expect(input.hooks).toEqual([]);
  });

  it('合并 runtimeHooks：去重后标 source=runtime', async () => {
    const input = await collectHooksPanelInput({
      workspaceRoot: '/not/exist/xyz',
      runtimeHooks: [
        {
          event: 'pre_tool_call',
          command: 'noop',
          name: 'gate',
        },
      ],
    });
    expect(input.hooks.length).toBe(1);
    expect(input.hooks[0].source).toBe('runtime');
    expect(input.hooks[0].name).toBe('gate');
    expect(input.counts.fromRuntime).toBe(1);
    // pre_tool_call 默认 deny=true
    expect(input.hooks[0].deny).toBe(true);
  });

  it('post_task hook 不记为 deny（只有 pre_* 可 deny）', async () => {
    const input = await collectHooksPanelInput({
      workspaceRoot: '/not/exist/xyz',
      runtimeHooks: [
        { event: 'post_task', command: 'log', name: 'logger' },
      ],
    });
    expect(input.hooks[0].deny).toBe(false);
    expect(input.counts.denying).toBe(0);
  });

  it('match 的人类可读拼接：tool + safetyLevel', async () => {
    const input = await collectHooksPanelInput({
      workspaceRoot: '/not/exist/xyz',
      runtimeHooks: [
        {
          event: 'pre_tool_call',
          command: 'noop',
          match: { tool: 'apply_*', safetyLevel: 'workspace_write' },
        },
      ],
    });
    expect(input.hooks[0].match).toBe('tool=apply_* safety=workspace_write');
    expect(input.counts.withMatch).toBe(1);
  });

  it('无 match → 显示 *', async () => {
    const input = await collectHooksPanelInput({
      workspaceRoot: '/not/exist/xyz',
      runtimeHooks: [{ event: 'on_error', command: 'x' }],
    });
    expect(input.hooks[0].match).toBe('*');
    expect(input.counts.withMatch).toBe(0);
  });
});
