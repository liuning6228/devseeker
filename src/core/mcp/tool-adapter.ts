/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * MCP Tool Adapter — 把一个 MCP 工具包装成本地 ITool（W9.6）
 *
 * 职责：
 * - 命名空间化：name = `<serverAlias>.<mcpToolName>`，点号分隔（Qoder 规范）
 * - description 前缀："[mcp:<server>] <原 description>"
 * - parameters 直接透传 inputSchema（MCP 使用 JSON Schema）
 * - safetyLevel = 'external'（MCP 工具由用户显式配置）
 * - execute(args) → client.callTool(原 name, args) → 将 content 数组序列化为字符串给 LLM
 *
 * 注意：本适配器不知悉 registry 的重连/灰化逻辑；若 client 不可用，
 * registry 层应当在注册前移除该工具。这里只处理 callTool 失败的降级。
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from '../tools/types.js';
import { ErrorCodes } from '../errors/index.js';
import type { McpClient } from './client.js';
import type { McpContentItem, McpToolDefinition } from './protocol.js';

export interface McpToolAdapterOptions {
  /** 服务器别名（用户在 mcp.json 中起的名字） */
  serverAlias: string;
  /** MCP 工具定义（来自 tools/list） */
  toolDef: McpToolDefinition;
  /** 获取 client：registry 持有 client 生命周期，adapter 通过 getter 懒取 */
  getClient: () => McpClient | undefined;
  /** 是否处于灰化（disabled）状态（W9.8） */
  isDisabled?: () => boolean;
  /** 命名空间分隔符，默认 `.` */
  separator?: string;
}

/** 命名空间化 tool name：`<server>.<tool>` */
export function namespaceToolName(serverAlias: string, toolName: string, sep = '.'): string {
  return `${serverAlias}${sep}${toolName}`;
}

/** 把 MCP content[] 拼成给 LLM 看的字符串 */
export function formatMcpContent(content: readonly McpContentItem[]): string {
  const parts: string[] = [];
  for (const c of content) {
    if (!c) continue;
    if (c.type === 'text') {
      parts.push(c.text);
    } else if (c.type === 'image') {
      parts.push(`[image: ${c.mimeType}, ${c.data.length} bytes base64]`);
    } else if (c.type === 'resource') {
      const label = c.resource.uri + (c.resource.mimeType ? ` (${c.resource.mimeType})` : '');
      parts.push(`[resource: ${label}]${c.resource.text ? `\n${c.resource.text}` : ''}`);
    }
  }
  return parts.join('\n').trim();
}

export class McpToolAdapter implements ITool<Record<string, unknown>, ToolResult> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'external';

  constructor(private readonly opts: McpToolAdapterOptions) {
    this.name = namespaceToolName(opts.serverAlias, opts.toolDef.name, opts.separator);
    const raw = opts.toolDef.description?.trim() || opts.toolDef.name;
    this.description = `[mcp:${opts.serverAlias}] ${raw}`;
    // MCP inputSchema 为 JSON Schema；若未提供，给一个空 object
    this.parameters = (opts.toolDef.inputSchema as Record<string, unknown> | undefined) ?? {
      type: 'object',
      properties: {},
      additionalProperties: true,
    };
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    if (this.opts.isDisabled?.()) {
      return {
        ok: false,
        content: `MCP server "${this.opts.serverAlias}" is currently disabled (grayed out due to repeated failures).`,
        errorCode: ErrorCodes.MCP_SERVER_HEALTH_FAIL,
      };
    }
    const client = this.opts.getClient();
    if (!client || !client.isInitialized) {
      return {
        ok: false,
        content: `MCP server "${this.opts.serverAlias}" is not connected.`,
        errorCode: ErrorCodes.MCP_SERVER_HEALTH_FAIL,
      };
    }
    try {
      const result = await client.callTool(this.opts.toolDef.name, args ?? {});
      const text = formatMcpContent(result.content ?? []);
      if (result.isError) {
        return {
          ok: false,
          content: text || `MCP tool returned isError=true`,
          errorCode: ErrorCodes.MCP_TOOL_CALL_FAIL,
        };
      }
      return {
        ok: true,
        content: text,
        display: {
          mcpServer: this.opts.serverAlias,
          mcpTool: this.opts.toolDef.name,
          contentItems: result.content?.length ?? 0,
        },
      };
    } catch (e) {
      const err = e as Error & { code?: string };
      return {
        ok: false,
        content: `MCP tool call failed: ${err.message}`,
        errorCode: err.code ?? ErrorCodes.MCP_TOOL_CALL_FAIL,
      };
    }
  }
}
