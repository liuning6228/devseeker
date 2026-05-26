/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W11.8 · Git 只读工具单测
 *
 * 覆盖：
 * 1. parseStatus 解析分支 / upstream / ahead-behind / 文件条目
 * 2. parseLog 解析 %x1f 分隔输出
 * 3. GitStatusTool：runner 注入 → 格式化输出 + ok=true + display 带结构化
 * 4. GitDiffTool：staged 透传 `--cached`；path 越界拒绝（TOOL_ARGS_INVALID）
 * 5. GitDiffTool：maxLines 截断
 * 6. GitLogTool：limit clamp 到 1..200；默认 20；args 包含 --pretty / -n
 * 7. 没有工作区 → PERMISSION_DENIED
 * 8. runner 返回非 0 退出 → TOOL_EXEC_FAILED
 */

import { describe, it, expect } from 'vitest';
import {
  GitStatusTool,
  GitDiffTool,
  GitLogTool,
  parseStatus,
  parseLog,
  type GitRunner,
} from '../../src/core/tools/git.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import type { ToolContext } from '../../src/core/tools/types.js';

function ctx(workspace: string | undefined = 'C:/ws'): ToolContext {
  return {
    workspaceRoot: workspace,
    signal: new AbortController().signal,
    taskId: 't1',
    toolCallId: 'c1',
  };
}

function ctxNoWs(): ToolContext {
  return {
    workspaceRoot: undefined,
    signal: new AbortController().signal,
    taskId: 't1',
    toolCallId: 'c1',
  };
}

/** 生成一个记录所有 args 的假 runner */
function fakeRunner(
  responses: ((args: readonly string[]) => { stdout?: string; stderr?: string; code?: number }),
): { runner: GitRunner; calls: Array<readonly string[]> } {
  const calls: Array<readonly string[]> = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    const r = responses(args);
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code ?? 0 };
  };
  return { runner, calls };
}

describe('parseStatus', () => {
  it('解析 branch / upstream / ahead / behind', () => {
    const raw = [
      '## main...origin/main [ahead 2, behind 1]',
      ' M src/foo.ts',
      '?? src/new.ts',
      'R  old.ts -> new.ts',
    ].join('\n');
    const s = parseStatus(raw);
    expect(s.branch).toBe('main');
    expect(s.upstream).toBe('origin/main');
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(1);
    expect(s.clean).toBe(false);
    expect(s.entries).toHaveLength(3);
    const rename = s.entries.find((e) => e.orig === 'old.ts');
    expect(rename?.path).toBe('new.ts');
  });

  it('clean 工作区', () => {
    const s = parseStatus('## main');
    expect(s.clean).toBe(true);
    expect(s.branch).toBe('main');
    expect(s.upstream).toBeNull();
  });

  it('detached HEAD', () => {
    const s = parseStatus('## HEAD (no branch)');
    // head 本身包含空格，这里不强求精确——只要不抛错且 ahead/behind 为 0
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
  });
});

