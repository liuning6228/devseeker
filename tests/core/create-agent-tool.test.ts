/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W14.4 · CreateAgentTool 单测
 *
 * 覆盖：
 *   1. slugifyAgentName 纯函数 6 case
 *   2. renderAgentMd frontmatter 结构 4 case
 *   3. 参数校验（name/description/system_prompt/tools/max_turns/overwrite）
 *   4. 未打开工作区 → hard fail PERMISSION_DENIED
 *   5. 首次创建 → 文件落盘 + onAgentCreated 被调用
 *   6. 冲突未 overwrite → hard fail
 *   7. 冲突 + overwrite=true → action=overwritten
 *   8. 全中文 name → slug 为空 → hard fail
 *   9. 内置名保留（Browser/Research/Guide/Verify）→ hard fail
 *  10. 任务取消 → TASK_LOOP_ABORTED
 *  11. 端到端：CreateAgentTool 写出的 AGENT.md 能被 AgentLoader 解析回来
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  CreateAgentTool,
  slugifyAgentName,
  renderAgentMd,
} from '../../src/core/tools/create_agent.js';
import { AgentLoader } from '../../src/core/agents/index.js';
import type { ToolContext } from '../../src/core/tools/types.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

function makeCtx(): ToolContext {
  const ctrl = new AbortController();
  return {
    signal: ctrl.signal,
    workspaceRoot: undefined,
    taskId: 't1',
    toolCallId: 'c1',
  } as ToolContext;
}

describe('W14.4 · slugifyAgentName', () => {
  it.each([
    ['Security Reviewer', 'security-reviewer'],
    ['api_doc_writer', 'api-doc-writer'],
    ['Commit!!!', 'commit'],
    ['   ', ''],
    ['提交代码', ''],
    ['abc-DEF_123', 'abc-def-123'],
  ])('%s → %s', (input, expected) => {
    expect(slugifyAgentName(input)).toBe(expected);
  });

  it('长度 > 64 被截断', () => {
    const input = 'a'.repeat(200);
    expect(slugifyAgentName(input).length).toBe(64);
  });
});

describe('W14.4 · renderAgentMd', () => {
  it('含 description 无 tools / max_turns', () => {
    const md = renderAgentMd({ description: 'do it', body: '# body' });
    expect(md).toContain('---');
    expect(md).toContain('description: do it');
    expect(md).not.toContain('tools:');
    expect(md).not.toContain('max_turns:');
    expect(md.trim().endsWith('# body')).toBe(true);
  });

  it('含 tools 数组', () => {
    const md = renderAgentMd({
      description: 'do it',
      tools: ['read_file', 'search_codebase'],
      body: '## step1',
    });
    expect(md).toContain('tools: "read_file, search_codebase"');
  });

  it('含 max_turns', () => {
    const md = renderAgentMd({
      description: 'do it',
      maxTurns: 20,
      body: 'x',
    });
    expect(md).toContain('max_turns: 20');
  });

  it('需 quote 的特殊字符 description', () => {
    const md = renderAgentMd({ description: 'it: has colon', body: 'x' });
    expect(md).toMatch(/description: "it: has colon"/);
  });
});

