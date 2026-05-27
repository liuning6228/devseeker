/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * trace_error 工具（Debug 模式 P0 §2.1）
 *
 * 高层工具封装"错误分析"完整流程，一次调用返回结构化追溯报告。
 *
 * 执行逻辑：
 * 1. 读失败文件 ±15 行上下文
 * 2. 对失败行上的符号做 goto_definition → 找到定义
 * 3. 对定义做 call_hierarchy('incoming') → 谁调用了它
 * 4. 对每个上游递归追溯 depth 层
 * 5. 对失败行的变量做 find_references → 看值从哪设的
 *
 * 依赖：LspBridge + fs（直接读文件，不与 ReadFileTool 耦合）
 */

import { promises as fs } from 'node:fs';
import { resolve as resolvePath, isAbsolute } from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { LspBridge, LspPosition } from '../lsp/bridge.js';
import { ErrorCodes, AgentError } from '../errors/index.js';

const MAX_CONTEXT_LINES = 15;

export interface TraceErrorArgs {
  /** 错误信息（必填） */
  errorMessage: string;
  /** 调用栈（可选） */
  stackTrace?: string;
  /** 失败文件路径（必填，相对或绝对） */
  failingFile: string;
  /** 失败行号（必填，1-based） */
  failingLine: number;
  /** 追溯深度，默认 3 */
  depth?: number;
}

const parameters = {
  type: 'object',
  properties: {
    errorMessage: {
      type: 'string',
      description: '错误信息（必填）。',
    },
    stackTrace: {
      type: 'string',
      description: '调用栈（可选）。',
    },
    failingFile: {
      type: 'string',
      description: '失败文件路径（相对工作区或绝对路径）。',
    },
    failingLine: {
      type: 'integer',
      minimum: 1,
      description: '失败行号（1-based）。',
    },
    depth: {
      type: 'integer',
      minimum: 1,
      maximum: 5,
      description: '追溯深度（调用链层数），默认 3。',
    },
  },
  required: ['errorMessage', 'failingFile', 'failingLine'],
  additionalProperties: false,
} as const;

export interface TraceErrorDeps {
  /** 懒获取 LSP 桥接器；未就绪时返回 undefined */
  getBridge(): LspBridge | undefined;
}

export class TraceErrorTool implements ITool<TraceErrorArgs, ToolResult> {
  readonly name = 'trace_error';
  readonly description =
    '高层错误分析工具：给定错误信息/文件/行号，自动追溯调用链（goto_definition → call_hierarchy → find_references），返回结构化追溯报告。一次调用替代多次 LSP 手动跳转。仅在 Debug 模式下使用。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: TraceErrorDeps) {}

  async execute(args: TraceErrorArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args.errorMessage !== 'string' || !args.errorMessage.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'errorMessage 不能为空');
    }
    if (!args.failingFile || typeof args.failingFile !== 'string') {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'failingFile 不能为空');
    }
    if (!Number.isInteger(args.failingLine) || args.failingLine < 1) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'failingLine 必须是 >= 1 的整数');
    }

    const depth = args.depth ?? 3;
    if (depth < 1 || depth > 5) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'depth 必须在 1-5 之间');
    }

    const bridge = this.deps.getBridge();
    if (!bridge) {
      return fail(
        ErrorCodes.LSP_SERVER_NOT_RUNNING,
        'LSP 桥接器未就绪（可能未打开工作区或 VSCode API 不可用）',
      );
    }
    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    const reports: string[] = [];
    const filePath = args.failingFile;

    // ── Step 1: 读取失败文件上下文 ──
    reports.push('## Trace Report for ' + filePath + ':' + args.failingLine + '\n');
    reports.push('### 1. 失败点');
    reports.push(filePath + ':' + args.failingLine + ' — ' + args.errorMessage);
    if (args.stackTrace) {
      reports.push('\n**调用栈：**\n```\n' + args.stackTrace + '\n```');
    }

    const context = await readFileContext(filePath, args.failingLine, ctx);
    if (context) {
      reports.push('\n**失败上下文：**');
      reports.push('```');
      reports.push(context);
      reports.push('```');
    }

    // ── Step 2: 符号解析 + 调用链追溯 ──
    reports.push('\n### 2. 调用链（反向追溯）');

    try {
      // 对失败行上的所有符号做分析
      // 使用多个列位置尝试解析（行首、行中、行尾附近的符号）
      const positions = guessPositions(args.failingLine, context);
      let foundAny = false;

      for (const pos of positions) {
        if (ctx.signal.aborted) break;

        // 2a. goto_definition
        const defs = await bridge.goToDefinition(filePath, pos);
        if (defs.length === 0) continue;
        foundAny = true;

        reports.push(
          `\n符号 \`${formatPos(pos)}\` 定义于：`,
        );
        for (const d of defs) {
          reports.push(`- \`${d.filePath}:${d.range.start.line}:${d.range.start.character}\`${d.preview ? ' ' + d.preview : ''}`);
        }

        // 2b. call_hierarchy（incoming）—— 谁调用了这个符号
        if (defs.length > 0) {
          const firstDef = defs[0];
          await traceCallHierarchy(
            bridge,
            firstDef.filePath,
            { line: firstDef.range.start.line, character: firstDef.range.start.character },
            depth,
            0,
            reports,
            ctx,
          );
        }

        // 2c. 数据流追溯
        const refs = await bridge.findReferences(filePath, pos, false);
        if (refs.length > 0) {
          reports.push('\n**引用点：**');
          for (const r of refs.slice(0, 5)) {
            reports.push(`- \`${r.filePath}:${r.range.start.line}:${r.range.start.character}\``);
          }
          if (refs.length > 5) {
            reports.push(`- ... 还有 ${refs.length - 5} 处`);
          }
        }
      }

      if (!foundAny) {
        reports.push('\n在失败行未找到可追溯的符号。请确认文件路径和行号是否正确，或尝试 LSP 重新启动。');
      }
    } catch (e) {
      reports.push('\n**追溯过程出错：** ' + (e instanceof Error ? e.message : String(e)));
    }

    // ── Step 3: 根因假设 ──
    reports.push('\n### 3. 根因假设');
    reports.push('（基于以上证据自动生成，仅供参考）');
    reports.push('- **错误点**：' + filePath + ':' + args.failingLine);
    reports.push('- **直接原因**：' + args.errorMessage);
    reports.push('- **建议**：请结合上述调用链和数据流追溯，定位根本原因。');

    return ok(reports.join('\n') + '\n');
  }
}

