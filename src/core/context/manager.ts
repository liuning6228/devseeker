/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Context 管理器（W8.1 + W8.2）
 *
 * 职责：
 * 1. 滑动窗口三阶段压缩：轻度（截断 tool_result）→ 中度（摘要旧轮次）→ 重度（丢弃旧轮次）
 * 2. Token 预算动态分配：system 15% + 最近 N 轮 40% + 其余历史 45%
 *
 * 设计决策：
 * - 精确 token 计数需要 tokenizer（tiktoken），MVP 用字符估算（1 token ≈ 4 chars for English / 2 chars for CJK）
 * - 后续可替换为精确计数器
 * - 压缩策略渐进触发：token 用量 70% → 轻度 → 85% → 中度 → 95% → 重度
 */

import type { Message, ToolCall } from '../../providers/types.js';

// ─────────── 配置 ───────────

export interface ContextManagerOptions {
  /** 模型上下文窗口大小（从 provider.contextWindow 取） */
  contextWindow: number;
  /** 输出 token 预留（provider maxTokens，默认 4096） */
  outputReserve: number;
  /** system prompt 预算占比（默认 0.15） */
  systemBudgetRatio: number;
  /** 最近 N 轮不压缩（默认 2） */
  protectedTurns: number;
  /** 字符→token 估算系数（默认 3.5，介于英文 4 和中文 2 之间） */
  charsPerToken: number;
}

const DEFAULT_OPTS: ContextManagerOptions = {
  contextWindow: 1_000_000, // 默认对齐 DeepSeek V4 的 1M 上下文
  outputReserve: 16384, // 大上下文模型需要更多输出预留（原 4096 对长输出场景偏小）
  systemBudgetRatio: 0.15,
  protectedTurns: 2,
  charsPerToken: 3.5,
};

// ─────────── Token 估算 ───────────

/**
 * 估算消息的 token 数。
 * MVP 用字符数 / charsPerToken；后续替换为 tiktoken。
 */
export function estimateTokens(messages: readonly Message[], charsPerToken = 3.5): number {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += 4; // role + formatting overhead
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') totalChars += part.text.length;
        else if (part.type === 'image_url') totalChars += 85; // low-detail image ≈ 85 tokens
      }
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        totalChars += (tc.name?.length ?? 0) + (tc.argsRaw?.length ?? 0) + 8;
      }
    }
    if (msg.reasoningContent) totalChars += msg.reasoningContent.length;
  }
  return Math.ceil(totalChars / charsPerToken);
}

// ─────────── 消息轮次分组 ───────────

interface MessageTurn {
  /** 该轮起始索引（messages 数组中） */
  startIdx: number;
  /** 该轮消息数（user + assistant + 关联 tool_results） */
  count: number;
  /** 估算 token 数 */
  tokens: number;
}

/**
 * 将消息列表按轮次分组。
 * 规则：每遇到一条 user 消息，开始新一轮。
 * system 消息不计入任何轮次。
 */
export function groupTurns(messages: readonly Message[], charsPerToken = 3.5): MessageTurn[] {
  const turns: MessageTurn[] = [];
  let currentTurn: MessageTurn | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      // 新轮次开始
      if (currentTurn) turns.push(currentTurn);
      currentTurn = { startIdx: i, count: 1, tokens: 0 };
    } else if (currentTurn) {
      currentTurn.count++;
    } else {
      // 没有 user 前导的 assistant/tool（session 恢复等），也算一轮
      currentTurn = { startIdx: i, count: 1, tokens: 0 };
    }
  }
  if (currentTurn) turns.push(currentTurn);

  // 估算每轮 token
  for (const turn of turns) {
    const slice = messages.slice(turn.startIdx, turn.startIdx + turn.count);
    turn.tokens = estimateTokens(slice);
  }

  return turns;
}

// ─────────── 三阶段压缩 ───────────

export type CompressionLevel = 'none' | 'light' | 'medium' | 'heavy';

/**
 * 根据使用率决定压缩级别。
 * - < 70%: none
 * - 70-85%: light（截断长 tool_result）
 * - 85-95%: medium（摘要旧轮次）
 * - > 95%: heavy（丢弃最旧轮次）
 */
