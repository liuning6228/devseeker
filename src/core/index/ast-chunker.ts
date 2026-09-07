/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * AST 语法感知分块器（M4-tree-sitter）
 *
 * 替代按行滑窗切分，使用 tree-sitter WASM 做语法感知切分：
 * - TypeScript/JavaScript → function / class / method / exported const
 * - Python → function / class / method
 * - Java → method / class
 * - Go → func / method / struct
 * - Rust → fn / impl / struct
 * - 其他语言 → 回退到按行滑窗（兼容原有的 chunkText）
 *
 * 接口与 chunkText 完全兼容：`astChunkText(filePath, content, options?) → TextChunk[]`
 *
 * 设计原则：
 * - WASM 文件懒加载（每个语言只加载一次）
 * - 单 chunk ≤ 400 token（~1600 chars）
 * - 单 chunk ≥ 20 token（~80 chars），过短合并到上一个
 * - 超大函数（> 400 token）按语句块二次切分，每片附上下文头
 * - 符号名称嵌入 chunk 前缀，让 search_codebase 向量命中上下文更精确
 */
import type { TextChunk, ChunkOptions } from './chunker.js';
import { chunkText } from './chunker.js';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('index.ast-chunker');

// ─────────── 语言 → WASM 文件映射 ───────────

/** 扩展名 → tree-sitter 语言 ID */
const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
  '.py': 'py', '.java': 'java', '.go': 'go', '.rs': 'rs',
  '.vue': 'vue',
};

/** 语言 ID → WASM 文件名（tree-sitter-wasms 包中的文件名） */
const LANG_TO_WASM: Record<string, string> = {
  ts: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  js: 'tree-sitter-javascript.wasm',
  py: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
  go: 'tree-sitter-go.wasm',
  rs: 'tree-sitter-rust.wasm',
  vue: 'tree-sitter-vue.wasm',
};

/** 可被 AST 切分的扩展名集合 */
export const AST_SUPPORTED_EXTS = new Set(Object.keys(EXT_TO_LANG));

// ─────────── 类型定义 ───────────

interface Point { row: number; column: number; }

export interface SyntaxNode {
  type: string;
  startPosition: Point;
  endPosition: Point;
  text: string;
  children: SyntaxNode[];
}

/** 每种语言的 AST 查询节点类型集合 */
const LANG_QUERIES: Record<string, string[]> = {
  ts:  ['function_declaration', 'method_definition', 'class_declaration',
        'interface_declaration', 'lexical_declaration'],
  tsx: ['function_declaration', 'method_definition', 'class_declaration',
        'interface_declaration', 'lexical_declaration', 'arrow_function'],
  js:  ['function_declaration', 'method_definition', 'class_declaration',
        'lexical_declaration'],
  py:  ['function_definition', 'class_definition'],
  java:['method_declaration', 'class_declaration', 'interface_declaration'],
  go:  ['function_declaration', 'method_declaration', 'type_declaration'],
  rs:  ['function_item', 'struct_item', 'impl_item', 'trait_item',
        'enum_item', 'type_item'],
  vue: ['template_element', 'script_element', 'style_element',
        'text', 'start_tag', 'end_tag', 'attribute'],
};

/** 节点类型 → 人类可读标签 */
const TYPE_LABEL: Record<string, string> = {
  function_declaration: 'function', method_definition: 'method',
  class_declaration: 'class', interface_declaration: 'interface',
  function_definition: 'function', class_definition: 'class',
  method_declaration: 'method', function_item: 'fn',
  struct_item: 'struct', impl_item: 'impl', trait_item: 'trait',
  enum_item: 'enum', export_statement: 'export',
  lexical_declaration: 'const', arrow_function: 'arrow',
  type_declaration: 'type', type_item: 'type',
};

// ─────────── 运行时状态 ───────────

/** Parser 初始化标记 */
let parserInitialized = false;
const parserCache = new Map<string, Parser>();

/** Parser 接口（供 graph-extractor 复用） */
export interface TreeSitterParser {
  parse(content: string): { rootNode: SyntaxNode };
  delete(): void;
}