// ─────────── helpers ───────────

/**
 * 读取失败行附近的代码上下文。
 * 返回格式化后的行文本（带行号前缀）；若文件不可读则返回 undefined。
 */
async function readFileContext(
  filePath: string,
  failingLine: number,
  ctx: ToolContext,
): Promise<string | undefined> {
  const ws = ctx.workspaceRoot;
  if (!ws) return undefined;

  try {
    const absPath = isAbsolute(filePath) ? resolvePath(filePath) : resolvePath(ws, filePath);
    const content = await fs.readFile(absPath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, failingLine - 1 - MAX_CONTEXT_LINES);
    const end = Math.min(lines.length, failingLine + MAX_CONTEXT_LINES);
    const out: string[] = [];
    for (let i = start; i < end; i++) {
      const prefix = i === failingLine - 1 ? '→' : ' ';
      out.push(prefix + ' ' + (i + 1) + '\t' + lines[i]);
    }
    return out.join('\n');
  } catch {
    return undefined;
  }
}

/** 在失败行上猜测可能的关键符号列位置 */
function guessPositions(line: number, context: string | undefined): LspPosition[] {
  // 一定尝试行首（常见于函数调用起始位置）
  const positions: LspPosition[] = [
    { line, character: 1 },
  ];

  if (context) {
    // 从上下文里找失败行内容
    const lines = context.split('\n');
    const failingLineContent = lines.find((l) => l.startsWith('→'));
    if (failingLineContent) {
      // 找到第一个非空格的标识符起始位置
      const trimmed = failingLineContent.replace(/^→\s*\d+\s*/, '');
      const prefixLen = failingLineContent.length - trimmed.length;
      const firstIdent = trimmed.search(/[a-zA-Z_$]/);
      if (firstIdent >= 0) {
        // character 为 1-based 列号：去掉前缀后偏移
        positions.push({ line, character: prefixLen + firstIdent + 1 });
      }
      // 如果行中有方法调用 .xxx(，在 . 后面也试
      const dotCallMatch = trimmed.match(/\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/);
      if (dotCallMatch) {
        const dotIdx = trimmed.indexOf(dotCallMatch[0]);
        positions.push({ line, character: prefixLen + dotIdx + 1 });
      }
    }
  }

  return positions;
}

/** 递归追溯调用链 */
async function traceCallHierarchy(
  bridge: LspBridge,
  filePath: string,
  pos: LspPosition,
  maxDepth: number,
  currentDepth: number,
  reports: string[],
  ctx: ToolContext,
): Promise<void> {
  if (currentDepth >= maxDepth) return;
  if (ctx.signal.aborted) return;

  try {
    const callers = await bridge.callHierarchy(filePath, pos, 'incoming');
    if (callers.length === 0) return;

    const depthLabel = maxDepth - currentDepth;
    reports.push(`\nL${depthLabel} callers of \`${filePath}:${pos.line}:${pos.character}\`:`);

    for (const caller of callers) {
      const loc = caller.location;
      const locStr = `\`${loc.filePath}:${loc.range.start.line}:${loc.range.start.character}\``;
      reports.push(`- ${locStr} \`${caller.name}\` (${caller.kind})`);

      // 递归追溯该调用者的 caller
      if (currentDepth + 1 < maxDepth) {
        await traceCallHierarchy(
          bridge,
          loc.filePath,
          { line: loc.range.start.line, character: loc.range.start.character },
          maxDepth,
          currentDepth + 1,
          reports,
          ctx,
        );
      }
    }
  } catch {
    // 单层失败不中止整体报告
    reports.push(`\n（追溯 \`${filePath}:${pos.line}:${pos.character}\` 的调用者失败）`);
  }
}

function formatPos(pos: LspPosition): string {
  return `${pos.line}:${pos.character}`;
}

function ok(content: string, display?: Record<string, unknown>): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}) };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
