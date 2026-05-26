/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W5b2b · CheckpointCoordinator 单测
 *
 * 覆盖：
 * - onToolExec：write_file / search_replace 触发写前读原文件
 * - 非跟踪工具（bash / read_file）不触发
 * - 同一 relPath 两次只记首次
 * - 文件原本不存在 → wasDeleted=true
 * - Windows 风格 \ 路径被归一化
 * - 路径穿越 / 绝对路径被拒绝
 * - finalizeTurn 落盘 + 清空 pending
 * - 无 sessionId / 空 messages 不创建快照
 * - revert 通过 coordinator 透传到 store
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CheckpointCoordinator,
  CheckpointStore,
  TRACKED_WRITE_TOOLS,
} from '../../src/core/checkpoints/index.js';
import type { Message } from '../../src/providers/types.js';
import { initLogger } from '../../src/infra/logger.js';

let tmpRoot: string;

beforeEach(async () => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-coord-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

function makeCoord(): { coord: CheckpointCoordinator; store: CheckpointStore } {
  const store = new CheckpointStore({ workspaceRoot: tmpRoot });
  const coord = new CheckpointCoordinator({ store, workspaceRoot: tmpRoot });
  return { coord, store };
}

const msgs: Message[] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'ok' },
];

describe('CheckpointCoordinator.TRACKED_WRITE_TOOLS', () => {
  it('includes write_file and search_replace', () => {
    expect(TRACKED_WRITE_TOOLS.has('write_file')).toBe(true);
    expect(TRACKED_WRITE_TOOLS.has('search_replace')).toBe(true);
    expect(TRACKED_WRITE_TOOLS.has('bash')).toBe(false);
    expect(TRACKED_WRITE_TOOLS.has('read_file')).toBe(false);
  });
});

