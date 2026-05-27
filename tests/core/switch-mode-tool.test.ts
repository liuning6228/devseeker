/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * switch_mode 工具单测（W6b1）
 *
 * 覆盖：
 * - 非法 target_mode_id → TOOL_ARGS_INVALID
 * - 审批通过 → content 含 "已切换"
 * - 审批拒绝 → ok:true 但 content 含 "拒绝" + display.approved=false
 * - 审批回调抛异常 → TOOL_EXEC_FAILED
 * - 审批回调收到正确的 targetMode / explanation / taskId
 */

import { describe, it, expect } from 'vitest';
import { SwitchModeTool } from '../../src/core/tools/switch_mode.js';
import type { SwitchModeApproval } from '../../src/core/tools/switch_mode.js';
import type { ToolContext } from '../../src/core/tools/types.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

function mkCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctl = new AbortController();
  return {
    workspaceRoot: undefined,
    signal: ctl.signal,
    taskId: 'task-xyz',
    toolCallId: 'call-1',
    ...overrides,
  };
}

describe('SwitchModeTool', () => {
  it('rejects invalid target_mode_id with TOOL_ARGS_INVALID', async () => {
    const tool = new SwitchModeTool({
      requestApproval: async () => true,
    });
    const r = await tool.execute(
      // @ts-expect-error intentionally invalid input for testing
      { target_mode_id: 'ask' },
      mkCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('returns success content when approval granted', async () => {
    const tool = new SwitchModeTool({ requestApproval: async () => true });
    const r = await tool.execute(
      { target_mode_id: 'plan', explanation: 'architecture decision' },
      mkCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('已切换');
    expect(r.content).toContain('plan');
    expect(r.display).toMatchObject({
      approvalRequired: true,
      approved: true,
      target: 'plan',
    });
  });

  it('returns refusal content when approval denied (still ok:true)', async () => {
    const tool = new SwitchModeTool({ requestApproval: async () => false });
    const r = await tool.execute({ target_mode_id: 'plan' }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('拒绝');
    expect(r.display).toMatchObject({
      approvalRequired: true,
      approved: false,
      target: 'plan',
    });
  });

  it('returns TOOL_EXEC_FAILED when approval callback throws', async () => {
    const tool = new SwitchModeTool({
      requestApproval: async () => {
        throw new Error('vscode API crashed');
      },
    });
    const r = await tool.execute({ target_mode_id: 'plan' }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_FAILED);
    expect(r.content).toContain('审批请求异常');
  });

  it('forwards targetMode / explanation / taskId to approval callback', async () => {
    let captured: Parameters<SwitchModeApproval>[0] | undefined;
    const tool = new SwitchModeTool({
      requestApproval: async (req) => {
        captured = req;
        return true;
      },
    });
    await tool.execute(
      { target_mode_id: 'plan', explanation: 'why switch' },
      mkCtx({ taskId: 'T42' }),
    );
    expect(captured).toEqual({
      targetMode: 'plan',
      explanation: 'why switch',
      taskId: 'T42',
    });
  });

  it('forwards undefined explanation when omitted', async () => {
    let captured: Parameters<SwitchModeApproval>[0] | undefined;
    const tool = new SwitchModeTool({
      requestApproval: async (req) => {
        captured = req;
        return true;
      },
    });
    await tool.execute({ target_mode_id: 'plan' }, mkCtx());
    expect(captured?.explanation).toBeUndefined();
  });

  it('tool metadata is read_only and named switch_mode', () => {
    const tool = new SwitchModeTool({ requestApproval: async () => true });
    expect(tool.name).toBe('switch_mode');
    expect(tool.safetyLevel).toBe('read_only');
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(0);
  });
});
