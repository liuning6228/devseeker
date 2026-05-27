/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W5b2a · CheckpointStore 单测
 *
 * 覆盖：
 * - create → 落盘 json + files 池去重
 * - list / get 读取
 * - revert 应用文件 + wasDeleted → 删除
 * - revert 文件内容回滚
 * - skipped：大文件不写池；revert 跳过
 * - prune：按 createdAt 升序裁剪
 * - 路径穿越防护
 * - sessionId 包含特殊字符被 sanitize
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { CheckpointStore } from '../../src/core/checkpoints/index.js';
import type { Message } from '../../src/providers/types.js';
import { initLogger } from '../../src/infra/logger.js';

let tmpRoot: string;

beforeEach(async () => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-checkpoints-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

function makeStore(opts?: { maxFileBytes?: number; maxPerSession?: number }): CheckpointStore {
  return new CheckpointStore({
    workspaceRoot: tmpRoot,
    ...(opts?.maxFileBytes !== undefined ? { maxFileBytes: opts.maxFileBytes } : {}),
    ...(opts?.maxPerSession !== undefined ? { maxPerSession: opts.maxPerSession } : {}),
  });
}

const sampleMessages: Message[] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
];

describe('CheckpointStore.create', () => {
  it('persists checkpoint json + updates index.json', async () => {
    const store = makeStore();
    const cp = await store.create({ sessionId: 's1', messages: sampleMessages, label: 'v1' });

    expect(cp.id).toMatch(/^cp-/);
    expect(cp.sessionId).toBe('s1');
    expect(cp.label).toBe('v1');
    expect(cp.messageCount).toBe(2);

    const file = path.join(tmpRoot, '.devseeker/checkpoints/s1', `${cp.id}.json`);
    expect(existsSync(file)).toBe(true);

    const list = await store.list('s1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(cp.id);
  });

  it('stores file snapshots and dedupes by sha256', async () => {
    const store = makeStore();
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [
        { relPath: 'a.ts', content: 'same' },
        { relPath: 'b.ts', content: 'same' }, // 同内容 → 同 hash
        { relPath: 'c.ts', content: 'different' },
      ],
    });

    expect(cp.fileSnapshots).toHaveLength(3);
    const hashSame = createHash('sha256').update('same').digest('hex');
    const hashDiff = createHash('sha256').update('different').digest('hex');
    expect(cp.fileSnapshots[0].contentHash).toBe(hashSame);
    expect(cp.fileSnapshots[1].contentHash).toBe(hashSame);
    expect(cp.fileSnapshots[2].contentHash).toBe(hashDiff);

    // 文件池应只有 2 个唯一内容
    const poolDir = path.join(tmpRoot, '.devseeker/checkpoints/files');
    const poolFiles = await fs.readdir(poolDir);
    expect(poolFiles.sort()).toEqual([hashDiff, hashSame].sort());
  });

  it('marks deleted files with wasDeleted=true', async () => {
    const store = makeStore();
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: 'gone.ts', content: null }],
    });
    expect(cp.fileSnapshots[0].wasDeleted).toBe(true);
    expect(cp.fileSnapshots[0].contentHash).toBe('');
  });

  it('marks oversize files as skipped; does not write pool', async () => {
    const store = makeStore({ maxFileBytes: 5 });
    const big = 'ABCDEFGHIJ'; // 10 bytes > 5
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: 'big.ts', content: big }],
    });
    expect(cp.fileSnapshots[0].skipped).toBe(true);
    expect(cp.fileSnapshots[0].contentHash).toBe('');

    const poolDir = path.join(tmpRoot, '.devseeker/checkpoints/files');
    const exists = existsSync(poolDir) ? (await fs.readdir(poolDir)).length : 0;
    expect(exists).toBe(0);
  });
});

