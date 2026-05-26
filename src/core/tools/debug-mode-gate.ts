/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * DebugModeGate —— Debug 模式下的强制取证门禁（Debug Mode 优化方案 S2）
 *
 * 功能：
 * - 在 Debug 模式下，检测 LLM 是否在未完成取证的情况下直接调用写工具。
 * - 满足任意 1 种取证操作即放行：read_file / trace_error / goto_definition /
 *   find_references / bash / get_terminal_output / get_problems / call_hierarchy
 * - 全部未满足 → 拒绝并提示"Debug 模式要求先取证 (Step 2)"
 *
 * 设计：
 * - 由 TaskLoop 在工具调用轮次中维护 hasEvidence 状态
 * - ToolRunner 通过 gate 函数判断是否放行
 * - gate 函数由 TaskLoop 创建并注入
 */

import type { Mode } from '../modes/index.js';

/** 取证工具集合 —— 任意调用一次即可视为已完成取证 */
const EVIDENCE_TOOLS = new Set([
  'read_file',
  'trace_error',
  'goto_definition',
  'find_references',
  'call_hierarchy',
  'bash',
  'get_terminal_output',
  'get_problems',
  'lsp',
]);

/** 被门禁拦截的编辑工具集合 */
const EDIT_TOOLS = new Set([
  'search_replace',
  'write_file',
  'append_file',
  'delete_file',
]);

export interface DebugModeGateDeps {
  /** 获取当前 mode（函数而非静态值，支持 mode 切换后动态取） */
  getMode: () => Mode;
  /** 本轮是否有取证操作记录 */
  hasEvidence: boolean;
}

export interface GateResult {
  verdict: 'allow' | 'block';
  message?: string;
}

/**
 * 创建 DebugModeGate 判定函数。
 *
 * 返回一个以 toolName 为入参的函数，用于 ToolRunner 在每次工具调用前判断是否拦截。
 *
 * 返回值：
 * - 'allow' — 允许执行
 * - 'block' — 拒绝执行（附带提示消息）
 */
export function createDebugModeGate(deps: DebugModeGateDeps): (toolName: string) => GateResult {
  return (toolName: string): GateResult => {
    // 非 Debug 模式 → 不拦截
    if (deps.getMode() !== 'debug') {
      return { verdict: 'allow' };
    }

    // 取证工具本身 → 放行
    if (EVIDENCE_TOOLS.has(toolName)) {
      return { verdict: 'allow' };
    }

    // 非编辑工具（switch_mode、create_plan 等）→ 放行
    if (!EDIT_TOOLS.has(toolName)) {
      return { verdict: 'allow' };
    }

    // 编辑工具且未取证 → 拦截
    if (!deps.hasEvidence) {
      return { verdict: 'block', message: getBlockedMessage(toolName) };
    }

    return { verdict: 'allow' };
  };
}

/**
 * 判断一个工具名是否是取证工具。
 * 用于 TaskLoop 在工具执行后更新 hasEvidence。
 */
export function isEvidenceTool(toolName: string): boolean {
  return EVIDENCE_TOOLS.has(toolName);
}

/**
 * 判断一个工具名是否需要门禁拦截的编辑工具。
 */
export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName);
}

/**
 * 生成 DebugMode 拒绝消息。
 */
export function getBlockedMessage(toolName: string): string {
  return [
    `Debug 模式要求先取证 (Step 2) 再执行 "${toolName}"。`,
    '当前未检测到任何取证操作。',
    '请先使用以下工具之一收集证据：',
    '- `read_file` — 读取目标文件',
    '- `trace_error` — 高层错误追溯',
    '- `goto_definition` / `find_references` / `call_hierarchy` — LSP 符号追溯',
    '- `bash` — 运行复现命令',
    '- `get_terminal_output` — 查看终端输出',
    '- `get_problems` — 读取编译器/Linter 诊断',
  ].join('\n');
}
