/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * get_repo_map 工具单测（方案 T2）
 *
 * 覆盖：
 * - 软降级：图索引 undefined / 抛异常 / 空图 → ok:true + fallback 引导
 * - 正常输出：全局骨架 content + display 统计
 * - focus：路径模式 / 符号模式 / 无命中提示
 * - 参数容错：max_tokens 非法值 clamp
 * - 取消：aborted signal → fail
 */

import { describe, it, expect } from 'vitest';
import { GetRepoMapTool } from '../../src/core/tools/get_repo_map.js';
import type { RepoMapGraphSource } from '../../src/core/index/repo-map.js';
import type { HotSymbolRow, SymbolRef } from '../../src/core/index/graph-index.js';
import type { ToolContext } from '../../src/core/tools/types.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

// ─────────── helpers ───────────

function hot(
  name: string,
  filePath: string,
  startLine: number,
  heat: number,
): HotSymbolRow {
  return { name, kind: 'function', filePath, startLine, endLine: startLine + 10, heat };
}

function ref(name: string, filePath: string, startLine = 1): SymbolRef {
  return { name, kind: 'function', filePath, startLine, endLine: startLine + 5 };
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

function ctx(signal?: AbortSignal): ToolContext {
  return {
    workspaceRoot: '/tmp/ws',
    signal: signal ?? new AbortController().signal,
    taskId: 't1',
    toolCallId: 'call-1',
  };
}

// ─────────── 软降级 ───────────

describe('GetRepoMapTool · 软降级', () => {
  it('索引未初始化 → ok:true + 替代方案引导', async () => {
    const tool = new GetRepoMapTool({ getGraphIndex: async () => undefined });
    const r = await tool.execute({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('代码骨架不可用');
    expect(r.content).toContain('search_codebase');
    expect(r.display?.indexState).toBe('not_ready');
    expect(r.display?.soft).toBe(true);
  });

  it('getGraphIndex 抛异常 → 同样软降级（不向上抛）', async () => {
    const tool = new GetRepoMapTool({
      getGraphIndex: async () => {
        throw new Error('sqlite unavailable');
      },
    });
    const r = await tool.execute({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.display?.indexState).toBe('not_ready');
  });

  it('空图（size=0）→ 软降级且回显 focus', async () => {
    const tool = new GetRepoMapTool({
      getGraphIndex: async () => makeGraph({ size: 0 }),
    });
    const r = await tool.execute({ focus: 'src/core/' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.display?.indexState).toBe('not_ready');
    expect(r.display?.focus).toBe('src/core/');
  });
});

// ─────────── 正常输出 ───────────

describe('GetRepoMapTool · 正常输出', () => {
  it('全局骨架：content 为 <repo_map> 块 + display 统计', async () => {
    const graph = makeGraph({
      hot: [hot('runThing', 'src/a.ts', 10, 7), hot('helper', 'src/b.ts', 3, 2)],
    });
    const tool = new GetRepoMapTool({ getGraphIndex: async () => graph });
    const r = await tool.execute({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.content.startsWith('<repo_map>\n')).toBe(true);
    expect(r.content.endsWith('</repo_map>')).toBe(true);
    expect(r.content).toContain('runThing');
    expect(r.display?.files).toBe(2);
    expect(r.display?.symbols).toBe(2);
    expect(r.display?.truncated).toBe(false);
  });

  it('focus 路径模式：渲染焦点路径骨架', async () => {
    const graph = makeGraph({
      hot: [],
      prefix: [ref('alpha', 'src/core/a.ts', 5)],
    });
    const tool = new GetRepoMapTool({ getGraphIndex: async () => graph });
    const r = await tool.execute({ focus: 'src/core/' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('焦点路径 "src/core/"');
    expect(r.content).toContain('alpha');
    expect(r.display?.focus).toBe('src/core/');
  });

  it('focus 符号模式：渲染 ±1 跳调用骨架', async () => {
    const graph = makeGraph({
      callers: [ref('callerA', 'src/x.ts', 9)],
      callees: [ref('calleeB', 'src/y.ts', 30)],
    });
    const tool = new GetRepoMapTool({ getGraphIndex: async () => graph });
    const r = await tool.execute({ focus: 'coreFn' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('callers');
    expect(r.content).toContain('callerA');
    expect(r.content).toContain('callees');
    expect(r.content).toContain('calleeB');
  });

  it('focus 无命中 → ok:true + 定位提示 + empty 标记', async () => {
    const graph = makeGraph({ hot: [hot('x', 'a.ts', 1, 1)] });
    const tool = new GetRepoMapTool({ getGraphIndex: async () => graph });
    const r = await tool.execute({ focus: 'no-such/' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('未在代码骨架中匹配到');
    expect(r.display?.empty).toBe(true);
  });

  it('max_tokens 非法值（0 / 浮点 / 超界）不抛错且正常执行', async () => {
    const graph = makeGraph({ hot: [hot('x', 'a.ts', 1, 1)] });
    const tool = new GetRepoMapTool({ getGraphIndex: async () => graph });
    for (const v of [0, 12.5, 999_999]) {
      const r = await tool.execute({ max_tokens: v }, ctx());
      expect(r.ok).toBe(true);
      expect(r.content).toContain('<repo_map>');
    }
  });

  it('取消信号已中止 → fail（TASK_LOOP_ABORTED）', async () => {
    const graph = makeGraph({ hot: [hot('x', 'a.ts', 1, 1)] });
    const tool = new GetRepoMapTool({ getGraphIndex: async () => graph });
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute({}, ctx(ac.signal));
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TASK_LOOP_ABORTED);
  });
});
