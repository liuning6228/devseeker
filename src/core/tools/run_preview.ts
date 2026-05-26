/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * run_preview 工具（W11.4 · DESIGN §M9.7）
 *
 * 语义：AI 启动了本地开发服务器（如 `npm run dev`）后，调用 run_preview(url, name)
 * 告知宿主：为这个地址开一个"预览浏览器"。
 *
 * MVP 行为：
 * - 工具仅做校验并返回结构化 payload
 * - Panel 通过注入的 `onOpenPreview` 回调把 payload 转给 webview → host
 * - Webview 侧显示一个"打开预览"按钮（用户点击才真正打开外部浏览器）
 * - 真实 Preview WebView（iframe + DOM 桥）留待 W11.5 逐步实现
 *
 * 安全：
 * - 只接受 http/https URL
 * - 可选拒绝非 localhost（阻止 AI 诱导打开钓鱼站）
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';

export interface RunPreviewArgs {
  url: string;
  name?: string;
}

export interface PreviewRequest {
  url: string;
  name: string;
  taskId: string;
  toolCallId: string;
}

export type PreviewSink = (req: PreviewRequest) => void | Promise<void>;

export interface RunPreviewToolDeps {
  /** 由 Panel 注入的预览回调；未配置时仅登记消息不打开 */
  sink?: PreviewSink;
  /**
   * 是否限制仅 localhost / 127.0.0.1 / ::1 / 本机 IP。
   * 默认 true（更安全）。设为 false 允许任意公网 URL。
   */
  requireLocalhost?: boolean;
}

const parameters = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description:
        'Web server URL (http/https). Should include scheme + host + port, e.g. http://localhost:5173',
    },
    name: {
      type: 'string',
      description: 'Short 3-5 word title-cased label, e.g. "Personal Website".',
    },
  },
  required: ['url'],
  additionalProperties: false,
} as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export class RunPreviewTool implements ITool<RunPreviewArgs, ToolResult> {
  readonly name = 'run_preview';
  readonly description =
    'Set up a preview browser for a local web server you just started. Call this AFTER running a local dev server (e.g. `npm run dev`). Passes the URL to the UI, which shows an "Open Preview" button for the user to click. Do NOT use for non-web applications.';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'network';

  constructor(private readonly deps: RunPreviewToolDeps = {}) {}

  async execute(args: RunPreviewArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args.url !== 'string' || args.url.trim().length === 0) {
      return {
        ok: false,
        content: 'Error: url 不能为空',
        errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      };
    }
    const url = args.url.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        ok: false,
        content: `Error: 不是合法的 URL: ${url}`,
        errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        content: `Error: 仅支持 http/https；got ${parsed.protocol}`,
        errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      };
    }
    const requireLocalhost = this.deps.requireLocalhost ?? true;
    if (requireLocalhost && !isLocalHost(parsed.hostname)) {
      return {
        ok: false,
        content: `Error: 仅允许本机预览地址（localhost/127.0.0.1/::1）；got ${parsed.hostname}`,
        errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      };
    }
    const name =
      args.name && args.name.trim().length > 0 ? args.name.trim() : 'Preview';

    const req: PreviewRequest = {
      url,
      name,
      taskId: ctx.taskId,
      toolCallId: ctx.toolCallId,
    };

    if (this.deps.sink) {
      try {
        await this.deps.sink(req);
      } catch {
        /* sink 失败不影响工具结果 */
      }
    }

    return {
      ok: true,
      content: `Preview registered: ${name} → ${url}\n点击 UI 中的"打开预览"按钮在外部浏览器查看。`,
      display: { url, name },
    };
  }
}

function isLocalHost(host: string): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  if (LOCAL_HOSTS.has(h)) return true;
  // 私网段 10.x / 172.16-31.x / 192.168.x
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  return false;
}
