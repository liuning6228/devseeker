/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * search_replace 模糊匹配集成测试
 *
 * 验证 search_replace 工具在精确匹配失败时自动降级到行 trim / 模糊匹配
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SearchReplaceTool } from '../../src/core/tools/search_replace.js';
import type { ToolContext } from '../../src/core/tools/types.js';

// Mock context
function makeCtx(workspaceRoot: string): ToolContext {
  return {
    workspaceRoot,
    signal: new AbortController().signal,
  } as ToolContext;
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('SearchReplaceTool with fuzzy matching', () => {
  const tool = new SearchReplaceTool();

  it('succeeds with exact match', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.ts');
      await fs.writeFile(filePath, 'const x = 1;\nconst y = 2;\n');

      const result = await tool.execute(
        { file_path: filePath, old_string: 'const y = 2;', new_string: 'const y = 3;' },
        makeCtx(dir),
      );
      expect(result.ok).toBe(true);

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('const y = 3;');
    });
  });

  it('fails when no match at all', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.ts');
      await fs.writeFile(filePath, 'const x = 1;\nconst y = 2;\n');

      const result = await tool.execute(
        { file_path: filePath, old_string: 'completely unrelated', new_string: 'nope' },
        makeCtx(dir),
      );
      expect(result.ok).toBe(false);
      expect(result.content).toContain('未找到匹配');
    });
  });

  it('succeeds with line-trim match (whitespace difference)', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.ts');
      // File has indented content
      await fs.writeFile(filePath, '  const x = 1;\n  const y = 2;\n');

      // old_string without indentation
      const result = await tool.execute(
        { file_path: filePath, old_string: 'const x = 1;\nconst y = 2;', new_string: 'const x = 10;\nconst y = 20;' },
        makeCtx(dir),
      );
      expect(result.ok).toBe(true);

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('const x = 10;');
    });
  });

  it('rejects non-unique exact matches', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.ts');
      await fs.writeFile(filePath, 'foo\nfoo\nfoo\n');

      const result = await tool.execute(
        { file_path: filePath, old_string: 'foo', new_string: 'bar' },
        makeCtx(dir),
      );
      expect(result.ok).toBe(false);
      expect(result.content).toContain('3 次');
    });
  });

  it('replaces all with replace_all=true', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.ts');
      await fs.writeFile(filePath, 'foo\nfoo\nfoo\n');

      const result = await tool.execute(
        { file_path: filePath, old_string: 'foo', new_string: 'bar', replace_all: true },
        makeCtx(dir),
      );
      expect(result.ok).toBe(true);

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('bar\nbar\nbar\n');
    });
  });
});
