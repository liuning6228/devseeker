/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * read_url 工具（W6b3）
 *
 * 来源：DESIGN §M12.3.3
 *
 * 语义：fetch_content 的精简版，专用于"用户已贴链接，快速看一下"
 * - 仅接受 url 参数
 * - 固定 mode='readable'、maxLength=10000
 * - 共享 fetch_content 的 SSRF 防护 + Jina Reader
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';
import { FetchContentTool, type FetchContentToolDeps } from './fetch_content.js';

export interface ReadUrlArgs {
  url: string;
}

const parameters = {
  type: 'object',
  properties: {
    url: { type: 'string', description: '目标 URL（http/https）' },
  },
  required: ['url'],
  additionalProperties: false,
} as const;

export class ReadUrlTool implements ITool<ReadUrlArgs, ToolResult> {
  readonly name = 'read_url';
  readonly description =
    'Quickly fetch a URL the user just pasted. Shortcut for fetch_content(url, mode="readable", maxLength=10000). Prefer this when the user says "看一下这个链接".';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'network';

  private readonly inner: FetchContentTool;

  constructor(deps: FetchContentToolDeps = {}) {
    this.inner = new FetchContentTool(deps);
  }

  async execute(args: ReadUrlArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args.url !== 'string' || args.url.trim().length === 0) {
      return {
        ok: false,
        content: 'Error: url 不能为空',
        errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      };
    }
    return await this.inner.execute(
      { url: args.url, mode: 'readable', maxLength: 10_000 },
      ctx,
    );
  }
}
