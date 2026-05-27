/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * get_terminal_output 工具（DESIGN §M9.6.3）
 *
 * 读取 TerminalPool 中指定 terminal_id 的输出与状态。
 * - wait_seconds: 若 session 仍在 running，可选择等待最多 N 秒（或直到结束）
 * - 支持可选 kill：读完后直接终止 session（对 watch/服务进程）
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';
import type { ITerminalPool, TerminalSnapshot } from './terminal-pool.js';

export interface GetTerminalOutputArgs {
  terminal_id: string;
  /** 等待秒数（0-120），缺省 0（立即返回当前快照） */
  wait_seconds?: number;
  /** 读取后是否 kill 该 session（对长时服务有用） */
  kill?: boolean;
}

const parameters = {
  type: 'object',
  properties: {
    terminal_id: {
      type: 'string',
      description: '后台 session id（来自 bash({is_background:true}) 的返回）',
    },
    wait_seconds: {
      type: 'integer',
      minimum: 0,
      maximum: 120,
      description: '最多等待该 session 结束的秒数；0（默认）立即快照返回',
    },
    kill: {
      type: 'boolean',
      description: '读完后是否 kill；默认 false',
    },
  },
  required: ['terminal_id'],
  additionalProperties: false,
} as const;

export interface GetTerminalOutputDeps {
  terminalManager: ITerminalPool;
}

export class GetTerminalOutputTool
  implements ITool<GetTerminalOutputArgs, ToolResult>
{
  readonly name = 'get_terminal_output';
  readonly description =
    '读取后台终端（bash is_background=true 返回的 terminal_id）的最新输出与状态。可选 wait_seconds 等待结束，kill=true 读完终止。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  private readonly pool: ITerminalPool;

  constructor(deps: GetTerminalOutputDeps) {
    this.pool = deps.terminalManager;
  }

  async execute(args: GetTerminalOutputArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args.terminal_id !== 'string' || !args.terminal_id.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'terminal_id 不能为空');
    }
    const id = args.terminal_id.trim();
    let snap = this.pool.get(id);
    if (!snap) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `未找到 terminal_id=${id}（可能已过期回收）`,
      );
    }

    const waitSec =
      typeof args.wait_seconds === 'number' && Number.isFinite(args.wait_seconds)
        ? Math.max(0, Math.min(120, Math.floor(args.wait_seconds)))
        : 0;

    if (waitSec > 0 && snap.status === 'running') {
      const waited = await this.pool.waitFor(id, waitSec * 1000);
      if (waited) snap = waited;
    }

    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    if (args.kill === true && snap.status === 'running') {
      this.pool.kill(id);
      // 给 SIGTERM 最多 2s 让子进程响应
      const after = await this.pool.waitFor(id, 2000);
      if (after) snap = after;
    }

    return {
      ok: true,
      content: renderContent(snap),
      display: {
        terminalId: snap.id,
        command: snap.command,
        status: snap.status,
        exitCode: snap.exitCode,
        signal: snap.signal,
        truncated: snap.truncated,
        byteCount: snap.byteCount,
        elapsedMs: snap.elapsedMs,
        classify: snap.classify,
      },
    };
  }
}

function renderContent(s: TerminalSnapshot): string {
  const head =
    `$ ${preview(s.command)}\n` +
    `terminal_id=${s.id} status=${s.status}` +
    (s.exitCode !== null ? ` exit=${s.exitCode}` : '') +
    (s.signal ? ` signal=${s.signal}` : '') +
    ` elapsed=${s.elapsedMs}ms` +
    (s.truncated ? ` (output head-truncated, ring ${s.byteCount}B)` : '') +
    `\n---\n`;
  const foot = s.status === 'running' ? `\n---\n[running —— 仍在后台执行]\n` : '';
  return head + s.output + foot;
}

function preview(cmd: string): string {
  return cmd.length <= 200 ? cmd : cmd.slice(0, 200) + '…';
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