describe('CheckpointStore.list / get', () => {
  it('list returns metadata only in creation order', async () => {
    const store = makeStore();
    const a = await store.create({ sessionId: 's1', messages: sampleMessages });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ sessionId: 's1', messages: sampleMessages });

    const list = await store.list('s1');
    expect(list.map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it('get returns full Checkpoint; undefined when not found', async () => {
    const store = makeStore();
    const a = await store.create({ sessionId: 's1', messages: sampleMessages });
    const got = await store.get(a.id, 's1');
    expect(got?.messages).toEqual(sampleMessages);
    const notFound = await store.get('cp-x', 's1');
    expect(notFound).toBeUndefined();
  });
});

describe('CheckpointStore.revert', () => {
  it('restores files from pool; returns messages', async () => {
    const store = makeStore();
    const target = path.join(tmpRoot, 'src/a.ts');
    await fs.mkdir(path.dirname(target), { recursive: true });

    // checkpoint 时刻 a.ts = "v1"
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: 'src/a.ts', content: 'v1' }],
    });

    // 模拟后续修改
    await fs.writeFile(target, 'v2 modified', 'utf-8');

    const res = await store.revert({ id: cp.id, sessionId: 's1' });
    expect(res.filesApplied).toBe(1);
    expect(res.messages).toEqual(sampleMessages);
    const content = await fs.readFile(target, 'utf-8');
    expect(content).toBe('v1');
  });

  it('deletes files when wasDeleted=true', async () => {
    const store = makeStore();
    const newly = path.join(tmpRoot, 'new.ts');

    // checkpoint 时刻 new.ts 不存在
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: 'new.ts', content: null }],
    });

    // 之后创建了 new.ts
    await fs.writeFile(newly, 'created later', 'utf-8');
    expect(existsSync(newly)).toBe(true);

    const res = await store.revert({ id: cp.id, sessionId: 's1' });
    expect(res.filesDeleted).toBe(1);
    expect(existsSync(newly)).toBe(false);
  });

  it('applyFiles=false skips file mutations', async () => {
    const store = makeStore();
    const target = path.join(tmpRoot, 'b.ts');
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: 'b.ts', content: 'snapshot' }],
    });
    await fs.writeFile(target, 'dirty', 'utf-8');

    const res = await store.revert({ id: cp.id, sessionId: 's1', applyFiles: false });
    expect(res.filesApplied).toBe(0);
    expect(await fs.readFile(target, 'utf-8')).toBe('dirty');
    expect(res.messages).toEqual(sampleMessages);
  });

  it('skipped files increment filesSkipped on revert', async () => {
    const store = makeStore({ maxFileBytes: 3 });
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: 'big.ts', content: 'XXXXXXX' }],
    });
    const res = await store.revert({ id: cp.id, sessionId: 's1' });
    expect(res.filesSkipped).toBe(1);
    expect(res.filesApplied).toBe(0);
  });

  it('throws when checkpoint id not found', async () => {
    const store = makeStore();
    await expect(store.revert({ id: 'nope', sessionId: 's1' })).rejects.toThrow(/not found/);
  });

  it('rejects path-traversal relPath (skipped, no write outside workspace)', async () => {
    const store = makeStore();
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: '../escape.ts', content: 'evil' }],
    });
    const res = await store.revert({ id: cp.id, sessionId: 's1' });
    expect(res.filesApplied).toBe(0);
    expect(res.filesSkipped).toBe(1);
    expect(existsSync(path.join(tmpRoot, '..', 'escape.ts'))).toBe(false);
  });
});

describe('CheckpointStore.prune', () => {
  it('removes oldest when exceeding max', async () => {
    const store = makeStore({ maxPerSession: 2 });
    const a = await store.create({ sessionId: 's1', messages: sampleMessages });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ sessionId: 's1', messages: sampleMessages });
    await new Promise((r) => setTimeout(r, 5));
    const c = await store.create({ sessionId: 's1', messages: sampleMessages });

    const list = await store.list('s1');
    expect(list.map((m) => m.id)).toEqual([b.id, c.id]);
    const oldFile = path.join(tmpRoot, '.devseeker/checkpoints/s1', `${a.id}.json`);
    expect(existsSync(oldFile)).toBe(false);
  });
});

describe('CheckpointStore.sessionId sanitization', () => {
  it('non-filesystem-safe sessionId is sanitized to _', async () => {
    const store = makeStore();
    const cp = await store.create({ sessionId: 's/1:bad?', messages: sampleMessages });
    const dir = path.join(tmpRoot, '.devseeker/checkpoints/s_1_bad_');
    expect(existsSync(dir)).toBe(true);
    const list = await store.list('s/1:bad?');
    expect(list[0].id).toBe(cp.id);
  });
});

