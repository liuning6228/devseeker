/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W14.4 · create_agent 工具
 *
 * 职责：让 Agent/用户通过对话在 `.devseeker/agents/<slug>/AGENT.md` 快速沉淀自定义子代理。
 *
 * 参数：
 *   - name: 人类可读的 agent 标识（会被 slugify 成目录名）
 *   - description: 一句话描述（写入 frontmatter.description，给主 Agent 选用时参考）
 *   - system_prompt: AGENT.md 正文（子代理独立 systemPrompt）
 *   - tools?: 允许的工具 name 列表（数组或逗号分隔字符串；缺省使用只读默认白名单）
 *   - max_turns?: 最大轮次（默认 15）
 *   - overwrite?: 是否覆盖已存在 AGENT.md（默认 false，冲突即 hard fail）
 *
 * 安全：workspace_write；未打开工作区时 hard fail。
 *
 * 内置名保留：与 Browser / Research / Guide / Verify 同名 → hard fail。
 *
 * 副作用：写完后调 `agentLoader.invalidate()`，下一次 Agent 工具调用就能命中新 agent。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';
import { ALL_BUILTIN_SUBAGENT_TYPES } from '../subagent/types.js';

export interface CreateAgentArgs {
  name: string;
  description: string;
  system_prompt: string;
  tools?: string | readonly string[];
  max_turns?: number;
  overwrite?: boolean;
}

const parameters = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        '子代理名（人类可读）。将被 slugify 为目录名 `<slug>`，文件落于 `.devseeker/agents/<slug>/AGENT.md`。示例："security-reviewer" / "api-doc-writer"。禁止与内置 Browser/Research/Guide/Verify 同名。',
    },
    description: {
      type: 'string',
      description: '一句话描述该子代理职责。写入 AGENT.md frontmatter.description。',
    },
    system_prompt: {
      type: 'string',
      description:
        'AGENT.md 正文（完整 markdown），将作为该子代理的独立 systemPrompt。应清晰界定 scope / 规则 / 输出格式。',
    },
    tools: {
      description:
        '允许的工具 name 列表。可为数组或逗号分隔字符串。缺省使用只读默认白名单（read_file / list_dir / search_codebase / search_knowledge / fetch_content / read_url）。',
      oneOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
      ],
    },
    max_turns: {
      type: 'number',
      description: '最大轮次（默认 15）。范围 1-50。',
      minimum: 1,
      maximum: 50,
    },
    overwrite: {
      type: 'boolean',
      description: '可选：默认 false。若 AGENT.md 已存在且 overwrite=false → 返回冲突错误。',
    },
  },
  required: ['name', 'description', 'system_prompt'],
  additionalProperties: false,
} as const;

export interface CreateAgentDeps {
  /** 工作区根（懒绑定） */
  getWorkspaceRoot(): string | undefined;
  /** 写完后刷新 AgentLoader 缓存 */
  onAgentCreated?(absPath: string, slug: string): void;
}

export class CreateAgentTool implements ITool<CreateAgentArgs, ToolResult> {
  readonly name = 'create_agent';
  readonly description =
    '创建一个项目级 subagent：在 `.devseeker/agents/<slug>/AGENT.md` 落盘。下一次主 Agent 调用 `Agent` 工具时传 `subagent_type=<slug>` 即可派生该子代理。适合把"反复出现、职责独立、可工具白名单隔离"的子任务沉淀为自定义角色（如 "security-reviewer" / "api-doc-writer"）。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'workspace_write';

  constructor(private readonly deps: CreateAgentDeps) {}

  async execute(args: CreateAgentArgs, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    const valErr = validateArgs(args);
    if (valErr) return fail(ErrorCodes.TOOL_ARGS_INVALID, valErr);

    const ws = this.deps.getWorkspaceRoot();
    if (!ws) {
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, '未打开工作区，无法创建 agent');
    }

