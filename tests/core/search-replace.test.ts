/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * SearchReplaceTool 单测
 *
 * 覆盖：
 * - 参数校验（空 old_string / old===new / 行号污染）
 * - 无 workspace 拒绝
 * - 默认模式 unique 替换成功
 * - 多处匹配 → TOOL_PATCH_UNIQUE_FAIL
 * - replace_all=true 全部替换
 * - 未匹配 → TOOL_PATCH_NO_MATCH
 * - 文件不存在 → TOOL_PATH_INVALID
 * - 越界拒绝
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SearchReplaceTool } from '../../src/core/tools/search_replace.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import { initLogger } from '../../src/infra/logger.js';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-sr-'));
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

describe('SearchReplaceTool', () => {
  const tool = new SearchReplaceTool();

  it('rejects empty old_string', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'hi');
    const r = await tool.execute(
      { file_path: 'a.txt', old_string: '', new_string: 'bye' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects old === new', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'hi');
    const r = await tool.execute(
      { file_path: 'a.txt', old_string: 'hi', new_string: 'hi' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects old_string with line-number prefix', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'hi');
    const r = await tool.execute(
      {
        file_path: 'a.txt',
        old_string: '     1\u2192hi',
        new_string: 'bye',
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects new_string with line-number prefix', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'hi');
    const r = await tool.execute(
      { file_path: 'a.txt', old_string: 'hi', new_string: '     1\u2192x' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects without workspace', async () => {
    const r = await tool.execute(
      { file_path: 'a.txt', old_string: 'x', new_string: 'y' },
      ctxNoWs(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
  });

  it('performs unique replacement', async () => {
    await fs.writeFile(path.join(tmpRoot, 'code.ts'), 'const version = "0.1.0";\n');
    const r = await tool.execute(
      {
        file_path: 'code.ts',
        old_string: '"0.1.0"',
        new_string: '"0.2.0"',
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmpRoot, 'code.ts'), 'utf-8')).toBe(
      'const version = "0.2.0";\n',
    );
    expect(r.display?.replacedCount).toBe(1);
  });

  it('rejects when old_string is not unique (default mode)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'dup.ts'), 'foo\nfoo\nfoo\n');
    const r = await tool.execute(
      { file_path: 'dup.ts', old_string: 'foo', new_string: 'bar' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    // 原文件不变
    expect(await fs.readFile(path.join(tmpRoot, 'dup.ts'), 'utf-8')).toBe('foo\nfoo\nfoo\n');
  });

  it('replace_all=true replaces every occurrence', async () => {
    await fs.writeFile(path.join(tmpRoot, 'dup.ts'), 'foo\nfoo\nfoo\n');
    const r = await tool.execute(
      {
        file_path: 'dup.ts',
        old_string: 'foo',
        new_string: 'bar',
        replace_all: true,
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmpRoot, 'dup.ts'), 'utf-8')).toBe('bar\nbar\nbar\n');
    expect(r.display?.replacedCount).toBe(3);
  });

  it('returns TOOL_PATCH_NO_MATCH when old_string absent', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'hello');
    const r = await tool.execute(
      { file_path: 'a.txt', old_string: 'missing', new_string: 'x' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_PATCH_NO_MATCH);
  });

  it('returns TOOL_PATH_INVALID for missing file', async () => {
    const r = await tool.execute(
      { file_path: 'no-such.txt', old_string: 'x', new_string: 'y' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_PATH_INVALID);
  });

  it('rejects outside workspace', async () => {
    const outside = path.join(os.tmpdir(), 'dualmind-outside-sr.txt');
    await fs.writeFile(outside, 'secret');
    try {
      const r = await tool.execute(
        { file_path: outside, old_string: 'secret', new_string: 'hacked' },
        ctx(),
      );
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
      // 文件未被修改
      expect(await fs.readFile(outside, 'utf-8')).toBe('secret');
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});
