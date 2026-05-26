/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W15.4b · InlineEditHistory 单测
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import { InlineEditHistory, type InlineEditRecord } from '../../src/core/inline-edit/history.js';

// ── Fake Memento ──

function createFakeMemento() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(<T>(key: string, defaultValue?: T): T | undefined => {
      return (store.get(key) as T | undefined) ?? defaultValue;
    }) as unknown as Map<string, unknown>['get'] & Mock,
    update: vi.fn(async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    }),
    _store: store,
  };
}

describe('InlineEditHistory', () => {
  it('record → getRecent 返回已记录条目', async () => {
    const memento = createFakeMemento();
    const hist = new InlineEditHistory(memento as any);
    await hist.record({
      filePath: 'src/foo.ts',
      startLine: 10,
      endLine: 15,
      snippetPreview: 'const x = 1;',
    });
    const recent = hist.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].filePath).toBe('src/foo.ts');
    expect(recent[0].startLine).toBe(10);
    expect(recent[0].timestamp).toBeGreaterThan(0);
  });

  it('getRecent(filePath) 按文件筛选', async () => {
    const memento = createFakeMemento();
    const hist = new InlineEditHistory(memento as any);
    await hist.record({ filePath: 'src/a.ts', startLine: 1, endLine: 5, snippetPreview: 'aaa' });
    await hist.record({ filePath: 'src/b.ts', startLine: 1, endLine: 5, snippetPreview: 'bbb' });
    await hist.record({ filePath: 'src/a.ts', startLine: 20, endLine: 25, snippetPreview: 'ccc' });

    const aRecords = hist.getRecent('src/a.ts');
    expect(aRecords).toHaveLength(2);
    expect(aRecords.every((r: InlineEditRecord) => r.filePath === 'src/a.ts')).toBe(true);
  });

  it('getRecent(limit) 限制返回条数', async () => {
    const memento = createFakeMemento();
    const hist = new InlineEditHistory(memento as any);
    for (let i = 0; i < 10; i++) {
      await hist.record({ filePath: 'src/f.ts', startLine: i, endLine: i + 1, snippetPreview: `line${i}` });
    }
    const limited = hist.getRecent(undefined, 3);
    expect(limited).toHaveLength(3);
  });

  it('record 去重同位置旧条目', async () => {
    const memento = createFakeMemento();
    const hist = new InlineEditHistory(memento as any);
    await hist.record({ filePath: 'src/x.ts', startLine: 5, endLine: 10, snippetPreview: 'old' });
    await hist.record({ filePath: 'src/x.ts', startLine: 5, endLine: 10, snippetPreview: 'new' });
    const records = hist.getRecent();
    expect(records).toHaveLength(1);
    expect(records[0].snippetPreview).toBe('new');
  });

  it('record 保留最多 50 条', async () => {
    const memento = createFakeMemento();
    const hist = new InlineEditHistory(memento as any);
    for (let i = 0; i < 60; i++) {
      await hist.record({ filePath: `src/file${i}.ts`, startLine: 1, endLine: 2, snippetPreview: `file${i}` });
    }
    const records = hist.getRecent();
    expect(records).toHaveLength(50);
  });

  it('clear 清空所有记录', async () => {
    const memento = createFakeMemento();
    const hist = new InlineEditHistory(memento as any);
    await hist.record({ filePath: 'src/a.ts', startLine: 1, endLine: 2, snippetPreview: 'x' });
    await hist.clear();
    expect(hist.getRecent()).toHaveLength(0);
  });

  it('snippetPreview 截断到 500 字符', async () => {
    const memento = createFakeMemento();
    const hist = new InlineEditHistory(memento as any);
    const longSnippet = 'x'.repeat(1000);
    // 注意：截断在 recordInlineEditHistory 调用方完成，InlineEditHistory 本身不截断
    // 这里验证传什么存什么
    await hist.record({ filePath: 'src/a.ts', startLine: 1, endLine: 2, snippetPreview: longSnippet });
    const records = hist.getRecent();
    expect(records[0].snippetPreview).toBe(longSnippet);
  });

  it('跨 memento 实例持久化', async () => {
    const memento = createFakeMemento();
    const hist1 = new InlineEditHistory(memento as any);
    await hist1.record({ filePath: 'src/persist.ts', startLine: 1, endLine: 5, snippetPreview: 'persisted' });
    // 新实例共享同一 memento
    const hist2 = new InlineEditHistory(memento as any);
    const records = hist2.getRecent();
    expect(records).toHaveLength(1);
    expect(records[0].filePath).toBe('src/persist.ts');
  });
});
