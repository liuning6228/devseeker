/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * LspBridge —— 封装 VSCode LSP 命令（W4 批次 1）
 *
 * 职责：
 * - 统一 VSCode 内置 executeXxxProvider 命令的输入输出
 * - 所有坐标：1-based 行列（面向 LLM；内部转 VSCode 的 0-based Position）
 * - 所有路径：工作区相对路径（POSIX 分隔符）
 *
 * 抽象原因：
 * - 便于单测注入假桥接器，不需启动真实 LSP 服务
 * - 便于将来换宿主（如 CLI）时替换实现
 */

/** 1-based 行列坐标 */
export interface LspPosition {
  /** 1-based 行号（含） */
  line: number;
  /** 1-based 列号（含） */
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  /** 工作区相对路径，POSIX 分隔符 */
  filePath: string;
  range: LspRange;
  /** 可选：引用处或定义处的预览文本（单行） */
  preview?: string;
}

/** 符号种类（对齐 LSP SymbolKind 子集） */
export type LspSymbolKind =
  | 'file'
  | 'module'
  | 'namespace'
  | 'package'
  | 'class'
  | 'method'
  | 'property'
  | 'field'
  | 'constructor'
  | 'enum'
  | 'interface'
  | 'function'
  | 'variable'
  | 'constant'
  | 'struct'
  | 'event'
  | 'type_parameter'
  | 'other';

export interface LspSymbol {
  name: string;
  kind: LspSymbolKind;
  /** 父层级（如 class 内的 method 会带 className） */
  containerName?: string;
  location: LspLocation;
}

/** 调用链条目（W7e3）——对齐 VSCode CallHierarchyItem 扁平化 */
export interface CallHierarchyEntry {
  name: string;
  kind: LspSymbolKind;
  /** 详细选区（符号精确位置） */
  location: LspLocation;
  /** 调用点列表（仅 incomingCalls/outgoingCalls 时填充） */
  fromRanges?: LspRange[];
}

/**
 * 桥接器接口：所有 LSP 能力的抽象入口。
 */
export interface LspBridge {
  goToDefinition(filePath: string, position: LspPosition): Promise<LspLocation[]>;
  findReferences(
    filePath: string,
    position: LspPosition,
    includeDeclaration?: boolean,
  ): Promise<LspLocation[]>;
  documentSymbols(filePath: string): Promise<LspSymbol[]>;
  workspaceSymbols(query: string, limit?: number): Promise<LspSymbol[]>;
  /** W7e3 · 查找接口/抽象方法的实现位置 */
  goToImplementation(filePath: string, position: LspPosition): Promise<LspLocation[]>;
  /** W7e3 · 查询调用链：direction='incoming'=谁调了我 / 'outgoing'=我调了谁 */
  callHierarchy(
    filePath: string,
    position: LspPosition,
    direction: 'incoming' | 'outgoing',
  ): Promise<CallHierarchyEntry[]>;
}

/**
 * VSCode SymbolKind（0-based）→ 本层字符串枚举。
 * 仅依赖纯数字常量以避免在测试环境引入 vscode 包。
 */
export function mapSymbolKind(kind: number): LspSymbolKind {
  // 对应 vscode.SymbolKind 枚举
  switch (kind) {
    case 0:
      return 'file';
    case 1:
      return 'module';
    case 2:
      return 'namespace';
    case 3:
      return 'package';
    case 4:
      return 'class';
    case 5:
      return 'method';
    case 6:
      return 'property';
    case 7:
      return 'field';
    case 8:
      return 'constructor';
    case 9:
      return 'enum';
    case 10:
      return 'interface';
    case 11:
      return 'function';
    case 12:
      return 'variable';
    case 13:
      return 'constant';
    case 22:
      return 'struct';
    case 23:
      return 'event';
    case 25:
      return 'type_parameter';
    default:
      return 'other';
  }
}
