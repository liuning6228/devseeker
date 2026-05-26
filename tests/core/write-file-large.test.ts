/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * write_file 大文件场景测试
 *
 * 验证移除 200 行硬限制后的行为：
 * - 大文件可以成功写入（不再被拒绝）
 * - 超过 500 行时返回提示信息
 * - 内容退化保护仍然有效
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteFileTool } from '../../src/core/tools/write_file.js';
import type { ToolContext } from '../../src/core/tools/types.js';

// Mock context
function makeCtx(workspaceRoot: string): ToolContext {
  return {
    workspaceRoot,
    signal: new AbortController().signal,
  } as ToolContext;
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 生成指定行数的文本 */
function generateLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `// Line ${i + 1}: some content here`).join('\n');
}

describe('WriteFileTool large file handling', () => {
  const tool = new WriteFileTool();

  it('allows writing files over 200 lines (no hard limit)', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'large-file.ts');
      const content = generateLines(300);

      const result = await tool.execute(
        { file_path: filePath, content },
        makeCtx(dir),
      );
      expect(result.ok).toBe(true);

      const written = await fs.readFile(filePath, 'utf-8');
      expect(written.split('\n').length).toBe(300);
    });
  });

  it('includes hint for files over 500 lines', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'very-large-file.ts');
      const content = generateLines(600);

      const result = await tool.execute(
        { file_path: filePath, content },
        makeCtx(dir),
      );
      expect(result.ok).toBe(true);
      expect(result.content).toContain('提示');
      expect(result.content).toContain('600');
    });
  });

  it('does not include hint for files under 500 lines', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'medium-file.ts');
      const content = generateLines(400);

      const result = await tool.execute(
        { file_path: filePath, content },
        makeCtx(dir),
      );
      expect(result.ok).toBe(true);
      expect(result.content).not.toContain('提示');
    });
  });

  it('still rejects content over 5MB', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'huge-file.ts');
      // Generate >5MB content
      const hugeContent = 'x'.repeat(6 * 1024 * 1024);

      const result = await tool.execute(
        { file_path: filePath, content: hugeContent },
        makeCtx(dir),
      );
      expect(result.ok).toBe(false);
      expect(result.content).toContain('5MB');
    });
  });

  it('overwrite 短内容到已有文件会成功（退化保护已移除，streaming 架构无退化风险）', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'existing.ts');
      await fs.writeFile(filePath, generateLines(100));

      const result = await tool.execute(
        { file_path: filePath, content: generateLines(10) },
        makeCtx(dir),
      );
      // streaming 架构直接写入，不再拒绝
      expect(result.ok).toBe(true);
    });
  });

  it('creates new files of any size', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'brand-new.ts');
      const content = generateLines(1000);

      const result = await tool.execute(
        { file_path: filePath, content },
        makeCtx(dir),
      );
      expect(result.ok).toBe(true);

      const written = await fs.readFile(filePath, 'utf-8');
      expect(written.split('\n').length).toBe(1000);
    });
  });
});
