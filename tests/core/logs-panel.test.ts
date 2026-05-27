/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-P1-14 · Logs Panel 单元测试
 *
 * 测试纯函数：parseNdjsonLine / filterLogEntries / collectLogPanelInput /
 * buildLogsPanelHtml（最少 10 条）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  parseNdjsonLine,
  filterLogEntries,
  collectLogPanelInput,
  buildLogsPanelHtml,
  LEVEL_MAP,
  type LogEntry,
  type LogLevelName,
} from '../../src/webview/panels/logs-panel.js';

describe('logs-panel · parseNdjsonLine', () => {
  it('合法 pino 行 → 返回 entry', () => {
    const line = JSON.stringify({
      level: 30,
      time: 1700000000000,
      module: 'webview.panel',
      msg: 'panel ready',
      foo: 'bar',
    });
    const e = parseNdjsonLine(line, 'runtime');
    expect(e).not.toBeNull();
    expect(e!.level).toBe('info');
    expect(e!.module).toBe('webview.panel');
    expect(e!.msg).toBe('panel ready');
    expect(e!.source).toBe('runtime');
    expect(e!.extra).toEqual({ foo: 'bar' });
    expect(e!.tsMs).toBe(1700000000000);
  });

  it('未知 level 数 → 默认 info', () => {
    const line = JSON.stringify({ level: 99, time: 1, module: 'x', msg: 'y' });
    const e = parseNdjsonLine(line, 'runtime');
    expect(e!.level).toBe('info');
  });

  it('level 为字符串 → 正常解析', () => {
    const line = JSON.stringify({ level: 'ERROR', time: 1, module: 'x', msg: 'z' });
    const e = parseNdjsonLine(line, 'error');
    expect(e!.level).toBe('error');
  });

  it('空行 / 非法 JSON → 返回 null', () => {
    expect(parseNdjsonLine('', 'runtime')).toBeNull();
    expect(parseNdjsonLine('   ', 'runtime')).toBeNull();
    expect(parseNdjsonLine('{not json', 'runtime')).toBeNull();
    expect(parseNdjsonLine('null', 'runtime')).toBeNull();
  });

  it('剥掉 hostname/pid/v 等 pino 冗余字段', () => {
    const line = JSON.stringify({
      level: 30,
      time: 1,
      module: 'm',
      msg: 'x',
      hostname: 'host',
      pid: 123,
      v: 1,
      keep: 'me',
    });
    const e = parseNdjsonLine(line, 'runtime');
    expect(Object.keys(e!.extra)).toEqual(['keep']);
  });

  it('LEVEL_MAP 覆盖全部 6 级', () => {
    expect(LEVEL_MAP[10]).toBe('trace');
    expect(LEVEL_MAP[20]).toBe('debug');
    expect(LEVEL_MAP[30]).toBe('info');
    expect(LEVEL_MAP[40]).toBe('warn');
    expect(LEVEL_MAP[50]).toBe('error');
    expect(LEVEL_MAP[60]).toBe('fatal');
  });
});

