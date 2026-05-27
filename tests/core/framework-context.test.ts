/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

import { describe, it, expect } from 'vitest';
import {
  collectFrameworkContext,
  formatFrameworkContext,
  buildFrameworkContext,
  MAX_OPEN_TABS,
  MAX_WORKSPACE_TREE_LINES,
} from '../../src/core/prompts/framework-context.js';

describe('framework-context (B-P1-13 · M10.1)', () => {
  const baseOpts = {
    mode: 'agent' as const,
    isFirstTurn: true,
    workspaceRoot: 'c:\\ws',
  };

  it('无工作区时返回空快照，格式化输出也是空字符串', async () => {
    const snap = await collectFrameworkContext({ mode: 'agent', isFirstTurn: true });
    expect(snap.openTabs).toHaveLength(0);
    expect(formatFrameworkContext(snap)).toBe('');
  });

  it('空输入（无 DI 回调）时 build 结果为空', async () => {
    const out = await buildFrameworkContext(baseOpts);
    expect(out).toBe('');
  });

  it('current_open_file 总是注入，格式带标签', async () => {
    const out = await buildFrameworkContext({
      ...baseOpts,
      getActiveFile: () => 'src/app.ts',
      getOpenTabs: () => [],
    });
    expect(out).toContain('<current_open_file>\nsrc/app.ts\n</current_open_file>');
  });

  it('open_tabs 超过 30 自动截断', async () => {
    const tabs = Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.ts` }));
    const snap = await collectFrameworkContext({
      ...baseOpts,
      getOpenTabs: () => tabs,
    });
    expect(snap.openTabs).toHaveLength(MAX_OPEN_TABS);
    expect(snap.openTabs[0]?.path).toBe('f0.ts');
    expect(snap.openTabs[MAX_OPEN_TABS - 1]?.path).toBe(`f${MAX_OPEN_TABS - 1}.ts`);
  });

  it('open_tabs 标记 active/dirty 输出 (active,dirty) 后缀', async () => {
    const out = await buildFrameworkContext({
      ...baseOpts,
      getOpenTabs: () => [
        { path: 'a.ts', active: true },
        { path: 'b.ts', dirty: true },
        { path: 'c.ts', active: true, dirty: true },
        { path: 'd.ts' },
      ],
    });
    expect(out).toContain('a.ts (active)');
    expect(out).toContain('b.ts (dirty)');
    expect(out).toContain('c.ts (active,dirty)');
    expect(out).toMatch(/\nd\.ts(?!\s*\()/);
  });

  it('workspace_tree 仅 firstTurn 注入', async () => {
    const tree = 'src/a.ts\nsrc/b.ts\nREADME.md';
    const firstTurn = await buildFrameworkContext({
      ...baseOpts,
      isFirstTurn: true,
      getWorkspaceTree: () => tree,
    });
    expect(firstTurn).toContain('<workspace_tree>');
    expect(firstTurn).toContain('src/a.ts');

    const subsequent = await buildFrameworkContext({
      ...baseOpts,
      isFirstTurn: false,
      getWorkspaceTree: () => tree,
    });
    expect(subsequent).not.toContain('<workspace_tree>');
  });

  it('workspace_tree 排除 node_modules/.git/dist/build/out 等常见目录', async () => {
    const tree = [
      'src/a.ts',
      'node_modules/foo/index.js',
      '.git/HEAD',
      'dist/bundle.js',
      'build/out.js',
      'out/compiled.js',
      '.next/cache.json',
      '.turbo/hash',
      'coverage/lcov.info',
      'README.md',
    ].join('\n');
    const out = await buildFrameworkContext({
      ...baseOpts,
      getWorkspaceTree: () => tree,
    });
    expect(out).toContain('src/a.ts');
    expect(out).toContain('README.md');
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('.git/HEAD');
    expect(out).not.toContain('dist/');
    expect(out).not.toContain('build/');
    expect(out).not.toContain('out/');
    expect(out).not.toContain('.next/');
    expect(out).not.toContain('.turbo/');
    expect(out).not.toContain('coverage/');
  });

  it('workspace_tree 超过 100 行被截断', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
    const snap = await collectFrameworkContext({
      ...baseOpts,
      getWorkspaceTree: () => lines.join('\n'),
    });
    expect(snap.workspaceTree).toBeDefined();
    const outLines = snap.workspaceTree!.split('\n');
    expect(outLines).toHaveLength(MAX_WORKSPACE_TREE_LINES);
    expect(outLines[0]).toBe('src/f0.ts');
    expect(outLines[MAX_WORKSPACE_TREE_LINES - 1]).toBe(`src/f${MAX_WORKSPACE_TREE_LINES - 1}.ts`);
  });

  it('workspace_tree 空内容 / 全被过滤时不输出块', async () => {
    const out = await buildFrameworkContext({
      ...baseOpts,
      getWorkspaceTree: () => 'node_modules/a\n.git/HEAD\ndist/x.js',
    });
    expect(out).not.toContain('<workspace_tree>');
  });

  it('workspace_tree 归一化反斜杠为正斜杠', async () => {
    const out = await buildFrameworkContext({
      ...baseOpts,
      getWorkspaceTree: () => 'src\\app.ts\nsrc\\lib\\util.ts',
    });
    expect(out).toContain('src/app.ts');
    expect(out).toContain('src/lib/util.ts');
    expect(out).not.toContain('src\\app.ts');
  });

  it('git_status 有内容时注入，空时省略', async () => {
    const withStatus = await buildFrameworkContext({
      ...baseOpts,
      getGitStatus: () => ' M src/a.ts\n?? src/b.ts',
    });
    expect(withStatus).toContain('<git_status>');
    expect(withStatus).toContain(' M src/a.ts');

    const empty = await buildFrameworkContext({
      ...baseOpts,
      getGitStatus: () => '',
    });
    expect(empty).not.toContain('<git_status>');
  });

  it('git_diff_staged 仅在 Debug mode 注入', async () => {
    const staged = ' src/a.ts | 3 +++\n 1 file changed, 3 insertions(+)';
    const debug = await buildFrameworkContext({
      ...baseOpts,
      mode: 'debug',
      getGitDiffStaged: () => staged,
    });
    expect(debug).toContain('<git_diff_staged>');
    expect(debug).toContain('src/a.ts | 3 +++');

    for (const mode of ['ask', 'agent', 'plan'] as const) {
      const out = await buildFrameworkContext({
        ...baseOpts,
        mode,
        getGitDiffStaged: () => staged,
      });
      expect(out).not.toContain('<git_diff_staged>');
    }
  });

  it('git_diff_staged 即使 Debug 下 staged 为空也不注入', async () => {
    const out = await buildFrameworkContext({
      ...baseOpts,
      mode: 'debug',
      getGitDiffStaged: () => '',
    });
    expect(out).not.toContain('<git_diff_staged>');
  });

  it('DI 回调抛异常不影响其他块', async () => {
    const out = await buildFrameworkContext({
      ...baseOpts,
      mode: 'debug',
      getActiveFile: () => 'src/app.ts',
      getWorkspaceTree: () => {
        throw new Error('tree fail');
      },
      getGitStatus: async () => {
        throw new Error('status fail');
      },
      getGitDiffStaged: async () => {
        throw new Error('diff fail');
      },
    });
    expect(out).toContain('<current_open_file>');
    expect(out).toContain('src/app.ts');
    expect(out).not.toContain('<workspace_tree>');
    expect(out).not.toContain('<git_status>');
    expect(out).not.toContain('<git_diff_staged>');
  });

  it('稳定排序：current_open_file → open_tabs → workspace_tree → git_status → git_diff_staged', async () => {
    const out = await buildFrameworkContext({
      ...baseOpts,
      mode: 'debug',
      getActiveFile: () => 'src/app.ts',
      getOpenTabs: () => [{ path: 'src/app.ts' }],
      getWorkspaceTree: () => 'src/app.ts',
      getGitStatus: () => ' M src/app.ts',
      getGitDiffStaged: () => ' src/app.ts | 3 +++',
    });
    const iFile = out.indexOf('<current_open_file>');
    const iTabs = out.indexOf('<open_tabs>');
    const iTree = out.indexOf('<workspace_tree>');
    const iStatus = out.indexOf('<git_status>');
    const iStaged = out.indexOf('<git_diff_staged>');
    expect(iFile).toBeGreaterThanOrEqual(0);
    expect(iFile).toBeLessThan(iTabs);
    expect(iTabs).toBeLessThan(iTree);
    expect(iTree).toBeLessThan(iStatus);
    expect(iStatus).toBeLessThan(iStaged);
  });

  it('同输入调用两次输出字节级一致', async () => {
    const opts = {
      ...baseOpts,
      mode: 'debug' as const,
      getActiveFile: () => 'src/app.ts',
      getOpenTabs: () => [{ path: 'a.ts', active: true }, { path: 'b.ts' }],
      getWorkspaceTree: () => 'src/a.ts\nsrc/b.ts',
      getGitStatus: () => ' M src/a.ts',
      getGitDiffStaged: () => ' src/a.ts | 3 +++',
    };
    const a = await buildFrameworkContext(opts);
    const b = await buildFrameworkContext(opts);
    expect(a).toBe(b);
  });
});
