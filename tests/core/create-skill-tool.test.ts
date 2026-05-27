/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W14.3 · CreateSkillTool 单测
 *
 * 覆盖：
 *   1. slugifySkillName 纯函数 6 case
 *   2. renderSkillMd frontmatter 结构 3 case
 *   3. 参数校验（name/description/instructions/overwrite/arguments_hint 类型与长度）
 *   4. 未打开工作区 → hard fail TOOL_EXEC_PERMISSION_DENIED
 *   5. 首次创建成功 → 文件落盘 + content 含 slug + onSkillCreated 被调用
 *   6. 冲突未 overwrite → hard fail
 *   7. 冲突 + overwrite=true → 覆盖成功，action='overwritten'
 *   8. 全中文 name → slugify 为空 → hard fail TOOL_ARGS_INVALID
 *   9. 写出的 SKILL.md 能被 SkillLoader 解析回来（端到端联调）
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  CreateSkillTool,
  slugifySkillName,
  renderSkillMd,
} from '../../src/core/tools/create_skill.js';
import { SkillLoader } from '../../src/core/skills/index.js';
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

describe('W14.3 · slugifySkillName', () => {
  it.each([
    ['Review PR', 'review-pr'],
    ['deploy_staging', 'deploy-staging'],
    ['Commit!!!', 'commit'],
    ['   ', ''],
    ['提交代码', ''],
    ['abc-DEF_123', 'abc-def-123'],
  ])('%s → %s', (input, expected) => {
    expect(slugifySkillName(input)).toBe(expected);
  });

  it('长度 > 64 被截断', () => {
    const input = 'a'.repeat(200);
    expect(slugifySkillName(input).length).toBe(64);
  });
});

describe('W14.3 · renderSkillMd', () => {
  it('含 description 无 arguments', () => {
    const md = renderSkillMd({ description: 'do it', body: '# body' });
    expect(md).toContain('---');
    expect(md).toContain('description: do it');
    expect(md).not.toContain('arguments:');
    expect(md.trim().endsWith('# body')).toBe(true);
  });

  it('含 arguments_hint', () => {
    const md = renderSkillMd({
      description: 'do it',
      argumentsHint: '--force',
      body: '## step1',
    });
    expect(md).toContain('arguments: "--force"');
  });

  it('需 quote 的特殊字符 description', () => {
    const md = renderSkillMd({ description: 'it: has colon', body: 'x' });
    // 带冒号必须加引号
    expect(md).toMatch(/description: "it: has colon"/);
  });
});

