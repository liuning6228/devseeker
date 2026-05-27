/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

import { describe, it, expect, vi } from 'vitest';
import { IndexFileWatcher } from '../../src/core/index/watcher.js';

/**
 * IndexFileWatcher 单测（W4.6 / B-P2-4）
 * - 使用 DI 注入 fake setTimeout/clearTimeout，避免真实 2s 等待
 * - 覆盖：节流合并 / 同文件事件重置 / delete→remove / size===0 跳过 / dispose 清理
 */

interface FakeTimer {
  id: number;
  fn: () => void;
  cancelled: boolean;
}

function makeFakeTimers() {
  let next = 1;
  const timers = new Map<number, FakeTimer>();
  const setTimeoutFn = ((fn: () => void) => {
    const id = next++;
    timers.set(id, { id, fn, cancelled: false });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  const clearTimeoutFn = ((id: unknown) => {
    const key = id as number;
    const t = timers.get(key);
    if (t) {
      t.cancelled = true;
      timers.delete(key);
    }
  }) as (id: ReturnType<typeof setTimeout>) => void;
  const flushAll = async () => {
    const snapshot = Array.from(timers.values()).filter((t) => !t.cancelled);
    timers.clear();
    for (const t of snapshot) t.fn();
    // drain microtasks: flush() has multiple awaits + catch
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { setTimeoutFn, clearTimeoutFn, flushAll, activeCount: () => timers.size };
}

describe('IndexFileWatcher', () => {
  it('schedule 后 timer 未触发时不调 updateFile，触发后调用一次', async () => {
    const { setTimeoutFn, clearTimeoutFn, flushAll } = makeFakeTimers();
    const updateFile = vi.fn().mockResolvedValue(undefined);
    const removeFile = vi.fn();
    const getIndex = vi.fn().mockResolvedValue({
      size: () => 42,
      updateFile,
      removeFile,
    });
    const w = new IndexFileWatcher({
      getIndex,
      isCodeFile: () => true,
      setTimeoutFn,
      clearTimeoutFn,
    });

    w.schedule('src/a.ts', 'update');
    expect(updateFile).not.toHaveBeenCalled();
    expect(w.pendingCount()).toBe(1);

    await flushAll();
    expect(updateFile).toHaveBeenCalledTimes(1);
    expect(updateFile).toHaveBeenCalledWith('src/a.ts');
    expect(w.pendingCount()).toBe(0);
  });

  it('同文件多次 schedule 合并为一次调用（重置 timer）', async () => {
    const { setTimeoutFn, clearTimeoutFn, flushAll } = makeFakeTimers();
    const updateFile = vi.fn().mockResolvedValue(undefined);
    const getIndex = vi.fn().mockResolvedValue({
      size: () => 10,
      updateFile,
      removeFile: vi.fn(),
    });
    const w = new IndexFileWatcher({
      getIndex,
      isCodeFile: () => true,
      setTimeoutFn,
      clearTimeoutFn,
    });

    w.schedule('src/a.ts', 'update');
    w.schedule('src/a.ts', 'update');
    w.schedule('src/a.ts', 'update');
    expect(w.pendingCount()).toBe(1);

    await flushAll();
    expect(updateFile).toHaveBeenCalledTimes(1);
  });

  it('delete 走 removeFile', async () => {
    const { setTimeoutFn, clearTimeoutFn, flushAll } = makeFakeTimers();
    const removeFile = vi.fn();
    const getIndex = vi.fn().mockResolvedValue({
      size: () => 5,
      updateFile: vi.fn(),
      removeFile,
    });
    const w = new IndexFileWatcher({
      getIndex,
      isCodeFile: () => true,
      setTimeoutFn,
      clearTimeoutFn,
    });

    w.schedule('src/gone.ts', 'remove');
    await flushAll();
    expect(removeFile).toHaveBeenCalledWith('src/gone.ts');
  });

  it('非代码文件直接跳过（不登记 timer）', () => {
    const { setTimeoutFn, clearTimeoutFn, activeCount } = makeFakeTimers();
    const w = new IndexFileWatcher({
      getIndex: vi.fn(),
      isCodeFile: (p) => p.endsWith('.ts'),
      setTimeoutFn,
      clearTimeoutFn,
    });

    w.schedule('README.md', 'update');
    w.schedule('build/out.js', 'update');
    expect(w.pendingCount()).toBe(0);
    expect(activeCount()).toBe(0);
  });

  it('索引尚未建立（size===0）时 flush 直接跳过', async () => {
    const { setTimeoutFn, clearTimeoutFn, flushAll } = makeFakeTimers();
    const updateFile = vi.fn().mockResolvedValue(undefined);
    const getIndex = vi.fn().mockResolvedValue({
      size: () => 0,
      updateFile,
      removeFile: vi.fn(),
    });
    const w = new IndexFileWatcher({
      getIndex,
      isCodeFile: () => true,
      setTimeoutFn,
      clearTimeoutFn,
    });

    w.schedule('src/a.ts', 'update');
    await flushAll();
    expect(updateFile).not.toHaveBeenCalled();
  });

  it('getIndex undefined（索引未开启）时静默跳过', async () => {
    const { setTimeoutFn, clearTimeoutFn, flushAll } = makeFakeTimers();
    const w = new IndexFileWatcher({
      getIndex: vi.fn().mockResolvedValue(undefined),
      isCodeFile: () => true,
      setTimeoutFn,
      clearTimeoutFn,
    });

    w.schedule('src/a.ts', 'update');
    await expect(flushAll()).resolves.toBeUndefined();
  });

  it('updateFile 抛错时触发 onError 回调（不崩溃）', async () => {
    const { setTimeoutFn, clearTimeoutFn, flushAll } = makeFakeTimers();
    const err = new Error('boom');
    const updateFile = vi.fn().mockRejectedValue(err);
    const getIndex = vi.fn().mockResolvedValue({
      size: () => 3,
      updateFile,
      removeFile: vi.fn(),
    });
    const onError = vi.fn();
    const w = new IndexFileWatcher({
      getIndex,
      isCodeFile: () => true,
      onError,
      setTimeoutFn,
      clearTimeoutFn,
    });

    w.schedule('src/a.ts', 'update');
    await flushAll();
    expect(onError).toHaveBeenCalledWith(err, 'src/a.ts', 'update');
  });

  it('dispose 清理所有 pending timer，之后 schedule 无效', async () => {
    const { setTimeoutFn, clearTimeoutFn, flushAll, activeCount } = makeFakeTimers();
    const updateFile = vi.fn().mockResolvedValue(undefined);
    const getIndex = vi.fn().mockResolvedValue({
      size: () => 10,
      updateFile,
      removeFile: vi.fn(),
    });
    const w = new IndexFileWatcher({
      getIndex,
      isCodeFile: () => true,
      setTimeoutFn,
      clearTimeoutFn,
    });

    w.schedule('src/a.ts', 'update');
    w.schedule('src/b.ts', 'update');
    expect(w.pendingCount()).toBe(2);

    w.dispose();
    expect(w.pendingCount()).toBe(0);
    expect(activeCount()).toBe(0);

    // dispose 后再 schedule 不应登记
    w.schedule('src/c.ts', 'update');
    expect(w.pendingCount()).toBe(0);

    await flushAll();
    expect(updateFile).not.toHaveBeenCalled();
  });

  it('flush 立即执行（绕过 timer）', async () => {
    const { setTimeoutFn, clearTimeoutFn } = makeFakeTimers();
    const updateFile = vi.fn().mockResolvedValue(undefined);
    const getIndex = vi.fn().mockResolvedValue({
      size: () => 1,
      updateFile,
      removeFile: vi.fn(),
    });
    const w = new IndexFileWatcher({
      getIndex,
      isCodeFile: () => true,
      setTimeoutFn,
      clearTimeoutFn,
    });

    await w.flush('src/x.ts', 'update');
    expect(updateFile).toHaveBeenCalledWith('src/x.ts');
  });
});