describe('CheckpointCoordinator.onToolExec', () => {
  it('captures current content for write_file before execution', async () => {
    const { coord } = makeCoord();
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'original', 'utf-8');

    coord.beginTurn();
    coord.onToolExec('write_file', { file_path: 'a.ts', content: 'NEW' });
    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });

    expect(cp).toBeDefined();
    expect(cp!.fileSnapshots).toHaveLength(1);
    expect(cp!.fileSnapshots[0].relPath).toBe('a.ts');
    expect(cp!.fileSnapshots[0].wasDeleted).toBe(false);
    // 读取池内容应为 "original"（任务前状态）
    const poolPath = path.join(
      tmpRoot,
      '.dualmind/checkpoints/files',
      cp!.fileSnapshots[0].contentHash,
    );
    expect(await fs.readFile(poolPath, 'utf-8')).toBe('original');
  });

  it('captures wasDeleted=true when target does not exist', async () => {
    const { coord } = makeCoord();
    coord.beginTurn();
    coord.onToolExec('write_file', { file_path: 'new.ts', content: 'hello' });
    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });

    expect(cp!.fileSnapshots).toHaveLength(1);
    expect(cp!.fileSnapshots[0].wasDeleted).toBe(true);
    expect(cp!.fileSnapshots[0].contentHash).toBe('');
  });

  it('captures for search_replace via file_path argument', async () => {
    const { coord } = makeCoord();
    await fs.writeFile(path.join(tmpRoot, 'b.ts'), 'BEFORE', 'utf-8');

    coord.beginTurn();
    coord.onToolExec('search_replace', {
      file_path: 'b.ts',
      old_string: 'BEFORE',
      new_string: 'AFTER',
    });
    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });

    expect(cp!.fileSnapshots).toHaveLength(1);
    expect(cp!.fileSnapshots[0].relPath).toBe('b.ts');
  });

  it('ignores non-tracked tools (bash, read_file)', async () => {
    const { coord } = makeCoord();
    coord.beginTurn();
    coord.onToolExec('bash', { command: 'rm x.ts' });
    coord.onToolExec('read_file', { file_path: 'a.ts' });
    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });

    // messages 非空 → 仍创建 checkpoint；但 files 为空
    expect(cp).toBeDefined();
    expect(cp!.fileSnapshots).toHaveLength(0);
  });

  it('only keeps the first snapshot of the same relPath across multiple tool calls', async () => {
    const { coord } = makeCoord();
    const target = path.join(tmpRoot, 'a.ts');
    await fs.writeFile(target, 'v1', 'utf-8');

    coord.beginTurn();
    coord.onToolExec('write_file', { file_path: 'a.ts', content: 'v2' });
    // 等第一次 onToolExec 的异步读完成后，模拟工具写盘导致 v2 落地
    await new Promise((r) => setTimeout(r, 10));
    await fs.writeFile(target, 'v2', 'utf-8');
    coord.onToolExec('write_file', { file_path: 'a.ts', content: 'v3' });

    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });
    expect(cp!.fileSnapshots).toHaveLength(1);
    const poolPath = path.join(
      tmpRoot,
      '.dualmind/checkpoints/files',
      cp!.fileSnapshots[0].contentHash,
    );
    expect(await fs.readFile(poolPath, 'utf-8')).toBe('v1');
  });

  it('normalizes Windows backslashes to /', async () => {
    const { coord } = makeCoord();
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'src', 'a.ts'), 'x', 'utf-8');

    coord.beginTurn();
    coord.onToolExec('write_file', { file_path: 'src\\a.ts', content: 'y' });
    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });
    expect(cp!.fileSnapshots[0].relPath).toBe('src/a.ts');
  });

  it('rejects path-traversal and absolute paths', async () => {
    const { coord } = makeCoord();
    coord.beginTurn();
    coord.onToolExec('write_file', { file_path: '../outside.ts', content: 'evil' });
    coord.onToolExec('write_file', { file_path: '/etc/passwd', content: 'evil' });
    coord.onToolExec('write_file', { file_path: 'C:/Windows/x.dll', content: 'evil' });
    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });
    expect(cp!.fileSnapshots).toHaveLength(0);
  });

  it('ignores tool call without file_path', async () => {
    const { coord } = makeCoord();
    coord.beginTurn();
    coord.onToolExec('write_file', { content: 'no path' });
    coord.onToolExec('write_file', { file_path: '' });
    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });
    expect(cp!.fileSnapshots).toHaveLength(0);
  });

  it('does nothing when disabled', async () => {
    const { coord } = makeCoord();
    coord.setEnabled(false);
    coord.beginTurn();
    coord.onToolExec('write_file', { file_path: 'a.ts', content: 'x' });
    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });
    expect(cp).toBeUndefined();
  });
});

describe('CheckpointCoordinator.finalizeTurn', () => {
  it('clears pending between turns', async () => {
    const { coord } = makeCoord();
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'A', 'utf-8');
    await fs.writeFile(path.join(tmpRoot, 'b.ts'), 'B', 'utf-8');

    coord.beginTurn();
    coord.onToolExec('write_file', { file_path: 'a.ts', content: '' });
    const cp1 = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });
    expect(cp1!.fileSnapshots.map((s) => s.relPath)).toEqual(['a.ts']);

    coord.beginTurn();
    coord.onToolExec('write_file', { file_path: 'b.ts', content: '' });
    const cp2 = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });
    expect(cp2!.fileSnapshots.map((s) => s.relPath)).toEqual(['b.ts']);
  });

  it('returns undefined when sessionId is empty', async () => {
    const { coord } = makeCoord();
    coord.beginTurn();
    coord.onToolExec('write_file', { file_path: 'a.ts', content: 'x' });
    const cp = await coord.finalizeTurn({ sessionId: '', messages: msgs });
    expect(cp).toBeUndefined();
  });

  it('skips creation when no files AND no messages', async () => {
    const { coord } = makeCoord();
    coord.beginTurn();
    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: [] });
    expect(cp).toBeUndefined();
  });

  it('creates message-only checkpoint when pending files are empty (default forceEmpty=true)', async () => {
    const { coord } = makeCoord();
    coord.beginTurn();
    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });
    expect(cp).toBeDefined();
    expect(cp!.fileSnapshots).toHaveLength(0);
    expect(cp!.messages).toEqual(msgs);
  });

  it('respects forceEmpty=false → skip when files empty', async () => {
    const { coord } = makeCoord();
    coord.beginTurn();
    const cp = await coord.finalizeTurn({
      sessionId: 's1',
      messages: msgs,
      forceEmpty: false,
    });
    expect(cp).toBeUndefined();
  });
});

