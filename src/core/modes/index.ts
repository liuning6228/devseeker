/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Mode Scheduler —— 四模式定义 + 白名单 + 状态机
 *
 * 来源：DESIGN §M7.1–§M7.3
 *
 * 职责：
 * 1. 定义四种 Mode（Agent / Plan / Debug / Ask）及其可用工具集
 * 2. 提供工具白名单判定函数（按 safetyLevel + 特殊工具名）
 * 3. 维护 ModeState（current / history / planDoc）+ 切换方法
 *
 * 注意：
 * - Mode 只影响工具可用性 + system prompt 提示段；具体工具执行仍走 ToolRunner
 * - Agent 是默认态；其他模式完成任务后 UI 应提示回到 Agent
 */

import type { ITool, ToolResult } from '../tools/types.js';

/** 四种工作模式 */
export type Mode = 'agent' | 'plan' | 'debug' | 'ask';

export const ALL_MODES: readonly Mode[] = ['agent', 'plan', 'debug', 'ask'] as const;

export const DEFAULT_MODE: Mode = 'agent';

/** Mode 的用户可见元信息 */
export interface ModeInfo {
  id: Mode;
  label: string;
  description: string;
}

export const MODE_INFO: Record<Mode, ModeInfo> = {
  agent: {
    id: 'agent',
    label: '智能体',
    description: '全能模式：可自主读写文件、执行命令、派发子代理，完成编码任务。',
  },
  plan: {
    id: 'plan',
    label: '规划师',
    description: '规划模式：只读调研 + 方案设计，产出计划文档供审批后再实施。',
  },
  debug: {
    id: 'debug',
    label: '调试专家',
    description: '诊断模式：循证排障五步法（复现→取证→定位→修复→验证）。',
  },
  ask: {
    id: 'ask',
    label: '智能问答',
    description: '问答模式：只读检索，只答不改，零代码变更风险。',
  },
};

/**
 * 仅 Plan 模式允许的额外工具白名单（当前为空）。
 * W6b2 加入 `create_plan`；若将来加 `ask_user_question`（W6b2/W7）也放这里。
 */
const PLAN_EXTRA_ALLOW_TOOLS = new Set<string>(['create_plan', 'update_plan']);

/**
 * 跨所有受限模式都允许的工具（目前仅 switch_mode，供 Agent 侧主动请求切 Plan）。
 * 注意：switch_mode 本身在 Plan 里没必要出现（已经是 Plan），故单独控制。
 */
const MODE_META_TOOLS = new Set<string>(['switch_mode']);

/**
 * 判断一个工具在当前 mode 下是否可用。
 *
 * 规则：
 * - Agent / Debug：所有工具（全开）
 * - Plan：safetyLevel === 'read_only' || 'network' + PLAN_EXTRA_ALLOW_TOOLS
 * - Ask：safetyLevel === 'read_only' || 'network'（允许查资料，但不改文件不跑命令）
 *
 * 联网工具（search_web / fetch_content / read_url）的 safetyLevel 统一为 'network'，
 * 在 Plan/Ask 同样放行（DESIGN §M12.8 鼓励 Plan/Debug 联网；Ask 场景需要查资料）。
 *
 * switch_mode 工具仅在 Agent / Debug 暴露给 LLM（Plan/Ask 不暴露）。
 */
export function isToolAllowedInMode(
  tool: Pick<ITool<unknown, ToolResult>, 'name' | 'safetyLevel'>,
  mode: Mode,
): boolean {
  // switch_mode 工具的特殊处理：仅 agent / debug 可见
  if (MODE_META_TOOLS.has(tool.name)) {
    return mode === 'agent' || mode === 'debug';
  }

  switch (mode) {
    case 'agent':
    case 'debug':
      return true;

    case 'plan':
      if (tool.safetyLevel === 'read_only') return true;
      if (tool.safetyLevel === 'network') return true;
      return PLAN_EXTRA_ALLOW_TOOLS.has(tool.name);

    case 'ask':
      return tool.safetyLevel === 'read_only' || tool.safetyLevel === 'network';
  }
}

/**
 * 为 system prompt 生成一段 Mode 约束说明。
 *
 * 放在 system prompt 开头，告诉模型当前模式的行为边界。
 */
