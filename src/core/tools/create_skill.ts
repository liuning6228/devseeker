/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W14.3 · create_skill 工具
 *
 * 职责：让 Agent/用户通过对话在 `.dualmind/skills/<slug>/SKILL.md` 快速沉淀自定义技能。
 *
 * 参数：
 *   - name: 人类可读的 skill 标识（会被 slugify 成目录名）
 *   - description: 简述（写入 frontmatter.description）
 *   - instructions: SKILL.md 正文（完整 markdown，Agent 下次 load 时按此执行）
 *   - arguments_hint?: 命令参数格式提示（frontmatter.arguments）
 *   - overwrite?: 是否覆盖已存在 SKILL.md（默认 false，冲突即 hard fail）
 *
 * 安全：workspace_write（属于本机文件落盘）；未打开工作区时 hard fail。
 *
 * 副作用：写完后调 `skillLoader.invalidate()`，下一次 `skill` 工具调用就能命中新 skill。
 *
 * 设计要点：
 *   - slug：[a-z0-9-]，长度 1-64，非 ascii 字符剥离（避免 FS 兼容问题）
 *   - frontmatter：`description: "..."` + `arguments: "..."`（YAML-lite，与 SkillLoader 解析器对齐）
 *   - 路径前缀白名单：只允许落盘在 `<ws>/.dualmind/skills/<slug>/` 下（防越权）
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';

export interface CreateSkillArgs {
  name: string;
  description: string;
  instructions: string;
  arguments_hint?: string;
  overwrite?: boolean;
}

const parameters = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        '技能名（人类可读）。将被 slugify 为目录名 `<slug>`，文件落于 `.dualmind/skills/<slug>/SKILL.md`。示例："commit" / "review-pr" / "deploy-staging"。',
    },
    description: {
      type: 'string',
      description: '简述该 skill 的作用。写入 SKILL.md frontmatter.description。',
    },
    instructions: {
      type: 'string',
      description:
        'SKILL.md 正文（完整 markdown）。下次用户用 `/<slug>` 触发此 skill 时，该正文将作为权威任务指令发给 Agent。',
    },
    arguments_hint: {
      type: 'string',
      description: '可选：命令行参数格式提示，写入 frontmatter.arguments。',
    },
    overwrite: {
      type: 'boolean',
      description: '可选：默认 false。若 SKILL.md 已存在且 overwrite=false → 返回冲突错误。',
    },
  },
  required: ['name', 'description', 'instructions'],
  additionalProperties: false,
} as const;

export interface CreateSkillDeps {
  /** 工作区根（懒绑定；panel 注入 `() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`） */
  getWorkspaceRoot(): string | undefined;
  /** 写完后刷新 SkillLoader 缓存 */
  onSkillCreated?(absPath: string, slug: string): void;
}

export class CreateSkillTool implements ITool<CreateSkillArgs, ToolResult> {
  readonly name = 'create_skill';
  readonly description =
    '创建一个项目级 skill（工作流模板）：在 `.dualmind/skills/<slug>/SKILL.md` 落盘。下一次对话中用户或 Agent 通过 `skill` 工具按 name 触发即可复用该指令集。适合把对话中反复出现的"固定套路"沉淀为可复用模板。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'workspace_write';

  constructor(private readonly deps: CreateSkillDeps) {}

  async execute(args: CreateSkillArgs, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    const valErr = validateArgs(args);
    if (valErr) return fail(ErrorCodes.TOOL_ARGS_INVALID, valErr);

    const ws = this.deps.getWorkspaceRoot();
    if (!ws) {
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, '未打开工作区，无法创建 skill');
    }

