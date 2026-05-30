/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * todo_write 工具（W7e4 ·   对齐补丁）
 *
 * 职责：管理任务待办列表。Agent 写入/更新 todo 项，UI 侧栏实时展示。
 * 数据通过 workspaceState 持久化（VSCode 切换工作区自动隔离）。
 *
 * 参数：
 * - todos: TodoItem[] — 完整替换（非增量 merge），与   的 todo_write 语义一致
 *
 * 设计决策：
 * - 全量替换而非增量：Agent 通常维护完整列表，增量 API 需要更复杂的冲突处理
 * - id 由 Agent 生成（简短随机串如 'r9Tg8Kq2'）：避免扩展侧自增 ID 导致双方不一致
 * - status 枚举对齐  ：PENDING / IN_PROGRESS / COMPLETE / CANCELLED
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { TodoItem } from '../../shared/protocol.js';
import { ErrorCodes } from '../errors/index.js';

export interface TodoWriteArgs {
  todos: TodoItem[];
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'PENDING',
  'IN_PROGRESS',
  'COMPLETE',
  'CANCELLED',
]);

const parameters = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '唯一标识符（短随机串如 "r9Tg8Kq2"）' },
          content: { type: 'string', description: '任务描述（≤70 字符推荐）' },
          status: {
            type: 'string',
            enum: ['PENDING', 'IN_PROGRESS', 'COMPLETE', 'CANCELLED'],
            description: '任务状态',
          },
        },
        required: ['id', 'content', 'status'],
        additionalProperties: false,
      },
      description: '完整的 todo 列表（全量替换，非增量 merge）。',
    },
  },
  required: ['todos'],
  additionalProperties: false,
} as const;

export interface TodoWriteDeps {
  /** 读取当前 todo 列表 */
  getTodos(): TodoItem[];
  /** 写入完整 todo 列表 + 通知 webview */
  setTodos(todos: TodoItem[]): void;
}

export class TodoWriteTool implements ITool<TodoWriteArgs, ToolResult> {
  readonly name = 'todo_write';
  readonly description =
    '管理任务待办列表。传入完整列表（全量替换），UI 侧栏实时展示。典型用法：任务开始时拆解步骤，逐步更新状态。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'workspace_write';

  constructor(private readonly deps: TodoWriteDeps) {}

  async execute(args: TodoWriteArgs, ctx: ToolContext): Promise<ToolResult> {
    const validationErr = validateArgs(args);
    if (validationErr) return fail(ErrorCodes.TOOL_ARGS_INVALID, validationErr);

    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    const prev = this.deps.getTodos();
    this.deps.setTodos(args.todos);

    // 生成简短 diff 摘要
    const diff = diffSummary(prev, args.todos);
    return ok(`Todo list updated (${diff}).\n`, {
      count: args.todos.length,
      diff,
      todos: args.todos,
    });
  }
}

// ─────────── helpers ───────────

export function validateArgs(args: TodoWriteArgs | undefined): string | undefined {
  if (!args || !Array.isArray(args.todos)) return 'todos 必须是数组';
  for (let i = 0; i < args.todos.length; i++) {
    const t = args.todos[i];
    if (!t || typeof t !== 'object') return `todos[${i}] 必须是对象`;
    if (typeof t.id !== 'string' || !t.id.trim()) return `todos[${i}].id 不能为空`;
    if (typeof t.content !== 'string' || !t.content.trim()) return `todos[${i}].content 不能为空`;
    if (!VALID_STATUSES.has(t.status)) {
      return `todos[${i}].status 必须是 PENDING/IN_PROGRESS/COMPLETE/CANCELLED 之一`;
    }
  }
  // id 唯一性
  const ids = new Set<string>();
  for (const t of args.todos) {
    if (ids.has(t.id)) return `todos 有重复 id: "${t.id}"`;
    ids.add(t.id);
  }
  return undefined;
}

export function diffSummary(prev: TodoItem[], next: TodoItem[]): string {
  const prevMap = new Map(prev.map((t) => [t.id, t]));
  const nextMap = new Map(next.map((t) => [t.id, t]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;

  for (const t of next) {
    const p = prevMap.get(t.id);
    if (!p) added++;
    else if (p.status !== t.status || p.content !== t.content) changed++;
    else unchanged++;
  }
  for (const t of prev) {
    if (!nextMap.has(t.id)) removed++;
  }

  const parts: string[] = [];
  if (added) parts.push(`+${added}`);
  if (removed) parts.push(`-${removed}`);
  if (changed) parts.push(`~${changed}`);
  if (unchanged && parts.length === 0) parts.push(`${unchanged} unchanged`);
  return parts.join(', ') || 'empty';
}

function ok(content: string, display?: Record<string, unknown>): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}) };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