interface Parser {
  parse(content: string): { rootNode: SyntaxNode };
  delete(): void;
}

/** 加载 tree-sitter WASM 基础设施 */
export async function ensureWasmModule(): Promise<void> {
  if (parserInitialized) return;
  try {
    // 兼容 web-tree-sitter 0.23-0.24（模块直接导出 Parser 类）与 0.25+
    // （模块导出 { Parser, Language, ... } 命名空间）：init 是类的静态方法。
    // 另需兼容 vitest 等 ESM interop 把 CJS 类导出包装为 { default: Ctor } 的形态。
    const mod = require('web-tree-sitter');
    const ParserCtor = mod.Parser ?? mod.default ?? mod;
    if (typeof ParserCtor.init === 'function') {
      await ParserCtor.init();
      // 0.24 的 Emscripten UMD 尾部在 init() 完成时执行 `module.exports = Module`，
      // 会把 require.cache 的导出覆盖为内部 Module 对象，同一进程后续 require 拿不到 Parser 类。
      // 恢复 init 前的原始导出，保证二次 require 形态稳定（0.25+ 无此行为，恢复同样无害）。
      try {
        const resolved = require.resolve('web-tree-sitter');
        const cached = require.cache[resolved];
        if (cached) cached.exports = mod;
      } catch {
        /* ignore: 恢复失败时按原样回退 */
      }
    }
    parserInitialized = true;
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'web-tree-sitter init failed, falling back to line-based chunker');
    parserInitialized = false;
  }
}

/** 获取指定语言的 parser（懒加载 WASM 语法文件） */
export async function getParser(langId: string): Promise<Parser | null> {
  if (!parserInitialized) return null;
  const cached = parserCache.get(langId);
  if (cached) return cached;
  const wasmFile = LANG_TO_WASM[langId];
  if (!wasmFile) return null;
  try {
    const mod = require('web-tree-sitter');
    // 0.25+ 命名空间导出 { Parser, Language }；旧版直接导出带静态 Language 的 Parser 类
    // （vitest interop 下表现为 { default: Ctor }，ParserCtor 需兼容三种形态）
    const ParserCtor = mod.Parser ?? mod.default ?? mod;
    const LanguageCtor = mod.Language ?? ParserCtor.Language;
    const parser = new ParserCtor();
    // 从 tree-sitter-wasms 包中加载 WASM 语法文件
    const wasmPath = require.resolve(`tree-sitter-wasms/out/${wasmFile}`);
    const fs = require('node:fs');
    // Language.load 的 input 同时兼容 Uint8Array（含 Buffer 子类）与文件路径：
    // 直接传 readFileSync 的 Buffer 在 0.24 与 0.26 两种 ABI 下都可用
    const lang = await LanguageCtor.load(fs.readFileSync(wasmPath));
    parser.setLanguage(lang);
    parserCache.set(langId, parser);
    return parser;
  } catch (e) {
    log.warn({ lang: langId, err: (e as Error).message }, 'failed to load tree-sitter WASM grammar');
    return null;
  }
}

// ─────────── 名称提取 ───────────

function extractName(node: SyntaxNode): string | undefined {
  const nameTypes = new Set(['identifier', 'property_identifier', 'type_identifier', 'name']);
  for (const child of node.children) {
    if (nameTypes.has(child.type)) return child.text;
    // Python function_definition 的 name 在 'name' 字段子节点
    if (child.type === 'identifier') return child.text;
  }
  return undefined;
}

function getContextPrefix(node: SyntaxNode, filePath: string): string {
  const name = extractName(node);
  const kind = TYPE_LABEL[node.type] ?? node.type;
  const symbol = name ? `${kind} ${name}` : kind;
  return `// file: ${filePath} :: ${symbol} (lines ${node.startPosition.row + 1}-${node.endPosition.row + 1})`;
}

// ─────────── AST 节点扁平化 ───────────

