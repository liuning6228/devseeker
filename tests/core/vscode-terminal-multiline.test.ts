/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * VscodeTerminalManager · 多行命令守卫单测
 *
 * 背景：VS Code Shell Integration 对含内嵌换行的命令有一系列已知缺陷
 * （microsoft/vscode#316556 / #250764 / #324392；PowerShell 被拆分执行 #267344 相邻行为）：
 * read 流不结束 / 无完成事件 / 输出缺失或与下一条命令串台（用户观感为「shell 不稳定」）。
 *
 * 守卫策略：多行命令绕开 shell integration，走 child_process 降级
 * （sh -c / powershell -Command 一次性执行），输出与 exit code 可靠。
 *
 * 注意：守卫在创建 VS Code 终端之前即返回降级路径，因此本组用例无需终端 API mock，
 * 直接验证真实子进程行为。跨平台用 node -e 做可移植命令。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  VscodeTerminalManager,
  hasMultilineCommand,
} from '../../src/core/tools/vscode-terminal.js';
import { BashTool, type BashToolDeps } from '../../src/core/tools/bash.js';
import { initLogger } from '../../src/infra/logger.js';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpRoot: string;

// 多行命令（含内嵌 \n）：两行各自输出一段文本
const MULTI_OK =
  'node -e "process.stdout.write(\'part1\')"\n' +
  'node -e "process.stdout.write(\'part2\')"';

// 多行命令：第二行以非零 exit code 结束
const MULTI_FAIL =
  'node -e "process.stdout.write(\'ok1\')"\n' +
  'node -e "process.exit(5)"';

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'devseeker-vterm-multiline-'));
});

afterAll(async () => {
  // Windows 下子进程延迟释放 cwd 句柄；清理失败不影响结果
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

describe('hasMultilineCommand', () => {
  it('单行命令不命中', () => {
    expect(hasMultilineCommand('node -v')).toBe(false);
    expect(hasMultilineCommand('npm test && npm run build')).toBe(false);
  });

  it('\\n 命中', () => {
    expect(hasMultilineCommand('echo a\necho b')).toBe(true);
  });

  it('\\r\\n 命中（Windows 风格换行）', () => {
    expect(hasMultilineCommand('echo a\r\necho b')).toBe(true);
  });
});

describe('VscodeTerminalManager · 多行命令守卫', () => {
  it('runCommand：多行命令走 child_process 降级，输出完整且 exit=0', async () => {
    const mgr = new VscodeTerminalManager();
    try {
      const r = await mgr.runCommand({ command: MULTI_OK, cwd: tmpRoot });
      expect(r.exitCode).toBe(0);
      expect(r.signal).toBeNull();
      expect(r.output).toContain('part1');
      expect(r.output).toContain('part2');
    } finally {
      mgr.dispose();
    }
  }, 20_000);

  it('runCommand：多行命令末行失败 → 透出真实非零 exit code', async () => {
    const mgr = new VscodeTerminalManager();
    try {
      const r = await mgr.runCommand({ command: MULTI_FAIL, cwd: tmpRoot });
      expect(r.exitCode).toBe(5);
      expect(r.signal).toBeNull();
      expect(r.output).toContain('ok1');
    } finally {
      mgr.dispose();
    }
  }, 20_000);

  it('spawn：后台模式多行命令降级执行，waitFor 后可读完整输出', async () => {
    const mgr = new VscodeTerminalManager();
    try {
      const snap = await mgr.spawn({ command: MULTI_OK, cwd: tmpRoot });
      expect(snap.status).toBe('running');
      expect(snap.id).toMatch(/^vterm-/);

      const final = await mgr.waitFor(snap.id, 10_000);
      expect(final).toBeDefined();
      expect(final!.status).toBe('exited');
      expect(final!.exitCode).toBe(0);
      expect(final!.output).toContain('part1');
      expect(final!.output).toContain('part2');
    } finally {
      mgr.dispose();
    }
  }, 20_000);
});

describe('BashTool · 多行命令降级说明', () => {
  it('多行命令结果带 [note] 降级说明（避免误判为 shell 基础设施不稳定）', async () => {
    const fakeManager = {
      runCommand: async () => ({ output: 'part1\n', exitCode: 0, signal: null }),
      runCommandOnUserTerminal: async () => ({ output: 'part1\n', exitCode: 0, signal: null }),
      spawn: async () => ({
        id: 'vterm-fake', status: 'running', command: '', cwd: tmpRoot,
        exitCode: null, signal: null, byteCount: 0, truncated: false,
        output: '', elapsedMs: 0, startedAt: Date.now(), classify: 'safe',
      }),
    };
    const tool = new BashTool({ terminalManager: fakeManager } as unknown as BashToolDeps);
    const ctx = {
      workspaceRoot: tmpRoot,
      signal: new AbortController().signal,
      taskId: 't1',
      toolCallId: 'c1',
    };

    const fg = await tool.execute({ command: MULTI_OK }, ctx);
    expect(fg.ok).toBe(true);
    expect(fg.content).toContain('[note]');

    const bg = await tool.execute({ command: MULTI_OK, is_background: true }, ctx);
    expect(bg.ok).toBe(true);
    expect(bg.content).toContain('[note]');

    // user_visible（用户选择“终端运行”）时明确“未在终端面板展示”
    const uv = await tool.execute({ command: MULTI_OK, terminalMode: 'user_visible' }, ctx);
    expect(uv.ok).toBe(true);
    expect(uv.content).toContain('未在终端面板');
  });

  it('单行命令结果不带 [note]', async () => {
    const fakeManager = {
      runCommand: async () => ({ output: 'ok\n', exitCode: 0, signal: null }),
      runCommandOnUserTerminal: async () => ({ output: 'ok\n', exitCode: 0, signal: null }),
    };
    const tool = new BashTool({ terminalManager: fakeManager } as unknown as BashToolDeps);
    const r = await tool.execute(
      { command: 'node -v' },
      {
        workspaceRoot: tmpRoot,
        signal: new AbortController().signal,
        taskId: 't1',
        toolCallId: 'c1',
      },
    );
    expect(r.ok).toBe(true);
    expect(r.content).not.toContain('[note]');
  });
});
