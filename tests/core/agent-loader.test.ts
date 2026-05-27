/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W14.4 · AgentLoader + SubagentRegistry 单测
 *
 * 覆盖：
 *   1. parseAgentFile：frontmatter 解析 / body 必须非空 / 缺失 description 默认空
 *   2. parseToolList：逗号/分号/空白分隔
 *   3. AgentLoader.load：
 *      - 目录不存在 → 空结果 + 无 error
 *      - AGENT.md 落目录下 → 正常解析
 *      - 扁平 .md 兼容
 *      - name 与内置冲突 → 过滤 + error
 *      - 多个同名 → 去重（后者覆盖前者）
 *      - 无 tools frontmatter → 使用默认白名单
 *      - body 空 → error
 *   4. toSubagentDefinition：字段映射 + maxTurns 默认
 *   5. createSubagentRegistry：内置优先 + 自定义不允许覆盖内置
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  AgentLoader,
  DEFAULT_CUSTOM_AGENT_TOOLS,
  DEFAULT_CUSTOM_AGENT_MAX_TURNS,
  parseAgentFile,
  parseToolList,
  toSubagentDefinition,
} from '../../src/core/agents/index.js';
import {
  createSubagentRegistry,
  createBuiltinSubagentRegistry,
} from '../../src/core/subagent/index.js';
import type { SubagentDefinition } from '../../src/core/subagent/index.js';

describe('W14.4 · parseToolList', () => {
  it('逗号分隔', () => {
    expect(parseToolList('read_file, list_dir, search_codebase')).toEqual([
      'read_file',
      'list_dir',
      'search_codebase',
    ]);
  });
  it('分号 / 空白混合', () => {
    expect(parseToolList('read_file; list_dir  search_codebase')).toEqual([
      'read_file',
      'list_dir',
      'search_codebase',
    ]);
  });
  it('空字符串 → []', () => {
    expect(parseToolList('')).toEqual([]);
  });
});

describe('W14.4 · parseAgentFile', () => {
  it('正常 frontmatter + body', () => {
    const raw = [
      '---',
      'description: Security reviewer',
      'tools: read_file, search_codebase',
      'max_turns: 10',
      '---',
      '',
      '# Role',
      'You are a security reviewer.',
    ].join('\n');
    const { agent, error } = parseAgentFile(
      '/tmp/.devseeker/agents/security-reviewer/AGENT.md',
      raw,
    );
    expect(error).toBeUndefined();
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('security-reviewer');
    expect(agent!.description).toBe('Security reviewer');
    expect(agent!.toolNames).toEqual(['read_file', 'search_codebase']);
    expect(agent!.maxTurns).toBe(10);
    expect(agent!.systemPrompt).toContain('# Role');
  });

  it('缺省 frontmatter → description 为空 / toolNames 为 undefined', () => {
    const { agent } = parseAgentFile(
      '/tmp/.devseeker/agents/minimal/AGENT.md',
      'just body',
    );
    expect(agent).toBeDefined();
    expect(agent!.description).toBe('');
    expect(agent!.toolNames).toBeUndefined();
    expect(agent!.maxTurns).toBeUndefined();
  });

  it('空 body → error', () => {
    const raw = ['---', 'description: x', '---', '', '  '].join('\n');
    const { error } = parseAgentFile('/tmp/x.md', raw);
    expect(error).toMatch(/empty/i);
  });

  it('显式 name 覆盖路径派生', () => {
    const { agent } = parseAgentFile(
      '/tmp/agents/foo/AGENT.md',
      '---\nname: custom-name\n---\n\nbody',
    );
    expect(agent!.name).toBe('custom-name');
  });

  it('扁平 .md 按文件名派生 name', () => {
    const { agent } = parseAgentFile('/tmp/agents/reviewer.md', 'body');
    expect(agent!.name).toBe('reviewer');
  });
});

describe('W14.4 · toSubagentDefinition', () => {
  it('toolNames 缺省时使用 defaultTools + maxTurns 默认 15', () => {
    const def = toSubagentDefinition(
      {
        name: 'foo',
        description: 'foo desc',
        systemPrompt: 'body',
        filePath: '/tmp/foo.md',
      },
      DEFAULT_CUSTOM_AGENT_TOOLS,
    );
    expect(def.type).toBe('foo');
    expect(def.isBuiltin).toBe(false);
    expect(def.maxTurns).toBe(DEFAULT_CUSTOM_AGENT_MAX_TURNS);
    expect(def.allowedTools.has('read_file')).toBe(true);
    expect(def.allowedTools.has('bash')).toBe(false);
    expect(def.description).toBe('foo desc');
  });

  it('显式 toolNames / maxTurns', () => {
    const def = toSubagentDefinition(
      {
        name: 'bar',
        description: '',
        toolNames: ['read_file'],
        maxTurns: 5,
        systemPrompt: 'body',
        filePath: '/tmp/bar.md',
      },
      DEFAULT_CUSTOM_AGENT_TOOLS,
    );
    expect(def.maxTurns).toBe(5);
    expect(Array.from(def.allowedTools)).toEqual(['read_file']);
    expect(def.description).toBeUndefined(); // 空 description 过滤为 undefined
  });
});

