/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-P2-8 · Prompt Token 预算裁剪
 *
 * 策略：保底 L0（稳定区）+ L1（会话区），按顺序裁剪 L3 / L2，保留 cache 命中前缀。
 *
 * 裁剪优先级（从高到低，优先被丢弃）：
 *   1. L3 selectedCodes 文本截断（按 text 长度从大到小）
 *   2. L3 attachments 摘要列表（整段丢弃）
 *   3. L2 memories 末尾条目（按数组顺序丢弃，memories 调用方已按 updatedAt 倒序 → 末尾最旧）
 *   4. L3 gitContext（整段丢弃）
 *   5. L2 selectedRules 按 priority 升序丢弃
 *
 * 不裁剪：L0 / L1 / memory_overview 的 "Active preferences"（需应用方保证）。
 *
 * **估算规则**：`estimateTokens(text)` 优先用 `js-tiktoken` 的 `cl100k_base` encoder
 *   （对 gpt-4 / deepseek / qwen 中文混合都比 `ceil(len/4)` 更准）。
 *   遇到 encoder 加载失败（包装打包缺省时等）自动降级回启发式 `ceil(len/4)` 作为兼容底线。
 *   Encoder 延迟加载 + 单例复用。
 */

import type { PromptBuildContext } from './builder.js';
import type { L3AttachmentsInput } from './layers/attachments.js';

export interface TokenBudget {
  /** 硬上限（含全部层）。0 或 undefined → 不裁剪 */
  maxTokens: number;
  /** 给后续 messages 保留的配额（默认 4096） */
  reserveForMessages?: number;
  /** 单条 selectedCode 被裁后保留的最大字符数（默认 1000 字符） */
  selectedCodeMaxChars?: number;
}

export interface TruncationReport {
  /** 估算 token 用量（裁剪前） */
  estimatedBefore: number;
  /** 估算 token 用量（裁剪后） */
  estimatedAfter: number;
  /** 裁掉的 memory 条数 */
  droppedMemories: number;
  /** 裁掉的 rule 条数 */
  droppedRules: number;
  /** 被截断的 selectedCode 条数 */
  truncatedSelectedCodes: number;
  /** 丢弃的 attachments 条数 */
  droppedAttachments: number;
  /** 是否丢弃了 gitContext */
  droppedGitContext: boolean;
  /** 是否触发了裁剪 */
  triggered: boolean;
}

/**
 * B-P3-8 · 真 tokenizer：优先 `js-tiktoken` `cl100k_base`，缺省降级到 `ceil(len / 4)`。
 *
 * - js-tiktoken 纯JS实现，无 native 依赖，适合打包进 VSCode 扩展。
 * - cl100k_base 对 gpt-4 / deepseek / qwen / claude 的近似均优于 `len/4`。
 * - 单例 + 延迟加载；加载失败会记录一次，后续调用直接走启发式。
 */
type TiktokenEncoderLike = { encode: (text: string) => { length: number } | number[] };
let _encoder: TiktokenEncoderLike | null | undefined = undefined;
let _encoderLoadAttempted = false;

function heuristicEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 测试可念：清空 encoder 缓存以重新试试加载路径。 */
export function resetTokenizerCache(): void {
  _encoder = undefined;
  _encoderLoadAttempted = false;
}

/** 测试可念：注入一个完全伪的 encoder（同时标记已加载）。 */
export function __setTokenizerForTests(enc: TiktokenEncoderLike | null): void {
  _encoder = enc;
  _encoderLoadAttempted = true;
}

function getEncoder(): TiktokenEncoderLike | null {
  if (_encoderLoadAttempted) return _encoder ?? null;
  _encoderLoadAttempted = true;
  try {
    // 使用同步 require 路径，避免 Top-Level Await 在 commonjs 下编译问题。
    //  js-tiktoken 是 CJS + ESM 兼容的纯 JS 包。
     
    const mod: unknown = require('js-tiktoken');
    const getEncoding = (mod as { getEncoding?: (name: string) => TiktokenEncoderLike }).getEncoding;
    if (typeof getEncoding === 'function') {
      _encoder = getEncoding('cl100k_base');
      return _encoder;
    }
  } catch {
    // 进入降级分支
  }
  _encoder = null;
  return null;
}

