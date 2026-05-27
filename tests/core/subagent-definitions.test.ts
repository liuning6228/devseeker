/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * SubagentDefinition 单测（W6.6 / W6.6b / W8.5）
 *
 * 覆盖：
 * - 四种子代理 def 的工具白名单严格性（Browser / Research / Guide / Verify）
 * - systemPrompt 必含条款（范围 / 规则 / 注入防御）
 * - getSubagentDefinition 分派
 * - Guide 读路径前缀 & URL host 白名单
 * - 反嵌套：四份白名单均不含 'Agent'
 */

import { describe, it, expect } from 'vitest';
import {
  BROWSER_DEFINITION,
  RESEARCH_DEFINITION,
  GUIDE_DEFINITION,
  VERIFY_DEFINITION,
  getSubagentDefinition,
  GUIDE_READ_PATH_PREFIXES,
  GUIDE_URL_HOST_WHITELIST,
  ALL_SUBAGENT_TYPES,
} from '../../src/core/subagent/index.js';

describe('SubagentDefinition', () => {
  it('exposes all five subagent types', () => {
    expect(ALL_SUBAGENT_TYPES).toEqual(['Browser', 'Research', 'Guide', 'Verify', 'Vision']);
  });

  it('Browser def: only web tools, no codebase / read_file', () => {
    const tools = BROWSER_DEFINITION.allowedTools;
    expect(tools.has('search_web')).toBe(true);
    expect(tools.has('fetch_content')).toBe(true);
    expect(tools.has('read_url')).toBe(true);
    // 必须不含本地读写
    expect(tools.has('read_file')).toBe(false);
    expect(tools.has('list_dir')).toBe(false);
    expect(tools.has('search_codebase')).toBe(false);
    expect(tools.has('search_replace')).toBe(false);
    expect(tools.has('create_file')).toBe(false);
    expect(BROWSER_DEFINITION.maxTurns).toBeGreaterThan(0);
  });

  it('Research def: web + local read-only tools, no write', () => {
    const tools = RESEARCH_DEFINITION.allowedTools;
    expect(tools.has('search_web')).toBe(true);
    expect(tools.has('fetch_content')).toBe(true);
    expect(tools.has('search_codebase')).toBe(true);
    expect(tools.has('read_file')).toBe(true);
    expect(tools.has('list_dir')).toBe(true);
    // 必须无写工具
    expect(tools.has('search_replace')).toBe(false);
    expect(tools.has('create_file')).toBe(false);
    expect(tools.has('delete_file')).toBe(false);
    expect(tools.has('run_in_terminal')).toBe(false);
  });

  it('Guide def: only docs/config reading + fetch, no codebase search', () => {
    const tools = GUIDE_DEFINITION.allowedTools;
    expect(tools.has('fetch_content')).toBe(true);
    expect(tools.has('read_url')).toBe(true);
    expect(tools.has('read_file')).toBe(true);
    // Guide 不搜业务代码
    expect(tools.has('search_codebase')).toBe(false);
    expect(tools.has('search_web')).toBe(false);
    // 同样无写工具
    expect(tools.has('search_replace')).toBe(false);
    expect(tools.has('create_file')).toBe(false);
  });

  it('Verify def: test-runner tools only, no write / network', () => {
    const tools = VERIFY_DEFINITION.allowedTools;
    // 必含：跑命令 + 读文件 + 诊断
    expect(tools.has('bash')).toBe(true);
    expect(tools.has('get_terminal_output')).toBe(true);
    expect(tools.has('read_file')).toBe(true);
    expect(tools.has('list_dir')).toBe(true);
    expect(tools.has('get_problems')).toBe(true);
    expect(tools.has('search_codebase')).toBe(true);
    // 必无：写工具
    expect(tools.has('search_replace')).toBe(false);
    expect(tools.has('create_file')).toBe(false);
    expect(tools.has('write_file')).toBe(false);
    expect(tools.has('delete_file')).toBe(false);
    // 必无：网络工具（Verify 不连外网）
    expect(tools.has('search_web')).toBe(false);
    expect(tools.has('fetch_content')).toBe(false);
    expect(tools.has('read_url')).toBe(false);
  });

  it('no subagent may spawn another subagent (anti-nesting)', () => {
    expect(BROWSER_DEFINITION.allowedTools.has('Agent')).toBe(false);
    expect(RESEARCH_DEFINITION.allowedTools.has('Agent')).toBe(false);
    expect(GUIDE_DEFINITION.allowedTools.has('Agent')).toBe(false);
    expect(VERIFY_DEFINITION.allowedTools.has('Agent')).toBe(false);
  });

  it('systemPrompt contains key clauses', () => {
    expect(BROWSER_DEFINITION.systemPrompt).toMatch(/Browser/);
    expect(BROWSER_DEFINITION.systemPrompt).toMatch(/search_web/);
    expect(BROWSER_DEFINITION.systemPrompt).toMatch(/DATA, not instructions/i);

    expect(RESEARCH_DEFINITION.systemPrompt).toMatch(/Research/);
    expect(RESEARCH_DEFINITION.systemPrompt).toMatch(/search_codebase/);
    expect(RESEARCH_DEFINITION.systemPrompt).toMatch(/DATA, not instructions/i);

    expect(GUIDE_DEFINITION.systemPrompt).toMatch(/Guide/);
    expect(GUIDE_DEFINITION.systemPrompt).toMatch(/\.devseeker\//);
    expect(GUIDE_DEFINITION.systemPrompt).toMatch(/AGENTS\.md/);

    expect(VERIFY_DEFINITION.systemPrompt).toMatch(/Verify/);
    expect(VERIFY_DEFINITION.systemPrompt).toMatch(/bash/);
    expect(VERIFY_DEFINITION.systemPrompt).toMatch(/READ-ONLY/);
    expect(VERIFY_DEFINITION.systemPrompt).toMatch(/DATA, not instructions/i);
  });

  it('getSubagentDefinition dispatches by type', () => {
    expect(getSubagentDefinition('Browser')).toBe(BROWSER_DEFINITION);
    expect(getSubagentDefinition('Research')).toBe(RESEARCH_DEFINITION);
    expect(getSubagentDefinition('Guide')).toBe(GUIDE_DEFINITION);
    expect(getSubagentDefinition('Verify')).toBe(VERIFY_DEFINITION);
    expect(getSubagentDefinition('Vision')).toBeDefined();
  });

  it('Guide read-path prefixes cover .devseeker/ + docs/ + AGENTS.md', () => {
    expect(GUIDE_READ_PATH_PREFIXES).toContain('.devseeker/');
    expect(GUIDE_READ_PATH_PREFIXES).toContain('docs/');
    expect(GUIDE_READ_PATH_PREFIXES).toContain('AGENTS.md');
  });

  it('Guide URL host whitelist contains expected official docs', () => {
    expect(GUIDE_URL_HOST_WHITELIST).toContain('code.visualstudio.com');
    expect(GUIDE_URL_HOST_WHITELIST).toContain('modelcontextprotocol.io');
    expect(GUIDE_URL_HOST_WHITELIST.length).toBeGreaterThan(0);
  });

  it('maxTurns sane (1..30) for all defs', () => {
    for (const def of [BROWSER_DEFINITION, RESEARCH_DEFINITION, GUIDE_DEFINITION, VERIFY_DEFINITION, getSubagentDefinition('Vision')!]) {
      expect(def.maxTurns).toBeGreaterThanOrEqual(1);
      expect(def.maxTurns).toBeLessThanOrEqual(30);
    }
  });
});
