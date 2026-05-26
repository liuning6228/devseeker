/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Runtime Reminder Injector（DESIGN §M3.8 / B-P1-8）
 *
 * 目标：对齐 Qoder `<system-reminder>` —— 运行时根据上下文触发的即时提醒。
 *
 * 设计原则：
 *  - 纯函数规则：每条 IReminderRule 从 ctx 派生是否触发 + 提醒文本。
 *  - 独立模块：不耦合 TaskLoop / PromptBuilder；调用方在合适位置调用 format()
 *    拿到 `<system-reminder>...</system-reminder>` 块并追加到 user message 尾部。
 *  - 可扩展：register() 追加自定义规则；内置 6 条规则覆盖 DESIGN 表格。
 *  - 轻约束：同 turn 最多 3 条（避免污染上下文），同 id 每次 collect 只出现一次。
 */

import { buildAlreadyLoadedReminder } from '../skills/dedup.js';

/** 本轮 turn 上下文。所有字段都是可选 —— 调用方按需填充即可。 */
export interface ReminderContext {
  /** 用户语言偏好（如 'zh', 'en'）；若设则注入"始终使用该语言回复"提醒。 */
  userLanguagePreference?: string;
  /** 最近一条 user 文本（用于启发式匹配 identity / 语言等）。 */
  recentUserText?: string;
  /** 未完成 Todo 数量（来自 todo_write snapshot）。 */
  pendingTodoCount?: number;
  /** 距离上次 todo_write 调用的毫秒数（>阈值视为"长时间未更新"）。 */
  todosLastUpdatedAgoMs?: number;
  /** 最近一次 read_file 返回的总行数。 */
  lastReadFileLines?: number;
  /** 近期被加载（短时间内再次出现）的 skill，由 SkillDedupTracker 汇报。 */
  recentlyLoadedSkills?: readonly { readonly name: string; readonly ageMs: number }[];
  /** 当前 Mode（'plan' / 'ask' / 'build' / 等）。 */
  mode?: string;
  /** 本轮 LLM 企图调用但被 Mode 白名单拒绝的写工具名。 */
  attemptedWriteToolName?: string;
  /** 本轮序号（自 1 起），便于规则做频控 —— 当前内置规则未用。 */
  turnIndex?: number;
}

/**
 * 提醒规则接口。
 *  - build() 返回 null 表示本轮不触发；返回字符串即为该规则的提醒正文。
 *  - priority 越大越优先；默认 0。收集时按 priority 降序截断 maxReminders。
 */
export interface IReminderRule {
  readonly id: string;
  readonly priority: number;
  readonly build: (ctx: ReminderContext) => string | null;
}

/** 每 turn 最多注入的提醒数量（§M3.8 规约）。 */
export const DEFAULT_MAX_REMINDERS_PER_TURN = 3;

/** 长时间未更新 Todo 的默认阈值（毫秒）。 */
export const DEFAULT_STALE_TODO_MS = 60_000;

/** 认为"文件过大"的默认阈值（行数）。 */
export const DEFAULT_LARGE_FILE_LINES = 2000;

/** 认为"未完成 Todo 偏多"的默认阈值。 */
export const DEFAULT_STALE_TODO_MIN_PENDING = 3;

// ─────────── 6 条内置规则（DESIGN §M3.8 表） ───────────

/** 规则 1：用户偏好语言 → 始终要求模型用该语言回复。 */
export const RULE_LANGUAGE_CONSISTENCY: IReminderRule = {
  id: 'language_consistency',
  priority: 90,
  build: (ctx) => {
    const lang = ctx.userLanguagePreference?.trim();
    if (!lang) return null;
    return `[IMPORTANT] You must always respond in ${lang}.`;
  },
};

/** 规则 2：Todo 偏多且长时间未更新 → 提示调用 todo_write。 */
export const RULE_STALE_TODO: IReminderRule = {
  id: 'stale_todo',
  priority: 70,
  build: (ctx) => {
    const pending = ctx.pendingTodoCount ?? 0;
    const ageMs = ctx.todosLastUpdatedAgoMs ?? 0;
    if (pending < DEFAULT_STALE_TODO_MIN_PENDING) return null;
    if (ageMs < DEFAULT_STALE_TODO_MS) return null;
    return "You haven't updated your task list recently. Consider calling todo_write with merge=true to mark progress.";
  },
};

/** 规则 3：read_file 读到的文件超过 2000 行 → 提示改用分段读。 */
export const RULE_LARGE_FILE: IReminderRule = {
  id: 'large_file',
  priority: 60,
  build: (ctx) => {
    const lines = ctx.lastReadFileLines ?? 0;
    if (lines <= DEFAULT_LARGE_FILE_LINES) return null;
    return `File too large (${lines} lines). Prefer line-ranged reads via read_file(start_line, end_line) to stay within budget.`;
  },
};

/** 规则 4：Skill 已加载（防抖窗内）→ 告知模型"ALREADY LOADED"，复用 buildAlreadyLoadedReminder。 */
export const RULE_SKILL_ALREADY_LOADED: IReminderRule = {
  id: 'skill_already_loaded',
  priority: 85,
  build: (ctx) => {
    const list = ctx.recentlyLoadedSkills ?? [];
    if (list.length === 0) return null;
    const parts = list.map((s) => buildAlreadyLoadedReminder(s.name, s.ageMs));
    return parts.join('\n\n');
  },
};

