/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * WriteFileTool 单测
 *
 * 覆盖：
 * - 参数校验（空路径/非字符串 content / 非法 mode）
 * - 行号前缀污染拒绝
 * - 无 workspace 拒绝
 * - create 模式：文件存在时拒绝
 * - overwrite 模式：文件存在时覆盖
 * - append 模式：追加
 * - 自动创建父目录
 * - 越界拒绝
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { WriteFileTool } from '../../src/core/tools/write_file.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import { initLogger } from '../../src/infra/logger.js';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-writefile-'));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
  // 每个测试前清空工作区但保留根
  const entries = await fs.readdir(tmpRoot);
  await Promise.all(
    entries.map((e) => fs.rm(path.join(tmpRoot, e), { recursive: true, force: true })),
  );
});

function ctx(workspaceRoot: string | undefined = tmpRoot, signal = new AbortController().signal) {
  return {
    workspaceRoot: workspaceRoot as string,
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

describe('WriteFileTool', () => {
  const tool = new WriteFileTool();

  it('rejects empty file_path', async () => {
    const r = await tool.execute({ file_path: '', content: 'x' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects non-string content', async () => {
    const r = await tool.execute(
      { file_path: 'a.txt', content: 123 as unknown as string },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects invalid mode', async () => {
    const r = await tool.execute(
      { file_path: 'a.txt', content: 'x', mode: 'delete' as never },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects content polluted with line-number prefix', async () => {
    const r = await tool.execute(
      { file_path: 'a.txt', content: '     1\u2192const x = 1;\n' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
    expect(r.content).toContain('行号前缀');
  });

  it('rejects without workspace', async () => {
    const r = await tool.execute({ file_path: 'a.txt', content: 'x' }, ctxNoWs());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
  });

  it('creates new file (default overwrite mode)', async () => {
    const r = await tool.execute(
      { file_path: 'new.txt', content: 'hello\nworld\n' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    const actual = await fs.readFile(path.join(tmpRoot, 'new.txt'), 'utf-8');
    expect(actual).toBe('hello\nworld\n');
    expect(r.display?.mode).toBe('overwrite');
    expect(r.display?.existed).toBe(false);
  });

  it('mode=create rejects existing file', async () => {
    await fs.writeFile(path.join(tmpRoot, 'exist.txt'), 'old');
    const r = await tool.execute(
      { file_path: 'exist.txt', content: 'new', mode: 'create' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_FAILED);
    // 文件保持原样
    const actual = await fs.readFile(path.join(tmpRoot, 'exist.txt'), 'utf-8');
    expect(actual).toBe('old');
  });

  it('mode=create succeeds for new file', async () => {
    const r = await tool.execute(
      { file_path: 'fresh.txt', content: 'brand new', mode: 'create' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmpRoot, 'fresh.txt'), 'utf-8')).toBe('brand new');
  });

  it('mode=overwrite replaces existing content', async () => {
    await fs.writeFile(path.join(tmpRoot, 'ow.txt'), 'before');
    const r = await tool.execute(
      { file_path: 'ow.txt', content: 'after', mode: 'overwrite' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmpRoot, 'ow.txt'), 'utf-8')).toBe('after');
    expect(r.display?.existed).toBe(true);
  });

  it('mode=append appends to existing file', async () => {
    await fs.writeFile(path.join(tmpRoot, 'ap.txt'), 'hello');
    const r = await tool.execute(
      { file_path: 'ap.txt', content: ' world', mode: 'append' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmpRoot, 'ap.txt'), 'utf-8')).toBe('hello world');
  });

  it('auto-creates parent directories', async () => {
    const r = await tool.execute(
      { file_path: 'deep/nested/dir/file.txt', content: 'x' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    const actual = await fs.readFile(
      path.join(tmpRoot, 'deep', 'nested', 'dir', 'file.txt'),
      'utf-8',
    );
    expect(actual).toBe('x');
  });

  it('rejects write outside workspace', async () => {
    const outside = path.join(os.tmpdir(), 'dualmind-outside-write.txt');
    const r = await tool.execute({ file_path: outside, content: 'evil' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
    // 确保没写出去
    await expect(fs.stat(outside)).rejects.toThrow();
  });
});