describe('W14.4 · AgentLoader', () => {
  let ws: string;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-loader-'));
  });

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  });

  it('agents 目录不存在 → 空结果 + 无 error', async () => {
    const loader = new AgentLoader({ workspaceRoot: ws });
    const r = await loader.load();
    expect(r.agents).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('推荐布局 <name>/AGENT.md', async () => {
    const dir = path.join(ws, '.devseeker', 'agents', 'reviewer');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'AGENT.md'),
      '---\ndescription: a reviewer\n---\n\n# Role\nbody',
      'utf-8',
    );
    const loader = new AgentLoader({ workspaceRoot: ws });
    const r = await loader.load();
    expect(r.errors).toEqual([]);
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0].type).toBe('reviewer');
    expect(r.agents[0].description).toBe('a reviewer');
    expect(r.agents[0].allowedTools.size).toBe(DEFAULT_CUSTOM_AGENT_TOOLS.length);
  });

  it('扁平 <name>.md 兼容', async () => {
    const dir = path.join(ws, '.devseeker', 'agents');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'quick.md'), 'just body', 'utf-8');
    const loader = new AgentLoader({ workspaceRoot: ws });
    const r = await loader.load();
    expect(r.agents.map((a) => a.type)).toEqual(['quick']);
  });

  it('name 与内置冲突 → 过滤 + 记录 error', async () => {
    const dir = path.join(ws, '.devseeker', 'agents', 'browser');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'AGENT.md'),
      '---\nname: Browser\n---\nbody',
      'utf-8',
    );
    const loader = new AgentLoader({ workspaceRoot: ws });
    const r = await loader.load();
    expect(r.agents).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/Browser.*内置/);
  });

  it('body 空 → error', async () => {
    const dir = path.join(ws, '.devseeker', 'agents', 'empty');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'AGENT.md'),
      '---\ndescription: x\n---\n\n',
      'utf-8',
    );
    const loader = new AgentLoader({ workspaceRoot: ws });
    const r = await loader.load();
    expect(r.agents).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });

  it('invalidate 后再次 load 读取最新内容', async () => {
    const dir = path.join(ws, '.devseeker', 'agents', 'x');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'AGENT.md'),
      '---\ndescription: v1\n---\nbody',
      'utf-8',
    );
    const loader = new AgentLoader({ workspaceRoot: ws });
    const r1 = await loader.load();
    expect(r1.agents[0].description).toBe('v1');

    // 修改文件；未 invalidate → 仍旧
    await fs.writeFile(
      path.join(dir, 'AGENT.md'),
      '---\ndescription: v2\n---\nbody',
      'utf-8',
    );
    const r2 = await loader.load();
    expect(r2.agents[0].description).toBe('v1'); // cache

    loader.invalidate();
    const r3 = await loader.load();
    expect(r3.agents[0].description).toBe('v2');
  });

  it('多个 agents 按 name 升序排序', async () => {
    const base = path.join(ws, '.devseeker', 'agents');
    for (const name of ['zebra', 'alpha', 'middle']) {
      const d = path.join(base, name);
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, 'AGENT.md'), 'body', 'utf-8');
    }
    const loader = new AgentLoader({ workspaceRoot: ws });
    const r = await loader.load();
    expect(r.agents.map((a) => a.type)).toEqual(['alpha', 'middle', 'zebra']);
  });
});

describe('W14.4 · createSubagentRegistry', () => {
  it('空 customs → 只暴露内置 5 种', () => {
    const reg = createSubagentRegistry([]);
    const types = reg.list().map((d) => d.type);
    expect(types).toEqual(['Browser', 'Research', 'Guide', 'Verify', 'Vision']);
    expect(reg.resolve('Browser')).toBeDefined();
    expect(reg.resolve('NotExist')).toBeUndefined();
  });

  it('合并自定义 agent', () => {
    const custom: SubagentDefinition = {
      type: 'devseeker',
      allowedTools: new Set(['read_file']),
      systemPrompt: 'hi',
      maxTurns: 5,
      isBuiltin: false,
    };
    const reg = createSubagentRegistry([custom]);
    expect(reg.resolve('devseeker')?.maxTurns).toBe(5);
    expect(reg.list()).toHaveLength(6);
  });

  it('自定义 agent 不允许覆盖内置 Browser', () => {
    const conflict: SubagentDefinition = {
      type: 'Browser',
      allowedTools: new Set(),
      systemPrompt: 'malicious',
      maxTurns: 100,
      isBuiltin: false,
    };
    const reg = createSubagentRegistry([conflict]);
    const browser = reg.resolve('Browser')!;
    expect(browser.isBuiltin).toBe(true);
    expect(browser.systemPrompt).not.toBe('malicious');
  });

  it('builtin-only registry 与 createBuiltinSubagentRegistry 等价', () => {
    const a = createSubagentRegistry([]);
    const b = createBuiltinSubagentRegistry();
    expect(a.list().map((d) => d.type)).toEqual(b.list().map((d) => d.type));
  });
});
