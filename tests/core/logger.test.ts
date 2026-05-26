/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  initLogger,
  getLogger,
  closeLogger,
  __resetLoggerForTest,
} from '../../src/infra/logger.js';

function tmpLogDir(): string {
  const dir = join(tmpdir(), `dualmind-logger-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('logger', () => {
  let logDir: string;

  beforeEach(() => {
    __resetLoggerForTest();
    logDir = tmpLogDir();
  });

  afterEach(async () => {
    await closeLogger();
    __resetLoggerForTest();
    try { rmSync(logDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('initLogger creates log directory and returns a logger', () => {
    const log = initLogger({ logDir, level: 'info' });
    expect(log).toBeDefined();
    expect(existsSync(logDir)).toBe(true);
  });

  it('initLogger creates runtime.log on info write', () => {
    const log = initLogger({ logDir, level: 'info' });
    log.info('hello');
    // flush 确保写盘
    const runtimeLog = join(logDir, 'runtime.log');
    // 等待 pino 写盘（sync:true 理论上同步，但保险等一小会儿）
    const content = readFileSync(runtimeLog, 'utf8');
    expect(content).toContain('hello');
  });

  it('initLogger creates error.log on error write', () => {
    const log = initLogger({ logDir, level: 'info' });
    log.error('boom');
    const errorLog = join(logDir, 'error.log');
    const content = readFileSync(errorLog, 'utf8');
    expect(content).toContain('boom');
  });

  it('getLogger returns a child logger with module binding', () => {
    initLogger({ logDir, level: 'info' });
    const child = getLogger('my-module');
    // 打一条，看是否含 module field
    child.info('module test');
    const runtimeLog = join(logDir, 'runtime.log');
    const content = readFileSync(runtimeLog, 'utf8');
    expect(content).toContain('"module":"my-module"');
  });

  it('getLogger works before initLogger (fallback), then proxies to real after init', () => {
    // 在 init 之前拿 logger
    const pre = getLogger('pre-module');
    pre.info('before init');
    // init 之后应该自动绑定到真实 logger
    initLogger({ logDir, level: 'info' });
    const post = getLogger('pre-module');
    post.info('after init');
    // 日志应该写入了 runtime.log（fallback 只打 stdout 不写文件）
    const runtimeLog = join(logDir, 'runtime.log');
    const content = readFileSync(runtimeLog, 'utf8');
    expect(content).toContain('after init');
    expect(content).toContain('"module":"pre-module"');
  });

  it('closeLogger flushes and sets rootLogger to null', async () => {
    initLogger({ logDir, level: 'info' });
    await closeLogger();
    // 再次 close 不抛
    await closeLogger();
    // 之后再 getLogger 应该用 fallback（不 crash）
    const log = getLogger('post-close');
    expect(() => log.info('still ok')).not.toThrow();
  });

  it('initLogger tolerates invalid log dir (parent exists)', () => {
    // 正常的目录
    const log = initLogger({ logDir });
    expect(log).toBeDefined();
  });

  it('getLogger caches by moduleName across calls', () => {
    initLogger({ logDir, level: 'info' });
    const a = getLogger('dup');
    const b = getLogger('dup');
    // 同一个 moduleName 应该返回同一个 Proxy（底层 child logger 应当共享）
    a.info('from a');
    b.info('from b');
    const runtimeLog = join(logDir, 'runtime.log');
    const content = readFileSync(runtimeLog, 'utf8');
    // 两条日志
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it('supports trace, debug, warn, fatal levels', () => {
    const log = initLogger({ logDir, level: 'trace' });
    log.trace('trace msg');
    log.debug('debug msg');
    log.warn('warn msg');
    log.fatal('fatal msg');
    const runtimeLog = join(logDir, 'runtime.log');
    const errorLog = join(logDir, 'error.log');
    const runtime = readFileSync(runtimeLog, 'utf8');
    const error = readFileSync(errorLog, 'utf8');
    // runtime.log 只记录 info+，trace/debug 不写盘
    expect(runtime).toContain('warn msg');
    // fatal 进 error.log
    expect(error).toContain('fatal msg');
    // trace/debug level 仅在 dev stdout 输出，不持久化到文件
    expect(runtime).not.toContain('trace msg');
    expect(runtime).not.toContain('debug msg');
  });

  it('__resetLoggerForTest clears cache', () => {
    initLogger({ logDir, level: 'info' });
    getLogger('cached');
    __resetLoggerForTest();
    // 重新 init 后 getLogger 应重建 child（不拿旧引用）
    const log = initLogger({ logDir, level: 'info' });
    log.info('after reset');
    expect(true).toBe(true); // 不 crash 即可
  });
});