describe('W14.3 · CreateSkillTool.execute', () => {
  let ws: string;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-skill-'));
  });

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  });

  it('未打开工作区 → hard fail PERMISSION_DENIED', async () => {
    const tool = new CreateSkillTool({ getWorkspaceRoot: () => undefined });
    const r = await tool.execute(
      { name: 'x', description: 'y', instructions: 'z' },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    expect((r as { errorCode?: string }).errorCode).toBe(
      ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
    );
  });

  it('name 空 → hard fail ARGS_INVALID', async () => {
    const tool = new CreateSkillTool({ getWorkspaceRoot: () => ws });
    const r = await tool.execute(
      { name: '  ', description: 'ok', instructions: 'body' },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    expect((r as { errorCode?: string }).errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('instructions 超长 → hard fail ARGS_INVALID', async () => {
    const tool = new CreateSkillTool({ getWorkspaceRoot: () => ws });
    const r = await tool.execute(
      { name: 'x', description: 'y', instructions: 'a'.repeat(100_001) },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    expect((r as { errorCode?: string }).errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('全中文 name → slug 为空 → hard fail ARGS_INVALID', async () => {
    const tool = new CreateSkillTool({ getWorkspaceRoot: () => ws });
    const r = await tool.execute(
      { name: '提交代码', description: 'y', instructions: 'body' },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    expect((r as { errorCode?: string }).errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('首次创建 → 文件落盘 + onSkillCreated 被调用', async () => {
    const onCreated = vi.fn();
    const tool = new CreateSkillTool({
      getWorkspaceRoot: () => ws,
      onSkillCreated: onCreated,
    });
    const r = await tool.execute(
      {
        name: 'Review PR',
        description: 'Inspect diff for style issues',
        instructions: '# Step 1\ninspect diff.',
        arguments_hint: '<pr-id>',
      },
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('review-pr');
    expect(r.content).toContain('created');

    // 文件真实存在
    const file = path.join(ws, '.devseeker', 'skills', 'review-pr', 'SKILL.md');
    const content = await fs.readFile(file, 'utf-8');
    expect(content).toContain('description: Inspect diff for style issues');
    // yamlEscape 把含 '<>' 的值加引号
    expect(content).toContain('arguments: "<pr-id>"');
    expect(content).toContain('# Step 1');

    // callback 触发
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith(file, 'review-pr');

    const display = (r as { display?: Record<string, unknown> }).display ?? {};
    expect(display['slug']).toBe('review-pr');
    expect(display['action']).toBe('created');
  });

  it('冲突 + overwrite=false → hard fail', async () => {
    const tool = new CreateSkillTool({ getWorkspaceRoot: () => ws });
    const args = { name: 'commit', description: 'a', instructions: 'b' };
    const r1 = await tool.execute(args, makeCtx());
    expect(r1.ok).toBe(true);
    const r2 = await tool.execute(args, makeCtx());
    expect(r2.ok).toBe(false);
    expect((r2 as { errorCode?: string }).errorCode).toBe(ErrorCodes.TOOL_EXEC_FAILED);
    expect(r2.content).toContain('已存在');
  });

  it('冲突 + overwrite=true → action=overwritten', async () => {
    const tool = new CreateSkillTool({ getWorkspaceRoot: () => ws });
    await tool.execute(
      { name: 'commit', description: 'v1', instructions: 'old' },
      makeCtx(),
    );
    const r2 = await tool.execute(
      { name: 'commit', description: 'v2', instructions: 'new', overwrite: true },
      makeCtx(),
    );
    expect(r2.ok).toBe(true);
    const display = (r2 as { display?: Record<string, unknown> }).display ?? {};
    expect(display['action']).toBe('overwritten');
    const file = path.join(ws, '.devseeker', 'skills', 'commit', 'SKILL.md');
    const content = await fs.readFile(file, 'utf-8');
    expect(content).toContain('description: v2');
    expect(content).toContain('new');
    expect(content).not.toContain('old');
  });

  it('端到端：CreateSkillTool 写出的 SKILL.md 能被 SkillLoader 解析回来', async () => {
    const tool = new CreateSkillTool({ getWorkspaceRoot: () => ws });
    await tool.execute(
      {
        name: 'deploy staging',
        description: 'Deploy to staging',
        instructions: '## Steps\n\n1. run tests\n2. kubectl apply',
        arguments_hint: '<service>',
      },
      makeCtx(),
    );

    const loader = new SkillLoader({ workspaceRoot: ws });
    const result = await loader.load();
    const skill = result.skills.find((s) => s.name === 'deploy-staging');
    expect(skill).toBeDefined();
    expect(skill!.description).toBe('Deploy to staging');
    expect(skill!.argumentsHint).toBe('<service>');
    expect(skill!.content).toContain('## Steps');
  });

  it('任务取消 → 返回 TASK_LOOP_ABORTED', async () => {
    const tool = new CreateSkillTool({ getWorkspaceRoot: () => ws });
    const ctrl = new AbortController();
    ctrl.abort();
    const ctx: ToolContext = {
      signal: ctrl.signal,
      workspaceRoot: ws,
      taskId: 't1',
      toolCallId: 'c1',
    } as ToolContext;
    const r = await tool.execute(
      { name: 'x', description: 'y', instructions: 'z' },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect((r as { errorCode?: string }).errorCode).toBe(ErrorCodes.TASK_LOOP_ABORTED);
  });
});
