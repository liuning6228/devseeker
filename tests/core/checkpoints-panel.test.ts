/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-P1-15 · Checkpoints Panel 单元测试
 *
 * 覆盖纯函数：
 *   - parseCheckpointLabel
 *   - groupByTurn（含连续 step / 新轮切换 / final 归属 / 独立 final）
 *   - computeCompareDiff（added / removed / modified / unchanged / skipped）
 *   - collectCheckpointsPanelInput（含无 session / 空列表 / 异常路径）
 *   - buildCheckpointsPanelHtml（含 diff 模式）
 */

import { describe, expect, it } from 'vitest';
import type {
  Checkpoint,
  CheckpointMeta,
  FileSnapshot,
} from '../../src/core/checkpoints/index.js';
import {
  parseCheckpointLabel,
  groupByTurn,
  computeCompareDiff,
  collectCheckpointsPanelInput,
  buildCheckpointsPanelHtml,
  type CheckpointsPanelDataSource,
} from '../../src/webview/panels/checkpoints-panel.js';

// ─────────── 构造 fixtures ───────────

function meta(
  id: string,
  ts: number,
  label?: string,
  msgCount = 2,
  fileCount = 1,
): CheckpointMeta {
  return {
    id,
    sessionId: 's1',
    createdAt: ts,
    ...(label !== undefined ? { label } : {}),
    messageCount: msgCount,
    fileCount,
    totalBytes: 100,
  };
}

function snap(
  relPath: string,
  hash: string,
  size = 10,
  opts: { wasDeleted?: boolean; skipped?: boolean } = {},
): FileSnapshot {
  return {
    relPath,
    contentHash: hash,
    sizeBytes: size,
    wasDeleted: opts.wasDeleted ?? false,
    ...(opts.skipped ? { skipped: true } : {}),
  };
}

function cp(
  id: string,
  ts: number,
  files: FileSnapshot[],
  label?: string,
): Checkpoint {
  return {
    id,
    sessionId: 's1',
    createdAt: ts,
    ...(label !== undefined ? { label } : {}),
    messageCount: 0,
    fileCount: files.length,
    totalBytes: files.reduce((a, b) => a + b.sizeBytes, 0),
    messages: [],
    fileSnapshots: files,
  };
}

// ─────────── parseCheckpointLabel ───────────

describe('checkpoints-panel · parseCheckpointLabel', () => {
  it('识别 step:N:tool 格式', () => {
    const p = parseCheckpointLabel('step:3:write_file');
    expect(p.kind).toBe('step');
    expect(p.stepIndex).toBe(3);
    expect(p.tool).toBe('write_file');
  });

  it('非 step 视为 final，原样保留 raw', () => {
    const p = parseCheckpointLabel('turn:done');
    expect(p.kind).toBe('final');
    expect(p.raw).toBe('turn:done');
  });

  it('undefined 视为 final, raw 为空串', () => {
    const p = parseCheckpointLabel(undefined);
    expect(p.kind).toBe('final');
    expect(p.raw).toBe('');
  });
});

// ─────────── groupByTurn ───────────

describe('checkpoints-panel · groupByTurn', () => {
  it('空列表 → 空分组', () => {
    expect(groupByTurn([])).toEqual([]);
  });

  it('连续 step:1,2,3 + final → 一个分组', () => {
    const list = [
      meta('a', 1, 'step:1:write_file'),
      meta('b', 2, 'step:2:search_replace'),
      meta('c', 3, 'step:3:write_file'),
      meta('d', 4, 'turn:done'),
    ];
    const groups = groupByTurn(list);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.steps.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(groups[0]!.final?.id).toBe('d');
  });

  it('遇到新的 step:1 → 开启新轮', () => {
    const list = [
      meta('a', 1, 'step:1:write_file'),
      meta('b', 2, 'step:2:write_file'),
      meta('c', 3, 'step:1:write_file'),
      meta('d', 4, 'step:2:write_file'),
    ];
    const groups = groupByTurn(list);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.steps.map((m) => m.id)).toEqual(['a', 'b']);
    expect(groups[1]!.steps.map((m) => m.id)).toEqual(['c', 'd']);
  });

  it('final 后再来 step → 新轮', () => {
    const list = [
      meta('a', 1, 'step:1:write_file'),
      meta('b', 2, 'turn:done'),
      meta('c', 3, 'step:1:write_file'),
    ];
    const groups = groupByTurn(list);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.final?.id).toBe('b');
    expect(groups[1]!.steps[0]!.id).toBe('c');
  });

  it('独立 final 节点自成一轮（无 step）', () => {
    const list = [meta('a', 1, 'turn:manual-save')];
    const groups = groupByTurn(list);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.steps).toEqual([]);
    expect(groups[0]!.final?.id).toBe('a');
  });

  it('step 索引回退（3 → 2）视为新轮（防乱序保护）', () => {
    const list = [
      meta('a', 1, 'step:1:write_file'),
      meta('b', 2, 'step:3:write_file'),
      meta('c', 3, 'step:2:write_file'), // 回退 → 新轮
    ];
    const groups = groupByTurn(list);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.steps.map((m) => m.id)).toEqual(['a', 'b']);
    expect(groups[1]!.steps.map((m) => m.id)).toEqual(['c']);
  });
});

