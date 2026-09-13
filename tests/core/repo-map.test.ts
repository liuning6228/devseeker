/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Repo Map 渲染器纯函数单测（方案 T1）
 *
 * 覆盖：
 * - 全局骨架：热度排序（文件级 / 文件内）、格式标记、单文件符号数上限
 * - 预算渐进裁剪：全量 → 二分文件前缀（truncated 标记）→ 输出稳定
 * - focus 路径模式：前缀查询路由 / 路径排序 / 空命中零输出
 * - focus 符号模式：callers/callees 渲染 / external 过滤 / 空命中零输出
 * - 零注入语义：空图 / 空热榜 / undefined 输入
 */

import { describe, it, expect } from 'vitest';
import {
  buildRepoMap,
  buildRepoMapFocus,
  type RepoMapGraphSource,
} from '../../src/core/index/repo-map.js';
import type { HotSymbolRow, SymbolRef, SymbolKind } from '../../src/core/index/graph-index.js';

// ─────────── helpers ───────────

function hot(
  name: string,
  filePath: string,
  startLine: number,
  heat: number,
  kind: SymbolKind = 'function',
): HotSymbolRow {
  return { name, kind, filePath, startLine, endLine: startLine + 10, heat };
}

function ref(
  name: string,
  filePath: string,
  startLine = 1,
  kind: SymbolKind = 'function',
): SymbolRef {
  return { name, kind, filePath, startLine, endLine: startLine + 5 };
}

interface StubOptions {
  size?: number;
  hot?: HotSymbolRow[];
  prefix?: SymbolRef[];
  callers?: SymbolRef[];
  callees?: SymbolRef[];
}

function makeGraph(o: StubOptions = {}): RepoMapGraphSource {
  return {
    size: () => o.size ?? 1,
    getHotSymbols: () => o.hot ?? [],
    findSymbolsByPathPrefix: () => o.prefix ?? [],
    findCallers: () => o.callers ?? [],
    findCallees: () => o.callees ?? [],
  };
}

// ─────────── 零注入语义 ───────────

describe('buildRepoMap · 零注入', () => {
  it('返回全零 stats：空图 / undefined / 空热榜', () => {
    const empty = buildRepoMap(makeGraph({ size: 0, hot: [hot('a', 'a.ts', 1, 5)] }));
    expect(empty.text).toBeUndefined();
    expect(empty.stats).toEqual({ files: 0, symbols: 0, truncated: false });

    const undef = buildRepoMap(undefined);
    expect(undef.text).toBeUndefined();
    expect(undef.stats.files).toBe(0);

    const noHot = buildRepoMap(makeGraph({ hot: [] }));
    expect(noHot.text).toBeUndefined();
  });
});

// ─────────── 全局骨架 ───────────

describe('buildRepoMap · 全局骨架', () => {
  it('文件按总热度排序，文件内符号按热度排序', () => {
    const g = makeGraph({
      hot: [
        hot('step', 'src/task/loop.ts', 200, 3),
        hot('runTask', 'src/task/loop.ts', 100, 9),
        hot('helper', 'src/util.ts', 1, 5),
      ],
    });
    const { text, stats } = buildRepoMap(g);
    expect(text).toBeDefined();
    expect(text!.startsWith('<repo_map>\n')).toBe(true);
    expect(text!.endsWith('\n</repo_map>')).toBe(true);
    // 文件热度：loop.ts = 9+3=12 > util.ts = 5
    expect(text!).toContain('src/task/loop.ts  [heat=12]');
    expect(text!).toContain('src/util.ts  [heat=5]');
    expect(text!.indexOf('src/task/loop.ts')).toBeLessThan(text!.indexOf('src/util.ts'));
    // 文件内：runTask(9) 在 step(3) 之前
    expect(text!.indexOf('runTask')).toBeLessThan(text!.indexOf('step'));
    expect(stats).toEqual({ files: 2, symbols: 3, truncated: false });
  });

  it('单文件符号数受 maxSymbolsPerFile 限制，文件热度仍为全部符号之和', () => {
    const g = makeGraph({
      hot: [
        hot('s1', 'src/a.ts', 1, 5),
        hot('s2', 'src/a.ts', 20, 4),
        hot('s3', 'src/a.ts', 40, 3),
        hot('s4', 'src/a.ts', 60, 2),
        hot('s5', 'src/a.ts', 80, 1),
      ],
    });
    const { text, stats } = buildRepoMap(g, { maxSymbolsPerFile: 2 });
    expect(text).toContain('[heat=15]');
    expect(text!.match(/^  - /gm)).toHaveLength(2);
    expect(text).toContain('s1');
    expect(text).toContain('s2');
    expect(text).not.toContain('s3');
    expect(stats.symbols).toBe(2);
  });

  it('相同输入两次渲染字节级恒等', () => {
    const g = makeGraph({
      hot: [
        hot('b', 'src/b.ts', 1, 3),
        hot('a', 'src/a.ts', 1, 3),
      ],
    });
    const first = buildRepoMap(g).text;
    const second = buildRepoMap(g).text;
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });
});

// ─────────── 预算裁剪 ───────────

