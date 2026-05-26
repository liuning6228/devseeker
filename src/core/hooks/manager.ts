/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * HookManager（W5 批次 1）
 *
 * 职责：
 * - 承载 Hook 配置（声明式 + 运行期注入）
 * - 按事件 + matcher 筛选候选 spec
 * - 串行执行候选；汇总 EmitOutcome
 * - 计算 denied：任一 pre_* 且 deny!==false 的 spec 非零退出 → denied=true
 *
 * 运行期注入（programmatic subscribe）支持：
 * - 内置审批门（后续批次）注册 pre_tool_call 监听，不必落到用户 hooks.json
 */

import { runHookCommand } from './executor.js';
import type {
  HookConfig,
  HookEvent,
  HookPayload,
  HookRunResult,
  HookSpec,
  EmitOutcome,
} from './types.js';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('hook.manager');

export interface HookManagerOptions {
  workspaceRoot?: string;
  /** 初始配置；可通过 setConfig() 替换 */
  config?: HookConfig;
  /**
   * 测试用：替换命令执行器。默认 runHookCommand。
   */
  runner?: typeof runHookCommand;
}

export class HookManager {
  private config: HookConfig;
  private readonly runtimeHooks: HookSpec[] = [];
  private readonly opts: HookManagerOptions;

  constructor(opts: HookManagerOptions = {}) {
    this.opts = opts;
    this.config = opts.config ?? { hooks: [] };
  }

  setConfig(config: HookConfig): void {
    this.config = config;
  }

  /** 运行期订阅（内部组件用） */
  subscribe(spec: HookSpec): () => void {
    this.runtimeHooks.push(spec);
    return () => {
      const idx = this.runtimeHooks.indexOf(spec);
      if (idx >= 0) this.runtimeHooks.splice(idx, 1);
    };
  }

  /** 合并配置 hooks + 运行期订阅（只读拷贝） */
  list(): HookSpec[] {
    return [...this.config.hooks, ...this.runtimeHooks];
  }

  /** 筛选匹配的 hook spec */
  select(payload: HookPayload): HookSpec[] {
    return this.list().filter((s) => matches(s, payload));
  }

  /** 触发事件；串行执行所有匹配的 hook */
  async emit(payload: HookPayload, signal?: AbortSignal): Promise<EmitOutcome> {
    const candidates = this.select(payload);
    const results: HookRunResult[] = [];
    let denied = false;
    let denier: HookRunResult | undefined;

    for (const spec of candidates) {
      if (signal?.aborted) break;
      const r = await this.opts.runner!.call(null, spec, payload, {
        workspaceRoot: this.opts.workspaceRoot,
        signal,
      }).catch((e) => {
        log.warn({ err: String(e), spec: spec.name }, 'hook runner threw');
        return {
          spec,
          ok: false,
          exitCode: -1,
          stdout: '',
          stderr: String(e),
          durationMs: 0,
          timedOut: false,
        } satisfies HookRunResult;
      });
      results.push(r);
      if (!r.ok && isDenyCapable(spec)) {
        denied = true;
        denier = r;
        log.info(
          { event: payload.event, name: spec.name, exitCode: r.exitCode },
          'pre-event hook denied',
        );
        break;
      }
    }

    return { results, denied, denier };
  }
}

// default runner injection for HookManager
export function createDefaultManager(opts: Omit<HookManagerOptions, 'runner'> = {}): HookManager {
  return new HookManager({ ...opts, runner: runHookCommand });
}

// ─────────── helpers ───────────

function isDenyCapable(spec: HookSpec): boolean {
  const isPre = spec.event === 'pre_task' || spec.event === 'pre_tool_call';
  if (!isPre) return false;
  return spec.deny !== false; // default true for pre_*
}

function matches(spec: HookSpec, payload: HookPayload): boolean {
  if (spec.event !== payload.event) return false;
  const m = spec.match;
  if (!m) return true;

  if (
    m.tool &&
    (payload.event === 'pre_tool_call' || payload.event === 'post_tool_call') &&
    !matchesToolName(m.tool, payload.toolName)
  ) {
    return false;
  }

  if (
    m.safetyLevel &&
    (payload.event === 'pre_tool_call' || payload.event === 'post_tool_call') &&
    m.safetyLevel !== payload.safetyLevel
  ) {
    return false;
  }

  // match.tool / safetyLevel 指定在非 tool 事件上 → 视为不匹配
  if (
    (m.tool || m.safetyLevel) &&
    payload.event !== 'pre_tool_call' &&
    payload.event !== 'post_tool_call'
  ) {
    return false;
  }

  return true;
}

function matchesToolName(pattern: string, name: string): boolean {
  if (pattern === '*' || pattern === name) return true;
  // 支持末尾通配：`read_*`
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return name.startsWith(prefix);
  }
  return false;
}

/** 辅助构造 payload timestamp（测试可注入固定值） */
export function nowMs(): number {
  return Date.now();
}

/** 选择导出 event 类型以方便调用方 */
export type { HookEvent };