function collectNodes(node: SyntaxNode, queries: string[], result: SyntaxNode[]): void {
  if (queries.includes(node.type)) {
    result.push(node);
    return; // 不递归进入已匹配的顶级节点内部
  }
  for (const child of node.children) {
    collectNodes(child, queries, result);
  }
}

function extractTopLevelNodes(root: SyntaxNode, langId: string): SyntaxNode[] | null {
  const queries = LANG_QUERIES[langId];
  if (!queries) return null;
  const result: SyntaxNode[] = [];
  collectNodes(root, queries, result);
  if (result.length === 0) return null;
  return result.sort((a, b) => a.startPosition.row - b.startPosition.row);
}

// ─────────── 超大函数二次切分 ───────────

const MAX_CHUNK_CHARS = 1600;
const MIN_CHUNK_CHARS = 80;

function splitLinesIntoChunks(
  lines: string[],
  baseLine: number,
  filePath: string,
  maxChars: number,
): TextChunk[] {
  const result: TextChunk[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    let end = cursor;
    let charCount = 0;
    while (end < lines.length) {
      const lineLen = lines[end].length + 1;
      if (charCount + lineLen > maxChars && end > cursor) break;
      charCount += lineLen;
      end++;
    }
    result.push({
      filePath,
      startLine: baseLine + cursor + 1,
      endLine: baseLine + end,
      text: lines.slice(cursor, end).join('\n'),
    });
    cursor = end;
  }
  return result;
}

function splitLargeNode(node: SyntaxNode, filePath: string, maxChars: number): TextChunk[] {
  // 行级字符滑窗：单 chunk ≤ maxChars（超长单行不拆，保持行完整性）
  return splitLinesIntoChunks(node.text.split('\n'), node.startPosition.row, filePath, maxChars);
}

// ─────────── 主入口 ───────────

/**
 * 扩展名 → 语言 ID 映射
 */
export function extToLangId(filePath: string): string | undefined {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return EXT_TO_LANG[ext];
}

/**
 * 语言 ID → WASM 文件名
 */
export function langToWasmFile(langId: string): string | undefined {
  return LANG_TO_WASM[langId];
}

/**
 * AST 语法感知切分。签名与 `chunkText` 完全一致。
 *
 * 对于支持的语言（TS/JS/Py/Java/Go/Rust），使用 tree-sitter 按语法节点切分；
 * 其他语言回退到行滑窗。
 *
 * @param filePath - 文件相对路径（用于扩展名检测 + 上下文头）
 * @param content - 文件内容
 * @param options - 可选参数（maxChars / minChars 等，与 chunkText 兼容）
 */
