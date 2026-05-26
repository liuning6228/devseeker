/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W13.1-B · search_codebase 软降级平台化单测
 *
 * 重点验证：
 *   1. 未传 getIndex → 进入 missing 软降级，且内容按注入 shellKind 渲染命令模板
 *   2. getShellKind 注入优先于现场探测（DI 友好，避免依赖 process.env）
 *   3. 软降级 result.ok === true（不标红）
 *   4. display.shellKind 暴露当前 kind 供 UI 展示
 *   5. query 非法时仍走 hard fail（TOOL_ARGS_INVALID）
 */
import { describe, expect, it } from 'vitest';
import { SearchCodebaseTool } from '../../src/core/tools/search_codebase.js';
import type { ShellKind } from '../../src/core/tools/shell-hint.js';
import type { ToolContext } from '../../src/core/tools/types.js';

function makeCtx(): ToolContext {
  const ctrl = new AbortController();
  return {
    signal: ctrl.signal,
    cwd: 'c:\\ws',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as ToolContext;
}

describe('W13.1-B · search_codebase 软降级平台化', () => {
  it('无索引 + PowerShell → fallback 含 Select-String 模板', async () => {
    const tool = new SearchCodebaseTool({
      getIndex: () => undefined,
      getShellKind: () => 'powershell' as ShellKind,
    });
    const r = await tool.execute({ query: 'auto-indexer' }, makeCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('index not ready');
    expect(r.content).toContain('Select-String');
    const display = (r as { display?: Record<string, unknown> }).display ?? {};
    expect(display['shellKind']).toBe('powershell');
    expect(display['indexState']).toBe('not_ready');
    expect(display['soft']).toBe(true);
  });

  it('无索引 + cmd → fallback 含 findstr 模板', async () => {
    const tool = new SearchCodebaseTool({
      getIndex: () => undefined,
      getShellKind: () => 'cmd' as ShellKind,
    });
    const r = await tool.execute({ query: 'x' }, makeCtx());
    expect(r.content).toContain('findstr');
  });

  it('无索引 + bash → fallback 含 grep -rn 模板', async () => {
    const tool = new SearchCodebaseTool({
      getIndex: () => undefined,
      getShellKind: () => 'bash' as ShellKind,
    });
    const r = await tool.execute({ query: 'x' }, makeCtx());
    expect(r.content).toContain('grep -rn');
    const display = (r as { display?: Record<string, unknown> }).display ?? {};
    expect(display['shellKind']).toBe('bash');
  });

  it('未提供 getShellKind → 走现场环境探测（不报错即可）', async () => {
    const tool = new SearchCodebaseTool({
      getIndex: () => undefined,
    });
    const r = await tool.execute({ query: 'x' }, makeCtx());
    expect(r.ok).toBe(true);
    const display = (r as { display?: Record<string, unknown> }).display ?? {};
    // 任何平台都应有一个合法 kind
    expect(['powershell', 'cmd', 'bash', 'zsh', 'unknown']).toContain(display['shellKind']);
  });

  it('空 query → hard fail TOOL_ARGS_INVALID', async () => {
    const tool = new SearchCodebaseTool({ getIndex: () => undefined });
    const r = await tool.execute({ query: '' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('TOOL.ARGS.INVALID');
  });

  it('fallback 含 list_dir / workspace_symbol 建议（无论平台）', async () => {
    for (const kind of ['powershell', 'cmd', 'bash', 'zsh', 'unknown'] as ShellKind[]) {
      const tool = new SearchCodebaseTool({
        getIndex: () => undefined,
        getShellKind: () => kind,
      });
      const r = await tool.execute({ query: 'x' }, makeCtx());
      expect(r.content).toContain('list_dir');
      expect(r.content).toContain('workspace_symbol');
    }
  });
});
