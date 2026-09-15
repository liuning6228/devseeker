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
  getDefinitionForPreset,
  GUIDE_READ_PATH_PREFIXES,
  GUIDE_URL_HOST_WHITELIST,
  ALL_SUBAGENT_TYPES,
} from '../../src/core/subagent/index.js';

describe('SubagentDefinition', () => {
  it('exposes all seven subagent types', () => {
    expect(ALL_SUBAGENT_TYPES).toEqual(['Browser', 'Research', 'Guide', 'Verify', 'Vision', 'RequirementAnalyzer', 'Debug']);
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

  it('Debug def: 诊断工具齐全，但无写工具（只诊断不修改）', () => {
    const def = getSubagentDefinition('Debug')!;
    const tools = def.allowedTools;
    expect(tools.has('trace_error')).toBe(true);
    expect(tools.has('get_problems')).toBe(true);
    expect(tools.has('bash')).toBe(true);
    // 子代理只读：不持有任何写工具（旧版 Debug 持有 search_replace）
    expect(tools.has('search_replace')).toBe(false);
    expect(tools.has('write_file')).toBe(false);
    expect(tools.has('append_file')).toBe(false);
    expect(tools.has('delete_file')).toBe(false);
  });

  it('只读不变量：所有内置 def 均不含写工具 / 派生工具（设计目标：只读调研验证）', () => {
    const WRITE_TOOLS = ['search_replace', 'write_file', 'append_file', 'delete_file'];
    for (const type of ALL_SUBAGENT_TYPES) {
      const def = getSubagentDefinition(type);
      expect(def, `missing def: ${type}`).toBeDefined();
      for (const w of WRITE_TOOLS) {
        expect(def!.allowedTools.has(w), `${type} must not have ${w}`).toBe(false);
      }
      expect(def!.allowedTools.has('Agent'), `${type} must not have Agent`).toBe(false);
    }
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

  it('getSubagentDefinition is case-insensitive and trims (F-4)', () => {
    // 模型常把 subagent_type 写成小写/带空格，不归一会打不中定义 → 零工具
    expect(getSubagentDefinition('browser' as unknown as Parameters<typeof getSubagentDefinition>[0])).toBe(BROWSER_DEFINITION);
    expect(getSubagentDefinition('  RESEARCH  ' as unknown as Parameters<typeof getSubagentDefinition>[0])).toBe(RESEARCH_DEFINITION);
    expect(getSubagentDefinition('vErIfY' as unknown as Parameters<typeof getSubagentDefinition>[0])).toBe(VERIFY_DEFINITION);
  });

  it('getSubagentDefinition returns undefined for unknown / non-string', () => {
    expect(getSubagentDefinition('NoSuchAgent' as unknown as Parameters<typeof getSubagentDefinition>[0])).toBeUndefined();
    expect(getSubagentDefinition(undefined as unknown as Parameters<typeof getSubagentDefinition>[0])).toBeUndefined();
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

  it('每个内置 def 都有角色级超时预算（timeoutMs，≤600s）', () => {
    for (const type of ALL_SUBAGENT_TYPES) {
      const def = getSubagentDefinition(type)!;
      expect(def.timeoutMs, `${type} missing timeoutMs`).toBeGreaterThan(0);
      expect(def.timeoutMs!, `${type} budget over schema cap`).toBeLessThanOrEqual(600_000);
    }
  });

  it('长任务角色给足预算：Verify / Debug = 300s（对齐 bash 上限，不再被 120s 默认值杀死）', () => {
    expect(getSubagentDefinition('Verify')!.timeoutMs).toBe(300_000);
    expect(getSubagentDefinition('Debug')!.timeoutMs).toBe(300_000);
  });

  it('preset def 也带角色级超时预算', () => {
    for (const preset of ['explore', 'planner', 'reviewer'] as const) {
      const def = getDefinitionForPreset(preset);
      expect(def, `missing preset: ${preset}`).toBeDefined();
      expect(def!.timeoutMs).toBeGreaterThan(0);
    }
  });
});