export async function astChunkText(
  filePath: string,
  content: string,
  options: ChunkOptions = {},
): Promise<TextChunk[]> {
  const maxChars = options.maxChars ?? MAX_CHUNK_CHARS;
  const minChars = options.minChars ?? MIN_CHUNK_CHARS;
  const langId = extToLangId(filePath);

  // 不支持的语言 → 回退到同步的行滑窗
  if (!langId) {
    return chunkText(filePath, content, options);
  }

  // §8.16.1 · Vue SFC 特殊处理：三层独立 chunk
  if (langId === 'vue') {
    return await chunkVueSfc(filePath, content, options);
  }

  // 尝试 AST 切分；失败时回退
  try {
    // 与 chunkText 对齐：空/空白内容不产生 chunk（跳过无意义的 WASM parse）
    if (!content.trim()) return [];
    await ensureWasmModule();
    const parser = await getParser(langId);
    if (!parser) {
      return chunkText(filePath, content, options);
    }

    const tree = parser.parse(content);
    const root = tree.rootNode;
    const nodes = extractTopLevelNodes(root, langId);
    // 无语法节点（纯数据/标识符文件）→ 退化为行式切分：
    // 避免把整个文件包装成带前缀的单个 chunk，稀释向量命中
    if (!nodes) {
      return chunkText(filePath, content, options);
    }

    // 提取节点区间之外的间隙文本（注释 / import / 杂散行）作为独立 chunk，
    // 保证 AST 切分不丢内容：注释常承载搜索语义（中文说明等），丢注释等于丢索引
    const coveredRows = new Set<number>();
    for (const node of nodes) {
      for (let r = node.startPosition.row; r <= node.endPosition.row; r++) coveredRows.add(r);
    }
    const contentLines = content.split('\n');
    const gapChunks: TextChunk[] = [];
    let gapStart = -1;
    const flushGap = (endRow: number): void => {
      if (gapStart < 0) return;
      const text = contentLines.slice(gapStart, endRow + 1).join('\n');
      if (text.trim()) {
        if (text.length <= maxChars) {
          gapChunks.push({ filePath, startLine: gapStart + 1, endLine: endRow + 1, text });
        } else {
          // 超大间隙（如整块 LICENSE 头注释）按 maxChars 二次切分，
          // 保持「单 chunk ≤ maxChars」的容量约束
          gapChunks.push(...splitLinesIntoChunks(contentLines.slice(gapStart, endRow + 1), gapStart, filePath, maxChars));
        }
      }
      gapStart = -1;
    };
    for (let r = 0; r < contentLines.length; r++) {
      if (coveredRows.has(r)) {
        flushGap(r - 1);
      } else if (gapStart < 0) {
        gapStart = r;
      }
    }
    flushGap(contentLines.length - 1);

    const chunks: TextChunk[] = [];

    for (const node of nodes) {
      const nodeChars = node.text.length;
      if (nodeChars <= maxChars) {
        // 正常大小节点：作为一个 chunk，带上下文头
        const prefix = getContextPrefix(node, filePath);
        chunks.push({
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          text: `${prefix}\n${node.text}`,
        });
      } else {
        // 超大节点：二次切分，每片带上下文头
        const subChunks = splitLargeNode(node, filePath, maxChars);
        const prefix = getContextPrefix(node, filePath);
        for (const sc of subChunks) {
          sc.text = `${prefix}\n${sc.text}`;
          chunks.push(sc);
        }
      }
    }

    // 注意：不能在此调用 parser.delete() —— parser 由 parserCache 缓存共享，
    // 销毁后同语言下次调用 getParser 会拿到已失效实例，parse 时 WASM 内存越界。
    // parser 生命周期终止于进程退出，无需显式释放。

    // 节点 chunk 与间隙 chunk 合并，按行号排序保持原文顺序
    chunks.push(...gapChunks);
    chunks.sort((a, b) => a.startLine - b.startLine);

    // 合并过短的尾部 chunk
    if (chunks.length >= 2) {
      const last = chunks[chunks.length - 1];
      if (last.text.length < minChars) {
        const prev = chunks[chunks.length - 2];
        prev.text = `${prev.text}\n${last.text}`;
        prev.endLine = last.endLine;
        chunks.pop();
      }
    }

    return chunks;
  } catch (e) {
    log.warn({ filePath, err: (e as Error).message }, 'astChunkText failed, falling back to line-based chunker');
    return chunkText(filePath, content, options);
  }
}

// ─────────── §8.16.1 · Vue SFC 三层切分 ───────────

/**
 * 对 Vue SFC 做三层感知切分：<template> / <script> / <style> 各为独立 chunk。
 * 优先使用 tree-sitter-vue WASM（若可用），失败时回退到正则按标签块分割。
 */
async function chunkVueSfc(
  filePath: string,
  content: string,
  options: ChunkOptions = {},
): Promise<TextChunk[]> {
  // 尝试用 tree-sitter 解析
  const astChunks = await chunkVueSfcWithTreeSitter(filePath, content, options);
  if (astChunks) return astChunks;

  // 回退到正则按标签块分割
  return chunkVueSfcRegex(filePath, content, options);
}

/**
 * 用 tree-sitter-vue WASM 解析 Vue SFC 并切分。
 * 返回 null 表示 tree-sitter 不可用，调用方应回退到正则。
 */
