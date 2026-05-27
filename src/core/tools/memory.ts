/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * memory 工具（Phase 5 Phase B Step 5）
 *
 * 替代 `update_memory`。`action='add'|'replace'|'remove'`，`target='memory'|'user'`。
 * `replace` 用子串 `old_text` 匹配。
 * 两套工具同时注册，`update_memory` 标记 `@deprecated`。
 *
 * DESIGN-1.md §4.3 · ROADMAP.md 方案三 Phase B Step 5
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { MemoryStore } from '../memory/store.js';
import { ErrorCodes } from '../errors/index.js';

export interface MemoryArgs {
  action: 'add' | 'replace' | 'remove';
  target: 'memory' | 'user';
  /** add/replace 必填 */
  content?: string;
  /** replace 用来匹配旧条目；remove 按 id 或子串 */
  old_text?: string;
}

export interface MemoryToolDeps {
  getStore: () => MemoryStore | undefined;
}

const parameters = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['add', 'replace', 'remove'] },
    target: { type: 'string', enum: ['memory', 'user'] },
    content: { type: 'string', description: 'add/replace 必填' },
    old_text: { type: 'string', description: 'replace/remove 必填，子串匹配。多匹配时拒绝。' },
  },
  required: ['action', 'target'],
  additionalProperties: false,
} as const;

export class MemoryTool implements ITool<MemoryArgs, ToolResult> {
  readonly name = 'memory';
  readonly description =
    'Manage memory entries (add/replace/remove). Replaces deprecated update_memory. Use memory_search to retrieve.';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'workspace_write';

  constructor(private readonly deps: MemoryToolDeps) {}

  async execute(args: MemoryArgs, _ctx: ToolContext): Promise<ToolResult> {
    const store = this.deps.getStore();
    if (!store) {
      return { ok: false, content: 'Error: MemoryStore 不可用', errorCode: ErrorCodes.TOOL_EXEC_FAILED };
    }

    if (args.action === 'add') {
      if (!args.content || !args.content.trim()) {
        return { ok: false, content: 'Error: add 操作需要 content', errorCode: ErrorCodes.TOOL_ARGS_INVALID };
      }
      try {
        const rec = await store.create({
          title: args.content.slice(0, 60),
          content: args.content,
          category: args.target === 'user' ? 'user_info' : 'project_rule',
          keywords: ['memory_added'],
          scope: 'workspace',
        });
        return { ok: true, content: `✅ 已添加记忆 [${rec.id}]` };
      } catch (e) {
        return { ok: false, content: `Error: 添加失败 - ${(e as Error).message}`, errorCode: ErrorCodes.TOOL_EXEC_FAILED };
      }
    }

    if (args.action === 'remove') {
      if (!args.old_text) {
        return { ok: false, content: 'Error: remove 需要 old_text（子串或 id）', errorCode: ErrorCodes.TOOL_ARGS_INVALID };
      }
      // 先按 id 精确匹配
      try {
        const byId = await store.getById(args.old_text);
        if (byId) {
          await store.remove(args.old_text);
          return { ok: true, content: `✅ 已删除记忆 [${args.old_text}]` };
        }
      } catch {
        // 非 id，继续子串匹配
      }

      // 子串匹配
      const all = await store.list();
      const matches = all.filter((r) => r.content.includes(args.old_text!));
      if (matches.length === 0) {
        return { ok: false, content: `Error: 未找到包含 "${args.old_text}" 的记忆`, errorCode: ErrorCodes.TOOL_ARGS_INVALID };
      }
      if (matches.length > 1) {
        const ids = matches.map((m) => `  - [${m.id}] ${m.title}`).join('\n');
        return { ok: false, content: `Error: 子串 "${args.old_text}" 匹配多个条目：\n${ids}\n请使用更精确的文本或 id 重试`, errorCode: ErrorCodes.TOOL_ARGS_INVALID };
      }
      await store.remove(matches[0].id);
      return { ok: true, content: `✅ 已删除匹配 "${args.old_text}" 的记忆 [${matches[0].id}]` };
    }

    if (args.action === 'replace') {
      if (!args.old_text || !args.content) {
        return { ok: false, content: 'Error: replace 需要 old_text 和 content', errorCode: ErrorCodes.TOOL_ARGS_INVALID };
      }
      const all = await store.list();
      const matches = all.filter((r) => r.content.includes(args.old_text!));
      if (matches.length === 0) {
        return { ok: false, content: `Error: 未找到包含 "${args.old_text}" 的记忆`, errorCode: ErrorCodes.TOOL_ARGS_INVALID };
      }
      if (matches.length > 1) {
        const ids = matches.map((m) => `  - [${m.id}] ${m.title}`).join('\n');
        return { ok: false, content: `Error: 子串 "${args.old_text}" 匹配多个条目：\n${ids}\n请使用更精确的文本或 id 重试`, errorCode: ErrorCodes.TOOL_ARGS_INVALID };
      }
      const rec = matches[0];
      const newContent = rec.content.replace(args.old_text, args.content);
      await store.update(rec.id, { content: newContent, title: newContent.slice(0, 60) });
      return { ok: true, content: `✅ 已替换记忆 [${rec.id}]` };
    }

    return { ok: false, content: `Error: 未知 action "${args.action}"`, errorCode: ErrorCodes.TOOL_ARGS_INVALID };
  }
}
