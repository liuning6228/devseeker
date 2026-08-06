/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * GraphExtractor —— 基于 tree-sitter 的符号/调用关系提取器（P2）
 *
 * 复用 ast-chunker.ts 已加载的 tree-sitter WASM 基础设施，
 * 从源码 AST 中提取：
 *   - 符号定义（函数/类/方法/接口）
 *   - 调用关系（每个符号内部调用了哪些其他符号）
 *   - import 语句（用于跨文件解析）
 *
 * 支持语言：TypeScript/JavaScript、Python、Java、Go、Rust
 * 不支持的语言 → 返回空结果（静默降级）
 */

import {
  ensureWasmModule,
  getParser,
  extToLangId,
  type SyntaxNode,
} from './ast-chunker.js';
import { getLogger } from '../../infra/logger.js';
import type {
  SymbolKind,
  ExtractedSymbol,
  ExtractedCall,
  ExtractedImport,
  FileExtractionResult,
} from './graph-index.js';

const log = getLogger('index.graph-extractor');

// ─────────── 语言特定配置 ───────────

/** 每种语言的「定义节点类型 → SymbolKind 映射」 */
const DEFINITION_NODES: Record<string, Record<string, SymbolKind>> = {
  ts: {
    function_declaration: 'function',
    method_definition: 'method',
    class_declaration: 'class',
    interface_declaration: 'interface',
  },
  tsx: {
    function_declaration: 'function',
    method_definition: 'method',
    class_declaration: 'class',
    interface_declaration: 'interface',
  },
  js: {
    function_declaration: 'function',
    method_definition: 'method',
    class_declaration: 'class',
  },
  jsx: {
    function_declaration: 'function',
    method_definition: 'method',
    class_declaration: 'class',
  },
  py: {
    function_definition: 'function',
    class_definition: 'class',
  },
  java: {
    method_declaration: 'method',
    class_declaration: 'class',
    interface_declaration: 'interface',
  },
  go: {
    function_declaration: 'function',
    method_declaration: 'method',
  },
  rs: {
    function_item: 'function',
    struct_item: 'class',
    impl_item: 'class',
    trait_item: 'interface',
  },
};

/** 每种语言的「调用表达式节点类型」 */
const CALL_NODE_TYPES: Record<string, string[]> = {
  ts:  ['call_expression', 'new_expression'],
  tsx: ['call_expression', 'new_expression', 'jsx_self_closing_element', 'jsx_opening_element'],
  js:  ['call_expression', 'new_expression'],
  jsx: ['call_expression', 'new_expression'],
  py:  ['call'],
  java: ['method_invocation'],
  go:  ['call_expression'],
  rs:  ['call_expression', 'macro_invocation'],
};

/** 每种语言的「import 节点类型」 */
const IMPORT_NODE_TYPES: Record<string, string[]> = {
  ts:  ['import_statement'],
  tsx: ['import_statement'],
  js:  ['import_statement'],
  jsx: ['import_statement'],
  py:  ['import_statement', 'import_from_statement'],
  java: ['import_declaration'],
  go:  ['import_spec'],
  rs:  ['use_declaration'],
};

// ─────────── 文件扩展名 → 语言 ID ───────────

function getLangId(filePath: string): string | undefined {
  return extToLangId(filePath);
}

// ─────────── 名称提取 ───────────

/** 从定义节点中提取符号名称 */
function extractSymbolName(node: SyntaxNode): string | undefined {
  const nameTypes = new Set(['identifier', 'property_identifier', 'type_identifier', 'name']);
  for (const child of node.children) {
    if (nameTypes.has(child.type)) return child.text;
  }
  return undefined;
}

/** 从调用表达式中提取被调用函数名 */
function extractCalleeName(node: SyntaxNode, langId: string): string | undefined {
  // TypeScript/JavaScript: call_expression 的 function 子节点
  if (langId === 'ts' || langId === 'tsx' || langId === 'js' || langId === 'jsx') {
    for (const child of node.children) {
      if (child.type === 'identifier') return child.text;
      if (child.type === 'member_expression') {
        // a.b() → 取 b
        return extractMemberName(child);
      }
    }
  }

  // Python: call 的 function 子节点
  if (langId === 'py') {
    for (const child of node.children) {
      if (child.type === 'identifier' || child.type === 'attribute') return child.text;
    }
  }

  // Java: method_invocation
  if (langId === 'java') {
    for (const child of node.children) {
      if (child.type === 'identifier') return child.text;
    }
  }

  // Go: call_expression 的 function 子节点
  if (langId === 'go') {
    for (const child of node.children) {
      if (child.type === 'identifier' || child.type === 'selector_expression') {
        return child.text;
      }
    }
  }

  // Rust: call_expression
  if (langId === 'rs') {
    for (const child of node.children) {
      if (child.type === 'identifier' || child.type === 'field_expression') {
        return child.text;
      }
    }
  }

  // 通用 fallback：取第一个 identifier 类型子节点
  for (const child of node.children) {
    if (child.type === 'identifier') return child.text;
  }

  return undefined;
}

/** 从 member_expression (a.b.c) 中提取最后一段名称 */
function extractMemberName(node: SyntaxNode): string | undefined {
  // member_expression 结构：object . property
  // 取最后的 property_identifier
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];
    if (child.type === 'property_identifier' || child.type === 'identifier') {
      return child.text;
    }
  }
  return undefined;
}

