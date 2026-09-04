/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * rg-search —— ripgrep 优先的精确文本搜索（检索差距弥补计划 T1）
 *
 * 与 grep_code 的既有 runGrep（系统 grep/findstr）并列：
 * - 探测到 `rg` 可用时走 --json 结构化输出 + 原生 -A/-B 上下文，
 *   解析（parseRgJson）为纯函数可单测
 * - 探测失败由调用方自动回退既有实现（零回归）
 * - 模块级单次探测缓存；resetRgProbeForTests 供测试重置
 *
 * 实现偏差（vs docs/retrieval-gap-close-plan.md §3.2）：
 * - 语法块上下文改用 rg 原生 `-A/-B`（与 plan 的 expandContext 纯函数方案等价且
 *   无需自实现缩进启发式；legacy 分支也通过 `-A/-B` 获得同格式上下文）；
 *   因此不新增 expandContext，纯函数面收缩为 parseRgJson / resolveEngine
 */

import { spawn, spawnSync } from 'node:child_process';

/** rg --json 输出的一行（match 或 context，行内不含换行） */
export interface RgLine {
  /** 文件路径文本（rg 数据原样，通常为搜索根内相对路径） */
  path: string;
  /** 1-based 行号 */
  line: number;
  /** 行内容（去尾部换行） */
  text: string;
  /** 'match'=命中行 / 'context'=-A/-B 上下文行 */
  kind: 'match' | 'context';
}

export interface RgResult {
  /** 解析出的全部行（match + context） */
  lines: RgLine[];
  /** 命中行（kind=match）条数 */
  matchCount: number;
  stderr: string;
  /** 0=命中 / 1=无匹配 / 其它=错误 */
  code: number;
  /** stdout 超过 64KB 被截断（code 已归一为 0，返回部分结果） */
  truncated: boolean;
}

/** 模块级探测缓存：同一进程只 spawn --version 一次 */
let rgProbe: boolean | undefined;

/** 探测 rg 是否可用（成功则缓存，供 resetRgProbeForTests 重置） */
export function probeRgAvailable(): boolean {
  if (rgProbe !== undefined) return rgProbe;
  try {
    const r = spawnSync('rg', ['--version'], { stdio: 'ignore', timeout: 3000 });
    rgProbe = r.status === 0;
  } catch {
    rgProbe = false;
  }
  return rgProbe;
}

/** 仅测试用：清除探测缓存，强制下次重新探测（不改变可用性结论本身） */
export function resetRgProbeForTests(): void {
  rgProbe = undefined;
}

/**
 * 引擎决策（纯函数，可单测）：rg 可用 → 'rg'；否则按平台回退 grep/findstr。
 * 与 grep_code.ts 的既有行为保持一致（win32=findstr / POSIX=grep）。
 */
export function resolveEngine(rgAvailable: boolean, isWin: boolean): 'rg' | 'grep' | 'findstr' {
  if (rgAvailable) return 'rg';
  return isWin ? 'findstr' : 'grep';
}

/**
 * 执行 ripgrep 搜索（--json）。
 *
 * - `-F` 固定字符串语义与既有 grep_code 一致（非正则）
 * - `contextLines > 0` 时追加 `-A/-B`（rg 原生上下文行，kind='context'）
 * - `-m` 每文件上限；stdout 64KB 截断后剩余可能切在 JSON 行中间，
 *   parseRgJson 逐行解析天然跳过残缺行（安全）；截断时 truncated=true 且
 *   code 归一为 0（调用方拿到部分结果而非误报执行失败）
 * - query 前加 `--` 分隔：query 以 `-` 开头（如搜 "-Werror"）不会与选项混淆
 */
export function runRg(
  cwd: string,
  query: string,
  maxLines: number,
  signal: AbortSignal,
  contextLines = 0,
): Promise<RgResult> {
  return new Promise((resolve) => {
    const args = [
      '--json',
      '-n',
      '--no-heading',
      '-F',
      '-m', String(maxLines),
      ...(contextLines > 0 ? ['-A', String(contextLines), '-B', String(contextLines)] : []),
      '--glob', '!**/node_modules/**',
      '--glob', '!**/.git/**',
      '--glob', '!**/dist/**',
      '--glob', '!**/out/**',
      '--glob', '!**/.devseeker/**',
      '--',
      query,
      '.',
    ];
    const child = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    const timeout = setTimeout(() => child.kill(), 30_000);
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 65536) {
        stdout = stdout.slice(0, 65536);
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      const result = parseRgJson(stdout);
      resolve({
        lines: result.lines,
        matchCount: result.matchCount,
        stderr,
        // 截断是预期的安全行为，归一为成功（部分结果）；否则 kill 后
        // close code 为 null → -1 会被调用方误判为执行失败
        code: truncated ? 0 : (code ?? -1),
        truncated,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve({ lines: [], matchCount: 0, stderr: err.message, code: -1, truncated: false });
    });
  });
}

/** 解析 rg --json 输出（纯函数）：只保留 match / context 两类行 */
export function parseRgJson(out: string): { lines: RgLine[]; matchCount: number } {
  const lines: RgLine[] = [];
  let matchCount = 0;
  for (const rawLine of out.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let obj: {
      type?: string;
      data?: {
        path?: { text?: string };
        line_number?: number;
        lines?: { text?: string };
      };
    };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // 截断/损坏行 —— 跳过
    }
    const d = obj?.data;
    if (!d) continue;
    const path = d.path?.text;
    const line = d.line_number;
    const text = d.lines?.text;
    if (typeof path !== 'string' || typeof line !== 'number' || typeof text !== 'string') continue;
    if (obj.type !== 'match' && obj.type !== 'context') continue;
    if (obj.type === 'match') matchCount++;
    lines.push({ path, line, text: text.replace(/\r?\n$/, ''), kind: obj.type });
  }
  return { lines, matchCount };
}