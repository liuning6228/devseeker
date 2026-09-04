/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * rg-search 单测（检索差距弥补计划 T1）
 *
 * 纯函数面：parseRgJson / resolveEngine —— 全平台必跑
 * spawn 集成面：runRg / probeRgAvailable —— 本机无 rg 时 early-return 跳过
 * （与本机 better-sqlite3 测试同策略：环境守卫式集成）
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRgJson,
  resolveEngine,
  runRg,
  probeRgAvailable,
  resetRgProbeForTests,
  type RgLine,
} from '../../src/core/tools/rg-search.js';

// ─────────── parseRgJson（纯函数） ───────────

describe('parseRgJson', () => {
  it('解析 match 记录：多文件多行 + 去尾部换行', () => {
    const out = [
      JSON.stringify({ type: 'match', data: { path: { text: 'src/a.ts' }, line_number: 4, lines: { text: 'const x = 1;\n' } } }),
      JSON.stringify({ type: 'match', data: { path: { text: 'src/a.ts' }, line_number: 9, lines: { text: 'const y = 2;' } } }),
      JSON.stringify({ type: 'match', data: { path: { text: 'src/b.ts' }, line_number: 1, lines: { text: 'const z = 3;\n' } } }),
    ].join('\n');
    const { lines, matchCount } = parseRgJson(out);
    expect(matchCount).toBe(3);
    expect(lines).toEqual([
      { path: 'src/a.ts', line: 4, text: 'const x = 1;', kind: 'match' },
      { path: 'src/a.ts', line: 9, text: 'const y = 2;', kind: 'match' },
      { path: 'src/b.ts', line: 1, text: 'const z = 3;', kind: 'match' },
    ]);
  });

  it('保留 match 与 context 的先后顺序（-A/-B 语义）', () => {
    const out = [
      JSON.stringify({ type: 'context', data: { path: { text: 's.ts' }, line_number: 2, lines: { text: 'before' } } }),
      JSON.stringify({ type: 'match', data: { path: { text: 's.ts' }, line_number: 3, lines: { text: 'hit' } } }),
      JSON.stringify({ type: 'context', data: { path: { text: 's.ts' }, line_number: 4, lines: { text: 'after' } } }),
      JSON.stringify({ type: 'context', data: { path: { text: 's.ts' }, line_number: 5, lines: { text: 'after2' } } }),
    ].join('\n');
    const { lines, matchCount } = parseRgJson(out);
    expect(matchCount).toBe(1);
    expect(lines.map((l) => l.kind)).toEqual(['context', 'match', 'context', 'context']);
    expect(lines[2].text).toBe('after');
  });

  it('跳过非 match/context 行与损坏行（截断安全）', () => {
    const out = [
      JSON.stringify({ type: 'begin', data: { path: { text: '.' } } }),
      '{"type":"match","data":{broken-json',
      JSON.stringify({ type: 'match', data: { path: { text: 'ok.ts' }, line_number: 1, lines: { text: 'good' } } }),
      'garbage',
      '',
    ].join('\n');
    const { lines, matchCount } = parseRgJson(out);
    expect(matchCount).toBe(1);
    expect(lines).toEqual([{ path: 'ok.ts', line: 1, text: 'good', kind: 'match' }]);
  });

  it('字段缺失的记录被丢弃', () => {
    const out = JSON.stringify({ type: 'match', data: { path: { text: 'x.ts' } } });
    expect(parseRgJson(out).lines).toEqual([]);
    expect(parseRgJson('').lines).toEqual([]);
  });
});

// ─────────── resolveEngine（纯函数） ───────────

describe('resolveEngine', () => {
  it('rg 可用时永远选 rg', () => {
    expect(resolveEngine(true, false)).toBe('rg');
    expect(resolveEngine(true, true)).toBe('rg');
  });
  it('rg 不可用时按平台回退 grep / findstr', () => {
    expect(resolveEngine(false, false)).toBe('grep');
    expect(resolveEngine(false, true)).toBe('findstr');
  });
});

// ─────────── probeRgAvailable（环境守卫式） ───────────

describe('probeRgAvailable', () => {
  it('返回布尔且可重置（不强制结论——取决于本机是否安装 rg）', () => {
    resetRgProbeForTests();
    const a = probeRgAvailable();
    expect(typeof a).toBe('boolean');
    resetRgProbeForTests();
    expect(typeof probeRgAvailable()).toBe('boolean');
  });
});

// ─────────── runRg 集成（本机无 rg 则 early-return） ───────────

describe('runRg 集成', () => {
  const rgAvailable = probeRgAvailable();

  function makeTempWs(): string {
    const dir = mkdtempSync(join(tmpdir(), 'rg-test-'));
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    mkdirSync(join(dir, '.devseeker'), { recursive: true });
    writeFileSync(
      join(dir, 'a.ts'),
      ['line1', 'line2 TARGET', 'line3', 'line4 TARGET', 'line5', 'line6', 'line7'].join('\n') + '\n',
    );
    writeFileSync(join(dir, 'node_modules', 'b.js'), 'TARGET in node_modules\n');
    writeFileSync(join(dir, '.devseeker', 'c.md'), 'TARGET in devseeker\n');
    writeFileSync(join(dir, 'd.txt'), 'unrelated\n');
    return dir;
  }

  it('命中输出 + 排除目录（node_modules/.devseeker）', async () => {
    if (!rgAvailable) return; // 环境守卫：无 rg 机器跳过
    const dir = makeTempWs();
    try {
      const res = await runRg(dir, 'TARGET', 50, new AbortController().signal, 0);
      expect(res.code).toBe(0);
      expect(res.matchCount).toBe(2);
      expect(res.lines.map((l: RgLine) => `${l.path}:${l.line}`)).toEqual(['a.ts:2', 'a.ts:4']);
      expect(res.lines.every((l) => l.kind === 'match')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('无匹配 → code=1 + count=0', async () => {
    if (!rgAvailable) return;
    const dir = makeTempWs();
    try {
      const res = await runRg(dir, 'NO_SUCH_TOKEN_9x', 50, new AbortController().signal, 0);
      expect(res.code).toBe(1);
      expect(res.matchCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('contextLines>0 时输出 -A/-B 上下文行（行号连续）', async () => {
    if (!rgAvailable) return;
    const dir = makeTempWs();
    try {
      const res = await runRg(dir, 'TARGET', 50, new AbortController().signal, 1);
      expect(res.matchCount).toBe(2);
      const linesAt2 = res.lines.filter((l) => l.line === 2);
      expect(linesAt2.some((l) => l.kind === 'match' && l.text === 'line2 TARGET')).toBe(true);
      // -B1：line1 出现在首个 match 前；-A1：line3 出现在 match 后
      const kinds = res.lines.map((l) => l.kind);
      expect(kinds[0]).toBe('context'); // -B 的 line1
      expect(kinds[1]).toBe('match'); // line2
      expect(kinds[2]).toBe('context'); // line3
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});