describe('CheckpointStore.precheckRevert (W10.2)', () => {
  it('detects modified_by_user when disk hash differs', async () => {
    const store = makeStore();
    const target = path.join(tmpRoot, 'a.ts');
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: 'a.ts', content: 'v1' }],
    });
    await fs.writeFile(target, 'v2 user edit', 'utf-8');

    const pre = await store.precheckRevert(cp.id, 's1');
    expect(pre.conflicts).toHaveLength(1);
    expect(pre.conflicts[0].relPath).toBe('a.ts');
    expect(pre.conflicts[0].reason).toBe('modified_by_user');
    expect(pre.conflicts[0].expectedHash).toBe(
      createHash('sha256').update('v1').digest('hex'),
    );
    expect(pre.conflicts[0].actualHash).toBe(
      createHash('sha256').update('v2 user edit').digest('hex'),
    );
  });

  it('detects deleted_by_user when file missing on disk', async () => {
    const store = makeStore();
    const target = path.join(tmpRoot, 'x.ts');
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: 'x.ts', content: 'hello' }],
    });
    // 写快照时 resolveSafe 不真实落盘；显式删除
    if (existsSync(target)) await fs.rm(target, { force: true });

    const pre = await store.precheckRevert(cp.id, 's1');
    expect(pre.conflicts).toHaveLength(1);
    expect(pre.conflicts[0].reason).toBe('deleted_by_user');
  });

  it('detects created_by_user when snapshot had wasDeleted but disk has file', async () => {
    const store = makeStore();
    const target = path.join(tmpRoot, 'new.ts');
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: 'new.ts', content: null }],
    });
    await fs.writeFile(target, 'user created', 'utf-8');

    const pre = await store.precheckRevert(cp.id, 's1');
    expect(pre.conflicts).toHaveLength(1);
    expect(pre.conflicts[0].reason).toBe('created_by_user');
  });

  it('returns empty conflicts when disk matches snapshot', async () => {
    const store = makeStore();
    const target = path.join(tmpRoot, 'same.ts');
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: 'same.ts', content: 'v1' }],
    });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'v1', 'utf-8');

    const pre = await store.precheckRevert(cp.id, 's1');
    expect(pre.conflicts).toHaveLength(0);
  });
});

describe('CheckpointStore.revert onConflict (W10.2)', () => {
  it('overwrite strategy (default) still applies even when modified', async () => {
    const store = makeStore();
    const target = path.join(tmpRoot, 'a.ts');
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: 'a.ts', content: 'v1' }],
    });
    await fs.writeFile(target, 'user edit', 'utf-8');
    const res = await store.revert({ id: cp.id, sessionId: 's1' });
    expect(res.filesApplied).toBe(1);
    expect(res.conflicts).toBeDefined();
    expect(res.conflicts?.length).toBe(1);
    expect(await fs.readFile(target, 'utf-8')).toBe('v1');
  });

  it('skip strategy keeps user version for conflicting files', async () => {
    const store = makeStore();
    const conflictTarget = path.join(tmpRoot, 'a.ts');
    const cleanTarget = path.join(tmpRoot, 'b.ts');
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [
        { relPath: 'a.ts', content: 'v1-a' },
        { relPath: 'b.ts', content: 'v1-b' },
      ],
    });
    await fs.writeFile(conflictTarget, 'user edit a', 'utf-8');
    // b.ts 保持未动 → 无冲突（disk 不存在即 deleted_by_user 冲突。为测 skip 选 disk 和快照一致）
    await fs.writeFile(cleanTarget, 'v1-b', 'utf-8');

    const res = await store.revert({
      id: cp.id,
      sessionId: 's1',
      onConflict: 'skip',
    });
    expect(res.filesSkipped).toBe(1);
    expect(res.filesApplied).toBe(1);
    expect(await fs.readFile(conflictTarget, 'utf-8')).toBe('user edit a');
    expect(await fs.readFile(cleanTarget, 'utf-8')).toBe('v1-b');
  });

  it('abort strategy throws and does not touch any file', async () => {
    const store = makeStore();
    const target = path.join(tmpRoot, 'a.ts');
    const cp = await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: 'a.ts', content: 'v1' }],
    });
    await fs.writeFile(target, 'user edit', 'utf-8');
    await expect(
      store.revert({ id: cp.id, sessionId: 's1', onConflict: 'abort' }),
    ).rejects.toThrow(/回滚中止/);
    expect(await fs.readFile(target, 'utf-8')).toBe('user edit');
  });
});