describe('W14.4 · CreateAgentTool.execute', () => {
  let ws: string;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-agent-'));
  });

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  });

  it('未打开工作区 → hard fail PERMISSION_DENIED', async () => {
    const tool = new CreateAgentTool({ getWorkspaceRoot: () => undefined });
    const r = await tool.execute(
      { name: 'x', description: 'y', system_prompt: 'z' },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    expect((r as { errorCode?: string }).errorCode).toBe(
      ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
    );
  });

  it('name 空 → hard fail ARGS_INVALID', async () => {
    const tool = new CreateAgentTool({ getWorkspaceRoot: () => ws });
    const r = await tool.execute(
      { name: '  ', description: 'ok', system_prompt: 'body' },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    expect((r as { errorCode?: string }).errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('system_prompt 超长 → hard fail ARGS_INVALID', async () => {
    const tool = new CreateAgentTool({ getWorkspaceRoot: () => ws });
    const r = await tool.execute(
      { name: 'x', description: 'y', system_prompt: 'a'.repeat(100_001) },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    expect((r as { errorCode?: string }).errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('全中文 name → slug 为空 → hard fail ARGS_INVALID', async () => {
    const tool = new CreateAgentTool({ getWorkspaceRoot: () => ws });
    const r = await tool.execute(
      { name: '提交代码', description: 'y', system_prompt: 'body' },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    expect((r as { errorCode?: string }).errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('内置名保留 → hard fail ARGS_INVALID', async () => {
    const tool = new CreateAgentTool({ getWorkspaceRoot: () => ws });
    const r = await tool.execute(
      { name: 'Browser', description: 'y', system_prompt: 'body' },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    expect((r as { errorCode?: string }).errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
    expect(r.content).toContain('内置');
  });

  it('首次创建 → 文件落盘 + onAgentCreated 被调用', async () => {
    const onCreated = vi.fn();
    const tool = new CreateAgentTool({
      getWorkspaceRoot: () => ws,
      onAgentCreated: onCreated,
    });
    const r = await tool.execute(
      {
        name: 'Security Reviewer',
        description: 'Inspect code for security issues',
        system_prompt: '# Role\nYou are a security reviewer.',
        tools: ['read_file', 'search_codebase'],
        max_turns: 10,
      },
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('security-reviewer');
    expect(r.content).toContain('created');

    // 文件真实存在
    const file = path.join(ws, '.dualmind', 'agents', 'security-reviewer', 'AGENT.md');
    const content = await fs.readFile(file, 'utf-8');
    expect(content).toContain('description: Inspect code for security issues');
    expect(content).toContain('tools: "read_file, search_codebase"');
    expect(content).toContain('max_turns: 10');
    expect(content).toContain('# Role');

    // callback 触发
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith(file, 'security-reviewer');

    const display = (r as { display?: Record<string, unknown> }).display ?? {};
    expect(display['slug']).toBe('security-reviewer');
    expect(display['action']).toBe('created');
  });

  it('冲突 + overwrite=false → hard fail', async () => {
    const tool = new CreateAgentTool({ getWorkspaceRoot: () => ws });
    const args = { name: 'reviewer', description: 'a', system_prompt: 'b' };
    const r1 = await tool.execute(args, makeCtx());
    expect(r1.ok).toBe(true);
    const r2 = await tool.execute(args, makeCtx());
    expect(r2.ok).toBe(false);
    expect((r2 as { errorCode?: string }).errorCode).toBe(ErrorCodes.TOOL_EXEC_FAILED);
    expect(r2.content).toContain('已存在');
  });

  it('冲突 + overwrite=true → action=overwritten', async () => {
    const tool = new CreateAgentTool({ getWorkspaceRoot: () => ws });
    await tool.execute(
      { name: 'reviewer', description: 'v1', system_prompt: 'old' },
      makeCtx(),
    );
    const r2 = await tool.execute(
      { name: 'reviewer', description: 'v2', system_prompt: 'new', overwrite: true },
      makeCtx(),
    );
    expect(r2.ok).toBe(true);
    const display = (r2 as { display?: Record<string, unknown> }).display ?? {};
    expect(display['action']).toBe('overwritten');
    const file = path.join(ws, '.dualmind', 'agents', 'reviewer', 'AGENT.md');
    const content = await fs.readFile(file, 'utf-8');
    expect(content).toContain('description: v2');
    expect(content).toContain('new');
    expect(content).not.toContain('old');
  });

  it('端到端：CreateAgentTool 写出的 AGENT.md 能被 AgentLoader 解析回来', async () => {
    const tool = new CreateAgentTool({ getWorkspaceRoot: () => ws });
    await tool.execute(
      {
        name: 'api doc writer',
        description: 'Write API docs',
        system_prompt: '## Rules\n\n1. Use OpenAPI spec',
        tools: 'read_file, search_codebase',
        max_turns: 8,
      },
      makeCtx(),
    );

    const loader = new AgentLoader({ workspaceRoot: ws });
    const result = await loader.load();
    const agent = result.agents.find((a) => a.type === 'api-doc-writer');
    expect(agent).toBeDefined();
    expect(agent!.description).toBe('Write API docs');
    expect(agent!.maxTurns).toBe(8);
    expect(agent!.systemPrompt).toContain('## Rules');
  });

  it('任务取消 → 返回 TASK_LOOP_ABORTED', async () => {
    const tool = new CreateAgentTool({ getWorkspaceRoot: () => ws });
    const ctrl = new AbortController();
    ctrl.abort();
    const ctx: ToolContext = {
      signal: ctrl.signal,
      workspaceRoot: ws,
      taskId: 't1',
      toolCallId: 'c1',
    } as ToolContext;
    const r = await tool.execute(
      { name: 'x', description: 'y', system_prompt: 'z' },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect((r as { errorCode?: string }).errorCode).toBe(ErrorCodes.TASK_LOOP_ABORTED);
  });
});