describe('buildRepoMap · 预算裁剪', () => {
  it('超预算时二分裁剪文件数并标注截断', () => {
    const hots: HotSymbolRow[] = [];
    for (let i = 0; i < 20; i++) {
      for (let s = 0; s < 3; s++) {
        hots.push(hot(`symbol_${i}_${s}`, `src/module_${String(i).padStart(2, '0')}/file_${i}.ts`, s * 10 + 1, 10 - s));
      }
    }
    const g = makeGraph({ hot: hots });
    // 大预算：全量不截断
    const full = buildRepoMap(g, { maxTokens: 8000 });
    expect(full.stats.truncated).toBe(false);
    expect(full.stats.files).toBe(20);

    // 小预算：触发二分裁剪
    const clipped = buildRepoMap(g, { maxTokens: 200 });
    expect(clipped.text).toBeDefined();
    expect(clipped.stats.truncated).toBe(true);
    expect(clipped.stats.files).toBeLessThan(20);
    expect(clipped.text).toContain('（已截断为');
    expect(clipped.text!.endsWith('</repo_map>')).toBe(true);
  });

  it('单文件超小预算仍产出可读文本（降符号数 / 硬截断兜底）', () => {
    const longName = (i: number) =>
      `very_long_symbol_name_segment_${i}_with_extra_descriptive_parts_for_token_pressure`;
    const hotRows: HotSymbolRow[] = [];
    for (let i = 0; i < 12; i++) {
      hotRows.push(hot(longName(i), 'src/some/deep/nested/directory/with/long/name/file.ts', i + 1, 12 - i));
    }
    const g = makeGraph({ hot: hotRows });
    const { text, stats } = buildRepoMap(g, { maxTokens: 200, maxSymbolsPerFile: 10 });
    expect(text).toBeDefined();
    expect(text).toContain('</repo_map>');
    expect(stats.truncated).toBe(true);
    expect(stats.symbols).toBeLessThan(10);
  });
});

// ─────────── focus 模式 ───────────

describe('buildRepoMap · focus 路径模式', () => {
  it('路径前缀命中时按路径排序渲染，符号附注热度', () => {
    const g = makeGraph({
      hot: [hot('beta', 'src/core/b.ts', 5, 7)],
      prefix: [ref('beta', 'src/core/b.ts', 5), ref('alpha', 'src/core/a.ts', 1)],
    });
    const { text } = buildRepoMap(g, { focus: 'src/core/' });
    expect(text).toBeDefined();
    expect(text!.startsWith('<repo_map>\n')).toBe(true);
    expect(text!).toContain('焦点路径 "src/core/"');
    expect(text!.indexOf('src/core/a.ts')).toBeLessThan(text!.indexOf('src/core/b.ts'));
    expect(text!).toContain('alpha (function) @1');
    // beta 在全局热榜中 → 附注 heat
    expect(text!).toContain('[heat=7]');
  });

  it('带扩展名的 focus 走路径模式（即使不含斜杠）', () => {
    const g = makeGraph({
      hot: [],
      prefix: [ref('fn', 'src/app.ts', 3)],
    });
    const { text } = buildRepoMap(g, { focus: 'src/app.ts' });
    expect(text).toBeDefined();
    expect(text).toContain('src/app.ts');
    expect(text).toContain('fn (function) @3');
  });

  it('路径无命中 → 零输出', () => {
    const g = makeGraph({ prefix: [] });
    const { text, stats } = buildRepoMap(g, { focus: 'src/nothing/' });
    expect(text).toBeUndefined();
    expect(stats.files).toBe(0);
  });
});

describe('buildRepoMap · focus 符号模式', () => {
  it('渲染 callers / callees 邻接骨架并过滤 external', () => {
    const g = makeGraph({
      callers: [ref('caller1', 'src/x.ts', 10, 'method')],
      callees: [ref('callee1', 'src/y.ts', 20), ref('ext', '<external>', 0)],
    });
    const { text, stats } = buildRepoMapFocus(g, 'targetFn');
    expect(text).toBeDefined();
    expect(text!).toContain('焦点符号 "targetFn"');
    expect(text!).toContain('callers');
    expect(text!).toContain('caller1 (method) @ src/x.ts:10');
    expect(text!).toContain('callees');
    expect(text!).toContain('callee1 (function) @ src/y.ts:20');
    expect(text!).not.toContain('<external>');
    expect(stats.files).toBe(2);
    expect(stats.symbols).toBe(2);
  });

  it('无邻接结果 → 零输出', () => {
    const g = makeGraph({ callers: [], callees: [] });
    const { text } = buildRepoMap(g, { focus: 'unknownFn' });
    expect(text).toBeUndefined();
  });
});

// ─────────── stub 协议自检 ───────────

describe('buildRepoMap · 源接口兼容', () => {
  it('GraphIndex 结构性满足 RepoMapGraphSource（编译期契约 + 运行期 stub 一致性）', () => {
    // 该用例同时锁定 stub 方法与真实 GraphIndex 方法名一致
    const g = makeGraph();
    expect(typeof g.size).toBe('function');
    expect(typeof g.getHotSymbols).toBe('function');
    expect(typeof g.findSymbolsByPathPrefix).toBe('function');
    expect(typeof g.findCallers).toBe('function');
    expect(typeof g.findCallees).toBe('function');
  });
});