/** 内部启发式估算器，给 applyTokenBudget 的 recompute 循环用。 */
function estimateTokensFast(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** 内部：用启发式估算整个 ctx，避免裁剪时反复调用真实 tokenizer。 */
function estimateContextTokensFast(ctx: PromptBuildContext): number {
  let total = 0;
  for (const m of ctx.memories) {
    total += estimateTokensFast(m.title ?? '');
    total += estimateTokensFast(m.content ?? '');
  }
  for (const r of ctx.selectedRules) {
    total += estimateTokensFast(r.name ?? '');
    const content = (r as unknown as { content?: string }).content ?? '';
    total += estimateTokensFast(content);
  }
  for (const r of ctx.allRules) {
    total += estimateTokensFast(r.name ?? '');
    total += estimateTokensFast((r as unknown as { description?: string }).description ?? '');
  }
  for (const sk of ctx.skills) {
    total += estimateTokensFast(sk.name ?? '');
    total += estimateTokensFast(sk.description ?? '');
  }
  const att = ctx.attachments ?? {};
  if (att.environment) total += estimateTokensFast(att.environment);
  if (att.gitContext) total += estimateTokensFast(att.gitContext);
  if (att.selectedCodes) for (const sc of att.selectedCodes) total += estimateTokensFast(sc.text);
  if (att.attachments) for (const a of att.attachments) total += estimateTokensFast(a.summary);
  return total + 1200;
}

/**
 * 估算 token：优先 js-tiktoken cl100k_base；加载失败或 encode 抛异常 fallback 启发式。
 *
 * 测试可用 `__setTokenizerForTests(null)` 强制走启发式分支。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const enc = getEncoder();
  if (!enc) return heuristicEstimate(text);
  try {
    const res = enc.encode(text);
    if (Array.isArray(res)) return res.length;
    if (typeof (res as { length?: number }).length === 'number') {
      return (res as { length: number }).length;
    }
  } catch {
    // noop → fallback
  }
  return heuristicEstimate(text);
}

/** 估算一份 PromptBuildContext 各层总 token。仅用字符长度估算。 */
export function estimateContextTokens(ctx: PromptBuildContext): number {
  // 近似：把所有 memory.content / rule.content / selectedCodes.text 等累加
  let total = 0;
  for (const m of ctx.memories) {
    total += estimateTokens(m.title ?? '');
    total += estimateTokens(m.content ?? '');
  }
  for (const r of ctx.selectedRules) {
    total += estimateTokens(r.name ?? '');
    const content = (r as unknown as { content?: string }).content ?? '';
    total += estimateTokens(content);
  }
  for (const r of ctx.allRules) {
    total += estimateTokens(r.name ?? '');
    total += estimateTokens((r as unknown as { description?: string }).description ?? '');
  }
  for (const sk of ctx.skills) {
    total += estimateTokens(sk.name ?? '');
    total += estimateTokens(sk.description ?? '');
  }
  const att = ctx.attachments ?? {};
  if (att.environment) total += estimateTokens(att.environment);
  if (att.gitContext) total += estimateTokens(att.gitContext);
  if (att.selectedCodes) for (const sc of att.selectedCodes) total += estimateTokens(sc.text);
  if (att.attachments) for (const a of att.attachments) total += estimateTokens(a.summary);
  // L0 静态模块保守估计：~1200 tokens
  return total + 1200;
}

/**
 * 应用 token 预算，按顺序裁剪得到新的 ctx。
 *
 * 若 budget 未设或估算未超，则返回 ctx 引用本身（不 copy）+ triggered=false 报告。
 */
export function applyTokenBudget(
  ctx: PromptBuildContext,
  budget: TokenBudget | undefined,
): { ctx: PromptBuildContext; report: TruncationReport } {
  // 裁剪决策用启发式（线性 + 快）；真实 tokenizer 只用于外部训练/展示。
  const estimatedBefore = estimateContextTokensFast(ctx);
  const report: TruncationReport = {
    estimatedBefore,
    estimatedAfter: estimatedBefore,
    droppedMemories: 0,
    droppedRules: 0,
    truncatedSelectedCodes: 0,
    droppedAttachments: 0,
    droppedGitContext: false,
    triggered: false,
  };
  if (!budget || !budget.maxTokens || budget.maxTokens <= 0) {
    return { ctx, report };
  }
  const reserve = budget.reserveForMessages ?? 4096;
  const available = budget.maxTokens - reserve;
  if (available <= 0) {
    // 预算太小，裁成最极端
    return finalize({
      ctx: {
        ...ctx,
        memories: [],
        selectedRules: [],
        attachments: {
          ...(ctx.attachments ?? {}),
          selectedCodes: [],
          attachments: [],
          gitContext: undefined,
        },
      },
      report: { ...report, triggered: true, droppedMemories: ctx.memories.length, droppedRules: ctx.selectedRules.length, droppedGitContext: !!ctx.attachments?.gitContext, droppedAttachments: ctx.attachments?.attachments?.length ?? 0 },
    });
  }
  if (estimatedBefore <= available) return { ctx, report };

  report.triggered = true;
  const selectedCodeMax = budget.selectedCodeMaxChars ?? 1000;

  let memories = ctx.memories.slice();
  let selectedRules = ctx.selectedRules.slice();
  const att: L3AttachmentsInput = { ...(ctx.attachments ?? {}) };
  let selectedCodes = att.selectedCodes ? att.selectedCodes.slice() : undefined;
  let attachments = att.attachments ? att.attachments.slice() : undefined;
  let gitContext = att.gitContext;

  const recompute = () => estimateContextTokensFast({
    ...ctx,
    memories,
    selectedRules,
    attachments: { ...att, selectedCodes, attachments, gitContext },
  });

  // 第 1 步：截断最长的 selectedCodes（按 text 长度降序）
  if (selectedCodes && selectedCodes.length > 0) {
    const order = selectedCodes
      .map((sc, idx) => ({ idx, len: sc.text.length }))
      .sort((a, b) => b.len - a.len);
    for (const { idx } of order) {
      if (recompute() <= available) break;
      const sc = selectedCodes[idx]!;
      if (sc.text.length > selectedCodeMax) {
        selectedCodes = selectedCodes.slice();
        selectedCodes[idx] = {
          ...sc,
          text: sc.text.slice(0, selectedCodeMax) + '\n…(truncated for token budget)',
        };
        report.truncatedSelectedCodes++;
      }
    }
  }

  // 第 2 步：丢弃 attachments 摘要
  if (attachments && attachments.length > 0 && recompute() > available) {
    report.droppedAttachments = attachments.length;
    attachments = [];
  }

  // 第 3 步：丢弃 memories 末尾（保留头部，头部多是最新 + 硬约束）
  while (memories.length > 0 && recompute() > available) {
    memories.pop();
    report.droppedMemories++;
  }

  // 第 4 步：丢弃 gitContext
  if (gitContext && recompute() > available) {
    gitContext = undefined;
    report.droppedGitContext = true;
  }

  // 第 5 步：丢弃 selectedRules（按 priority 升序；无 priority 的视为 0）
  if (recompute() > available && selectedRules.length > 0) {
    const withPri = selectedRules.map((r) => ({
      rule: r,
      pri: Number((r as unknown as { priority?: number }).priority ?? 0),
    }));
    withPri.sort((a, b) => a.pri - b.pri);
    for (const { rule: r } of withPri) {
      if (recompute() <= available) break;
      selectedRules = selectedRules.filter((x) => x !== r);
      report.droppedRules++;
    }
  }

  return finalize({
    ctx: {
      ...ctx,
      memories,
      selectedRules,
      attachments: { ...att, selectedCodes, attachments, gitContext },
    },
    report: { ...report, estimatedAfter: recompute() },
  });
}

function finalize(input: { ctx: PromptBuildContext; report: TruncationReport }) {
  return input;
}

// ─────────── §8.17.2 · Token 预算感知构建 ───────────

/**
 * 根据当前 context window 使用率自动计算 system prompt 预算。
 *
 * 三档阈值：
 * - <70%：不额外裁剪
 * - 70-85%：可用 system tokens = max(5000, remaining * 0.5)
 * - 85-95%：available = max(3000, remaining * 0.3)
 * - ≥95%：available = max(2000, remaining * 0.3)，极端裁剪
 *
 * @param contextWindow Provider 上下文窗口大小
 * @param usedTokens 消息历史已用 token 数
 * @param outputReserve 输出预留 token
 * @returns TokenBudget（maxTokens=0 表示不裁剪）
 */
export function computeSystemBudgetFromUsage(
  contextWindow: number,
  usedTokens: number,
  outputReserve: number,
): TokenBudget {
  const usageRatio = usedTokens / contextWindow;

  if (usageRatio < 0.7) {
    return { maxTokens: 0 };
  }

  const remaining = contextWindow - usedTokens - outputReserve;

  if (usageRatio >= 0.95) {
    return {
      maxTokens: Math.max(2000, Math.floor(remaining * 0.3)),
      reserveForMessages: 1024,
    };
  }

  if (usageRatio >= 0.85) {
    return {
      maxTokens: Math.max(3000, Math.floor(remaining * 0.3)),
      reserveForMessages: 2048,
    };
  }

  // usageRatio >= 0.7
  return {
    maxTokens: Math.max(5000, Math.floor(remaining * 0.5)),
    reserveForMessages: 4096,
  };
}
