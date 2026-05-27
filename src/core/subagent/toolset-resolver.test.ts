/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * toolset-resolver 单测
 *
 * 覆盖：ROADMAP.md 验收项 A3, A4, A5, C1, C2
 */

import { describe, it, expect } from 'vitest';
import { resolveToolsets, applyBlockedTools } from './toolset-resolver.js';
import { DELEGATE_BLOCKED_TOOLS, TOOLSETS } from './types.js';

describe('resolveToolsets', () => {
  it('search toolset 包含预期工具且不含 file/terminal', () => {
    const r = resolveToolsets(['search']);
    const expected = new Set(TOOLSETS.search);
    expect(r).toEqual(expected);
    expect(r.has('bash')).toBe(false);
    expect(r.has('search_replace')).toBe(false);
    expect(r.has('write_file')).toBe(false);
  });

  it('file toolset 不含 search/terminal 工具', () => {
    const r = resolveToolsets(['file']);
    expect(r.has('search_codebase')).toBe(false);
    expect(r.has('bash')).toBe(false);
  });

  it('search+file 的并集正确', () => {
    const r = resolveToolsets(['search', 'file']);
    const expected = new Set([...TOOLSETS.search, ...TOOLSETS.file]);
    expect(r).toEqual(expected);
  });

  it('planner toolsets 含 create_plan/git_log, 不含 bash/search_replace', () => {
    const r = resolveToolsets(['search', 'plan']);
    expect(r.has('create_plan')).toBe(true);
    expect(r.has('git_log')).toBe(true);
    expect(r.has('bash')).toBe(false);
    expect(r.has('search_replace')).toBe(false);
  });

  it('explorer preset 映射正确', () => {
    const r = resolveToolsets(['search']);
    expect(r.has('search_codebase')).toBe(true);
    expect(r.has('search_knowledge')).toBe(true);
    expect(r.has('lsp')).toBe(true);
    expect(r.has('list_dir')).toBe(true);
    expect(r.has('read_file')).toBe(true);
  });

  it('未知 toolset 抛 Error', () => {
    expect(() => resolveToolsets(['nonexistent' as any])).toThrow();
    expect(() => resolveToolsets(['nonexistent' as any])).toThrow(/unknown toolset/i);
  });

  it('空数组抛 TypeError', () => {
    expect(() => resolveToolsets([])).toThrow(TypeError);
  });

  it('all 通配符返回标记', () => {
    const r = resolveToolsets(['all']);
    expect(r.has('*')).toBe(true);
    expect(r.size).toBe(1);
  });
});

describe('applyBlockedTools', () => {
  it('移除 DELEGATE_BLOCKED_TOOLS', () => {
    const all = new Set([...DELEGATE_BLOCKED_TOOLS, 'read_file', 'bash']);
    const filtered = applyBlockedTools(all);
    expect(filtered.has('read_file')).toBe(true);
    expect(filtered.has('bash')).toBe(true);
    expect(filtered.has('agent')).toBe(false);
    expect(filtered.has('delegate_task')).toBe(false);
    expect(filtered.has('create_agent')).toBe(false);
    expect(filtered.has('ask_user_question')).toBe(false);
    expect(filtered.has('skill')).toBe(false);
  });
});
