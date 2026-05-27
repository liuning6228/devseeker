/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Skill 工具（W4 批次 4）
 *
 * 职责：按 name 取 Skill 的指令内容，拼上调用者传入的 args，以工具结果形式返回给 LLM。
 * LLM 在下一轮会根据这段指令继续执行任务。
 *
 * 安全分级：external（由用户通过 .devseeker/skills 显式提供的工作流）
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { SkillLoader } from '../skills/index.js';
import { SkillDedupTracker, buildAlreadyLoadedReminder } from '../skills/index.js';
import { ErrorCodes } from '../errors/index.js';

export interface SkillArgs {
  skill: string;
  args?: string;
}

const parameters = {
  type: 'object',
  properties: {
    skill: {
      type: 'string',
      description: '要调用的 skill name，来自 System Prompt 中的 "Available Skills" 清单。',
    },
    args: {
      type: 'string',
      description: '调用参数（自由文本）。Skill 指令会看到这段文本，并根据 argumentsHint 做处理。',
    },
  },
  required: ['skill'],
  additionalProperties: false,
} as const;

export interface SkillToolDeps {
  getLoader(): SkillLoader | undefined;
  /**
   * W9.11 · ALREADY LOADED 防抖跟踪器（可选）。传入后，60s 内重复调用
   * 同一 skill 将只返回简短的 reminder，避免将完整 SKILL.md 重复展开到 context。
   */
  dedup?: SkillDedupTracker;
}

export class SkillTool implements ITool<SkillArgs, ToolResult> {
  readonly name = 'skill';
  readonly description =
    '调用一个 project skill：按 name 载入 SKILL.md 的任务指令模板，结合 args 执行工作流。'
    + ' 当用户任务匹配下方 Available Skills 清单中的任一 skill 时，必须先调用此工具加载完整指令，再按指令执行。不要直接尝试解决问题——先加载 skill。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: SkillToolDeps) {}

  async execute(args: SkillArgs, _ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args.skill !== 'string' || !args.skill.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'skill 必须是非空字符串');
    }
    const loader = this.deps.getLoader();
    if (!loader) {
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, 'SkillLoader 未就绪（未打开工作区？）');
    }
    await loader.load();
    const skill = loader.findByName(args.skill.trim());
    if (!skill) {
      const names = loader.list().map((s) => s.name).join(', ');
      return fail(
        ErrorCodes.TOOL_EXEC_FAILED,
        `skill not found: ${args.skill}. Available: [${names || '(none)'}]`,
      );
    }

    const argsText = (args.args ?? '').trim();

    // W9.11 · ALREADY LOADED 防抖
    const dedup = this.deps.dedup;
    if (dedup && dedup.isLoadedRecently(skill.name)) {
      const ageMs = dedup.ageMs(skill.name);
      const reminder = buildAlreadyLoadedReminder(skill.name, Math.max(0, ageMs));
      return {
        ok: true,
        content: reminder,
        display: {
          skill: skill.name,
          dedup: true,
          ageMs: Math.max(0, ageMs),
          argsProvided: argsText.length > 0,
        },
      };
    }

    const content = renderSkill(skill.name, skill.content, argsText);
    dedup?.markTriggered(skill.name);
    return {
      ok: true,
      content,
      display: {
        skill: skill.name,
        description: skill.description,
        argumentsHint: skill.argumentsHint,
        argsProvided: argsText.length > 0,
      },
    };
  }
}

// ─────────── helpers ───────────

function renderSkill(name: string, body: string, argsText: string): string {
  const header = `# Skill invoked: ${name}`;
  const argsBlock = argsText
    ? `## Invocation arguments\n\n${argsText}`
    : `## Invocation arguments\n\n(none)`;
  const instructionBlock = `## Instructions\n\n${body}`;
  const tail = [
    'Execute the Instructions above now using the available tools and the Invocation arguments.',
    'Do NOT just analyze or summarize — take concrete actions (read_file, write_file, bash, etc.) to fulfill the skill.',
    'Treat this as the authoritative task spec for this skill.',
    '',
    'IMPORTANT: You MUST call one or more tools in your very next response. Do NOT respond with only text.',
  ].join('\n');
  return [header, '', argsBlock, '', instructionBlock, '', tail].join('\n');
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
