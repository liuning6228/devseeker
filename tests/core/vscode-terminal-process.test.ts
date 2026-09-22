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
  type TerminalCompletionDetails,
} from '../../src/core/tools/vscode-terminal.js';
import { initLogger } from '../../src/infra/logger.js';
import * as os from 'node:os';
import * as path from 'node:path';

type TerminalLike = Parameters<TerminalProcess['run']>[0];

/** 构造 fake 终端：executeCommand 的 read() 按给定 chunk 序列产出后自然结束 */
function fakeTerminal(chunks: string[]): TerminalLike {
  return {
    shellIntegration: {
      executeCommand: (_cmd: string) => ({
        read: () =>
          (async function* () {
            for (const c of chunks) yield c;
          })(),
      }),
    },
  } as unknown as TerminalLike;
}

/** 驱动一次 TerminalProcess.run，收集 line 事件与 completed 明细 */
async function runProcess(
  command: string,
  chunks: string[],
): Promise<{ lines: string[]; details: TerminalCompletionDetails }> {
  const proc = new TerminalProcess();
  const lines: string[] = [];
  proc.on('line', (l) => lines.push(l));
  const completed = new Promise<TerminalCompletionDetails>((resolve) => {
    proc.once('completed', (d) => resolve(d ?? {}));
  });
  await proc.run(fakeTerminal(chunks), command);
  return { lines, details: await completed };
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
