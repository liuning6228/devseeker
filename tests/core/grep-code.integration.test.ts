/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * grep_code 引擎集成测试（检索差距弥补计划 T1）
 *
 * 真实子进程验证（不经 mock）：
 * - 本机无 rg → 走 legacy grep 分支（修复既有缺陷：query 从未传给 grep，
 *   恒返回"未找到匹配项"——本文件即回归测试）
 * - 有 rg 的环境 → 走 rg 分支（两条引擎分环境真实验证）
 * - Windows 本机找 findstr 语义，此文件整体跳过（findstr 分支不做 POSIX 断言）
 *
 * 在临时目录构造带唯一标记的文件，避免污染仓库。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platform } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrepCodeTool } from '../../src/core/tools/grep_code.js';
import { resetRgProbeForTests } from '../../src/core/tools/rg-search.js';

const UNIQ = 'UNIQ_DZ7K9_';
const isWin = platform() === 'win32';
let tmpDir: string;

function ctx() {
  return {
    workspaceRoot: tmpDir,
    signal: new AbortController().signal,
    taskId: 't1',
    toolCallId: 'c1',
  };
}

describe.skipIf(isWin)('GrepCodeTool · 真实子进程集成', () => {
  beforeAll(() => {
    resetRgProbeForTests();
    tmpDir = mkdtempSync(join(tmpdir(), 'grep-code-int-'));
    writeFileSync(join(tmpDir, 'a.ts'), `const marker = '${UNIQ}first';\nconst other = 1;\n`);
    writeFileSync(join(tmpDir, 'b.md'), `# doc\n${UNIQ}second\n`);
    writeFileSync(join(tmpDir, 'skip.txt'), UNIQ + 'txt'); // .txt 不在 include 列表，不参与
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('命中：返回匹配行 path:line:text（修复前 legacy 分支恒报"未找到"）', async () => {
    const tool = new GrepCodeTool();
    const r = await tool.execute({ query: UNIQ }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain(`${UNIQ}first`);
    expect(r.content).toContain('a.ts'); // include 列表内的 a.ts 命中
    expect((r.display as { engine?: string; count?: number })?.count).toBeGreaterThanOrEqual(1);
    const engine = (r.display as { engine?: string })?.engine;
    expect(['rg', 'grep']).toContain(engine);
  });

  it('命中行带行号（path:line:text 格式）', async () => {
    const tool = new GrepCodeTool();
    const r = await tool.execute({ query: `${UNIQ}second` }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/b\.md:\d+:/);
  });

  it('无匹配 → ok + 未找到（不报执行失败）', async () => {
    const tool = new GrepCodeTool();
    const r = await tool.execute({ query: 'NOTHING_MATCHES_ZZZ_98765' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('未找到匹配项');
  });

  it('context_lines=1 → 上下文行随匹配行返回', async () => {
    const tool = new GrepCodeTool();
    const r = await tool.execute({ query: `${UNIQ}first`, context_lines: 1 }, ctx());
    expect(r.ok).toBe(true);
    // 匹配行 + 上下文行都出现；注意格式差异：rg 为 path:line:text，
    // POSIX grep 上下文行是 path-line-text（- 分隔），统一按 'a.ts' 过滤
    const rows = r.content.split('\n').filter((l) => l.includes('a.ts'));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('以 - 开头的 query（如 "-Werror"）不被当作选项', async () => {
    const dashFile = join(tmpDir, 'flags.ts');
    writeFileSync(dashFile, "const f = '-DDEBUG';\n");
    const tool = new GrepCodeTool();
    const r = await tool.execute({ query: '-DDEBUG' }, ctx());
    writeFileSync(dashFile, "const f = 'x';\n");
    expect(r.ok).toBe(true);
    expect(r.content).toContain('-DDEBUG');
    expect(r.content).toContain('flags.ts');
  });

  it('query 为空 → 参数错误', async () => {
    const tool = new GrepCodeTool();
    const r = await tool.execute({ query: '   ' }, ctx());
    expect(r.ok).toBe(false);
  });
});