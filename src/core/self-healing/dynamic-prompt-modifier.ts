/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * dynamic-prompt-modifier —— W15.3 + §8.12.1 自愈重试策略升级
 *
 * 职责：
 * - 跟踪 TaskLoop 运行期间每个工具的错误模式（按 toolName + errorCode 维度）
 * - 当同一组合重复 >=3 次时，生成 `<heuristic>` XML 约束块
 * - 约束被注入到发给 LLM 的 system prompt 末尾，实现"修正 prompt"
 * - 每条 pattern 最多注入 1 次，防止撑爆 context
 *
 * 与 tool-healing 的关系：
 * - tool-healing（W7b5a）：在 tool result 中追加 `[Healing Hint X/Y]`，针对单次调用
 * - dynamic-prompt-modifier（§8.12.1）：在 system prompt 中追加 `<heuristic>` 约束，针对重复错误模式
 * - 两者并行工作，互不替代
 *
 * 生命周期：
 * - TaskLoop.send() 开始时 clearAll()（新任务重置）
 * - 工具失败时 record(toolName, errorCode)
 * - 工具成功时 clear(toolName)（该工具所有约束清除）
 * - 调用 provider 前取 buildConstraints() 注入 system prompt
 */

import type { ErrorCode } from '../errors/index.js';
import { ErrorCodes } from '../errors/index.js';

export interface ErrorPattern {
  toolName: string;
  errorCode: ErrorCode | string;
  count: number;
  firstAt: number;
}

export interface PatternMatch {
  patternName: string;
  toolName: string;
  errorCode: ErrorCode | string;
  count: number;
  injected: boolean;
}

/** 触发约束生成的最小重复次数（§8.12.1 从 2→3） */
const CONSTRAINT_THRESHOLD = 3;

/** 预置模式名 → pattern 配置 */
interface PatternDef {
  patternName: string;
  toolName: string;
  errorCode: ErrorCode | string;
  heuristicContent: string;
}

const PATTERNS: PatternDef[] = [
  {
    patternName: 'SEARCH_REPLACE_NO_MATCH',
    toolName: 'search_replace',
    errorCode: ErrorCodes.TOOL_PATCH_NO_MATCH,
    heuristicContent: '每次编辑前先 read_file 取得当前文件确切内容。对缩进使用精确匹配。如果匹配不到，用 read_file 确认后再重试。',
  },
  {
    patternName: 'SEARCH_REPLACE_AMBIGUOUS',
    toolName: 'search_replace',
    errorCode: ErrorCodes.TOOL_PATCH_UNIQUE_FAIL,
    heuristicContent: '当同一段代码在文件中多次出现时，请在 old_string 前/后增加 2-3 行上下文使其唯一。',
  },
  {
    patternName: 'WRITE_FILE_TIMEOUT',
    toolName: 'write_file',
    errorCode: ErrorCodes.TOOL_EXEC_FAILED,
    heuristicContent: '单次写入不要超过 100KB。大文件拆分为多次 write_file + append_file。',
  },
  {
    patternName: 'TOOL_ARGS_INVALID_JSON',
    toolName: '',
    errorCode: ErrorCodes.TOOL_ARGS_INVALID_JSON,
    heuristicContent: '所有工具参数必须是严格合法 JSON：无注释、无尾随逗号、字符串引号正确转义、结构完整闭合。',
  },
];

export class DynamicPromptModifier {
  private patterns = new Map<string, ErrorPattern>();
  /** 已注入的 pattern 名集合（防止重复注入撑爆 context） */
  private injectedPatterns = new Set<string>();

  /** 记录一次工具失败 */
  record(toolName: string, errorCode: ErrorCode | string): void {
    const k = key(toolName, errorCode);
    const existing = this.patterns.get(k);
    if (existing) {
      existing.count++;
    } else {
      this.patterns.set(k, { toolName, errorCode, count: 1, firstAt: Date.now() });
    }
  }

  /** 工具成功执行后，清除该工具的所有错误模式 */
  clear(toolName: string): void {
    for (const k of this.patterns.keys()) {
      if (k.startsWith(`${toolName}:`)) {
        this.patterns.delete(k);
      }
    }
  }

  /** 任务开始时清空所有记录 */
  clearAll(): void {
    this.patterns.clear();
    this.injectedPatterns.clear();
  }

  /** 是否有满足阈值的有效约束 */
  hasConstraints(): boolean {
    for (const p of this.patterns.values()) {
      if (p.count >= CONSTRAINT_THRESHOLD) return true;
    }
    return false;
  }

  /** 检测指定 (toolName, errorCode) 是否已达到注入阈值且未注入过 */
  detectPattern(toolName: string, errorCode: ErrorCode | string): PatternMatch | null {
    const k = key(toolName, errorCode);
    const ep = this.patterns.get(k);
    if (!ep || ep.count < CONSTRAINT_THRESHOLD) return null;
    // 查找匹配的预置 pattern 名
    for (const p of PATTERNS) {
      if (p.errorCode === errorCode && (p.toolName === '' || p.toolName === toolName)) {
        return {
          patternName: p.patternName,
          toolName,
          errorCode,
          count: ep.count,
          injected: this.injectedPatterns.has(p.patternName),
        };
      }
    }
    return null;
  }

  /** 标记某 pattern 已注入（防止重复注入撑爆 context） */
  markInjected(patternName: string): void {
    this.injectedPatterns.add(patternName);
  }

  /** 生成所有满足阈值的运行时约束文本（<heuristic> XML 格式） */
  buildConstraints(): string[] {
    const out: string[] = [];
    for (const p of this.patterns.values()) {
      if (p.count >= CONSTRAINT_THRESHOLD) {
        const c = constraintFor(p);
        if (c) out.push(c);
      }
    }
    return out;
  }

  /** 返回当前所有错误模式（调试用） */
  snapshot(): ErrorPattern[] {
    return Array.from(this.patterns.values());
  }
}

function key(toolName: string, code: ErrorCode | string): string {
  return `${toolName}:${code}`;
}

/** 按匹配的模式生成 <heuristic> 格式约束 */
function constraintFor(p: ErrorPattern): string | null {
  for (const def of PATTERNS) {
    if (def.errorCode === p.errorCode && (def.toolName === '' || def.toolName === p.toolName)) {
      return `<heuristic pattern="${def.patternName}" count="${p.count}">\n${def.heuristicContent}\n</heuristic>`;
    }
  }
  return null;
}