// ─────────── computeCompareDiff ───────────

describe('checkpoints-panel · computeCompareDiff', () => {
  it('两空 checkpoint → 全 0 计数', () => {
    const a = cp('a', 1, []);
    const b = cp('b', 2, []);
    const d = computeCompareDiff(a, b);
    expect(d.items).toHaveLength(0);
    expect(d.counts).toEqual({ added: 0, removed: 0, modified: 0, unchanged: 0, skipped: 0 });
  });

  it('b 新增文件 → added', () => {
    const a = cp('a', 1, []);
    const b = cp('b', 2, [snap('src/x.ts', 'h1')]);
    const d = computeCompareDiff(a, b);
    expect(d.counts.added).toBe(1);
    expect(d.items[0]!.status).toBe('added');
    expect(d.items[0]!.relPath).toBe('src/x.ts');
    expect(d.items[0]!.bHash).toBe('h1');
  });

  it('b 删除文件（wasDeleted） → removed', () => {
    const a = cp('a', 1, [snap('src/x.ts', 'h1')]);
    const b = cp('b', 2, [snap('src/x.ts', '', 0, { wasDeleted: true })]);
    const d = computeCompareDiff(a, b);
    expect(d.counts.removed).toBe(1);
    expect(d.items[0]!.status).toBe('removed');
  });

  it('hash 不同 → modified', () => {
    const a = cp('a', 1, [snap('src/x.ts', 'h1')]);
    const b = cp('b', 2, [snap('src/x.ts', 'h2', 20)]);
    const d = computeCompareDiff(a, b);
    expect(d.counts.modified).toBe(1);
    expect(d.items[0]!.status).toBe('modified');
    expect(d.items[0]!.aSize).toBe(10);
    expect(d.items[0]!.bSize).toBe(20);
  });

  it('hash 相同 → unchanged', () => {
    const a = cp('a', 1, [snap('src/x.ts', 'h1')]);
    const b = cp('b', 2, [snap('src/x.ts', 'h1')]);
    const d = computeCompareDiff(a, b);
    expect(d.counts.unchanged).toBe(1);
    expect(d.items[0]!.status).toBe('unchanged');
  });

  it('任一侧 skipped → skipped（不算 added/modified）', () => {
    const a = cp('a', 1, [snap('big.bin', 'h1', 9_000_000, { skipped: true })]);
    const b = cp('b', 2, [snap('big.bin', 'h2', 9_000_000)]);
    const d = computeCompareDiff(a, b);
    expect(d.counts.skipped).toBe(1);
    expect(d.items[0]!.status).toBe('skipped');
    expect(d.counts.modified).toBe(0);
  });

  it('路径升序输出（稳定顺序）', () => {
    const a = cp('a', 1, [snap('z.ts', 'h1'), snap('a.ts', 'h2')]);
    const b = cp('b', 2, [snap('m.ts', 'h3'), snap('a.ts', 'h2')]);
    const d = computeCompareDiff(a, b);
    const paths = d.items.map((i) => i.relPath);
    expect(paths).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });
});

// ─────────── collectCheckpointsPanelInput ───────────