async function chunkVueSfcWithTreeSitter(
  filePath: string,
  content: string,
  options: ChunkOptions = {},
): Promise<TextChunk[] | null> {
  // 必须先初始化 WASM 基础设施：vue 可能是本会话首个被处理的文件类型。
  // 主流程 AST 分支会调 ensureWasmModule，但 vue 先走本分支，不能依赖主流程。
  await ensureWasmModule();
  if (!parserInitialized) return null;

  try {
    const mod = require('web-tree-sitter');
    const ParserCtor = mod.Parser ?? mod.default ?? mod;
    const LanguageCtor = mod.Language ?? ParserCtor.Language;
    const parser = new ParserCtor();
    const wasmFile = LANG_TO_WASM.vue!;
    const wasmPath = require.resolve(`tree-sitter-wasms/out/${wasmFile}`);
    const fs = require('node:fs');
    const lang = await LanguageCtor.load(fs.readFileSync(wasmPath));
    parser.setLanguage(lang);

    const tree = parser.parse(content);
    const root = tree.rootNode;
    const maxChars = options.maxChars ?? MAX_CHUNK_CHARS;
    const chunks: TextChunk[] = [];

    let templateNode: SyntaxNode | null = null;
    let scriptNode: SyntaxNode | null = null;
    let styleNode: SyntaxNode | null = null;

    // 查找三个顶级元素：template_element / script_element / style_element
    for (const child of root.children) {
      if (child.type === 'template_element' && !templateNode) {
        templateNode = child;
      } else if (child.type === 'script_element' && !scriptNode) {
        scriptNode = child;
      } else if (child.type === 'style_element' && !styleNode) {
        styleNode = child;
      }
    }

    // template chunk
    if (templateNode) {
      const templateContent = extractTagContent(templateNode);
      const elTags = extractElementPlusTags(templateNode.text);
      const tagHint = elTags.length > 0 ? ` [el-tags: ${elTags.join(', ')}]` : '';
      chunks.push({
        filePath,
        startLine: templateNode.startPosition.row + 1,
        endLine: templateNode.endPosition.row + 1,
        text: `[vue-template]${tagHint}\n${templateContent.trim()}`,
      });
    }

    // script chunk
    if (scriptNode) {
      const scriptContent = extractTagContent(scriptNode);
      if (scriptContent) {
        if (scriptContent.length <= maxChars) {
          chunks.push({
            filePath,
            startLine: scriptNode.startPosition.row + 1,
            endLine: scriptNode.endPosition.row + 1,
            text: `[vue-script]\n${scriptContent.trim()}`,
          });
        } else {
          // 按字符上限滑窗切分（与主流程 splitLargeNode 同策略），
          // 避免 40 行硬编码在长行场景下单个 chunk 超出 maxChars
          const lines = scriptContent.split('\n');
          const subChunks = splitLinesIntoChunks(lines, scriptNode.startPosition.row, filePath, maxChars);
          for (const sc of subChunks) {
            const from = sc.startLine - scriptNode.startPosition.row;
            const to = sc.endLine - scriptNode.startPosition.row;
            sc.text = `[vue-script:${from}-${to}]\n${sc.text}`;
            chunks.push(sc);
          }
        }
      }
    }

    // style chunk
    if (styleNode) {
      const styleContent = extractTagContent(styleNode);
      chunks.push({
        filePath,
        startLine: styleNode.startPosition.row + 1,
        endLine: styleNode.endPosition.row + 1,
        text: `[vue-style]\n${styleContent.trim()}`,
      });
    }

    parser.delete();

    if (chunks.length === 0) return null;
    return chunks;
  } catch {
    return null; // tree-sitter 不可用 → 回退正则
  }
}

/**
 * 从 Vue SFC AST 节点（template_element / script_element / style_element）中提取标签内的文本。
 * 跳过开闭标签的文本。
 */
