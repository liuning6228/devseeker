/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ProblemsBridge —— 诊断（VSCode Problems 面板）抽象层（W7e1）
 *
 * 职责：
 * - 统一 VSCode `languages.getDiagnostics(uri?)` 输出的坐标与路径约定
 * - 对外 1-based 行列 + 工作区相对路径（POSIX 分隔符）
 * - 便于单测注入假桥接器
 */

/** 诊断严重级（对齐 vscode.DiagnosticSeverity，但降为字符串枚举） */
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/** 单条诊断（扁平结构，便于 LLM 消费） */
export interface DiagnosticItem {
  /** 工作区相对路径（POSIX '/' 分隔） */
  filePath: string;
  severity: DiagnosticSeverity;
  message: string;
  /** 1-based 起始行 */
  line: number;
  /** 1-based 起始列 */
  character: number;
  /** 1-based 结束行 */
  endLine: number;
  /** 1-based 结束列 */
  endCharacter: number;
  /** 诊断来源，如 'ts' / 'eslint' / 'tsc' */
  source?: string;
  /** 诊断码，如 '2304' / 'no-unused-vars' */
  code?: string | number;
}

/** 查询选项 */
export interface GetDiagnosticsOptions {
  /** 可选：限定这些文件（相对工作区 / 绝对路径）；未提供则返回工作区所有诊断 */
  filePaths?: string[];
  /** 可选：最低严重级（含）。默认 'hint'（全部） */
  minSeverity?: DiagnosticSeverity;
}

/** 桥接器接口 */
export interface ProblemsBridge {
  getDiagnostics(opts?: GetDiagnosticsOptions): Promise<DiagnosticItem[]>;
}

/** 严重级由高到低的数字权重（error=0 最严重） */
export const SEVERITY_ORDER: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
} as const;

/** vscode.DiagnosticSeverity 枚举值 → 字符串（纯数字映射，避免引入 vscode 包） */
export function mapSeverity(v: number): DiagnosticSeverity {
  switch (v) {
    case 0:
      return 'error';
    case 1:
      return 'warning';
    case 2:
      return 'info';
    case 3:
      return 'hint';
    default:
      return 'info';
  }
}