describe('checkpoints-panel · collectCheckpointsPanelInput', () => {
  function mkSource(
    sessionId: string | undefined,
    list: CheckpointMeta[] | Error,
  ): CheckpointsPanelDataSource {
    return {
      getCurrentSessionId: () => sessionId,
      listCheckpoints: async () => {
        if (list instanceof Error) throw list;
        return list;
      },
      getCheckpointDetails: async () => undefined,
      revertCheckpoint: async () => undefined,
    };
  }

  it('无 session → total=0 且不调 list', async () => {
    let called = false;
    const src: CheckpointsPanelDataSource = {
      getCurrentSessionId: () => undefined,
      listCheckpoints: async () => {
        called = true;
        return [];
      },
      getCheckpointDetails: async () => undefined,
      revertCheckpoint: async () => undefined,
    };
    const inp = await collectCheckpointsPanelInput(src);
    expect(inp.sessionId).toBeUndefined();
    expect(inp.total).toBe(0);
    expect(inp.groups).toEqual([]);
    expect(called).toBe(false);
  });

  it('list 抛错 → fallback 空列表，不上抛', async () => {
    const src = mkSource('s1', new Error('boom'));
    const inp = await collectCheckpointsPanelInput(src);
    expect(inp.total).toBe(0);
    expect(inp.groups).toEqual([]);
  });

  it('正常分组：2 step + final', async () => {
    const src = mkSource('s1', [
      meta('b', 2, 'step:2:write_file'),
      meta('a', 1, 'step:1:write_file'), // 乱序给入
      meta('c', 3, 'turn:done'),
    ]);
    const inp = await collectCheckpointsPanelInput(src);
    expect(inp.total).toBe(3);
    expect(inp.groups).toHaveLength(1);
    expect(inp.groups[0]!.steps.map((m) => m.id)).toEqual(['a', 'b']);
    expect(inp.groups[0]!.final?.id).toBe('c');
  });
});

// ─────────── buildCheckpointsPanelHtml ───────────

describe('checkpoints-panel · buildCheckpointsPanelHtml', () => {
  it('空 input → 渲染 empty + Compare 禁用', () => {
    const html = buildCheckpointsPanelHtml(
      { sessionId: undefined, groups: [], total: 0, generatedAt: '2026-05-02T00:00:00.000Z' },
      'N1',
      'vscode-resource:/cspSrc',
    );
    expect(html).toContain('DevSeeker · Checkpoint Timeline');
    expect(html).toContain('no checkpoints');
    expect(html).toContain('id="btn-compare" disabled');
    // CSP default-src 'none'
    expect(html).toContain("default-src 'none'");
  });

  it('含分组 → 渲染 step pill + final pill + session id', () => {
    const list = [
      meta('id1abcdef', 100, 'step:1:write_file', 3, 2),
      meta('id2abcdef', 200, 'turn:done', 4, 2),
    ];
    const groups = groupByTurn(list);
    const html = buildCheckpointsPanelHtml(
      { sessionId: 'sess-xyz', groups, total: 2, generatedAt: '2026-05-02T00:00:00.000Z' },
      'N2',
      'vscode-resource:/cspSrc',
    );
    expect(html).toContain('sess-xyz');
    expect(html).toContain('write_file');
    expect(html).toContain('pill ok">final');
    // item data-id
    expect(html).toContain('data-id="id1abcdef"');
    expect(html).toContain('data-id="id2abcdef"');
  });

  it('传入 diff → 渲染 added/removed/modified 计数和文件行', () => {
    const a = cp('a', 1, [snap('src/x.ts', 'h1')]);
    const b = cp('b', 2, [snap('src/x.ts', 'h2'), snap('src/y.ts', 'h3')]);
    const diff = computeCompareDiff(a, b);
    const html = buildCheckpointsPanelHtml(
      { sessionId: 's1', groups: [], total: 0, generatedAt: '2026-05-02T00:00:00.000Z' },
      'N3',
      'vscode-resource:/cspSrc',
      diff,
    );
    expect(html).toContain('+1 added');
    expect(html).toContain('~1 modified');
    expect(html).toContain('src/x.ts');
    expect(html).toContain('src/y.ts');
    expect(html).toContain('class="status modified"');
    expect(html).toContain('class="status added"');
  });

  it('HTML escape：label 中的 < > 不会破坏结构', () => {
    const list = [meta('ida', 100, 'step:1:<script>alert(1)</script>')];
    const groups = groupByTurn(list);
    const html = buildCheckpointsPanelHtml(
      { sessionId: 's1', groups, total: 1, generatedAt: '2026-05-02T00:00:00.000Z' },
      'N4',
      'vscode-resource:/cspSrc',
    );
    // 用户内容应被转义，不会以原始 <script>alert(1)</script> 出现在身体里
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

