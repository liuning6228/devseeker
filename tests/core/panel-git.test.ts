/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C5 · Git Panel（B-P1-4）纯函数单测
 */

import { describe, it, expect } from 'vitest';
import {
  buildGitPanelHtml,
  collectGitPanelInput,
  groupStatus,
  type GitPanelInput,
} from '../../src/webview/panels/git-panel.js';
import type { ParsedStatus } from '../../src/core/tools/git.js';

function makeStatus(overrides: Partial<ParsedStatus> = {}): ParsedStatus {
  return {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    entries: [],
    clean: true,
    ...overrides,
  };
}

function makeInput(overrides: Partial<GitPanelInput> = {}): GitPanelInput {
  return {
    workspaceRoot: '/ws',
    isRepo: true,
    error: undefined,
    status: makeStatus(),
    statusGroups: [],
    log: [],
    selectedPath: undefined,
    selectedStaged: false,
    diff: undefined,
    generatedAt: '2026-05-02T10:00:00.000Z',
    ...overrides,
  };
}

describe('groupStatus', () => {
  it('空 entries → 空分组', () => {
    expect(groupStatus(makeStatus({ entries: [], clean: true }))).toEqual([]);
  });

  it('staged / modified / untracked / conflict 四类分组', () => {
    const s = makeStatus({
      entries: [
        { xy: 'M ', path: 'a.ts' }, // staged only
        { xy: ' M', path: 'b.ts' }, // modified only
        { xy: 'MM', path: 'c.ts' }, // both
        { xy: '??', path: 'd.ts' }, // untracked
        { xy: 'UU', path: 'e.ts' }, // conflict
        { xy: 'DD', path: 'f.ts' }, // conflict
      ],
      clean: false,
    });
    const groups = groupStatus(s);
    const byKind = Object.fromEntries(groups.map((g) => [g.kind, g.entries.map((e) => e.path)]));
    expect(byKind.conflict).toEqual(['e.ts', 'f.ts']);
    expect(byKind.staged).toEqual(['a.ts', 'c.ts']);
    expect(byKind.modified).toEqual(['b.ts', 'c.ts']);
    expect(byKind.untracked).toEqual(['d.ts']);
  });

  it('?? 只算 untracked，不算 staged', () => {
    const s = makeStatus({
      entries: [{ xy: '??', path: 'x.ts' }],
      clean: false,
    });
    const groups = groupStatus(s);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('untracked');
  });
});

describe('buildGitPanelHtml', () => {
  it('CSP nonce + cspSource + default-src none', () => {
    const html = buildGitPanelHtml(makeInput(), 'NX', 'vscode-webview://Z');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('nonce-NX');
    expect(html).toContain('vscode-webview://Z');
  });

  it('clean 仓库：展示 clean pill + Working tree clean', () => {
    const html = buildGitPanelHtml(
      makeInput({ status: makeStatus({ clean: true }), statusGroups: [] }),
      'N',
      'C',
    );
    expect(html).toContain('main');
    expect(html).toContain('origin/main');
    expect(html).toContain('clean');
    expect(html).toContain('Working tree clean');
  });

  it('error banner 展示', () => {
    const html = buildGitPanelHtml(
      makeInput({ isRepo: false, error: 'fatal: not a git repo <y>' }),
      'N',
      'C',
    );
    expect(html).toContain('err-banner');
    expect(html).toContain('&lt;y&gt;');
  });

  it('ahead/behind 展示 pill', () => {
    const html = buildGitPanelHtml(
      makeInput({
        status: makeStatus({ ahead: 2, behind: 3, clean: true }),
      }),
      'N',
      'C',
    );
    expect(html).toContain('ahead 2');
    expect(html).toContain('behind 3');
  });

  it('statusGroups 渲染 Staged/Modified/Untracked 标题 + XY pill', () => {
    const html = buildGitPanelHtml(
      makeInput({
        status: makeStatus({ clean: false }),
        statusGroups: [
          { label: 'Staged', kind: 'staged', entries: [{ xy: 'M ', path: 'a.ts' }] },
          { label: 'Modified', kind: 'modified', entries: [{ xy: ' M', path: 'b.ts' }] },
          { label: 'Untracked', kind: 'untracked', entries: [{ xy: '??', path: 'c.ts' }] },
        ],
      }),
      'N',
      'C',
    );
    expect(html).toContain('Staged (1)');
    expect(html).toContain('Modified (1)');
    expect(html).toContain('Untracked (1)');
    expect(html).toContain('a.ts');
    expect(html).toContain('b.ts');
    expect(html).toContain('c.ts');
    expect(html).toContain('data-action="selectFile"');
    expect(html).toContain('data-action="openFile"');
  });

  it('renamed entry 展示 orig -> path', () => {
    const html = buildGitPanelHtml(
      makeInput({
        statusGroups: [
          {
            label: 'Staged',
            kind: 'staged',
            entries: [{ xy: 'R ', path: 'new.ts', orig: 'old.ts' }],
          },
        ],
      }),
      'N',
      'C',
    );
    expect(html).toContain('old.ts -&gt; new.ts');
  });

  it('diff 着色：+ / - / @@', () => {
    const html = buildGitPanelHtml(
      makeInput({
        selectedPath: 'src/a.ts',
        selectedStaged: false,
        diff: {
          text: '@@ -1,3 +1,3 @@\n-old\n+new\n some',
          truncated: false,
        },
      }),
      'N',
      'C',
    );
    expect(html).toContain('Diff · src/a.ts');
    expect(html).toContain('class="hunk"');
    expect(html).toContain('class="add"');
    expect(html).toContain('class="del"');
    expect(html).toContain('working tree');
  });

  it('diff truncated pill', () => {
    const html = buildGitPanelHtml(
      makeInput({
        selectedPath: 'a.ts',
        diff: { text: 'diff', truncated: true },
      }),
      'N',
      'C',
    );
    expect(html).toContain('truncated');
  });

  it('selectedStaged=true 展示 --cached 提示 + toggle data-staged=1', () => {
    const html = buildGitPanelHtml(
      makeInput({
        selectedPath: 'a.ts',
        selectedStaged: true,
        diff: { text: '', truncated: false },
      }),
      'N',
      'C',
    );
    expect(html).toContain('--cached');
    expect(html).toContain('data-action="toggleStaged"');
    expect(html).toContain('data-staged="1"');
  });

  it('log 渲染 sha + author + subject + escape', () => {
    const html = buildGitPanelHtml(
      makeInput({
        log: [
          {
            hash: 'abcdef1234567890',
            author: '<a>',
            date: '2026-01-01',
            subject: 'fix & bug',
          },
        ],
      }),
      'N',
      'C',
    );
    expect(html).toContain('Log (1)');
    expect(html).toContain('abcdef12'); // 8 chars
    expect(html).toContain('&lt;a&gt;');
    expect(html).toContain('fix &amp; bug');
  });

  it('空 log: 展示 (no commits)', () => {
    const html = buildGitPanelHtml(makeInput({ log: [] }), 'N', 'C');
    expect(html).toContain('(no commits)');
  });
});

