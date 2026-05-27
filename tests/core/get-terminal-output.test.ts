/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * get_terminal_output 工具单测（W7b4a）
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GetTerminalOutputTool } from '../../src/core/tools/get_terminal_output.js';
import { TerminalPool } from '../../src/core/tools/terminal-pool.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import { initLogger } from '../../src/infra/logger.js';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-gto-'));
});

afterAll(async () => {
  // Windows 下子进程延迟释放 cwd 句柄；测试本身已完成，清理失败不影响结果
  await new Promise((r) => setTimeout(r, 500));
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* ignore: tmpdir will be cleaned by OS */
  }
}, 30_000);

beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
});

function ctx() {
  return {
    workspaceRoot: tmpRoot,
    signal: new AbortController().signal,
    taskId: 't',
    toolCallId: 'c',
  };
}

describe('GetTerminalOutputTool', () => {
  it('rejects empty terminal_id', async () => {
    const pool = new TerminalPool();
    try {
      const tool = new GetTerminalOutputTool({ terminalManager: pool });
      const r = await tool.execute({ terminal_id: '' }, ctx());
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
    } finally {
      pool.dispose();
    }
  });

  it('returns error for unknown terminal_id', async () => {
    const pool = new TerminalPool();
    try {
      const tool = new GetTerminalOutputTool({ terminalManager: pool });
      const r = await tool.execute({ terminal_id: 'nope' }, ctx());
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
    } finally {
      pool.dispose();
    }
  });

  it('reads exited session output', async () => {
    const pool = new TerminalPool();
    try {
      const s = await pool.spawn({
        command: 'node -e "process.stdout.write(\'hello-gto\')"',
        cwd: tmpRoot,
      });
      await pool.waitFor(s.id, 10_000);
      const tool = new GetTerminalOutputTool({ terminalManager: pool });
      const r = await tool.execute({ terminal_id: s.id }, ctx());
      expect(r.ok).toBe(true);
      expect(r.content).toContain('hello-gto');
      expect(r.display?.status).toBe('exited');
      expect(r.display?.exitCode).toBe(0);
    } finally {
      pool.dispose();
    }
  }, 20_000);

  it('wait_seconds waits for short session to finish', async () => {
    const pool = new TerminalPool();
    try {
      const s = await pool.spawn({
        command: 'node -e "setTimeout(()=>{process.stdout.write(\'done\')}, 200)"',
        cwd: tmpRoot,
      });
      const tool = new GetTerminalOutputTool({ terminalManager: pool });
      const r = await tool.execute(
        { terminal_id: s.id, wait_seconds: 5 },
        ctx(),
      );
      expect(r.ok).toBe(true);
      expect(r.display?.status).toBe('exited');
      expect(r.content).toContain('done');
    } finally {
      pool.dispose();
    }
  }, 15_000);

  it('wait_seconds=0 (default) returns running snapshot immediately', async () => {
    const pool = new TerminalPool();
    try {
      const s = await pool.spawn({
        command: 'node -e "setInterval(()=>{}, 1000)"',
        cwd: tmpRoot,
      });
      const tool = new GetTerminalOutputTool({ terminalManager: pool });
      const t0 = Date.now();
      const r = await tool.execute({ terminal_id: s.id }, ctx());
      const dur = Date.now() - t0;
      expect(r.ok).toBe(true);
      expect(r.display?.status).toBe('running');
      expect(dur).toBeLessThan(1000);
      pool.kill(s.id);
    } finally {
      pool.dispose();
    }
  }, 10_000);

  it('kill=true terminates running session after read', async () => {
    const pool = new TerminalPool();
    try {
      const s = await pool.spawn({
        command: 'node -e "setInterval(()=>{}, 1000)"',
        cwd: tmpRoot,
      });
      // 让 PS→node 进程树启动完成
      await new Promise((r) => setTimeout(r, 500));
      const tool = new GetTerminalOutputTool({ terminalManager: pool });
      const r = await tool.execute(
        { terminal_id: s.id, kill: true },
        ctx(),
      );
      expect(r.ok).toBe(true);
      expect(r.display?.status === 'killed' || r.display?.status === 'exited').toBe(true);
    } finally {
      pool.dispose();
    }
  }, 15_000);

  it('honours cancellation signal', async () => {
    const pool = new TerminalPool();
    try {
      const s = await pool.spawn({
        command: 'node -e "setInterval(()=>{}, 1000)"',
        cwd: tmpRoot,
      });
      const tool = new GetTerminalOutputTool({ terminalManager: pool });
      const ctl = new AbortController();
      ctl.abort();
      const r = await tool.execute(
        { terminal_id: s.id },
        {
          workspaceRoot: tmpRoot,
          signal: ctl.signal,
          taskId: 't',
          toolCallId: 'c',
        },
      );
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe(ErrorCodes.TASK_LOOP_ABORTED);
      pool.kill(s.id);
    } finally {
      pool.dispose();
    }
  }, 10_000);
});
