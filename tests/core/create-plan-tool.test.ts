/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * create_plan 工具单测（W6b2）
 *
 * 覆盖：
 * - mode 非法 → TOOL_ARGS_INVALID
 * - overview 缺失/空白 → TOOL_ARGS_INVALID
 * - notify_update 无 planDoc → TOOL_ARGS_INVALID
 * - notify_update 有 planDoc → 成功
 * - write 缺 name / 缺 plan → TOOL_ARGS_INVALID
 * - write 无 workspace → TOOL_EXEC_FAILED
 * - write 正常 → 文件落盘 + onPlanWritten 钩子触发 + 返回 planFilePath
 * - write 自动补全 # Title（plan 未以 # 开头时）
 * - slugifyPlanName / planHash 纯函数行为
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join, isAbsolute } from 'node:path';
import {
  CreatePlanTool,
  slugifyPlanName,
  planHash,
} from '../../src/core/tools/create_plan.js';
import type { ToolContext } from '../../src/core/tools/types.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

let wsDir: string;

function mkCtx(): ToolContext {
  return {
    workspaceRoot: wsDir,
    signal: new AbortController().signal,
    taskId: 't',
    toolCallId: 'tc',
  };
}

beforeEach(async () => {
  wsDir = await fs.mkdtemp(join(os.tmpdir(), 'cp-'));
});

afterEach(async () => {
  await fs.rm(wsDir, { recursive: true, force: true });
});

describe('slugifyPlanName', () => {
  it('keeps safe chars; replaces others with underscore', () => {
    expect(slugifyPlanName('Add Login Flow')).toBe('Add_Login_Flow');
    expect(slugifyPlanName('修复-Bug 12')).toBe('-Bug_12');
    expect(slugifyPlanName('a   b')).toBe('a_b');
  });

  it('returns "plan" fallback when name sanitizes to empty', () => {
    expect(slugifyPlanName('中文')).toBe('plan');
    expect(slugifyPlanName('   ')).toBe('plan');
  });

  it('trims to 60 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugifyPlanName(long).length).toBeLessThanOrEqual(60);
  });
});

describe('planHash', () => {
  it('is deterministic 6-char hex', () => {
    const h = planHash('Test', 'summary');
    expect(h).toMatch(/^[0-9a-f]{6}$/);
    expect(planHash('Test', 'summary')).toBe(h);
  });

  it('differs for different inputs', () => {
    expect(planHash('A', 'x')).not.toBe(planHash('A', 'y'));
    expect(planHash('A', 'x')).not.toBe(planHash('B', 'x'));
  });
});

describe('CreatePlanTool', () => {
  it('rejects invalid mode', async () => {
    const tool = new CreatePlanTool({ getWorkspaceRoot: () => wsDir });
    const r = await tool.execute(
      // @ts-expect-error intentional
      { mode: 'bogus', overview: 'x' },
      mkCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects empty overview', async () => {
    const tool = new CreatePlanTool({ getWorkspaceRoot: () => wsDir });
    const r = await tool.execute(
      { mode: 'write', name: 'n', overview: '  ', plan: '# x' },
      mkCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('notify_update without existing planDoc → TOOL_ARGS_INVALID', async () => {
    const tool = new CreatePlanTool({
      getWorkspaceRoot: () => wsDir,
      getPlanDoc: () => undefined,
    });
    const r = await tool.execute({ mode: 'notify_update', overview: 'edited' }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('notify_update with existing planDoc → success echo', async () => {
    const tool = new CreatePlanTool({
      getWorkspaceRoot: () => wsDir,
      getPlanDoc: () => '/tmp/plans/foo_abc123.md',
    });
    const r = await tool.execute({ mode: 'notify_update', overview: 'added step 2' }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('/tmp/plans/foo_abc123.md');
    expect(r.display).toMatchObject({ mode: 'notify_update' });
  });

  it('write without name → TOOL_ARGS_INVALID', async () => {
    const tool = new CreatePlanTool({ getWorkspaceRoot: () => wsDir });
    const r = await tool.execute(
      { mode: 'write', name: '', overview: 'x', plan: '# x' },
      mkCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('write without plan → TOOL_ARGS_INVALID', async () => {
    const tool = new CreatePlanTool({ getWorkspaceRoot: () => wsDir });
    const r = await tool.execute(
      { mode: 'write', name: 'n', overview: 'x', plan: '' },
      mkCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('write without workspace → TOOL_EXEC_FAILED', async () => {
    const tool = new CreatePlanTool({ getWorkspaceRoot: () => undefined });
    const r = await tool.execute(
      { mode: 'write', name: 'n', overview: 'x', plan: '# x' },
      mkCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_FAILED);
  });

  it('write happy path: file written + onPlanWritten fired + path returned', async () => {
    let notified: string | undefined;
    const tool = new CreatePlanTool({
      getWorkspaceRoot: () => wsDir,
      onPlanWritten: (p) => {
        notified = p;
      },
    });
    const r = await tool.execute(
      {
        mode: 'write',
        name: 'Add Login Flow',
        overview: 'JWT session + middleware',
        plan: '# Add Login Flow\n\n## Step 1\nSetup auth',
      },
      mkCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.display).toMatchObject({ mode: 'write' });

    const planFilePath = (r.display as { planFilePath: string }).planFilePath;
    expect(typeof planFilePath).toBe('string');
    expect(isAbsolute(planFilePath)).toBe(true);
    expect(planFilePath).toMatch(/Add_Login_Flow_[0-9a-f]{6}\.md$/);
    expect(notified).toBe(planFilePath);

    const body = await fs.readFile(planFilePath, 'utf8');
    expect(body).toContain('# Add Login Flow');
    expect(body).toContain('## Step 1');
    expect(body.endsWith('\n')).toBe(true);

    // 文件应在 docs/plans/
    expect(planFilePath).toContain(join('docs', 'plans'));
  });

  it('write auto-prepends # Title when plan does not start with heading', async () => {
    const tool = new CreatePlanTool({ getWorkspaceRoot: () => wsDir });
    const r = await tool.execute(
      {
        mode: 'write',
        name: 'Foo',
        overview: 'bar',
        plan: 'just steps, no heading',
      },
      mkCtx(),
    );
    expect(r.ok).toBe(true);
    const planFilePath = (r.display as { planFilePath: string }).planFilePath;
    const body = await fs.readFile(planFilePath, 'utf8');
    expect(body.startsWith('# Foo\n')).toBe(true);
  });

  it('write uses plansDirRel override', async () => {
    const tool = new CreatePlanTool({
      getWorkspaceRoot: () => wsDir,
      plansDirRel: '.dualmind/plans',
    });
    const r = await tool.execute(
      { mode: 'write', name: 'X', overview: 'y', plan: '# X' },
      mkCtx(),
    );
    expect(r.ok).toBe(true);
    const planFilePath = (r.display as { planFilePath: string }).planFilePath;
    expect(planFilePath).toContain(join('.dualmind', 'plans'));
    // 确认文件真的落在该目录
    const stat = await fs.stat(planFilePath);
    expect(stat.isFile()).toBe(true);
  });

  it('tool metadata: name/safetyLevel', () => {
    const tool = new CreatePlanTool({ getWorkspaceRoot: () => wsDir });
    expect(tool.name).toBe('create_plan');
    expect(tool.safetyLevel).toBe('workspace_write');
  });
});
