/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * SessionStore —— 会话持久化
 *
 * 来源：DESIGN §M16 会话恢复
 *
 * 职责：
 * - 保存最近 N 次会话（默认 20）到 workspaceState
 * - Panel 重开时读取最新一次 session → HISTORY_RESET
 * - 记录累积 cost（与 CostTracker 配合）
 *
 * 设计：
 * - 不强依赖 vscode.ExtensionContext；只接 MementoLike 抽象 → 单测无需 vscode mock
 * - 消息原样保存（Message[] + ProviderCost[]）
 * - 写入是异步的；忽略写入错误（不阻断 UI）
 */

import type { Message } from '../../providers/types.js';
import type { ProviderCost } from '../cost/tracker.js';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('session.store');

/** 兼容 vscode.Memento 的最小接口，便于单测 */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface StoredSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  messages: Message[];
  /** 本 session 的累计成本（不含全局 total） */
  sessionCost: ProviderCost[];
  /**
   * Phase 5 Phase D C2 · 关联的 plan id（docs/plans/<planId>.md）。
   * 跨 session 恢复时，若 plan 状态为 `in_progress` 则自动注入 `<approved_plan>`。
   */
  planId?: string;
}

export interface SessionStoreSnapshot {
  sessions: StoredSession[];
  /** 跨所有 session 的累积成本（SessionStore 负责 record 到此） */
  totalCost: ProviderCost[];
}

const DEFAULT_MAX_SESSIONS = 100;
const KEY_SESSIONS = 'dualMind.sessions.v1';
const KEY_TOTAL_COST = 'dualMind.totalCost.v1';

export class SessionStore {
  private readonly memento: MementoLike;
  private readonly maxSessions: number;

  constructor(memento: MementoLike, maxSessions = DEFAULT_MAX_SESSIONS) {
    this.memento = memento;
    this.maxSessions = Math.max(1, maxSessions);
  }

  listSessions(): StoredSession[] {
    const raw = this.memento.get<StoredSession[]>(KEY_SESSIONS, []);
    if (!Array.isArray(raw)) return [];
    return raw;
  }

  latestSession(): StoredSession | undefined {
    const all = this.listSessions();
    if (all.length === 0) return undefined;
    // 按 updatedAt 倒序取头
    return [...all].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  getSession(id: string): StoredSession | undefined {
    return this.listSessions().find((s) => s.id === id);
  }

  async saveSession(session: StoredSession): Promise<void> {
    const all = this.listSessions().filter((s) => s.id !== session.id);
    all.unshift(session);
    // 按 updatedAt 倒序裁剪
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    const trimmed = all.slice(0, this.maxSessions);
    try {
      await this.memento.update(KEY_SESSIONS, trimmed);
    } catch (e) {
      log.warn({ err: String(e) }, 'saveSession failed; swallow');
    }
  }

  async deleteSession(id: string): Promise<void> {
    const all = this.listSessions().filter((s) => s.id !== id);
    try {
      await this.memento.update(KEY_SESSIONS, all);
    } catch (e) {
      log.warn({ err: String(e) }, 'deleteSession failed; swallow');
    }
  }

  async clearAll(): Promise<void> {
    try {
      await this.memento.update(KEY_SESSIONS, []);
    } catch (e) {
      log.warn({ err: String(e) }, 'clearAll failed; swallow');
    }
  }

  /**
   * 追加一条消息到指定 session（不存在则忽略）。
   * DESIGN §M17.3 契约：细粒度消息级持久化。
   * MVP 语义：读-改-写（全量覆盖 workspaceState），updatedAt 刷新。
   */
  async appendMessage(sessionId: string, msg: Message): Promise<void> {
    const all = this.listSessions();
    const idx = all.findIndex((s) => s.id === sessionId);
    if (idx < 0) return;
    const target = all[idx];
    if (!target) return;
    const next: StoredSession = {
      ...target,
      messages: [...target.messages, msg],
      updatedAt: Date.now(),
    };
    all[idx] = next;
    try {
      await this.memento.update(KEY_SESSIONS, all);
    } catch (e) {
      log.warn({ err: String(e) }, 'appendMessage failed; swallow');
    }
  }

  /**
   * 标记指定 session 中某条消息为 reverted（DESIGN §M17.3）。
   * 如果 messageIndex 未提供则清空整条 session 消息 reverted 标记（MVP 用不到）。
   * 这里采用 messages[i]._reverted = true 的软删除语义。
   */
  async markReverted(sessionId: string, messageIndex: number): Promise<void> {
    const all = this.listSessions();
    const idx = all.findIndex((s) => s.id === sessionId);
    if (idx < 0) return;
    const target = all[idx];
    if (!target) return;
    if (messageIndex < 0 || messageIndex >= target.messages.length) return;
    const nextMessages = target.messages.map((m, i) =>
      i === messageIndex ? ({ ...m, _reverted: true } as Message & { _reverted: true }) : m,
    );
    const next: StoredSession = {
      ...target,
      messages: nextMessages,
      updatedAt: Date.now(),
    };
    all[idx] = next;
    try {
      await this.memento.update(KEY_SESSIONS, all);
    } catch (e) {
      log.warn({ err: String(e) }, 'markReverted failed; swallow');
    }
  }

  /**
   * 导出 session 为 Markdown 或 JSON（DESIGN §M17.6）。
   * Markdown 格式：标题 / 创建时间 / 按 turn 分段 user/assistant。
   */
  exportSession(sessionId: string, format: 'md' | 'json'): string | undefined {
    const s = this.getSession(sessionId);
    if (!s) return undefined;
    if (format === 'json') {
      return JSON.stringify(s, null, 2);
    }
    return renderSessionMarkdown(s);
  }

  /**
   * GC：保留最近 N 个 session（按 updatedAt 倒序），多余删除。
   * 返回删除的条数。
   */
  async gc(keepLast: number): Promise<number> {
    if (keepLast <= 0) return 0;
    const all = this.listSessions().sort((a, b) => b.updatedAt - a.updatedAt);
    if (all.length <= keepLast) return 0;
    const kept = all.slice(0, keepLast);
    try {
      await this.memento.update(KEY_SESSIONS, kept);
    } catch (e) {
      log.warn({ err: String(e) }, 'gc failed; swallow');
      return 0;
    }
    return all.length - kept.length;
  }

  loadTotalCost(): ProviderCost[] {
    const raw = this.memento.get<ProviderCost[]>(KEY_TOTAL_COST, []);
    return Array.isArray(raw) ? raw : [];
  }

  async saveTotalCost(costs: ProviderCost[]): Promise<void> {
    try {
      await this.memento.update(KEY_TOTAL_COST, costs);
    } catch (e) {
      log.warn({ err: String(e) }, 'saveTotalCost failed; swallow');
    }
  }

  snapshot(): SessionStoreSnapshot {
    return {
      sessions: this.listSessions(),
      totalCost: this.loadTotalCost(),
    };
  }
}

/** 从第一条 user 消息抽 title（截断 40 字） */
export function extractTitleFromMessages(messages: Message[], fallback = '新会话'): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    let text: string | undefined;
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      const first = m.content.find((p) => p.type === 'text');
      if (first && first.type === 'text') text = first.text;
    }
    if (text) {
      const oneLine = text.replace(/\s+/g, ' ').trim();
      return oneLine.length <= 40 ? oneLine : oneLine.slice(0, 40) + '…';
    }
  }
  return fallback;
}