    const slug = slugifyAgentName(args.name);
    if (!slug) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `name "${args.name}" 无法生成合法 slug（需包含至少一个 [a-z0-9] 字符）`,
      );
    }

    // 内置名保留：与 Browser / Research / Guide / Verify 同名（大小写不敏感）→ hard fail
    if (ALL_BUILTIN_SUBAGENT_TYPES.some((b) => b.toLowerCase() === slug)) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `name "${slug}" 与内置 subagent 冲突，请改用其它名称（内置：${ALL_BUILTIN_SUBAGENT_TYPES.join(' / ')}）`,
      );
    }

    const agentsRoot = path.join(ws, '.devseeker', 'agents');
    const agentDir = path.join(agentsRoot, slug);
    const agentFile = path.join(agentDir, 'AGENT.md');

    // 路径越权保护：确保 agentFile 严格位于 agentsRoot 下
    const normAgentFile = path.resolve(agentFile);
    const normAgentsRoot = path.resolve(agentsRoot);
    if (!normAgentFile.startsWith(normAgentsRoot + path.sep)) {
      return fail(
        ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        `路径越权：${normAgentFile}（必须位于 ${normAgentsRoot}/）`,
      );
    }

    // 冲突检查
    let exists = false;
    try {
      await fs.stat(agentFile);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists && !args.overwrite) {
      return fail(
        ErrorCodes.TOOL_EXEC_FAILED,
        `AGENT.md 已存在：${agentFile}。如需覆盖请显式传 overwrite=true。`,
      );
    }

    // 构造 markdown 内容
    const md = renderAgentMd({
      description: args.description,
      tools: normalizeTools(args.tools),
      maxTurns: args.max_turns,
      body: args.system_prompt,
    });

    try {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(agentFile, md, 'utf-8');
    } catch (e) {
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `写入 AGENT.md 失败：${(e as Error).message}`);
    }

    // 通知 panel 刷新 AgentLoader 缓存
    try {
      this.deps.onAgentCreated?.(agentFile, slug);
    } catch {
      /* 刷新失败不阻断返回 */
    }

    const action = exists ? 'overwritten' : 'created';
    const relPath = path.relative(ws, agentFile);
    return {
      ok: true,
      content: [
        `Agent ${action}: ${slug}`,
        `File: ${relPath}`,
        '',
        `下一轮调用 \`Agent\` 工具传 \`{ "subagent_type": "${slug}", ... }\` 即可派生该子代理。`,
      ].join('\n'),
      display: {
        slug,
        filePath: agentFile,
        relPath,
        action,
        bytes: Buffer.byteLength(md, 'utf-8'),
      },
    };
  }
}

// ─────────── public helpers（供单测复用） ───────────

/**
 * 把人类可读 name 转成 FS 友好的 slug。规则与 slugifySkillName 一致。
 * 示例：
 *  - "Security Reviewer" → "security-reviewer"
 *  - "api_doc_writer"    → "api-doc-writer"
 *  - "Verify"            → "verify"（调用方在 reserved 名单里 hard fail）
 *  - "   "               → ""
 */
export function slugifyAgentName(name: string): string {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.slice(0, 64);
}

export function renderAgentMd(opts: {
  description: string;
  tools?: readonly string[];
  maxTurns?: number;
  body: string;
}): string {
  const fm: string[] = ['---'];
  fm.push(`description: ${yamlEscape(opts.description)}`);
  if (opts.tools && opts.tools.length > 0) {
    fm.push(`tools: ${yamlEscape(opts.tools.join(', '))}`);
  }
  if (typeof opts.maxTurns === 'number' && Number.isFinite(opts.maxTurns) && opts.maxTurns > 0) {
    fm.push(`max_turns: ${Math.floor(opts.maxTurns)}`);
  }
  fm.push('---');
  fm.push('');
  const body = opts.body.endsWith('\n') ? opts.body : opts.body + '\n';
  return fm.join('\n') + '\n' + body;
}

// ─────────── internal ───────────

function validateArgs(args: CreateAgentArgs): string | undefined {
  if (!args || typeof args !== 'object') return 'args 必须是对象';
  if (typeof args.name !== 'string' || !args.name.trim()) return 'name 必须是非空字符串';
  if (typeof args.description !== 'string' || !args.description.trim())
    return 'description 必须是非空字符串';
  if (typeof args.system_prompt !== 'string' || !args.system_prompt.trim())
    return 'system_prompt 必须是非空字符串';
  if (args.tools !== undefined) {
    if (typeof args.tools !== 'string' && !Array.isArray(args.tools)) {
      return 'tools 必须是字符串或字符串数组';
    }
    if (Array.isArray(args.tools) && args.tools.some((t) => typeof t !== 'string')) {
      return 'tools 数组每一项必须是字符串';
    }
  }
  if (args.max_turns !== undefined) {
    if (
      typeof args.max_turns !== 'number' ||
      !Number.isFinite(args.max_turns) ||
      args.max_turns < 1 ||
      args.max_turns > 50
    ) {
      return 'max_turns 必须是 1-50 之间的数字';
    }
  }
  if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean')
    return 'overwrite 必须是布尔值';
  // 防爆：system_prompt 上限 100KB（远大于常规 AGENT.md）
  if (args.system_prompt.length > 100_000) return 'system_prompt 过长（>100KB）';
  if (args.description.length > 500) return 'description 过长（>500 chars）';
  return undefined;
}

function normalizeTools(tools: CreateAgentArgs['tools']): readonly string[] | undefined {
  if (tools === undefined) return undefined;
  const raw = Array.isArray(tools)
    ? tools
    : String(tools)
        .split(/[,;\s]+/)
        .map((s) => s.trim());
  const out = raw.map((s) => s.trim()).filter((s) => s.length > 0);
  return out.length > 0 ? out : undefined;
}

function yamlEscape(s: string): string {
  const needsQuote = /[:#\-&*!|>{}[\]"'`,\n]/.test(s) || s.trim() !== s;
  if (!needsQuote) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