// ─────────── AST 遍历 ───────────

/** 收集所有匹配指定类型的节点 */
function collectNodes(node: SyntaxNode, types: string[], result: SyntaxNode[]): void {
  if (types.includes(node.type)) {
    result.push(node);
  }
  for (const child of node.children) {
    collectNodes(child, types, result);
  }
}

/** 在指定节点范围内收集调用表达式 */
function collectCalls(node: SyntaxNode, callTypes: string[], result: SyntaxNode[]): void {
  if (callTypes.includes(node.type)) {
    result.push(node);
    // 不递归进入调用表达式内部（避免嵌套调用重复计数）
    return;
  }
  for (const child of node.children) {
    collectCalls(child, callTypes, result);
  }
}

// ─────────── Import 解析 ───────────

/** 从 import 节点中提取目标文件和符号 */
function extractImport(node: SyntaxNode, langId: string): ExtractedImport | undefined {
  // 简化处理：提取 import 语句中的所有字符串/标识符
  // 跨文件解析需要模块系统支持，这里只做 best-effort
  const text = node.text;

  // 提取引号中的路径
  const pathMatch = text.match(/['"]([^'"]+)['"]/);
  if (!pathMatch) return undefined;

  const targetFile = pathMatch[1];
  // 跳过非相对路径（node_modules 包）
  if (!targetFile.startsWith('.') && !targetFile.startsWith('/')) {
    return undefined;
  }

  // 提取导入的符号名（简化：取所有 identifier 类型子节点）
  const symbols: string[] = [];
  for (const child of node.children) {
    if (child.type === 'identifier' || child.type === 'property_identifier') {
      symbols.push(child.text);
    }
    // import { a, b, c } from '...'
    if (child.type === 'named_imports' || child.type === 'import_specifiers') {
      for (const spec of child.children) {
        if (spec.type === 'import_specifier' || spec.type === 'identifier') {
          const name = extractSymbolName(spec);
          if (name) symbols.push(name);
        }
      }
    }
  }

  return { targetFile, symbols };
}

// ─────────── 主提取函数 ───────────

/**
 * 从源码中提取符号定义、调用关系和 import 信息
 *
 * @param filePath 文件相对路径（用于确定语言）
 * @param content  文件内容
 * @returns 提取结果；不支持的语言或解析失败时返回空结果
 */
export async function extractGraphData(
  filePath: string,
  content: string,
): Promise<FileExtractionResult> {
  const langId = getLangId(filePath);
  if (!langId) {
    return { filePath, symbols: [], imports: [] };
  }

  const defTypes = DEFINITION_NODES[langId];
  const callTypes = CALL_NODE_TYPES[langId];
  const importTypes = IMPORT_NODE_TYPES[langId];

  if (!defTypes || !callTypes) {
    return { filePath, symbols: [], imports: [] };
  }

  // 初始化 WASM
  await ensureWasmModule();
  const parser = await getParser(langId);
  if (!parser) {
    return { filePath, symbols: [], imports: [] };
  }

  try {
    const tree = parser.parse(content);
    const root = tree.rootNode;

    // 1. 提取定义节点
    const defNodes: SyntaxNode[] = [];
    collectNodes(root, Object.keys(defTypes), defNodes);

    // 2. 对每个定义节点，提取符号 + 内部调用
    const symbols: ExtractedSymbol[] = [];
    for (const defNode of defNodes) {
      const name = extractSymbolName(defNode);
      if (!name) continue;

      const kind = defTypes[defNode.type];
      if (!kind) continue;

      // 在该定义节点内部收集调用
      const callNodes: SyntaxNode[] = [];
      collectCalls(defNode, callTypes, callNodes);

      const calls: ExtractedCall[] = [];
      const seen = new Set<string>();
      for (const callNode of callNodes) {
        const calleeName = extractCalleeName(callNode, langId);
        if (!calleeName) continue;
        // 去重：同一符号在同一函数内多次调用只记一次
        const key = `${calleeName}:${callNode.startPosition.row + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);

        calls.push({
          calleeName,
          callLine: callNode.startPosition.row + 1, // 1-based
        });
      }

      symbols.push({
        name,
        kind,
        startLine: defNode.startPosition.row + 1,
        endLine: defNode.endPosition.row + 1,
        calls,
      });
    }

    // 3. 提取 import 语句
    const imports: ExtractedImport[] = [];
    if (importTypes) {
      const importNodes: SyntaxNode[] = [];
      collectNodes(root, importTypes, importNodes);

      for (const importNode of importNodes) {
        const imp = extractImport(importNode, langId);
        if (imp) imports.push(imp);
      }
    }

    return { filePath, symbols, imports };
  } catch (e) {
    log.warn({ filePath, err: (e as Error).message }, 'graph extraction failed');
    return { filePath, symbols: [], imports: [] };
  }
}

/**
 * 批量提取多个文件的图数据
 */
export async function extractGraphDataBatch(
  files: Array<{ filePath: string; content: string }>,
): Promise<FileExtractionResult[]> {
  const results: FileExtractionResult[] = [];
  for (const file of files) {
    const result = await extractGraphData(file.filePath, file.content);
    results.push(result);
  }
  return results;
}