/** 生成 session id —— 无 crypto 依赖，够随机即可 */
export function newSessionId(): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `s-${Date.now().toString(36)}-${rnd}`;
}

/**
 * Markdown 渲染器（DESIGN §M17.6）。
 * 输出：Title / Created / Updated / messages 按 role 分段；工具调用压缩为占位。
 */
export function renderSessionMarkdown(s: StoredSession): string {
  const lines: string[] = [];
  lines.push(`# Session: ${s.title}`);
  lines.push(`- ID: ${s.id}`);
  lines.push(`- Created: ${new Date(s.createdAt).toISOString()}`);
  lines.push(`- Updated: ${new Date(s.updatedAt).toISOString()}`);
  lines.push(`- Messages: ${s.messages.length}`);
  lines.push('');
  let turn = 0;
  for (const m of s.messages) {
    if (m.role === 'user') turn += 1;
    const reverted = (m as unknown as { _reverted?: boolean })._reverted ? ' _(reverted)_' : '';
    lines.push(`## ${m.role === 'user' ? `Turn ${turn} · User` : capitalize(m.role)}${reverted}`);
    lines.push('');
    lines.push(extractTextForMarkdown(m));
    lines.push('');
  }
  return lines.join('\n');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractTextForMarkdown(m: Message): string {
  // role=tool：展示 toolCallId 引用
  if (m.role === 'tool') {
    const ref = m.toolCallId ? ` (call: ${m.toolCallId})` : '';
    const body = typeof m.content === 'string' ? m.content : '';
    return `_[tool_result${ref}]_\n\n${body}`;
  }
  // assistant 带 toolCalls：压缩显示
  const toolSuffix =
    m.role === 'assistant' && m.toolCalls && m.toolCalls.length
      ? '\n\n' + m.toolCalls.map((t) => `_[tool: ${t.name}]_`).join(' ')
      : '';
  if (typeof m.content === 'string') return (m.content || '') + toolSuffix;
  if (Array.isArray(m.content)) {
    const parts: string[] = [];
    for (const p of m.content) {
      if (p.type === 'text') parts.push(p.text);
      else if (p.type === 'image_url') parts.push(`_[image]_`);
    }
    return parts.join('\n\n') + toolSuffix;
  }
  return toolSuffix;
}