describe('logs-panel · filterLogEntries', () => {
  function entry(overrides: Partial<LogEntry> = {}): LogEntry {
    return {
      time: '2026-05-02T00:00:00.000Z',
      tsMs: 1746144000000,
      level: 'info',
      module: 'webview.panel',
      msg: 'hello world',
      extra: { foo: 'bar' },
      source: 'runtime',
      raw: '{}',
      ...overrides,
    };
  }

  it('无 filter → 原样返回', () => {
    const list = [entry({ msg: 'a' }), entry({ msg: 'b' })];
    expect(filterLogEntries(list)).toHaveLength(2);
  });

  it('levels 白名单过滤', () => {
    const list = [
      entry({ level: 'info' }),
      entry({ level: 'warn' }),
      entry({ level: 'error' }),
    ];
    const r = filterLogEntries(list, { levels: ['warn', 'error'] });
    expect(r).toHaveLength(2);
    expect(r.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('module 子串 + 大小写不敏感', () => {
    const list = [
      entry({ module: 'webview.panel' }),
      entry({ module: 'terminal.pool' }),
      entry({ module: 'Webview.Route' }),
    ];
    const r = filterLogEntries(list, { module: 'webview' });
    expect(r).toHaveLength(2);
  });

  it('keyword 匹配 msg + extra 序列化后的内容', () => {
    const list = [
      entry({ msg: 'tool invoked' }),
      entry({ msg: 'other', extra: { tool: 'read_file' } as Record<string, unknown> }),
      entry({ msg: 'unrelated' }),
    ];
    const r = filterLogEntries(list, { keyword: 'tool' });
    expect(r).toHaveLength(2);
  });

  it('同时 levels + module + keyword → 取交集', () => {
    const list = [
      entry({ level: 'info', module: 'a', msg: 'x tool' }),
      entry({ level: 'warn', module: 'a', msg: 'x tool' }),
      entry({ level: 'warn', module: 'b', msg: 'x tool' }),
      entry({ level: 'warn', module: 'a', msg: 'y' }),
    ];
    const r = filterLogEntries(list, {
      levels: ['warn'],
      module: 'a',
      keyword: 'tool',
    });
    expect(r).toHaveLength(1);
  });
});

describe('logs-panel · collectLogPanelInput', () => {
  let tmp: string;
  let logsDir: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'logs-panel-test-'));
    logsDir = path.join(tmp, '.devseeker', 'logs');
    await fs.mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('无工作区 → 返回空 entries、runtimeExists=false', async () => {
    const input = await collectLogPanelInput({ workspaceRoot: undefined });
    expect(input.entries).toHaveLength(0);
    expect(input.runtimeExists).toBe(false);
    expect(input.errorExists).toBe(false);
  });

  it('两份日志文件 → 合并 + tsMs 升序', async () => {
    const runtime = [
      JSON.stringify({ level: 30, time: 2, module: 'a', msg: 'r2' }),
      JSON.stringify({ level: 30, time: 4, module: 'a', msg: 'r4' }),
    ].join('\n');
    const error = [
      JSON.stringify({ level: 50, time: 1, module: 'a', msg: 'e1' }),
      JSON.stringify({ level: 50, time: 3, module: 'a', msg: 'e3' }),
    ].join('\n');
    await fs.writeFile(path.join(logsDir, 'runtime.log'), runtime, 'utf8');
    await fs.writeFile(path.join(logsDir, 'error.log'), error, 'utf8');

    const input = await collectLogPanelInput({ workspaceRoot: tmp });
    expect(input.runtimeExists).toBe(true);
    expect(input.errorExists).toBe(true);
    expect(input.entries.map((e) => e.msg)).toEqual(['e1', 'r2', 'e3', 'r4']);
    expect(input.counts.total).toBe(4);
    expect(input.counts.byLevel.info).toBe(2);
    expect(input.counts.byLevel.error).toBe(2);
    expect(input.counts.fromRuntime).toBe(2);
    expect(input.counts.fromError).toBe(2);
  });

  it('maxEntries 截断保留末尾', async () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ level: 30, time: i, module: 'm', msg: `line-${i}` }),
    );
    await fs.writeFile(path.join(logsDir, 'runtime.log'), lines.join('\n'), 'utf8');
    const input = await collectLogPanelInput({ workspaceRoot: tmp, maxEntries: 3 });
    expect(input.entries).toHaveLength(3);
    expect(input.entries.map((e) => e.msg)).toEqual(['line-7', 'line-8', 'line-9']);
  });

  it('非法行被容忍并跳过', async () => {
    const content = [
      JSON.stringify({ level: 30, time: 1, module: 'm', msg: 'ok' }),
      'garbage',
      '',
      JSON.stringify({ level: 30, time: 2, module: 'm', msg: 'ok2' }),
    ].join('\n');
    await fs.writeFile(path.join(logsDir, 'runtime.log'), content, 'utf8');
    const input = await collectLogPanelInput({ workspaceRoot: tmp });
    expect(input.entries).toHaveLength(2);
  });

  it('DI readTail + exists → stub 可用', async () => {
    const levels: LogLevelName[] = [];
    const input = await collectLogPanelInput({
      workspaceRoot: '/fake/ws',
      exists: async (p) => p.endsWith('runtime.log'),
      readTail: async () =>
        JSON.stringify({ level: 40, time: 1, module: 'x', msg: 'stubbed' }),
    });
    expect(input.runtimeExists).toBe(true);
    expect(input.errorExists).toBe(false);
    expect(input.entries).toHaveLength(1);
    expect(input.entries[0]!.msg).toBe('stubbed');
    expect(input.entries[0]!.level).toBe('warn');
    expect(levels).toEqual([]);
  });
});