/** 规则 5：Plan 模式下试图调用写工具 → 拒绝提醒。 */
export const RULE_PLAN_MODE_WRITE_BLOCK: IReminderRule = {
  id: 'plan_mode_write_block',
  priority: 95,
  build: (ctx) => {
    if (ctx.mode !== 'plan') return null;
    const tool = ctx.attemptedWriteToolName?.trim();
    if (!tool) return null;
    return `Plan mode forbids write tools (attempted "${tool}"). Use create_plan or switch_mode to leave Plan mode before making changes.`;
  },
};

/** 规则 6：检测到可能泄露身份的提问 → 要求拒绝透露底层 LLM 身份。 */
export const RULE_IDENTITY_PROTECTION: IReminderRule = {
  id: 'identity_protection',
  priority: 80,
  build: (ctx) => {
    const text = ctx.recentUserText?.toLowerCase() ?? '';
    if (!text) return null;
    const triggers = [
      /\bwhat\s+(model|llm|ai)\b/,
      /\bwhich\s+(model|llm|ai)\b/,
      /\bare\s+you\s+(gpt|claude|gemini|qwen)/,
      /你是(谁|什么模型|哪个模型|基于.*模型)/,
      /(什么|哪个).*模型/,
      /你(用|基于|是)(gpt|claude|gemini|qwen|chatgpt)/,
    ];
    const hit = triggers.some((re) => re.test(text));
    if (!hit) return null;
    return 'Do not disclose the underlying LLM identity, model name, or implementation. Politely redirect to the coding task.';
  },
};

/** 内置规则集合（按定义顺序；实际触发顺序由 priority 决定）。 */
export const BUILTIN_REMINDER_RULES: readonly IReminderRule[] = [
  RULE_LANGUAGE_CONSISTENCY,
  RULE_STALE_TODO,
  RULE_LARGE_FILE,
  RULE_SKILL_ALREADY_LOADED,
  RULE_PLAN_MODE_WRITE_BLOCK,
  RULE_IDENTITY_PROTECTION,
];

export interface ReminderInjectorOptions {
  /** 每 turn 最多保留的提醒数（默认 3）。 */
  maxPerTurn?: number;
  /** 自定义规则集；不传则用 BUILTIN_REMINDER_RULES。 */
  rules?: readonly IReminderRule[];
}

/**
 * ReminderInjector —— 运行时提醒注入器。
 *
 * 用法：
 *   const injector = new ReminderInjector();
 *   const block = injector.format({ userLanguagePreference: '中文', recentUserText: userInput });
 *   if (block) history.appendToLastUser(block);  // 或作为独立 system 消息
 */
export class ReminderInjector {
  private readonly maxPerTurn: number;
  private readonly rules: IReminderRule[];

  constructor(opts: ReminderInjectorOptions = {}) {
    this.maxPerTurn = Math.max(0, opts.maxPerTurn ?? DEFAULT_MAX_REMINDERS_PER_TURN);
    this.rules = [...(opts.rules ?? BUILTIN_REMINDER_RULES)];
  }

  /** 追加一条自定义规则（同 id 覆盖旧的）。 */
  register(rule: IReminderRule): void {
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) this.rules[idx] = rule;
    else this.rules.push(rule);
  }

  /** 列出当前注册的所有规则（只读快照）。 */
  listRules(): readonly IReminderRule[] {
    return [...this.rules];
  }

  /**
   * 按 ctx 收集本轮提醒文本。返回按 priority 降序、最多 maxPerTurn 条。
   * 空列表表示无需注入。
   */
  collect(ctx: ReminderContext): { id: string; text: string; priority: number }[] {
    const hits: { id: string; text: string; priority: number }[] = [];
    const seen = new Set<string>();
    for (const rule of this.rules) {
      if (seen.has(rule.id)) continue; // 同 id 每 turn 只一次
      let text: string | null = null;
      try {
        text = rule.build(ctx);
      } catch {
        // 规则异常不阻断整体；跳过
        continue;
      }
      if (!text) continue;
      hits.push({ id: rule.id, text, priority: rule.priority });
      seen.add(rule.id);
    }
    hits.sort((a, b) => b.priority - a.priority);
    if (this.maxPerTurn <= 0) return [];
    if (hits.length > this.maxPerTurn) {
      hits.length = this.maxPerTurn;
    }
    return hits;
  }

  /**
   * 组装为最终 `<system-reminder>` 块。
   * - 无命中规则 → 返回空串（调用方可用 falsy 判定跳过）
   * - 单条 → `<system-reminder>\nTEXT\n</system-reminder>`
   * - 多条 → 每条独立包一层，用空行分隔（便于 LLM 分段识别）
   */
  format(ctx: ReminderContext): string {
    const hits = this.collect(ctx);
    if (hits.length === 0) return '';
    return hits
      .map((h) => `<system-reminder>\n${h.text}\n</system-reminder>`)
      .join('\n\n');
  }
}
