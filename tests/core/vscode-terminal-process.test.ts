/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * TerminalProcess · shell integration 路径单测（fake terminal）
 *
 * 背景：全仓库此前没有任何 shellIntegration mock，TerminalProcess.run 处于零回归保护状态。
 * 本文件用 fake 终端直接驱动 run()，覆盖此前无法断言的关键链路：
 * - 命令回显（整行等于命令行）被丢弃，真实输出保留（含“输出文本是命令子串”的回归场景）
 * - 流结束但 exitCode 缺失时不伪造 0（保持 undefined，由上层显示 exit=unknown）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TerminalProcess,
  wrapCommandWithCwd,
  type TerminalCompletionDetails,
} from '../../src/core/tools/vscode-terminal.js';
import { initLogger } from '../../src/infra/logger.js';
import * as os from 'node:os';
import * as path from 'node:path';

type TerminalLike = Parameters<TerminalProcess['run']>[0];

/** 驱动一次 TerminalProcess.run，收集 line 事件与 completed 明细（以及实际下发的命令） */
async function runProcess(
  command: string,
  chunks: string[],
  alignCwd?: string,
): Promise<{ lines: string[]; details: TerminalCompletionDetails; commands: string[] }> {
  const commands: string[] = [];
  const terminal = {
    shellIntegration: {
      executeCommand: (cmd: string) => {
        commands.push(cmd);
        return {
          read: () =>
            (async function* () {
              for (const c of chunks) yield c;
            })(),
        };
      },
    },
  } as unknown as TerminalLike;
  const proc = new TerminalProcess();
  const lines: string[] = [];
  proc.on('line', (l) => lines.push(l));
  const completed = new Promise<TerminalCompletionDetails>((resolve) => {
    proc.once('completed', (d) => resolve(d ?? {}));
  });
  await proc.run(terminal, command, alignCwd);
  return { lines, details: await completed, commands };
}

beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
});

describe('TerminalProcess · shell integration 流处理', () => {
  it('回显被丢弃 + 输出是命令子串时保留（echo 回归）', async () => {
    const { lines, details } = await runProcess('echo hello', [
      '\x1b]633;C\x07',
      'echo hello\r\nhello\r\n',
      '\x1b]633;D;0\x07',
    ]);

    expect(lines).toContain('hello');
    expect(lines.join('\n')).not.toContain('echo hello');
    expect(details.exitCode).toBe(0);
  });

  it('第二类回归：node -e 的输出（命令子串）不被吞', async () => {
    const { lines } = await runProcess('node -e "process.stdout.write(\'part1\')"', [
      '\x1b]633;C\x07',
      'part1',
      '\x1b]633;D;0\x07',
    ]);

    expect(lines.join('\n')).toContain('part1');
  });

  it('流结束但无 633;D 与完成事件 → exitCode 保持 undefined（不伪造 0）', async () => {
    const { lines, details } = await runProcess('node -v', [
      '\x1b]633;C\x07',
      'v20.0.0\r\n',
    ]);

    expect(lines.join('\n')).toContain('v20.0.0');
    expect(details.exitCode).toBeUndefined();
  }, 15_000);
});

describe('wrapCommandWithCwd · cwd 对齐包装', () => {
  it('POSIX：包装为 cd \'<cwd>\' && (<cmd>)（子 shell 隔离命令内 cd 残留）', () => {
    expect(wrapCommandWithCwd('ls -la', '/ws/root', 'linux')).toBe(
      `cd '/ws/root' && (ls -la)`,
    );
    expect(wrapCommandWithCwd('cd DevSeeker && wc -l src/a.ts', '/ws/root', 'darwin')).toBe(
      `cd '/ws/root' && (cd DevSeeker && wc -l src/a.ts)`,
    );
  });

  it('POSIX：路径含单引号/空格 → 单引号转义（字面量安全）', () => {
    expect(wrapCommandWithCwd('pwd', `/tmp/it's here`, 'linux')).toBe(
      `cd '/tmp/it'\\''s here' && (pwd)`,
    );
  });

  it('win32 / 空 cwd：不包装（保持原命令）', () => {
    expect(wrapCommandWithCwd('dir', 'C:\\ws', 'win32')).toBe('dir');
    expect(wrapCommandWithCwd('ls', undefined, 'linux')).toBe('ls');
    expect(wrapCommandWithCwd('ls', '   ', 'linux')).toBe('ls');
  });
});

describe('TerminalProcess · cwd 对齐执行', () => {
  it('传入 alignCwd → executeCommand 收到包装命令，包装行回显被过滤且输出保留', async () => {
    const wrapped = `cd '/home/ws' && (echo hello)`;
    const { lines, details, commands } = await runProcess(
      'echo hello',
      ['\x1b]633;C\x07', `${wrapped}\r\nhello\r\n`, '\x1b]633;D;0\x07'],
      '/home/ws',
    );

    // 下发的就是包装命令（终端回显 = 包装行 → 回显过滤基于包装命令）
    expect(commands).toEqual([wrapped]);
    expect(lines.join('\n')).toContain('hello');
    expect(lines.join('\n')).not.toContain('cd ');
    expect(details.exitCode).toBe(0);
  });

  it('不传 alignCwd → 保持历史行为（原命令直接下发）', async () => {
    const { commands } = await runProcess('echo hi', [
      '\x1b]633;C\x07',
      'hi\r\n',
      '\x1b]633;D;0\x07',
    ]);
    expect(commands).toEqual(['echo hi']);
  });
});