export function renderModePromptSection(mode: Mode): string {
  const info = MODE_INFO[mode];
  const lines: string[] = [`# Current Mode: ${info.id} (${info.label})`, info.description, ''];
  switch (mode) {
    case 'agent':
      lines.push(
        'Behavior: You MAY modify files and run commands. Prefer the smallest diff.',
        'If the task is large, ambiguous, or has significant trade-offs,',
        'call `switch_mode(target_mode_id="plan")` FIRST to propose a plan (user must approve).',
        'If you encounter a bug or need to diagnose an error,',
        'call `switch_mode(target_mode_id="debug")` to use the evidence-first troubleshooting loop.',
      );
      break;
    case 'plan':
      lines.push(
        'Behavior: READ-ONLY. You MUST NOT call write / edit / terminal tools.',
        'Collaborate with the user to design an approach. When using `create_plan`,',
        'write a concise markdown plan; the user will approve it before switching back to Agent.',
        '',
        '## Interview Phase (分阶段需求收集)',
        'Before writing the plan, gather requirements iteratively:',
        '  1st round: Understand the **goal and scope** — what needs to be done, boundaries.',
        '  2nd round: Understand the **architecture and constraints** — existing patterns, risks.',
        '  3rd round: Understand the **details** — file paths, interfaces, edge cases.',
        'Provide all questions in a SINGLE turn. The user will answer them, then you refine.',
        '',
        '## Three-Phase Orchestration (Plan Orchestrator)',
        'When the task is large, decompose it into three phases using the `Agent` tool:',
        '',
        '**Phase 1 — Explore**:',
        '  `Agent({preset:\'explorer\', mode:\'fork\', description:\'Explore codebase for X\', prompt:\'...\'})`',
        '  Delegate exploration to understand the current codebase. Output: affected files + key interfaces + risks.',
        '',
        '**Phase 2 — Plan**:',
        '  Synthesize the explore results into a structured plan yourself.',
        '  Call `create_plan(mode="write")` to persist the plan to `docs/plans/`.',
        '  If exploration was insufficient, you may fall back to Phase 1 (max 1 time).',
        '',
        '**Phase 3 — Verify**:',
        '  `Agent({preset:\'verifier\', mode:\'fork\', description:\'Verify plan file/symbols\', prompt:\'...\'})`',
        '  Verify that the files and symbols referenced in the plan actually exist.',
        '  If they don\'t, iterate back to Phase 1.',
        '',
        'Rules:',
        '- Parallel exploration: launch 2+ explorer agents concurrently for independent areas.',
        '- Do NOT fabricate exploration results — the explorer agent reports actual findings.',
        '- Synthesize findings yourself, do NOT delegate understanding to the explorer.',
      );
      break;
    case 'debug':
      lines.push(
        'Behavior: Evidence-first troubleshooting loop. Follow these steps IN ORDER:',
        '',
        'Step 1 — REPRODUCE: Run the failing test or command to confirm the error.',
        '  - Detect test runner: read package.json for "test" script / devDependencies (vitest/jest/mocha/pytest/go test/cargo test).',
        '  - Run: `bash({ command: "<runner> <filter>", is_background: true })` then poll `get_terminal_output`.',
        '  - For compilation errors: `bash({ command: "npx tsc --noEmit" })` or equivalent.',
        '  - Capture the FULL error message, stack trace, and exit code.',
        '',
        'Step 2 — COLLECT EVIDENCE: Gather all relevant logs and context BEFORE touching code.',
        '  - Read the failing test file and the source file it tests.',
        '  - Use `search_codebase` or `trace_error` to find related call sites and implementations.',
        '  - If the error references a specific line, read ±10 lines around it.',
        '  - If the first fix attempt fails, call `trace_error` to trace the full call chain.',
        '',
        'Step 3 — LOCATE ROOT CAUSE: Narrow down to the exact bug.',
        '  - Trace the error from the failure point backwards through the call stack.',
        '  - Identify: null/undefined access, wrong condition, missing await, type mismatch, off-by-one, race condition, etc.',
        '  - Formulate a one-sentence hypothesis: "X is Y because Z".',
        '',
        'Step 4 — FIX: Apply the smallest possible change that resolves the root cause.',
        '  - Prefer `search_replace` over rewriting entire files.',
        '  - If multiple fixes are possible, choose the least invasive one.',
        '  - Do NOT fix symptoms (e.g., adding null checks everywhere); fix the root cause.',
        '',
        'Step 5 — VERIFY: Re-run the SAME test/command to confirm the fix.',
        '  - Use the exact same command as Step 1.',
        '  - If it still fails, go back to Step 2 with the new error.',
        '  - Only when the test PASSES (or the original error is resolved) is the loop complete.',
        '',
        'Rules:',
        '- NEVER edit code before seeing the actual error output (no guessing).',
        '- NEVER skip the VERIFY step. A fix without verification is incomplete.',
        '- At least ONE evidence-gathering action (read_file / trace_error / bash / goto_definition etc.) is REQUIRED before editing code.',
        '- DebugModeGate enforces this rule — editing without evidence will be REJECTED.',
        '- If the issue is intermittent or flaky, run the test multiple times.',
        '- Prefer a reasoning-capable model if available (deepseek-reasoner, o1, etc.).',
        '',
        'When the bug is fixed and verified (Step 5 PASSES), call',
        '`switch_mode(target_mode_id="agent")` to return to full-capability coding mode.',
      );
      break;
    case 'ask':
      lines.push(
        'Behavior: READ-ONLY Q&A. You MUST NOT modify any file or execute commands.',
        'Answer the user’s question with citations to code (file paths + line numbers).',
      );
      break;
  }
  return lines.join('\n');
}

/** Mode 历史条目（DESIGN §M7.3） */
export interface ModeHistoryEntry {
  mode: Mode;
  enteredAt: number;
  reason: string;
}

export interface ModeStateSnapshot {
  current: Mode;
  history: ModeHistoryEntry[];
  planDoc?: string;
}

/**
 * Mode 状态机。轻量实现：仅保存状态；所有"切换触发器"（DESIGN §M7.2）
 * 作为建议写入 system prompt，由 LLM 自己决定是否调用 switch_mode。
 */
export class ModeManager {
  private current: Mode;
  private readonly history: ModeHistoryEntry[] = [];
  private planDoc: string | undefined;

  constructor(initial: Mode = DEFAULT_MODE) {
    this.current = initial;
    this.history.push({ mode: initial, enteredAt: Date.now(), reason: 'initial' });
  }

  getCurrent(): Mode {
    return this.current;
  }

  snapshot(): ModeStateSnapshot {
    return {
      current: this.current,
      history: this.history.slice(),
      ...(this.planDoc ? { planDoc: this.planDoc } : {}),
    };
  }

  /**
   * 切换 Mode；幂等（切到同一模式无操作）。
   *
   * @param target 目标模式
   * @param reason 切换原因（写进历史，供调试）
   * @returns 实际发生变化返回 true；否则 false
   */
  setMode(target: Mode, reason: string): boolean {
    if (this.current === target) return false;
    this.current = target;
    this.history.push({ mode: target, enteredAt: Date.now(), reason });
    return true;
  }

  setPlanDoc(path: string | undefined): void {
    this.planDoc = path;
  }
}