describe('CheckpointCoordinator.list / revert', () => {
  it('list delegates to store in creation order', async () => {
    const { coord } = makeCoord();
    coord.beginTurn();
    const a = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });
    coord.beginTurn();
    const b = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });

    const list = await coord.list('s1');
    expect(list.map((m) => m.id)).toEqual([a!.id, b!.id]);
  });

  it('revert restores files and returns messages', async () => {
    const { coord } = makeCoord();
    const target = path.join(tmpRoot, 'a.ts');
    await fs.writeFile(target, 'BEFORE', 'utf-8');

    coord.beginTurn();
    coord.onToolExec('write_file', { file_path: 'a.ts', content: 'AFTER' });
    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });

    // 模拟工具已把内容改成 AFTER
    await fs.writeFile(target, 'AFTER', 'utf-8');

    const res = await coord.revert({ id: cp!.id, sessionId: 's1' });
    expect(res.filesApplied).toBe(1);
    expect(res.messages).toEqual(msgs);
    expect(await fs.readFile(target, 'utf-8')).toBe('BEFORE');
  });

  it('revert with applyFiles=false keeps current files on disk', async () => {
    const { coord } = makeCoord();
    const target = path.join(tmpRoot, 'a.ts');
    await fs.writeFile(target, 'BEFORE', 'utf-8');

    coord.beginTurn();
    coord.onToolExec('write_file', { file_path: 'a.ts', content: 'AFTER' });
    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });
    await fs.writeFile(target, 'AFTER', 'utf-8');

    const res = await coord.revert({ id: cp!.id, sessionId: 's1', applyFiles: false });
    expect(res.filesApplied).toBe(0);
    expect(await fs.readFile(target, 'utf-8')).toBe('AFTER');
  });

  it('wasDeleted snapshot → revert deletes the file', async () => {
    const { coord } = makeCoord();
    const target = path.join(tmpRoot, 'new.ts');
    // 任务前不存在

    coord.beginTurn();
    coord.onToolExec('write_file', { file_path: 'new.ts', content: 'created' });
    const cp = await coord.finalizeTurn({ sessionId: 's1', messages: msgs });

    // 模拟工具落盘
    await fs.writeFile(target, 'created', 'utf-8');
    expect(existsSync(target)).toBe(true);

    const res = await coord.revert({ id: cp!.id, sessionId: 's1' });
    expect(res.filesDeleted).toBe(1);
    expect(existsSync(target)).toBe(false);
  });
});

// ─────────── W7b2 · step 粒度 checkpoint ───────────

