/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PromptBuilder（DESIGN §M3.6 · W3.6 Cache Priority Ordering）
 *
 * 把 System Prompt 按变更频率自低到高分为四层 L0/L1/L2/L3，
 * 保证 LLM Provider 的 Prompt Cache 能在 L0/L1/L2 分段前缀命中：
 *
 *   L0 Identity & Protocol         ← 缓存起点（永不变）
 *   L1 Tools & Mode                ← 切换 Mode / 增删 skill 时变
 *   L2 Workspace Rules & Memory    ← 写 rule 文件 / 写 memory 时变
 *   L3 Session Attachments（预留）  ← 每轮可能变（当前为空）
 *
 * 调用方拿到 `LayeredPrompt.full` 即可当作传统 system prompt 使用；
 * `computeLayerCacheKeys` 提供可观测的 L0/L0L1/L0L1L2 前缀哈希，
 * 便于调试命中率 + 单测断言层间独立性。
 */

import { buildL0Identity } from './layers/identity.js';
import { buildL1ToolsMode } from './layers/tools-mode.js';
import { buildL2RulesMemory } from './layers/rules-memory.js';
import { buildL3Attachments, type L3AttachmentsInput } from './layers/attachments.js';
import { computeLayerCacheKeys, RollingPrefixCache, type LayerCacheKeys } from './cache-boundary.js';
import { applyTokenBudget, type TokenBudget, type TruncationReport } from './token-budget.js';
import type { Mode } from '../modes/index.js';
import type { Skill } from '../skills/types.js';
import type { Rule } from '../rules/types.js';
import type { MemoryRecord } from '../memory/types.js';

/**
 * Prompt 构造器版本号。每当任一 L0/L1/L2/L3 的生成逻辑发生向前不兼容变动
 * （字段增删 / 顺序调整 / 分隔符改动）时，**必须**同步突升此版本号。
 *
 * 用途：
 *   1. 排查缓存命中率异常时定位是否是因构造版本升级导致
 *   2. 归档 PerfProbe / session 导出时随行，建立性能/行为数据与版本的映射
 *   3. B-P3-2：与 `dumpPromptSnapshot()` 结合输出结构化调试信息
 */
export const PROMPT_BUILDER_VERSION = '2026-05-01';

export interface PromptBuildContext {
  mode: Mode;
  /** workspace + builtin 合并后的技能清单 */
  skills: readonly Skill[];
  /** selector 已过滤/排序后的 always_on + 命中 glob 规则 */
  selectedRules: readonly Rule[];
  /** 全部规则（含 model_decision，用于生成索引清单） */
  allRules: readonly Rule[];
  /** MemoryStore.list() 输出（按 updatedAt 倒序） */
  memories: readonly MemoryRecord[];
  /** L3 动态附件输入；当前留空即可，未来批次逐步填充 */
  attachments?: L3AttachmentsInput;
  /**
   * B-P2-8 · Token 预算裁剪。设置后会在 build 前将超预算的 L2/L3 内容裁剪。
   * 不设时行为与原来完全一致。
   */
  budget?: TokenBudget;
  /**
   * V2 M3.14.8 · 可选 task_context 块文本。
   * 由上层从 experience 类记忆中选择最相关的 1-2 条、
   * 调用 renderTaskContextSection() 生成后传入。
   */
  taskContext?: string;
  /**
   * V2 M3.14.6 · 当前使用的模型 ID（如 "deepseek-chat"、"deepseek-reasoner"）；
   * 用于选择 model variant，为空时使用 generic variant。
   */
  modelId?: string;
}

export interface LayeredPrompt {
  /** L0 identity & protocol（永不变） */
  L0: string;
  /** L1 tools & mode */
  L1: string;
  /** L2 rules & memory */
  L2: string;
  /** L3 session attachments（当前 W3.6 基线为空） */
  L3: string;
  /** 最终 system prompt 字符串：`[L0, L1, L2, L3].filter(non-empty).join('\n\n')` */
  full: string;
  /** B-P3-2 · Prompt 构造器版本号（方便排查） */
  version: string;
  /** B-P3-2 · 分层前缀哈希（等价于 `computeLayerCacheKeys(this)`） */
  cacheKeys: LayerCacheKeys;
  /** B-P2-8 · Token 裁剪报告（不触发裁剪时 triggered=false） */
  truncation?: TruncationReport;
}

export class PromptBuilder {
  /** §8.17.1 · 滚动前缀缓存（全局单例，每次 send 后 clear） */
  private static rollingCache = new RollingPrefixCache();

  /**
   * 按四层稳定区构建 system prompt。
   *
   * 输入同 ⇒ 输出字节级恒等（前提：传入的 rules/skills/memories 顺序稳定）。
   * §8.17.1：若 L0/L1/L2 与前一轮字节级相同，复用上一轮的 full 字符串。
   */
  static build(ctx: PromptBuildContext): LayeredPrompt {
    const { ctx: budgetedCtx, report } = applyTokenBudget(ctx, ctx.budget);
    const L0 = buildL0Identity(budgetedCtx.modelId);
    const L1 = buildL1ToolsMode({ mode: budgetedCtx.mode, skills: budgetedCtx.skills });
    const L2 = buildL2RulesMemory({
      selectedRules: budgetedCtx.selectedRules,
      allRules: budgetedCtx.allRules,
      memories: budgetedCtx.memories,
      taskContext: budgetedCtx.taskContext,
    });
    const L3 = buildL3Attachments(budgetedCtx.attachments);

    // §8.17.1 · 滚动前缀缓存
    const modeName = budgetedCtx.mode ?? 'unknown';
    const cached = PromptBuilder.rollingCache.get(modeName, PROMPT_BUILDER_VERSION, L0, L1, L2);
    let full: string;
    if (cached !== undefined) {
      // L0/L1/L2 与前一轮相同 → 复用上一轮的 full（仅 L3 可能变化）
      full = L3 && L3.length > 0 ? `${cached}\n\n${L3}` : cached;
      PromptBuilder.rollingCache.hitCount++;
    } else {
      full = [L0, L1, L2, L3].filter((s) => s && s.length > 0).join('\n\n');
      PromptBuilder.rollingCache.set(modeName, PROMPT_BUILDER_VERSION, L0, L1, L2, full);
      PromptBuilder.rollingCache.missCount++;
    }

    const partial = { L0, L1, L2, L3, full };
    const cacheKeys = computeLayerCacheKeys(partial);
    return {
      ...partial,
      version: PROMPT_BUILDER_VERSION,
      cacheKeys,
      ...(report.triggered ? { truncation: report } : {}),
    };
  }

  /** 清除滚动缓存（TaskLoop send() 结束时调用） */
  static clearCache(): void {
    PromptBuilder.rollingCache.clear();
  }
}

/**
 * B-P3-2 · 产生结构化调试快照。非密文，可归档或打到日志。
 *
 * 字段义：
 *   - version：当前 PromptBuilder 版本
 *   - lengths：各层字符长度（保护隐私）
 *   - cacheKeys：L0 / L0L1 / L0L1L2 / full 的短哈希
 */
export interface PromptSnapshot {
  version: string;
  lengths: { L0: number; L1: number; L2: number; L3: number; full: number };
  cacheKeys: LayerCacheKeys;
}

export function dumpPromptSnapshot(p: LayeredPrompt): PromptSnapshot {
  return {
    version: p.version,
    lengths: {
      L0: p.L0.length,
      L1: p.L1.length,
      L2: p.L2.length,
      L3: p.L3.length,
      full: p.full.length,
    },
    cacheKeys: p.cacheKeys,
  };
}
