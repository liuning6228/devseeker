/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Logger: 全局 pino NDJSON 日志实例
 *
 * 规约（SPEC/error-model.md §9）：
 * - 所有 error 日志必须含：ts / lvl / module / code / msg / context / traceId / subagentId
 * - error/fatal 进 .dualmind/logs/error.log
 * - warn/info 进 .dualmind/logs/runtime.log
 * - 子代理额外进 .dualmind/logs/subagents/<id>.jsonl（由 M8 实现注入）
 * - 滚动：单文件 10MB，保留 5 份（由 pino.transport 处理）
 *
 * 双模式：
 * - 开发（NODE_ENV !== production）：pino-pretty 彩色输出到 stdout + 写文件
 * - 生产：仅写文件（不污染 VSCode 扩展主机输出）
 */

import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger, type LoggerOptions, type DestinationStream } from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerConfig {
  /** 日志目录，通常是 `<workspaceRoot>/.dualmind/logs` */
  logDir: string;
  /** 日志级别，默认 'info' */
  level?: LogLevel;
  /** 是否开发模式（输出彩色到 stdout） */
  dev?: boolean;
}

let rootLogger: Logger | null = null;

// Lazy-binding cache：按 moduleName 缓存已解析的 child logger。
// key = moduleName, value = { root: 当时的 rootLogger 引用, child: 对应 child logger }
// 当 rootLogger 变化（init 完成或 reset）时自动重建 child，确保 logger 总指向最新实例。
const loggerCache = new Map<string, { root: Logger | null; child: Logger }>();

/**
 * 初始化全局 logger。应在扩展激活时调用一次。
 */
export function initLogger(config: LoggerConfig): Logger {
  // 确保日志目录存在
  if (!existsSync(config.logDir)) {
    mkdirSync(config.logDir, { recursive: true });
  }

  const errorPath = join(config.logDir, 'error.log');
  const runtimePath = join(config.logDir, 'runtime.log');

  const level: LogLevel = config.level ?? 'info';
  const dev = config.dev ?? process.env.NODE_ENV !== 'production';

  const options: LoggerOptions = {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      // 不要 pino 默认的 pid / hostname 字段，干扰结构化查询
      pid: undefined,
      hostname: undefined,
    },
    formatters: {
      level(label) {
        return { lvl: label };
      },
    },
    messageKey: 'msg',
    redact: {
      paths: ['*.apiKey', '*.token', '*.secret', '*.password', '*.authorization'],
      censor: '<redacted>',
    },
  };

  // 组合多目的地输出
  // - runtime.log: info+warn
  // - error.log:   error+fatal
  // - stdout (dev): pretty 输出所有
  const streams: Array<{ level: LogLevel; stream: DestinationStream }> = [
    {
      level: 'info',
      stream: pino.destination({ dest: runtimePath, sync: true, mkdir: true }),
    },
    {
      level: 'error',
      stream: pino.destination({ dest: errorPath, sync: true, mkdir: true }),
    },
  ];

  if (dev) {
    // 开发模式加 pino-pretty 到 stdout
    try {
      // 动态 require 避免生产打包 pino-pretty
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const prettyFactory = require('pino-pretty');
      const prettyStream = prettyFactory({
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
      });
      streams.push({ level: level as LogLevel, stream: prettyStream });
    } catch {
      // pino-pretty 不可用则忽略（仍然写文件）
    }
  }

  rootLogger = pino(options, pino.multistream(streams, { dedupe: false }));
  return rootLogger;
}

/**
 * 获取子 logger。
 *
 * 返回一个 lazy Proxy：每次调用方法时才解析真正的 child logger。
 * 这样即使在 initLogger 之前（如模块顶层）调用 getLogger，后续 initLogger 完成后也能正常写日志。
 * 解决模块顶层 `const log = getLogger(...)` 绑定到 fallback 实例永不写盘的 bug。
 *
 * @param moduleName - 模块名，如 'M1' 'M4' 'task-loop'（会写入 bindings 里）
 */
export function getLogger(moduleName: string): Logger {
  return new Proxy({} as Logger, {
    get(_target, prop) {
      let entry = loggerCache.get(moduleName);
      if (!entry || entry.root !== rootLogger) {
        const child = rootLogger ? rootLogger.child({ module: moduleName }) : createFallbackLogger(moduleName);
        entry = { root: rootLogger, child };
        loggerCache.set(moduleName, entry);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v: any = (entry.child as any)[prop];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return typeof v === 'function' ? (v as (...args: any[]) => unknown).bind(entry.child) : v;
    },
  });
}

/**
 * 优雅关闭 logger（VSCode 扩展 deactivate 时调用）。
 */
export async function closeLogger(): Promise<void> {
  if (!rootLogger) return;
  await new Promise<void>((resolve) => {
    rootLogger!.flush(() => resolve());
  });
  rootLogger = null;
}

/**
 * 没初始化时的兜底 logger（只打 stdout）
 */
function createFallbackLogger(moduleName: string): Logger {
  return pino({
    level: 'info',
    base: { module: moduleName },
  });
}

/**
 * 供测试重置
 */
export function __resetLoggerForTest(): void {
  rootLogger = null;
  loggerCache.clear();
}