describe('CheckpointCoordinator.createStepCheckpoint (W7b2)', () => {
  it('creates a step checkpoint with label "step:<N>:<tool>"', async () => {
    const { coord, store } = makeCoord();
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'V1', 'utf-8');

    coord.beginTurn();
    const cp = await coord.createStepCheckpoint({
      sessionId: 's1',
      messages: msgs,
      toolName: 'write_file',
      toolArgs: { file_path: 'a.ts', content: 'V2' },
    });
    expect(cp).toBeDefined();
    expect(cp!.label).toBe('step:1:write_file');
    const list = await store.list('s1');
    expect(list).toHaveLength(1);
    expect(list[0].fileCount).toBe(1);
  });

  it('step counter increments within a turn and resets on beginTurn', async () => {
    const { coord } = makeCoord();
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'V1', 'utf-8');
    await fs.writeFile(path.join(tmpRoot, 'b.ts'), 'V1', 'utf-8');

    coord.beginTurn();
    const c1 = await coord.createStepCheckpoint({
      sessionId: 's1',
      messages: msgs,
      toolName: 'write_file',
      toolArgs: { file_path: 'a.ts' },
    });
    const c2 = await coord.createStepCheckpoint({
      sessionId: 's1',
      messages: msgs,
      toolName: 'search_replace',
      toolArgs: { file_path: 'b.ts' },
    });
    expect(c1!.label).toBe('step:1:write_file');
    expect(c2!.label).toBe('step:2:search_replace');

    coord.beginTurn();
    const c3 = await coord.createStepCheckpoint({
      sessionId: 's1',
      messages: msgs,
      toolName: 'write_file',
      toolArgs: { file_path: 'a.ts' },
    });
    expect(c3!.label).toBe('step:1:write_file');
  });

  it('skips non-tracked tools', async () => {
    const { coord, store } = makeCoord();
    coord.beginTurn();
    const cp = await coord.createStepCheckpoint({
      sessionId: 's1',
      messages: msgs,
      toolName: 'bash',
      toolArgs: { command: 'ls' },
    });
    expect(cp).toBeUndefined();
    expect(await store.list('s1')).toHaveLength(0);
  });

  it('skips missing file_path / absolute path / traversal', async () => {
    const { coord } = makeCoord();
    coord.beginTurn();
    expect(
      await coord.createStepCheckpoint({
        sessionId: 's1',
        messages: msgs,
        toolName: 'write_file',
        toolArgs: {},
      }),
    ).toBeUndefined();
    expect(
      await coord.createStepCheckpoint({
        sessionId: 's1',
        messages: msgs,
        toolName: 'write_file',
        toolArgs: { file_path: '/abs/x.ts' },
      }),
    ).toBeUndefined();
    expect(
      await coord.createStepCheckpoint({
        sessionId: 's1',
        messages: msgs,
        toolName: 'write_file',
        toolArgs: { file_path: '../outside.ts' },
      }),
    ).toBeUndefined();
  });

  it('file missing on disk → snapshot with wasDeleted=true', async () => {
    const { coord } = makeCoord();
    coord.beginTurn();
    const cp = await coord.createStepCheckpoint({
      sessionId: 's1',
      messages: msgs,
      toolName: 'write_file',
      toolArgs: { file_path: 'fresh.ts' },
    });
    expect(cp).toBeDefined();
    const full = await coord.get(cp!.id, 's1');
    expect(full!.fileSnapshots[0].wasDeleted).toBe(true);
  });

  it('disabled coordinator returns undefined', async () => {
    const { coord, store } = makeCoord();
    coord.setEnabled(false);
    coord.beginTurn();
    const cp = await coord.createStepCheckpoint({
      sessionId: 's1',
      messages: msgs,
      toolName: 'write_file',
      toolArgs: { file_path: 'a.ts' },
    });
    expect(cp).toBeUndefined();
    expect(await store.list('s1')).toHaveLength(0);
  });

  it('empty sessionId → undefined', async () => {
    const { coord } = makeCoord();
    coord.beginTurn();
    const cp = await coord.createStepCheckpoint({
      sessionId: '',
      messages: msgs,
      toolName: 'write_file',
      toolArgs: { file_path: 'a.ts' },
    });
    expect(cp).toBeUndefined();
  });

  it('revert by step checkpoint id restores the pre-step file content', async () => {
    const { coord } = makeCoord();
    const target = path.join(tmpRoot, 'a.ts');
    await fs.writeFile(target, 'V1', 'utf-8');

    coord.beginTurn();
    const cp = await coord.createStepCheckpoint({
      sessionId: 's1',
      messages: msgs,
      toolName: 'write_file',
      toolArgs: { file_path: 'a.ts' },
    });
    // 模拟工具落盘改写
    await fs.writeFile(target, 'V2', 'utf-8');

    const res = await coord.revert({ id: cp!.id, sessionId: 's1' });
    expect(res.filesApplied).toBe(1);
    expect(await fs.readFile(target, 'utf-8')).toBe('V1');
  });
});