    const slug = slugifySkillName(args.name);
    if (!slug) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `name "${args.name}" 无法生成合法 slug（需包含至少一个 [a-z0-9] 字符）`,
      );
    }

    const skillsRoot = path.join(ws, '.dualmind', 'skills');
    const skillDir = path.join(skillsRoot, slug);
    const skillFile = path.join(skillDir, 'SKILL.md');

    // 路径越权保护：确保 skillFile 严格位于 skillsRoot 下
    const normSkillFile = path.resolve(skillFile);
    const normSkillsRoot = path.resolve(skillsRoot);
    if (!normSkillFile.startsWith(normSkillsRoot + path.sep)) {
      return fail(
        ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        `路径越权：${normSkillFile}（必须位于 ${normSkillsRoot}/）`,
      );
    }

    // 冲突检查
    let exists = false;
    try {
      await fs.stat(skillFile);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists && !args.overwrite) {
      return fail(
        ErrorCodes.TOOL_EXEC_FAILED,
        `SKILL.md 已存在：${skillFile}。如需覆盖请显式传 overwrite=true。`,
      );
    }

    // 构造 markdown 内容
    const md = renderSkillMd({
      description: args.description,
      argumentsHint: args.arguments_hint,
      body: args.instructions,
    });

    try {
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(skillFile, md, 'utf-8');
    } catch (e) {
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `写入 SKILL.md 失败：${(e as Error).message}`);
    }

    // 通知 panel 刷新 SkillLoader 缓存
    try {
      this.deps.onSkillCreated?.(skillFile, slug);
    } catch {
      /* 刷新失败不阻断返回 */
    }

    const action = exists ? 'overwritten' : 'created';
    const relPath = path.relative(ws, skillFile);
    return {
      ok: true,
      content: [
        `Skill ${action}: ${slug}`,
        `File: ${relPath}`,
        '',
        `用户下次用 \`skill\` 工具传 \`{ "skill": "${slug}" }\` 即可触发本 skill。`,
      ].join('\n'),
      display: {
        slug,
        filePath: skillFile,
        relPath,
        action,
        bytes: Buffer.byteLength(md, 'utf-8'),
      },
    };
  }
}

// ─────────── public helpers（供单测复用 / 将来 create_agent 借鉴） ───────────

/**
 * 把人类可读 name 转成 FS 友好的 slug：
 *  - lowercase
 *  - 非 [a-z0-9] 字符替换为 '-'
 *  - 多个 '-' 压缩为单个
 *  - 去首尾 '-'
 *  - 长度限制 1-64
 *
 * 示例：
 *  - "Review PR" → "review-pr"
 *  - "deploy_staging" → "deploy-staging"
 *  - "Commit!!!" → "commit"
 *  - "   " → ""
 *  - 中文 name "提交代码" → "" （全部被剥离，调用方应 hard fail）
 */
export function slugifySkillName(name: string): string {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.slice(0, 64);
}

export function renderSkillMd(opts: {
  description: string;
  argumentsHint?: string;
  body: string;
}): string {
  const fm: string[] = ['---'];
  fm.push(`description: ${yamlEscape(opts.description)}`);
  if (opts.argumentsHint && opts.argumentsHint.trim()) {
    fm.push(`arguments: ${yamlEscape(opts.argumentsHint.trim())}`);
  }
  fm.push('---');
  fm.push('');
  const body = opts.body.endsWith('\n') ? opts.body : opts.body + '\n';
  return fm.join('\n') + '\n' + body;
}

// ─────────── internal ───────────

function validateArgs(args: CreateSkillArgs): string | undefined {
  if (!args || typeof args !== 'object') return 'args 必须是对象';
  if (typeof args.name !== 'string' || !args.name.trim()) return 'name 必须是非空字符串';
  if (typeof args.description !== 'string' || !args.description.trim())
    return 'description 必须是非空字符串';
  if (typeof args.instructions !== 'string' || !args.instructions.trim())
    return 'instructions 必须是非空字符串';
  if (args.arguments_hint !== undefined && typeof args.arguments_hint !== 'string')
    return 'arguments_hint 必须是字符串';
  if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean')
    return 'overwrite 必须是布尔值';
  // 防爆：instructions 上限 100KB（远大于常规 SKILL.md）
  if (args.instructions.length > 100_000) return 'instructions 过长（>100KB）';
  if (args.description.length > 500) return 'description 过长（>500 chars）';
  return undefined;
}

function yamlEscape(s: string): string {
  const needsQuote = /[:#\-&*!|>{}[\]"'`,\n]/.test(s) || s.trim() !== s;
  if (!needsQuote) return s;
  // 用双引号 + 反斜杠转义
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