export function decideCompression(usageRatio: number): CompressionLevel {
  if (usageRatio < 0.70) return 'none';
  if (usageRatio < 0.85) return 'light';
  if (usageRatio < 0.95) return 'medium';
  return 'heavy';
}

/** 轻度：截断超长 tool_result（保留首尾摘要） */
function applyLightCompression(messages: Message[], maxToolResultChars = 2000): Message[] {
  return messages.map((msg) => {
    if (msg.role !== 'tool' || typeof msg.content !== 'string') return msg;
    if (msg.content.length <= maxToolResultChars) return msg;
    const head = msg.content.slice(0, maxToolResultChars * 0.6);
    const tail = msg.content.slice(-maxToolResultChars * 0.3);
    const truncated = `${head}\n\n... [truncated ${msg.content.length - maxToolResultChars} chars] ...\n\n${tail}`;
    return { ...msg, content: truncated };
  });
}

/** 中度：把旧轮次摘要为一条 summary assistant 消息 */
function applyMediumCompression(
  messages: Message[],
  turns: MessageTurn[],
  protectedCount: number,
): Message[] {
  if (turns.length <= protectedCount) return messages;

  const result: Message[] = [];
  // 保留 system
  let sysEnd = 0;
  if (messages[0]?.role === 'system') {
    result.push(messages[0]);
    sysEnd = 1;
  }

  // 摘要的旧轮次范围
  const oldTurnCount = turns.length - protectedCount;
  const oldEndIdx = turns[oldTurnCount - 1].startIdx + turns[oldTurnCount - 1].count;

  // 生成摘要
  const summaryParts: string[] = ['[Context Summary - earlier conversation compressed]'];
  for (let i = 0; i < oldTurnCount; i++) {
    const turn = turns[i];
    const slice = messages.slice(turn.startIdx, turn.startIdx + turn.count);
    for (const m of slice) {
      if (m.role === 'user') {
        const text = typeof m.content === 'string' ? m.content.slice(0, 100) : '[image]';
        summaryParts.push(`User: ${text}${m.content && typeof m.content === 'string' && m.content.length > 100 ? '...' : ''}`);
      } else if (m.role === 'assistant') {
        const text = (typeof m.content === 'string' ? m.content : '').slice(0, 100);
        if (text) summaryParts.push(`Assistant: ${text}${text.length >= 100 ? '...' : ''}`);
        if (m.toolCalls?.length) {
          summaryParts.push(`  Tools: ${m.toolCalls.map((tc) => tc.name).join(', ')}`);
        }
      } else if (m.role === 'tool') {
        const text = (typeof m.content === 'string' ? m.content : '').slice(0, 80);
        summaryParts.push(`  [${m.name ?? 'tool'}]: ${text}${text.length >= 80 ? '...' : ''}`);
      }
    }
  }

  result.push({ role: 'assistant', content: summaryParts.join('\n') });
  result.push({ role: 'user', content: '[Continue from above summary]' });

  // 保留受保护的最近轮次
  for (let i = oldEndIdx; i < messages.length; i++) {
    result.push(messages[i]);
  }

  return result;
}

/** 重度：丢弃最旧轮次，仅保留受保护的最近轮次 */
function applyHeavyCompression(
  messages: Message[],
  turns: MessageTurn[],
  protectedCount: number,
): Message[] {
  if (turns.length <= protectedCount) return messages;

  const result: Message[] = [];
  // 保留 system
  if (messages[0]?.role === 'system') result.push(messages[0]);

  // 仅保留最近 protectedCount 轮
  const keptTurnStart = turns[turns.length - protectedCount].startIdx;
  for (let i = keptTurnStart; i < messages.length; i++) {
    result.push(messages[i]);
  }

  return result;
}

// ─────────── 主入口 ───────────

export interface CompressResult {
  messages: Message[];
  level: CompressionLevel;
  originalTokens: number;
  compressedTokens: number;
  savingsPercent: number;
}

