/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * FileStateCache 单测 + PATCH.CONFLICT 误报回归
 *
 * 覆盖：
 * - record/get 基础 + TTL 过期
 * - invalidate 移除条目
 * - refreshFileStateCacheAfterWrite（误报修复核心）：
 *   写后刷新新 mtime → "自写当外写"的连续编辑不再误报（修复前必误报）
 * - removed / 文件不存在 → invalidate
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileStateCache,
  refreshFileStateCacheAfterWrite,
} from '../../src/core/tools/file-state-cache.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsc-test-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('FileStateCache 基础', () => {
  it('record 后可 get；TTL 过期后返回 null 并清除条目', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00Z'));
    const cache = new FileStateCache(1000);
    cache.record('/x/a.ts', 123);
    expect(cache.get('/x/a.ts')?.recordedMtimeMs).toBe(123);

    vi.setSystemTime(new Date('2026-09-18T00:00:02Z')); // +2s > 1s TTL
    expect(cache.get('/x/a.ts')).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('invalidate 移除条目', () => {
    const cache = new FileStateCache();
    cache.record('/x/a.ts', 123);
    cache.invalidate('/x/a.ts');
    expect(cache.get('/x/a.ts')).toBeNull();
  });
});

describe('refreshFileStateCacheAfterWrite · PATCH.CONFLICT 误报回归', () => {
  it('写后刷新：陈旧 mtime 被更新为磁盘当前 mtime（消除连续编辑误报）', async () => {
    const file = path.join(tmpDir, 'a.ts');
    await fs.writeFile(file, 'const a = 1;\n');
    const real = await fs.realpath(file);

    const cache = new FileStateCache();
    // 模拟 read_file 记录的陈旧 mtime（修复前：此后自写会把它变成"外部修改"）
    const st0 = await fs.stat(real);
    cache.record(real, st0.mtimeMs - 9999);

    // 编辑#1 写盘 → 写后刷新（修复点：ToolRunner 在写类工具成功后调用）
    await fs.writeFile(file, 'const a = 2;\n');
    await refreshFileStateCacheAfterWrite(cache, file);

    // 编辑#2 的冲突检查条件：缓存 mtime === 磁盘当前 mtime
    const st1 = await fs.stat(real);
    const cached = cache.get(real);
    expect(cached).not.toBeNull();
    expect(cached!.recordedMtimeMs).toBe(st1.mtimeMs);
  });

  it('相对路径 + workspaceRoot 解析成功', async () => {
    const file = path.join(tmpDir, 'rel.ts');
    await fs.writeFile(file, 'x\n');
    const cache = new FileStateCache();
    await refreshFileStateCacheAfterWrite(cache, 'rel.ts', { workspaceRoot: tmpDir });
    const real = await fs.realpath(file);
    expect(cache.get(real)).not.toBeNull();
  });

  it('removed=true → invalidate（删除后不残留旧 mtime）', async () => {
    const file = path.join(tmpDir, 'gone.ts');
    await fs.writeFile(file, 'x\n');
    const real = await fs.realpath(file);
    const cache = new FileStateCache();
    cache.record(real, 123);
    await fs.rm(file);
    await refreshFileStateCacheAfterWrite(cache, file, { removed: true });
    expect(cache.get(real)).toBeNull();
  });

  it('文件不存在且未标记 removed → invalidate（避免残留过期 mtime）', async () => {
    const cache = new FileStateCache();
    const file = path.join(tmpDir, 'never-existed.ts');
    await refreshFileStateCacheAfterWrite(cache, file);
    expect(cache.size()).toBe(0);
  });
});