describe('logs-panel · buildLogsPanelHtml', () => {
  it('空 entries → 渲染 empty 提示 + 基本 HTML 外壳', () => {
    const html = buildLogsPanelHtml(
      {
        workspaceRoot: '/ws',
        runtimePath: '/ws/.devseeker/logs/runtime.log',
        errorPath: '/ws/.devseeker/logs/error.log',
        runtimeExists: true,
        errorExists: false,
        entries: [],
        maxBytes: 1024,
        counts: {
          total: 0,
          byLevel: { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 },
          fromRuntime: 0,
          fromError: 0,
        },
        generatedAt: '2026-05-02T00:00:00.000Z',
      },
      'nonce-xyz',
      'vscode-resource:',
    );
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('no log entries');
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain('nonce-xyz');
    expect(html).toContain('DevSeeker · Logs');
  });

  it('非空 entries → 渲染表格 + 行', () => {
    const entries: LogEntry[] = [
      {
        time: '2026-05-02T00:00:00.000Z',
        tsMs: 1,
        level: 'error',
        module: 'webview.panel',
        msg: 'boom',
        extra: { code: 42 },
        source: 'error',
        raw: '{}',
      },
      {
        time: '2026-05-02T00:00:01.000Z',
        tsMs: 2,
        level: 'info',
        module: 'task.loop',
        msg: 'hello',
        extra: {},
        source: 'runtime',
        raw: '{}',
      },
    ];
    const html = buildLogsPanelHtml(
      {
        workspaceRoot: '/ws',
        runtimePath: '/ws/.devseeker/logs/runtime.log',
        errorPath: '/ws/.devseeker/logs/error.log',
        runtimeExists: true,
        errorExists: true,
        entries,
        maxBytes: 1024,
        counts: {
          total: 2,
          byLevel: { trace: 0, debug: 0, info: 1, warn: 0, error: 1, fatal: 0 },
          fromRuntime: 1,
          fromError: 1,
        },
        generatedAt: '2026-05-02T00:00:00.000Z',
      },
      'nonce-xyz',
      'vscode-resource:',
    );
    expect(html).toContain('webview.panel');
    expect(html).toContain('task.loop');
    expect(html).toContain('boom');
    expect(html).toContain('level-error');
    expect(html).toContain('log-source-error');
    expect(html).toContain('log-source-runtime');
  });

  it('HTML 转义防止 XSS 串味', () => {
    const entries: LogEntry[] = [
      {
        time: 't',
        tsMs: 1,
        level: 'info',
        module: '<script>',
        msg: '</body><img onerror=x>',
        extra: { x: '<raw>' } as Record<string, unknown>,
        source: 'runtime',
        raw: '{}',
      },
    ];
    const html = buildLogsPanelHtml(
      {
        workspaceRoot: '/ws',
        runtimePath: '/ws/runtime.log',
        errorPath: '/ws/error.log',
        runtimeExists: true,
        errorExists: true,
        entries,
        maxBytes: 1024,
        counts: {
          total: 1,
          byLevel: { trace: 0, debug: 0, info: 1, warn: 0, error: 0, fatal: 0 },
          fromRuntime: 1,
          fromError: 0,
        },
        generatedAt: 't',
      },
      'n',
      'c',
    );
    expect(html).not.toContain('<script>t');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;/body&gt;');
    expect(html).toContain('&lt;raw&gt;');
  });
});