describe('CheckpointStore.gcOlderThan (W10.4)', () => {
  it('removes checkpoints older than cutoff across sessions', async () => {
    const store = makeStore();
    const oldCp = await store.create({ sessionId: 's1', messages: sampleMessages });
    const newCp = await store.create({ sessionId: 's1', messages: sampleMessages });
    const other = await store.create({ sessionId: 's2', messages: sampleMessages });

    // 手动把 s1/oldCp 的 createdAt 改成 10 天前
    const ageMs = 10 * 24 * 60 * 60 * 1000;
    const oldFile = path.join(
      tmpRoot,
      '.devseeker/checkpoints/s1',
      `${oldCp.id}.json`,
    );
    const raw = JSON.parse(await fs.readFile(oldFile, 'utf-8'));
    raw.createdAt = Date.now() - ageMs;
    await fs.writeFile(oldFile, JSON.stringify(raw), 'utf-8');
    const idxFile = path.join(tmpRoot, '.devseeker/checkpoints/s1/index.json');
    const idx = JSON.parse(await fs.readFile(idxFile, 'utf-8'));
    for (const m of idx.entries) {
      if (m.id === oldCp.id) m.createdAt = raw.createdAt;
    }
    await fs.writeFile(idxFile, JSON.stringify(idx, null, 2), 'utf-8');

    const out = await store.gcOlderThan(7);
    expect(out.removedCheckpoints).toBe(1);
    expect(existsSync(oldFile)).toBe(false);

    const lst1 = await store.list('s1');
    expect(lst1.map((m) => m.id)).toEqual([newCp.id]);
    const lst2 = await store.list('s2');
    expect(lst2.map((m) => m.id)).toEqual([other.id]);
  });

  it('noop when olderThanDays <= 0', async () => {
    const store = makeStore();
    await store.create({ sessionId: 's1', messages: sampleMessages });
    const out = await store.gcOlderThan(0);
    expect(out.removedCheckpoints).toBe(0);
    expect(out.removedPoolEntries).toBe(0);
  });
});

describe('CheckpointStore.gcOrphanPoolFiles (W10.4)', () => {
  it('removes pool files not referenced by any checkpoint', async () => {
    const store = makeStore();
    await store.create({
      sessionId: 's1',
      messages: sampleMessages,
      files: [{ relPath: 'a.ts', content: 'keep-me' }],
    });
    // 手动在 files/ 池中放一个孤儿
    const poolDir = path.join(tmpRoot, '.devseeker/checkpoints/files');
    const orphanHash = createHash('sha256').update('orphan').digest('hex');
    await fs.writeFile(path.join(poolDir, orphanHash), 'orphan', 'utf-8');

    const removed = await store.gcOrphanPoolFiles();
    expect(removed).toBe(1);
    expect(existsSync(path.join(poolDir, orphanHash))).toBe(false);
    // 被引用的 hash 还在
    const keepHash = createHash('sha256').update('keep-me').digest('hex');
    expect(existsSync(path.join(poolDir, keepHash))).toBe(true);
  });
});

describe('CheckpointStore.delete', () => {
  it('removes the json file and strips from index', async () => {
    const store = makeStore();
    const a = await store.create({ sessionId: 's1', messages: sampleMessages, label: 'a' });
    await new Promise((r) => setTimeout(r, 2));
    const b = await store.create({ sessionId: 's1', messages: sampleMessages, label: 'b' });

    const ok = await store.delete(a.id, 's1');
    expect(ok).toBe(true);

    const list = await store.list('s1');
    expect(list.map((m) => m.id)).toEqual([b.id]);

    const aFile = path.join(tmpRoot, '.devseeker/checkpoints/s1', `${a.id}.json`);
    expect(existsSync(aFile)).toBe(false);
  });

  it('returns false when id not found', async () => {
    const store = makeStore();
    await store.create({ sessionId: 's1', messages: sampleMessages });
    const ok = await store.delete('cp-nope', 's1');
    expect(ok).toBe(false);
  });

  it('leaves other sessions untouched', async () => {
    const store = makeStore();
    const a = await store.create({ sessionId: 's1', messages: sampleMessages });
    const b = await store.create({ sessionId: 's2', messages: sampleMessages });
    await store.delete(a.id, 's1');
    const l2 = await store.list('s2');
    expect(l2.map((m) => m.id)).toEqual([b.id]);
  });
});