export class ContextManager {
  private readonly opts: ContextManagerOptions;

  constructor(opts: Partial<ContextManagerOptions> = {}) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  /** 输入 token 预算 = contextWindow - outputReserve */
  get inputBudget(): number {
    return this.opts.contextWindow - this.opts.outputReserve;
  }

  /** system prompt 预算 */
  get systemBudget(): number {
    return Math.floor(this.inputBudget * this.opts.systemBudgetRatio);
  }

  /** 历史预算（含 tool_results） */
  get historyBudget(): number {
    return this.inputBudget - this.systemBudget;
  }

  /**
   * 对消息列表执行滑动窗口压缩。
   * @param messages 待压缩的消息列表
   * @param forceLevel 强制使用的压缩级别（用于 context_overflow 恢复等场景）。
   *                   不传时根据使用率自动选择。
   * @returns 压缩后的消息 + 元数据
   */
  compress(messages: readonly Message[], forceLevel?: CompressionLevel): CompressResult {
    const mutable = messages.map((m) => ({ ...m }));
    const originalTokens = estimateTokens(mutable, this.opts.charsPerToken);
    const usageRatio = originalTokens / this.inputBudget;

    let level = forceLevel ?? decideCompression(usageRatio);
    let result = mutable;

    // 渐进压缩：light → medium → heavy，直到 token 在预算内
    const maxAttempts = forceLevel ? 1 : 3; // 强制压缩时只执行一次（跳过渐进升级）
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (level === 'none') break;

    const turns = groupTurns(result, this.opts.charsPerToken);

      switch (level) {
        case 'light':
          result = applyLightCompression(result);
          break;
        case 'medium':
          result = applyMediumCompression(result, turns, this.opts.protectedTurns);
          break;
        case 'heavy':
          result = applyHeavyCompression(result, turns, this.opts.protectedTurns);
          break;
      }

      const newTokens = estimateTokens(result, this.opts.charsPerToken);
      const newRatio = newTokens / this.inputBudget;

      // 如果还在超限，升级压缩级别
      const nextLevel = decideCompression(newRatio);
      if (nextLevel === level || nextLevel === 'none') break;
      level = nextLevel;
    }

    const compressedTokens = estimateTokens(result, this.opts.charsPerToken);
    const savingsPercent = originalTokens > 0
      ? Math.round(((originalTokens - compressedTokens) / originalTokens) * 100)
      : 0;

    return {
      messages: result,
      level,
      originalTokens,
      compressedTokens,
      savingsPercent,
    };
  }

  /**
   * 为 Provider createMessage 计算 maxTokens。
   * 逻辑：contextWindow - (历史 token 数) - 安全余量
   */
  computeMaxTokens(currentHistoryTokens: number): number {
    const remaining = this.opts.contextWindow - currentHistoryTokens - 500; // 500 安全余量
    return Math.max(Math.min(remaining, this.opts.outputReserve), 256);
  }
}

// ─────────── §8.14 · LLM 语义摘要压缩 ───────────

/**
 * 将一条消息截断为单行摘要文本（用于构建摘要 prompt）。
 */
export function summarizeForPrompt(msg: Message): string {
  if (msg.role === 'user') {
    const text = typeof msg.content === 'string' ? msg.content : '[image]';
    return text.slice(0, 200);
  }
  if (msg.role === 'assistant') {
    const parts: string[] = [];
    if (msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        parts.push(`tool_call:${tc.name}`);
      }
    }
    const text = typeof msg.content === 'string' ? msg.content.slice(0, 100) : '';
    if (text) parts.push(text);
    return parts.join(' | ') || '[empty assistant]';
  }
  if (msg.role === 'tool') {
    const text = typeof msg.content === 'string' ? msg.content.slice(0, 100) : '';
    return `[${msg.name ?? 'tool'}]: ${text}`;
  }
  return '';
}