describe('parseLog', () => {
  it('按 %x1f 分隔字段', () => {
    const raw =
      'abcd1234\x1fAlice\x1f2025-05-01T10:00:00+08:00\x1fsubject one\n' +
      'ef567890\x1fBob\x1f2025-04-30T09:00:00+08:00\x1fsubject with\x1fembedded sep';
    const out = parseLog(raw);
    expect(out).toHaveLength(2);
    expect(out[0].hash).toBe('abcd1234');
    expect(out[0].author).toBe('Alice');
    expect(out[0].subject).toBe('subject one');
    // 第二条 subject 含 \x1f → 还原
    expect(out[1].subject).toBe('subject with\x1fembedded sep');
  });

  it('空输入返回空数组', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('GitStatusTool', () => {
  it('runner args 正确 + content 含 branch/file', async () => {
    const { runner, calls } = fakeRunner(() => ({
      stdout: '## main...origin/main [ahead 1]\n M a.ts\n',
    }));
    const tool = new GitStatusTool({ runner });
    const res = await tool.execute({}, ctx());
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual(['status', '--porcelain=v1', '-b']);
    expect(res.content).toContain('branch: main');
    expect(res.content).toContain('ahead 1');
    expect(res.content).toContain('a.ts');
  });

  it('没有工作区 → PERMISSION_DENIED', async () => {
    const { runner } = fakeRunner(() => ({}));
    const tool = new GitStatusTool({ runner });
    const res = await tool.execute({}, ctxNoWs());
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
  });

  it('非 0 退出 → TOOL_EXEC_FAILED', async () => {
    const { runner } = fakeRunner(() => ({ stderr: 'not a git repo', code: 128 }));
    const tool = new GitStatusTool({ runner });
    const res = await tool.execute({}, ctx());
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.TOOL_EXEC_FAILED);
    expect(res.content).toContain('not a git repo');
  });
});

describe('GitDiffTool', () => {
  it('staged=true 透传 --cached；path 安全 → 带 pathspec', async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: 'diff --git a/x b/x\n' }));
    const tool = new GitDiffTool({ runner });
    const res = await tool.execute({ staged: true, path: 'src/a.ts' }, ctx('C:/ws'));
    expect(res.ok).toBe(true);
    const a = calls[0];
    expect(a).toContain('--cached');
    expect(a).toContain('--');
    expect(a[a.length - 1]).toBe('src/a.ts');
  });

  it('path 越界（..）→ TOOL_ARGS_INVALID', async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: '' }));
    const tool = new GitDiffTool({ runner });
    const res = await tool.execute({ path: '../escape.ts' }, ctx('C:/ws'));
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
    // 不应真的调 runner
    expect(calls).toHaveLength(0);
  });

  it('maxLines 截断长 diff', async () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line${i}`).join('\n');
    const { runner } = fakeRunner(() => ({ stdout: big }));
    const tool = new GitDiffTool({ runner });
    const res = await tool.execute({ maxLines: 100 }, ctx('C:/ws'));
    expect(res.ok).toBe(true);
    // 截断后行数远小于 3000
    expect(res.content.split('\n').length).toBeLessThan(200);
    expect(res.content).toContain('truncated');
    const d = res.display as { truncated: boolean } | undefined;
    expect(d?.truncated).toBe(true);
  });

  it('空 diff → (no changes)', async () => {
    const { runner } = fakeRunner(() => ({ stdout: '' }));
    const tool = new GitDiffTool({ runner });
    const res = await tool.execute({}, ctx('C:/ws'));
    expect(res.ok).toBe(true);
    expect(res.content).toBe('(no changes)');
  });
});

describe('GitLogTool', () => {
  it('默认 limit=20；args 包含 --pretty 和 -n', async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: '' }));
    const tool = new GitLogTool({ runner });
    const res = await tool.execute({}, ctx('C:/ws'));
    expect(res.ok).toBe(true);
    const a = calls[0];
    expect(a[0]).toBe('log');
    const nIdx = a.indexOf('-n');
    expect(nIdx).toBeGreaterThanOrEqual(0);
    expect(a[nIdx + 1]).toBe('20');
    expect(a.some((x) => x.startsWith('--pretty=format:'))).toBe(true);
  });

  it('limit clamp 到 [1, 200]', async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: '' }));
    const tool = new GitLogTool({ runner });
    await tool.execute({ limit: 9999 }, ctx('C:/ws'));
    await tool.execute({ limit: 0 }, ctx('C:/ws'));
    const arg0 = calls[0];
    const arg1 = calls[1];
    expect(arg0[arg0.indexOf('-n') + 1]).toBe('200');
    expect(arg1[arg1.indexOf('-n') + 1]).toBe('1');
  });

  it('格式化输出含 hash 前 8 位 + subject', async () => {
    const raw = 'abcdef0123456789\x1fAlice\x1f2025-05-01\x1fFix bug';
    const { runner } = fakeRunner(() => ({ stdout: raw }));
    const tool = new GitLogTool({ runner });
    const res = await tool.execute({}, ctx('C:/ws'));
    expect(res.ok).toBe(true);
    expect(res.content).toContain('abcdef01');
    expect(res.content).toContain('Fix bug');
    expect(res.content).toContain('Alice');
  });

  it('path 越界 → TOOL_ARGS_INVALID', async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: '' }));
    const tool = new GitLogTool({ runner });
    const res = await tool.execute({ path: '/tmp/outside' }, ctx('C:/ws'));
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
    expect(calls).toHaveLength(0);
  });

  it('空输出 → (no commits)', async () => {
    const { runner } = fakeRunner(() => ({ stdout: '' }));
    const tool = new GitLogTool({ runner });
    const res = await tool.execute({}, ctx('C:/ws'));
    expect(res.ok).toBe(true);
    expect(res.content).toBe('(no commits)');
  });
});
