/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ReadFileTool 单测
 *
 * 覆盖：
 * - 参数校验（空路径/非法行号）
 * - 无 workspace 拒绝
 * - 正确读取 + 行号前缀
 * - start_line / end_line 切片
 * - 工作区越界拒绝
 * - 文件不存在
 * - 行号前缀格式（6 字符右对齐 + →）
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ReadFileTool } from '../../src/core/tools/read_file.js';
import { formatWithLineNumbers, detectLineNumberPrefix } from '../../src/core/tools/result-formatter.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import { initLogger } from '../../src/infra/logger.js';
import { buildValidPdf } from './pdf-fixtures.js';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-readfile-'));
  await fs.writeFile(path.join(tmpRoot, 'hello.txt'), 'line1\nline2\nline3\nline4\nline5\n');
  await fs.mkdir(path.join(tmpRoot, 'sub'));
  await fs.writeFile(path.join(tmpRoot, 'sub', 'nested.md'), '# Title\n\ncontent\n');
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

function ctxNoWs(signal = new AbortController().signal) {
  return {
    workspaceRoot: undefined as unknown as string,
    signal,
    taskId: 't1',
    toolCallId: 'c1',
  };
}

describe('ReadFileTool', () => {
  const tool = new ReadFileTool();

  it('rejects empty file_path', async () => {
    const r = await tool.execute({ file_path: '' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects invalid start_line', async () => {
    const r = await tool.execute({ file_path: 'hello.txt', start_line: 0 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects end_line < start_line', async () => {
    const r = await tool.execute(
      { file_path: 'hello.txt', start_line: 3, end_line: 1 },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects without workspace', async () => {
    const r = await tool.execute({ file_path: 'x.txt' }, ctxNoWs());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
  });

  it('reads full file with line numbers', async () => {
    const r = await tool.execute({ file_path: 'hello.txt' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('from line 1-5 (total 5 lines)');
    // 行号前缀：" " *5 + "1" + "→" + "line1"
    expect(r.content).toContain('     1\u2192line1');
    expect(r.content).toContain('     5\u2192line5');
    expect(r.display?.totalLines).toBe(5);
  });

  it('reads line range', async () => {
    const r = await tool.execute(
      { file_path: 'hello.txt', start_line: 2, end_line: 4 },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('from line 2-4 (total 5 lines)');
    expect(r.content).toContain('     2\u2192line2');
    expect(r.content).toContain('     4\u2192line4');
    expect(r.content).not.toContain('     5\u2192line5');
    expect(r.content).not.toContain('     1\u2192line1');
  });

  it('reads nested file via relative path', async () => {
    const r = await tool.execute({ file_path: 'sub/nested.md' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('     1\u2192# Title');
  });

  it('rejects path outside workspace', async () => {
    // 构造一个在 tmpRoot 外的绝对路径
    const outsidePath = path.join(os.tmpdir(), 'outside-workspace-file.txt');
    await fs.writeFile(outsidePath, 'secret');
    try {
      const r = await tool.execute({ file_path: outsidePath }, ctx());
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
      expect(r.content).toContain('拒绝');
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it('returns TOOL_PATH_INVALID for missing file', async () => {
    const r = await tool.execute({ file_path: 'no-such.txt' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_PATH_INVALID);
  });

  it('respects abort signal', async () => {
    const c = new AbortController();
    c.abort();
    const r = await tool.execute({ file_path: 'hello.txt' }, ctx(undefined, c.signal));
    // 未打开工作区先被拒，这里换成传 workspace 测
    const r2 = await tool.execute({ file_path: 'hello.txt' }, {
      workspaceRoot: tmpRoot,
      signal: c.signal,
      taskId: 't1',
      toolCallId: 'c1',
    });
    expect(r2.ok).toBe(false);
    expect(r2.errorCode).toBe(ErrorCodes.TASK_LOOP_ABORTED);
    void r;
  });
});

describe('formatWithLineNumbers', () => {
  it('right-aligns to width 6 with arrow', () => {
    const out = formatWithLineNumbers('a\nb\n');
    expect(out).toBe('     1\u2192a\n     2\u2192b\n');
  });

  it('honors startLine offset', () => {
    const out = formatWithLineNumbers('x', 100);
    expect(out).toBe('   100\u2192x\n');
  });

  it('handles content without trailing newline', () => {
    const out = formatWithLineNumbers('hello');
    expect(out).toBe('     1\u2192hello\n');
  });
});

describe('detectLineNumberPrefix', () => {
  it('detects polluted content', () => {
    expect(detectLineNumberPrefix('     1\u2192code\n')).toBe(1);
    expect(detectLineNumberPrefix('ok\n  12\u2192bad\n')).toBe(2);
  });

  it('returns null for clean content', () => {
    expect(detectLineNumberPrefix('normal code\nwithout prefixes')).toBeNull();
  });
});

describe('ReadFileTool - 子代理路径白名单（角色范围工具层硬执行）', () => {
  const tool = new ReadFileTool();

  it('Guide 角色：白名单外路径拒绝（SUBAGENT_TOOL_NOT_ALLOWED）', async () => {
    const r = await tool.execute(
      { file_path: 'hello.txt' },
      {
        ...ctx(),
        delegate: { role: 'Guide', allowBashWrite: false, readPathPrefixes: ['.devseeker/', 'docs/', 'AGENTS.md'] },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.SUBAGENT_TOOL_NOT_ALLOWED);
    expect(r.content).toContain('仅允许读取');
  });

  it('Guide 角色：白名单内路径正常读取', async () => {
    const r = await tool.execute(
      { file_path: 'sub/nested.md' },
      {
        ...ctx(),
        delegate: { role: 'Guide', allowBashWrite: false, readPathPrefixes: ['sub/'] },
      },
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Title');
  });

  it('主 Agent（无 delegate）：不受路径白名单约束', async () => {
    const r = await tool.execute({ file_path: 'hello.txt' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('line1');
  });
});

describe('ReadFileTool - 图片 PDF 视觉识别兜底', () => {
  let pdfRoot: string;

  beforeAll(async () => {
    pdfRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-readfile-pdf-'));
    // 空白页 PDF（模拟无文本层的扫描件）
    await fs.writeFile(path.join(pdfRoot, 'scanned.pdf'), buildValidPdf(['']));
    // 有文本层的 PDF（正常路径，不应触发视觉识别）
    await fs.writeFile(
      path.join(pdfRoot, 'text.pdf'),
      buildValidPdf(['A text layer document long enough to pass the usable threshold of fifty chars.']),
    );
  });

  afterAll(async () => {
    await fs.rm(pdfRoot, { recursive: true, force: true });
  });

  function pdfCtx(signal = new AbortController().signal) {
    return { workspaceRoot: pdfRoot, signal, taskId: 't1', toolCallId: 'c1' };
  }

  it('无文本层 + Runner 可用 → 返回识别文本并标注来源', { timeout: 30_000 }, async () => {
    const run = vi.fn(async () => ({
      text: '--- Page 1 ---\nidentified scanned content',
      pages: 1,
      failedPages: [] as number[],
      skippedRenderPages: [] as number[],
    }));
    const tool = new ReadFileTool({ getVisionOcr: () => ({ run }) });

    const r = await tool.execute({ file_path: 'scanned.pdf' }, pdfCtx());

    expect(r.ok).toBe(true);
    expect(r.content).toContain('identified scanned content');
    expect(r.content).toContain('scanned PDF, transcribed by vision model');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('无文本层 + Runner 返回 null → 视觉识别失败错误', { timeout: 30_000 }, async () => {
    const tool = new ReadFileTool({ getVisionOcr: () => ({ run: async () => null }) });

    const r = await tool.execute({ file_path: 'scanned.pdf' }, pdfCtx());

    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_FAILED);
    expect(r.content).toContain('视觉识别失败');
  });

  it('无文本层 + 未注入 Runner → 提示未配置视觉模型', { timeout: 30_000 }, async () => {
    const tool = new ReadFileTool();

    const r = await tool.execute({ file_path: 'scanned.pdf' }, pdfCtx());

    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_FAILED);
    expect(r.content).toContain('未配置视觉模型');
  });

  it('有文本层 → 正常走文本提取，不触发视觉识别', { timeout: 30_000 }, async () => {
    const run = vi.fn(async () => ({
      text: 'should not be used',
      pages: 1,
      failedPages: [] as number[],
      skippedRenderPages: [] as number[],
    }));
    const tool = new ReadFileTool({ getVisionOcr: () => ({ run }) });

    const r = await tool.execute({ file_path: 'text.pdf' }, pdfCtx());

    expect(r.ok).toBe(true);
    expect(r.content).toContain('A text layer document');
    expect(run).not.toHaveBeenCalled();
  });
});