/** 构建摘要 prompt */
export function buildCompactionPrompt(messagesToCompact: Message[]): string {
  const lines: string[] = [
    '请对以下对话轮次做语义摘要。',
    '用 <compacted_turns> XML 格式输出。',
    '每个 <turn> 只需一句话描述关键动作和结果。',
    '保留：工具调用名/文件路径/关键输出；丢弃：逐行diff/完整堆栈/大段内容。',
    '',
    '--- messages to compact ---',
  ];
  for (let i = 0; i < messagesToCompact.length; i++) {
    const m = messagesToCompact[i]!;
    lines.push(`[${i}] role=${m.role} ${summarizeForPrompt(m)}`);
  }
  return lines.join('\n');
}

/** 从 LLM 返回的文本中提取 <compacted_turns> XML 块 */
export function extractCompactedXml(text: string): string | null {
  const match = text.match(/<compacted_turns[\s\S]*?<\/compacted_turns>/);
  return match ? match[0] : null;
}

/** 用语义摘要替换旧轮次 */
export function replaceWithSummary(
  messages: Message[],
  oldEndIdx: number,
  summaryXml: string,
): Message[] {
  const result: Message[] = [];
  // 保留 system（第一条）
  if (messages[0]?.role === 'system') result.push(messages[0]);
  // 注入摘要消息
  result.push({
    role: 'assistant',
    content: summaryXml,
    _compacted: true,
  });
  // 保留 protected 轮次 + 后续消息
  for (let i = oldEndIdx; i < messages.length; i++) {
    result.push(messages[i]);
  }
  return result;
}

/** 估算被压缩轮次的原始 token 数（用于 cost 校验） */
export function estimateCompactCost(compactableMessages: Message[]): number {
  return estimateTokens(compactableMessages) * 0.2;
}

export interface CompactWithSummaryOptions {
  messages: Message[];
  turns: MessageTurn[];
  compactableTurnCount: number;
  protectedCount: number;
  provider: {
    createMessage: (opts: {
      messages: Message[];
      signal?: AbortSignal;
    }) => AsyncIterable<{ type: string; text?: string; content?: string }>;
  };
  signal?: AbortSignal;
}

/**
 * 用 LLM 回环调用做语义摘要（§8.14）。
 * 成功返回压缩后的消息数组；失败返回 null（回退机械压缩）。
 */
export async function compactWithSummary(
  opts: CompactWithSummaryOptions,
): Promise<Message[] | null> {
  const { messages, turns, compactableTurnCount, protectedCount, provider, signal } = opts;
  if (compactableTurnCount <= 0) return null;

  // 被压缩的原始消息结束索引
  const oldEndIdx = turns[compactableTurnCount - 1].startIdx + turns[compactableTurnCount - 1].count;

  // 提取待压缩的消息
  const sysOffset = messages[0]?.role === 'system' ? 1 : 0;
  const toCompact = messages.slice(sysOffset, oldEndIdx);
  if (toCompact.length === 0) return null;

  // 构建摘要 prompt
  const compactionPrompt = buildCompactionPrompt(toCompact);
  const summaryMessages: Message[] = [
    { role: 'user', content: compactionPrompt },
  ];

  // 回环调用 LLM（超时 10s）
  let summaryXml: string | null = null;
  try {
    const timeoutSignal = AbortSignal.timeout(10_000);
    const combinedSignal = signal
      ? combineAbortSignals(signal, timeoutSignal)
      : timeoutSignal;

    let fullResponse = '';
    for await (const ev of provider.createMessage({
      messages: summaryMessages,
      signal: combinedSignal,
    })) {
      if (ev.type === 'text_delta' && ev.text) {
        fullResponse += ev.text;
      }
    }
    summaryXml = extractCompactedXml(fullResponse);
  } catch {
    // 超时/异常 → 回退机械压缩
    return null;
  }

  if (!summaryXml) return null;

  // 替换消息
  return replaceWithSummary(messages, oldEndIdx, summaryXml);
}

/** 合并两个 AbortSignal（polyfill for environments without AbortSignal.any） */
function combineAbortSignals(s1: AbortSignal, s2: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  s1.addEventListener('abort', onAbort);
  s2.addEventListener('abort', onAbort);
  if (s1.aborted) controller.abort();
  if (s2.aborted) controller.abort();
  return controller.signal;
}