function extractTagContent(node: SyntaxNode): string {
  // tree-sitter-vue 的 template_element 结构：children = [{tag_open}, {text?}, {tag_close}]
  // 我们需要中间的文本内容
  let content = '';
  for (const child of node.children) {
    if (child.type === 'text' || child.type === 'template_text') {
      content += child.text;
    } else if (child.type === 'start_tag' || child.type === 'end_tag') {
      // 跳过标签本身
      continue;
    }
  }
  // 若上述方式未提取到内容（不同版本 tree-sitter-vue 结构差异），
  // 用整体文本减去首尾标签的近似方法
  if (!content && node.text) {
    const text = node.text;
    const firstLt = text.indexOf('>');
    const lastLt = text.lastIndexOf('<');
    if (firstLt > 0 && lastLt > firstLt) {
      content = text.slice(firstLt + 1, lastLt).trim();
    }
  }
  return content;
}

/**
 * 正则回退版 Vue SFC 切分。
 */
function chunkVueSfcRegex(
  filePath: string,
  content: string,
  options: ChunkOptions = {},
): TextChunk[] {
  const maxChars = options.maxChars ?? 1600;
  const chunks: TextChunk[] = [];

  // 提取 <template> 块
  const templateMatch = content.match(/<template>([\s\S]*?)<\/template>/);
  if (templateMatch) {
    const lineOffset = content.slice(0, templateMatch.index!).split('\n').length;
    const tagLines = templateMatch[0]!.split('\n').length;
    // 提取 el-* 标签列表用于元数据标注
    const elTags = extractElementPlusTags(templateMatch[0]!);
    const tagHint = elTags.length > 0 ? ` [el-tags: ${elTags.join(', ')}]` : '';
    chunks.push({
      filePath,
      startLine: lineOffset,
      endLine: lineOffset + tagLines - 1,
      text: `[vue-template]${tagHint}\n${templateMatch[1]!.trim()}`,
    });
  }

  // 提取 <script> / <script setup> 块
  const scriptMatch = content.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
  if (scriptMatch) {
    const lineOffset = content.slice(0, scriptMatch.index!).split('\n').length;
    const tagLines = scriptMatch[0]!.split('\n').length;
    const scriptText = scriptMatch[1]!.trim();
    if (scriptText) {
      // 超过最大字符数时做二次切分
      if (scriptText.length <= maxChars) {
        chunks.push({
          filePath,
          startLine: lineOffset,
          endLine: lineOffset + tagLines - 1,
          text: `[vue-script]\n${scriptText}`,
        });
      } else {
        // 按字符上限滑窗切分（与 AST 分支同策略），避免长行场景超出 maxChars
        const lines = scriptText.split('\n');
        const subChunks = splitLinesIntoChunks(lines, lineOffset - 1, filePath, maxChars);
        for (const sc of subChunks) {
          const from = sc.startLine - lineOffset + 1;
          const to = sc.endLine - lineOffset + 1;
          sc.text = `[vue-script:${from}-${to}]\n${sc.text}`;
          chunks.push(sc);
        }
      }
    }
  }

  // 提取 <style> / <style scoped> 块
  const styleMatch = content.match(/<style\b[^>]*>([\s\S]*?)<\/style>/);
  if (styleMatch) {
    const lineOffset = content.slice(0, styleMatch.index!).split('\n').length;
    const tagLines = styleMatch[0]!.split('\n').length;
    chunks.push({
      filePath,
      startLine: lineOffset,
      endLine: lineOffset + tagLines - 1,
      text: `[vue-style]\n${styleMatch[1]!.trim()}`,
    });
  }

  // 若未匹配到任何标签，回退到全文滑窗
  if (chunks.length === 0) {
    const { chunkText } = require('./chunker.js');
    return chunkText(filePath, content, options);
  }

  return chunks;
}

/** 从 template 文本中提取 Element Plus 标签名（el-*） */
function extractElementPlusTags(templateText: string): string[] {
  const tags = new Set<string>();
  const tagRegex = /<(\w[\w-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(templateText)) !== null) {
    const tagName = m[1]!;
    if (/^el-/i.test(tagName)) {
      tags.add(tagName);
    }
  }
  return Array.from(tags).sort();
}
