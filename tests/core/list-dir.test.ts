/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ListDirTool 单测
 *
 * 覆盖：
 * - 无 workspace 拒绝
 * - 默认列工作区根
 * - 默认排除 node_modules / .git
 * - show_hidden 控制 "." 开头
 * - max_depth 递归控制
 * - 路径越界拒绝
 * - 目录不存在
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ListDirTool } from '../../src/core/tools/list_dir.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import { initLogger } from '../../src/infra/logger.js';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-listdir-'));
  // 工作区结构：
  // - a.txt
  // - .hidden
  // - node_modules/should_exclude.txt
  // - .git/config
  // - src/
  //   - index.ts
  //   - util/
  //     - helper.ts
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), '');
  await fs.writeFile(path.join(tmpRoot, '.hidden'), '');
  await fs.mkdir(path.join(tmpRoot, 'node_modules'));
  await fs.writeFile(path.join(tmpRoot, 'node_modules', 'should_exclude.txt'), '');
  await fs.mkdir(path.join(tmpRoot, '.git'));
  await fs.writeFile(path.join(tmpRoot, '.git', 'config'), '');
  await fs.mkdir(path.join(tmpRoot, 'src'));
  await fs.writeFile(path.join(tmpRoot, 'src', 'index.ts'), '');
  await fs.mkdir(path.join(tmpRoot, 'src', 'util'));
  await fs.writeFile(path.join(tmpRoot, 'src', 'util', 'helper.ts'), '');
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
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

describe('ListDirTool', () => {
  const tool = new ListDirTool();

  it('rejects without workspace', async () => {
    const r = await tool.execute({}, ctxNoWs());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
  });

  it('lists root with defaults (depth=1, no hidden, no excluded)', async () => {
    const r = await tool.execute({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('a.txt');
    expect(r.content).toContain('src/');
    // 隐藏 + 排除
    expect(r.content).not.toContain('.hidden');
    expect(r.content).not.toContain('node_modules');
    expect(r.content).not.toContain('.git/');
  });

  it('shows hidden when show_hidden=true but still excludes noise dirs', async () => {
    const r = await tool.execute({ show_hidden: true }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('.hidden');
    // 但 .git 在噪声清单里，即使 show_hidden=true 也排除
    expect(r.content).not.toContain('.git/');
    expect(r.content).not.toContain('node_modules');
  });

  it('respects max_depth=2 and recurses into src/', async () => {
    const r = await tool.execute({ max_depth: 2 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('src/');
    expect(r.content).toContain('src/index.ts');
    expect(r.content).toContain('src/util/');
    // depth=2 不应深入到 util 内部
    expect(r.content).not.toContain('src/util/helper.ts');
  });

  it('max_depth=3 reaches grandchild', async () => {
    const r = await tool.execute({ max_depth: 3 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('src/util/helper.ts');
  });

  it('lists specific subdir', async () => {
    const r = await tool.execute({ dir_path: 'src' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Contents of "src"');
    expect(r.content).toContain('src/index.ts');
  });

  it('rejects outside workspace', async () => {
    const outside = path.join(os.tmpdir(), 'dualmind-outside-listdir');
    await fs.mkdir(outside, { recursive: true });
    try {
      const r = await tool.execute({ dir_path: outside }, ctx());
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('returns TOOL_PATH_INVALID for missing dir', async () => {
    const r = await tool.execute({ dir_path: 'no-such-dir' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_PATH_INVALID);
  });

  it('returns TOOL_ARGS_INVALID when path is a file', async () => {
    const r = await tool.execute({ dir_path: 'a.txt' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('clamps max_depth to [1,5]', async () => {
    const r = await tool.execute({ max_depth: 999 }, ctx());
    expect(r.ok).toBe(true);
    // 999 被 clamp 到 5，仍能跑
    expect(r.content).toContain('max_depth=5');
  });
});
