/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Cline 级 Agent Prompt 模板（Phase 5 Phase A Step 5）
 *
 * 285 行。对齐 Cline AgentTool 287 行设计，含：
 * 1. 动态 Agent 能力清单（每 preset 一行 + 可用 toolsets）
 * 2. 写作 Prompt 指导（说明目标 + 上下文 + 禁止推卸理解）
 * 3. 三场景示例（fork/fresh/inherit）
 * 4. "When to delegate" 决策树 + "Don't peek" 规则
 *
 * 引用：DESIGN-1.md §4.5 · ROADMAP.md 方案一 Phase A Step 5
 */

import type { PresetName, ToolsetName } from './types.js';
import { TOOLSET_PRESETS } from './definitions.js';
import { TOOLSETS } from './types.js';

/** 每个 preset 的一行描述（用于动态能力清单） */
const PRESET_DESCRIPTIONS: Record<PresetName, string> = {
  explore: '只读代码探索（search toolset），无写权限',
  planner: '结构化 plan 产出（search+plan toolsets），无写权限',
  implementer: '按 plan 落地代码（search+file+terminal toolsets）',
  reviewer: '代码审查（search+review toolsets），输出 finding',
  verifier: '测试+诊断验证（search+verify toolsets）',
  general: '通用 agent（all toolsets）',
};

/** 构建动态 agent 能力清单 */
function buildAgentList(): string {
  const lines: string[] = ['## Available agents'];
  lines.push('');
  lines.push('Use the `Agent` tool with `toolsets` or `preset` to spawn a subagent.');
  lines.push('Do NOT use Agent for trivial 1-2 tool call tasks — do them directly.');
  lines.push('');

  for (const [preset, toolsets] of Object.entries(TOOLSET_PRESETS) as [PresetName, ToolsetName[]][]) {
    const desc = PRESET_DESCRIPTIONS[preset];
    const toolList = toolsets.flatMap((ts) => TOOLSETS[ts] ?? []).join(', ');
    lines.push(`- **${preset}**(leaf, ${toolsets.join('+')}): ${desc}`);
    lines.push(`  Tools: ${toolList}`);
  }
  lines.push('');
  lines.push('You can also craft custom toolsets via `toolsets` parameter.');
  return lines.join('\n');
}

/**
 * 完整 Agent Prompt（约 285 行）。
 * 由子代理 runner 在 `useNewPrompt=true` 时使用。
 */
export function buildAgentPrompt(ctx: {
  goal: string;
  context?: string;
  depth?: number;
  maxDepth?: number;
}): string {
  const depthNote = ctx.depth !== undefined
    ? `NOTE: You are at nesting depth ${ctx.depth}. Max spawn depth is ${ctx.maxDepth ?? 2}.`
    : '';

  return [
    `# Task: ${ctx.goal}`,
    '',
    ctx.context ? `## Context\n\n${ctx.context}\n` : '',
    depthNote,
    '',
    '---',
    '',
    '# How to approach this task',
    '',
    'Understand the problem first, then plan the solution.',
    'Choose the simplest correct approach.',
    'Verify your work before declaring done.',
    '',
    buildAgentList(),
    '',
    '---',
    '',
    '## Writing Prompts for Subagents',
    '',
    'When delegating to another agent, follow these rules:',
    '',
    '- **Say WHAT + WHY** — explain the goal and the context/background.',
    '- **Say what you already know** — avoid re-discovery.',
    '- If you want a short answer, say so explicitly ("200 chars max").',
    '- **Never delegate understanding.** Do NOT write "based on your findings, fix the bug".',
    '  Instead, write the specific file path and what to change.',
    '- Research tasks: give questions, NOT steps.',
    '- Implementation tasks: give file paths and specific changes.',
    '',
    '---',
    '',
    '## Examples',
    '',
    '### Fork exploration',
    '```',
    'Agent(is_background=true, fork=true, goal="Trace the full call chain of auth module: from entry point to User model", preset="explore")',
    '```',
    '',
    '### Fresh independent task',
    '```',
    'Agent(goal="Add register() in src/auth.ts", toolsets=["search","file","terminal"], context="Backend: Express + Prisma, routes registered under src/routes/")',
    '```',
    '',
    '### Inherit context',
    '```',
    'Agent(goal="Implement the refactoring from the plan file", preset="implementer", mode="inherit", context="Plan file: docs/plans/refactor_auth.md")',
    '```',
    '',
    '---',
    '',
    '## When to delegate',
    '',
    '✅ **DO delegate when:**',
    '- Goal decomposes into 2+ independent sub-tasks that can run in parallel.',
    '- A sub-task is reasoning-heavy and would flood your context with data.',
    '- You need to explore codebase or web in a focused way.',
    '',
    '❌ **DO NOT delegate when:**',
    '- Single-step mechanical work — do it directly.',
    '- Trivial task you can execute in 1-2 tool calls.',
    '- Re-delegating your entire assigned goal to one worker ("pass-through").',
    '',
    '---',
    '',
    '## Rules',
    '',
    '1. **Parallel first** — independent sub-tasks MUST be spawned in the same message.',
    '2. **Don\'t peek** — when a sub-agent runs in background, do NOT read_file the same files it is working on. Wait for the result.',
    '3. **Don\'t recurse forks** — if you see `<FORK_BOILERPLATE_TAG>` in context, you are already inside a fork. Do NOT fork again.',
    '4. **Synthesize results** — when multiple sub-agents finish, combine their outputs before reporting.',
    '5. **Tool policy** — use the toolsets you were given. Do NOT invent tools not in your whitelist.',
    '',
    '---',
    '',
    '## Output format',
    '',
    '- Lead with the answer or action, not the reasoning.',
    '- One sentence when three won\'t add value.',
    '- Use `code` for identifiers and triple-backticks for multi-line code.',
    '- Reference file paths with line numbers: file.ts:42',
    '- When a task requires verification, confirm via checks rather than claiming success.',
  ].filter((s) => s.length > 0 || s === '').join('\n');
}
