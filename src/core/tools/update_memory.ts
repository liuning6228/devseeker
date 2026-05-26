/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * update_memory 工具（W4 批次 2）
 *
 * 职责：创建 / 更新 / 删除记忆
 *
 * 参数：
 * - action: 'create' | 'update' | 'delete'
 * - id: 更新 / 删除时必填
 * - title / content: 创建时必填；更新时可选
 * - category: 创建时必填；更新时可选（必须为可写类别）
 * - keywords: 创建时必填；更新时可选
 * - scope: 可选，默认 'workspace'
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { MemoryStore, MemoryAction, MemoryScope, MemoryRecord } from '../memory/index.js';
import { ErrorCodes, AgentError } from '../errors/index.js';

export interface UpdateMemoryArgs {
  action: MemoryAction;
  id?: string;
  title?: string;
  content?: string;
  category?: string;
  keywords?: string | string[];
  scope?: MemoryScope;
}

const parameters = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'update', 'delete'],
      description: '操作类型：create / update / delete。',
    },
    id: {
      type: 'string',
      description: 'update / delete 时必填的记忆 id（来自 search_memory 或 overview）。',
    },
    title: {
      type: 'string',
      description: '简短标题。create 必填；update 可选。',
    },
    content: {
      type: 'string',
      description: '详细内容。create 必填；update 可选。',
    },
    category: {
      type: 'string',
      description: '记忆分类（必须是 22 个可写类别之一）。create 必填；update 可选。',
    },
    keywords: {
      type: 'string',
      description: '逗号分隔的关键词，用于后续 shallow 检索。示例："w1,mvp,deepseek"。',
    },
    scope: {
      type: 'string',
      enum: ['workspace', 'global'],
      description: '作用域：workspace（随项目）/ global（跨项目）。默认 workspace。',
    },
  },
  required: ['action'],
  additionalProperties: false,
} as const;

export interface UpdateMemoryDeps {
  getStore(): MemoryStore | undefined;
}

export class UpdateMemoryTool implements ITool<UpdateMemoryArgs, ToolResult> {
  readonly name = 'update_memory';
  readonly description =
    '管理用户 / 项目 / 开发规范 / 经验类记忆。支持 create / update / delete。类别必须是 22 个可写类别之一，系统沉淀类别不允许写入。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'workspace_write';

  constructor(private readonly deps: UpdateMemoryDeps) {}

  async execute(args: UpdateMemoryArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || (args.action !== 'create' && args.action !== 'update' && args.action !== 'delete')) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'action 必须是 create / update / delete');
    }
    const store = this.deps.getStore();
    if (!store) {
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, '记忆存储未就绪（未打开工作区？）');
    }
    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    try {
      switch (args.action) {
        case 'create': {
          const rec = await store.create({
            title: args.title ?? '',
            content: args.content ?? '',
            category: args.category ?? '',
            keywords: normalizeKw(args.keywords),
            scope: args.scope,
          });
          return ok(formatRecord('Created', rec), {
            action: 'create',
            id: rec.id,
            scope: rec.scope,
          });
        }
        case 'update': {
          if (!args.id) {
            return fail(ErrorCodes.TOOL_ARGS_INVALID, 'update 操作必须提供 id');
          }
          const patch: {
            title?: string;
            content?: string;
            category?: string;
            keywords?: string[];
          } = {};
          if (args.title !== undefined) patch.title = args.title;
          if (args.content !== undefined) patch.content = args.content;
          if (args.category !== undefined) patch.category = args.category;
          if (args.keywords !== undefined) patch.keywords = normalizeKw(args.keywords);
          const rec = await store.update(args.id, patch);
          return ok(formatRecord('Updated', rec), {
            action: 'update',
            id: rec.id,
          });
        }
        case 'delete': {
          if (!args.id) {
            return fail(ErrorCodes.TOOL_ARGS_INVALID, 'delete 操作必须提供 id');
          }
          await store.remove(args.id);
          return ok(`Deleted memory ${args.id}\n`, { action: 'delete', id: args.id });
        }
      }
    } catch (e) {
      if (e instanceof AgentError) return fail(e.code, e.message);
      const err = e as { code?: string; message?: string };
      return fail(ErrorCodes.TOOL_EXEC_FAILED, err.message ?? String(e));
    }
  }
}

// ─────────── helpers ───────────

export function normalizeKw(input: string | string[] | undefined): string[] {
  if (Array.isArray(input)) return input.map((s) => String(s));
  if (typeof input !== 'string') return [];
  return input.split(/[,，]+/).map((s) => s.trim()).filter(Boolean);
}

function formatRecord(prefix: string, r: MemoryRecord): string {
  const lines = [
    `${prefix} memory ${r.id}`,
    `  title: ${r.title}`,
    `  category: ${r.category}`,
    `  scope: ${r.scope}`,
    `  keywords: ${r.keywords.join(', ')}`,
  ];
  return lines.join('\n') + '\n';
}

function ok(content: string, display?: Record<string, unknown>): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}) };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
