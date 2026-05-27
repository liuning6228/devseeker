/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

import { describe, it, expect } from 'vitest';
import {
  collectGitContext,
  formatGitContext,
  buildGitContextBlock,
  type GitCtxRunner,
  type GitCtxRunResult,
} from '../../src/core/prompts/git-context.js';

/**
 * git-context 单测（B-P1-11）
 * 使用 fake GitCtxRunner，按 args[0] 分派返回 stdout/stderr/code。
 */

function makeRunner(
  map: Record<string, GitCtxRunResult>,
  fallback: GitCtxRunResult = { stdout: '', stderr: '', code: 0 },
): GitCtxRunner {
  return async (args) => {
    const key = args.join(' ');
    for (const [k, v] of Object.entries(map)) {
      if (key.startsWith(k)) return v;
    }
    return fallback;
  };
}

describe('collectGitContext', () => {
  it('非 git 仓库（status 非 0）返回 undefined', async () => {
    const runner = makeRunner({
      'status': { stdout: '', stderr: 'fatal: not a git repo', code: 128 },
    });
    const snap = await collectGitContext({ cwd: '/x', runner });
    expect(snap).toBeUndefined();
  });

  it('解析 branch + ahead/behind + commits + staged stat', async () => {
    const runner = makeRunner({
      'status --porcelain=v1 -b': {
        stdout:
          '## main...origin/main [ahead 2, behind 1]\n M src/a.ts\n?? src/new.ts\n',
        stderr: '',
        code: 0,
      },
      'log -n 5 --pretty=format:%h %s': {
        stdout: 'abc1234 feat: x\ndef5678 fix: y\n',
        stderr: '',
        code: 0,
      },
      'diff --cached --stat': {
        stdout: ' src/a.ts | 10 ++++++++++\n src/b.ts | 3 +-\n 2 files changed',
        stderr: '',
        code: 0,
      },
    });
    const snap = await collectGitContext({ cwd: '/repo', runner });
    expect(snap).toBeDefined();
    expect(snap!.branch).toBe('main');
    expect(snap!.upstream).toBe('origin/main');
    expect(snap!.ahead).toBe(2);
    expect(snap!.behind).toBe(1);
    expect(snap!.recentCommits).toEqual(['abc1234 feat: x', 'def5678 fix: y']);
    expect(snap!.stagedFileCount).toBe(2);
    expect(snap!.stagedStat).toContain('src/a.ts');
    expect(snap!.statusShort).toContain(' M src/a.ts');
  });

  it('log 失败时 recentCommits 为空，但不破坏整体快照', async () => {
    const runner = makeRunner({
      'status': { stdout: '## main\n', stderr: '', code: 0 },
      'log': { stdout: '', stderr: 'bad', code: 1 },
      'diff': { stdout: '', stderr: '', code: 0 },
    });
    const snap = await collectGitContext({ cwd: '/r', runner });
    expect(snap).toBeDefined();
    expect(snap!.recentCommits).toEqual([]);
    expect(snap!.branch).toBe('main');
  });

  it('无 staged 变更时 stagedFileCount=0 且 formatGitContext 不输出 staged 段', async () => {
    const runner = makeRunner({
      'status': { stdout: '## main\n', stderr: '', code: 0 },
      'log': { stdout: 'abc feat\n', stderr: '', code: 0 },
      'diff': { stdout: '', stderr: '', code: 0 },
    });
    const snap = await collectGitContext({ cwd: '/r', runner });
    const out = formatGitContext(snap!);
    expect(out).toContain('branch: main');
    expect(out).not.toContain('staged (');
    expect(out).toContain('abc feat');
  });

  it('formatGitContext 空快照（无 branch / 无 commits / 无 staged / 无 status）返回空串', () => {
    const out = formatGitContext({
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      recentCommits: [],
      stagedStat: '',
      stagedFileCount: 0,
      statusShort: '',
    });
    expect(out).toBe('');
  });

  it('buildGitContextBlock 集成：非 git 仓库返回 undefined', async () => {
    const runner = makeRunner({
      'status': { stdout: '', stderr: 'fatal', code: 128 },
    });
    const out = await buildGitContextBlock({ cwd: '/x', runner });
    expect(out).toBeUndefined();
  });

  it('buildGitContextBlock 集成：正常仓库返回块', async () => {
    const runner = makeRunner({
      'status': { stdout: '## dev\n M a.ts\n', stderr: '', code: 0 },
      'log': { stdout: 'abcd1234 feat\n', stderr: '', code: 0 },
      'diff': { stdout: '', stderr: '', code: 0 },
    });
    const out = await buildGitContextBlock({ cwd: '/r', runner });
    expect(out).toBeDefined();
    expect(out).toContain('<git_context>');
    expect(out).toContain('</git_context>');
    expect(out).toContain('branch: dev');
    expect(out).toContain('abcd1234 feat');
  });

  it('maxDiffLines 对 staged stat 做截断', async () => {
    const manyLines = Array.from({ length: 30 }, (_, i) => ` f${i}.ts | 1 +`).join('\n');
    const runner = makeRunner({
      'status': { stdout: '## main\n', stderr: '', code: 0 },
      'log': { stdout: '', stderr: '', code: 0 },
      'diff': { stdout: manyLines, stderr: '', code: 0 },
    });
    const snap = await collectGitContext({ cwd: '/r', runner, maxDiffLines: 5 });
    expect(snap!.stagedStat).toMatch(/truncated \d+ more line/);
    // 截断后仍应保留前 5 行
    expect(snap!.stagedStat).toContain('f0.ts');
    expect(snap!.stagedStat).toContain('f4.ts');
  });
});