describe('collectGitPanelInput', () => {
  it('workspaceRoot 空 → error + isRepo=false', async () => {
    const input = await collectGitPanelInput({ workspaceRoot: undefined });
    expect(input.isRepo).toBe(false);
    expect(input.error).toContain('No workspace');
    expect(input.statusGroups).toEqual([]);
  });

  it('runner status 非 0 → error banner + 无 log', async () => {
    const input = await collectGitPanelInput({
      workspaceRoot: '/ws',
      runner: async () => ({ stdout: '', stderr: 'fatal: not a git repo', code: 128 }),
    });
    expect(input.isRepo).toBe(false);
    expect(input.error).toContain('not a git repo');
    expect(input.log).toEqual([]);
  });

  it('正常 status + log 解析', async () => {
    const runner = async (args: readonly string[]) => {
      const first = args[0];
      if (first === 'status') {
        return {
          stdout: '## main...origin/main [ahead 1]\n M src/a.ts\n??  src/b.ts\n',
          stderr: '',
          code: 0,
        };
      }
      if (first === 'log') {
        return {
          stdout: [
            'abcdef1234567890\x1fAlice\x1f2026-01-01\x1ffix bug',
            '1234567890abcdef\x1fBob\x1f2026-01-02\x1fadd feature',
          ].join('\n'),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    };
    const input = await collectGitPanelInput({ workspaceRoot: '/ws', runner });
    expect(input.isRepo).toBe(true);
    expect(input.status?.branch).toBe('main');
    expect(input.status?.ahead).toBe(1);
    expect(input.statusGroups.map((g) => g.kind).sort()).toEqual(['modified', 'untracked']);
    expect(input.log).toHaveLength(2);
    expect(input.log[0].subject).toBe('fix bug');
  });

  it('selectedPath 越界 (..) → 忽略 selectedPath', async () => {
    const runner = async (args: readonly string[]) => {
      if (args[0] === 'status') return { stdout: '## main\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const input = await collectGitPanelInput({
      workspaceRoot: '/ws',
      selectedPath: '../etc/passwd',
      runner,
    });
    expect(input.selectedPath).toBeUndefined();
    expect(input.diff).toBeUndefined();
  });

  it('selectedPath 合法 → 调用 git diff 并填 diff', async () => {
    let diffArgs: readonly string[] | undefined;
    const runner = async (args: readonly string[]) => {
      if (args[0] === 'status') return { stdout: '## main\n', stderr: '', code: 0 };
      if (args[0] === 'log') return { stdout: '', stderr: '', code: 0 };
      if (args[0] === 'diff') {
        diffArgs = args;
        return { stdout: '@@ -1 +1 @@\n-a\n+b\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };
    const input = await collectGitPanelInput({
      workspaceRoot: '/ws',
      selectedPath: 'src/a.ts',
      selectedStaged: true,
      runner,
    });
    expect(diffArgs).toEqual(['diff', '--cached', '--', 'src/a.ts']);
    expect(input.diff?.text).toContain('+b');
    expect(input.diff?.truncated).toBe(false);
  });

  it('diff 超过 maxLines → truncated=true', async () => {
    const runner = async (args: readonly string[]) => {
      if (args[0] === 'status') return { stdout: '## main\n', stderr: '', code: 0 };
      if (args[0] === 'log') return { stdout: '', stderr: '', code: 0 };
      if (args[0] === 'diff') {
        const lines = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
        return { stdout: lines, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };
    const input = await collectGitPanelInput({
      workspaceRoot: '/ws',
      selectedPath: 'a.ts',
      diffMaxLines: 5,
      runner,
    });
    expect(input.diff?.truncated).toBe(true);
    expect(input.diff?.text).toContain('[truncated');
  });

  it('logLimit clamp 到 1..200', async () => {
    let logArgs: readonly string[] | undefined;
    const runner = async (args: readonly string[]) => {
      if (args[0] === 'status') return { stdout: '## main\n', stderr: '', code: 0 };
      if (args[0] === 'log') {
        logArgs = args;
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };
    await collectGitPanelInput({ workspaceRoot: '/ws', logLimit: 9999, runner });
    expect(logArgs?.[1]).toBe('-n');
    expect(logArgs?.[2]).toBe('200');
    await collectGitPanelInput({ workspaceRoot: '/ws', logLimit: 0, runner });
    expect(logArgs?.[2]).toBe('1');
  });
});
