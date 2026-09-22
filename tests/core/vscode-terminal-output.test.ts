/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * stripLeadingCommandEcho 单测（命令回显过滤）
 *
 * 回归背景：旧实现用 `command.includes(line)` 判断回显——只要输出行是命令文本的“子串”
 * 就会被当作回显丢弃：
 *   - `echo hello`            → 输出 `hello` 被吞
 *   - `node -e "process.stdout.write('x')"` → 输出 `x` 被吞
 *   - `printf ok`             → 输出 `ok` 被吞
 * 现象：「bash 执行完成、终端有输出，但工具侧抓不到输出内容」。
 *
 * 现规则：仅整行（trim 后）与命令行完全一致才视为回显。
 */

import { describe, it, expect } from 'vitest';
import {
  stripLeadingCommandEcho,
  buildCommandLines,
} from '../../src/core/tools/vscode-terminal.js';

/** 直接使用生产端同一实现构建命令行集合（避免测试复制逻辑导致漂移） */
const linesOf = buildCommandLines;

describe('stripLeadingCommandEcho', () => {
  it('回归：输出文本是命令行子串时不再被吞（echo 场景）', () => {
    const cmd = 'echo hello';
    const r = stripLeadingCommandEcho('hello\n', linesOf(cmd), false);
    expect(r.data).toContain('hello');
    expect(r.alreadyOutput).toBe(true);
  });

  it('回归：node -e / printf 输出为命令子串时保留', () => {
    const cmd1 = 'node -e "process.stdout.write(\'part1\')"';
    const r1 = stripLeadingCommandEcho('part1\n', linesOf(cmd1), false);
    expect(r1.data).toContain('part1');

    const cmd2 = 'printf ok';
    const r2 = stripLeadingCommandEcho('ok\n', linesOf(cmd2), false);
    expect(r2.data).toContain('ok');
  });

  it('回显行（整行等于命令行）被丢弃，后续真实输出保留', () => {
    const cmd = 'npm run build';
    const r = stripLeadingCommandEcho('npm run build\nCompiled ok\n', linesOf(cmd), false);
    expect(r.data).toBe('Compiled ok\n');
    expect(r.alreadyOutput).toBe(true);
  });

  it('回显行与真实输出同名（echo hi 输出 hi）：回显丢弃、输出保留', () => {
    const cmd = 'echo hi';
    const r = stripLeadingCommandEcho('echo hi\nhi\n', linesOf(cmd), false);
    expect(r.data).toBe('hi\n');
    expect(r.alreadyOutput).toBe(true);
  });

  it('CRLF 回显（\\r）也能识别并丢弃', () => {
    const cmd = 'npm run build';
    const r = stripLeadingCommandEcho('npm run build\r\nout\r\n', linesOf(cmd), false);
    expect(r.data).toBe('out\r\n');
    expect(r.alreadyOutput).toBe(true);
  });

  it('已出现真实输出（alreadyOutput=true）→ 原样返回', () => {
    const r = stripLeadingCommandEcho('echo hi\n', linesOf('echo hi'), true);
    expect(r.data).toBe('echo hi\n');
    expect(r.alreadyOutput).toBe(true);
  });

  it('仅回显与空行 → 全部清空且状态保持未开始（后续 chunk 继续过滤）', () => {
    const r = stripLeadingCommandEcho('echo hi\n\n', linesOf('echo hi'), false);
    expect(r.data.trim()).toBe('');
    expect(r.alreadyOutput).toBe(false);
  });

  it('无回显的真实输出原样保留', () => {
    const r = stripLeadingCommandEcho('hello world\n', linesOf('echo hi'), false);
    expect(r.data).toBe('hello world\n');
    expect(r.alreadyOutput).toBe(true);
  });
});
