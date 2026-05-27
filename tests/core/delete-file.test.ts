/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * DeleteFileTool 单测（W7e2）
 *
 * 覆盖：
 * - 参数校验（空路径）
 * - 无 workspace 拒绝
 * - 路径越界拒绝（.. 穿越）
 * - 文件不存在 → 幂等成功（existed=false）
 * - 文件存在 → 成功删除 + bytes 统计
 * - 路径是目录 → 失败（TOOL_ARGS_INVALID）
 * - 取消信号拒绝
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DeleteFileTool } from '../../src/core/tools/delete_file.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import { initLogger } from '../../src/infra/logger.js';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-deletefile-'));
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  const entries = await fs.readdir(tmpRoot);
  await Promise.all(
    entries.map((e) => fs.rm(path.join(tmpRoot, e), { recursive: true, force: true })),
  );
});

function ctx(workspaceRoot: string = tmpRoot, signal = new AbortController().signal) {
  return {
    workspaceRoot,
    signal,
    taskId: 't1',
    toolCallId: 'c1',
  };
}

function ctxNoWs() {
  return {
    workspaceRoot: undefined as unknown as string,
    signal: new AbortController().signal,
    taskId: 't1',
    toolCallId: 'c1',
  };
}

describe('DeleteFileTool', () => {
  it('rejects empty file_path', async () => {
    const t = new DeleteFileTool();
    const r = await t.execute({ file_path: ' ' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects when workspace is undefined', async () => {
    const t = new DeleteFileTool();
    const r = await t.execute({ file_path: 'a.txt' }, ctxNoWs());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
  });

  it('rejects paths outside workspace (parent traversal)', async () => {
    const t = new DeleteFileTool();
    const r = await t.execute({ file_path: '../../etc/passwd' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
  });

  it('returns idempotent success when file does not exist', async () => {
    const t = new DeleteFileTool();
    const r = await t.execute({ file_path: 'missing.txt' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/File not found/);
    expect(r.display).toMatchObject({ existed: false, filePath: 'missing.txt' });
  });

  it('deletes existing file and reports size', async () => {
    const abs = path.join(tmpRoot, 'hello.txt');
    await fs.writeFile(abs, 'hello world', 'utf-8');
    const t = new DeleteFileTool();
    const r = await t.execute({ file_path: 'hello.txt' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/Deleted hello\.txt \(11 bytes\)/);
    expect(r.display).toMatchObject({
      existed: true,
      filePath: 'hello.txt',
      bytes: 11,
    });
    // 确认文件真的没了
    await expect(fs.stat(abs)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes file in nested directory (with absolute path)', async () => {
    const dir = path.join(tmpRoot, 'sub', 'deeper');
    await fs.mkdir(dir, { recursive: true });
    const abs = path.join(dir, 'x.ts');
    await fs.writeFile(abs, 'x', 'utf-8');
    const t = new DeleteFileTool();
    const r = await t.execute({ file_path: abs }, ctx());
    expect(r.ok).toBe(true);
    expect(r.display).toMatchObject({ existed: true });
    await expect(fs.stat(abs)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects when path is a directory', async () => {
    const dir = path.join(tmpRoot, 'adir');
    await fs.mkdir(dir);
    const t = new DeleteFileTool();
    const r = await t.execute({ file_path: 'adir' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
    expect(r.content).toMatch(/目录/);
    // 确认目录仍在
    const st = await fs.stat(dir);
    expect(st.isDirectory()).toBe(true);
  });

  it('respects aborted signal', async () => {
    const abs = path.join(tmpRoot, 'will-stay.txt');
    await fs.writeFile(abs, 'x', 'utf-8');
    const t = new DeleteFileTool();
    const ac = new AbortController();
    ac.abort();
    const r = await t.execute({ file_path: 'will-stay.txt' }, ctx(tmpRoot, ac.signal));
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TASK_LOOP_ABORTED);
    // 文件应该仍在
    const st = await fs.stat(abs);
    expect(st.isFile()).toBe(true);
  });
});
