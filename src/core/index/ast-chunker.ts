/**
 * Copyright (c) 2026 DualMind Contributors
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

interface SyntaxNode {
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

interface Parser {
  parse(content: string): { rootNode: SyntaxNode };
  delete(): void;
}

/** 加载 tree-sitter WASM 基础设施 */
async function ensureWasmModule(): Promise<void> {
  if (parserInitialized) return;
  try {
    const Parser = require('web-tree-sitter');
    await Parser.init();
    parserInitialized = true;
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'web-tree-sitter init failed, falling back to line-based chunker');
    parserInitialized = false;
  }
}

/** 获取指定语言的 parser（懒加载 WASM 语法文件） */
async function getParser(langId: string): Promise<Parser | null> {
  if (!parserInitialized) return null;
  const cached = parserCache.get(langId);
  if (cached) return cached;
  const wasmFile = LANG_TO_WASM[langId];
  if (!wasmFile) return null;
  try {
    const Parser = require('web-tree-sitter');
    const parser = new Parser();
    // 从 tree-sitter-wasms 包中加载 WASM 语法文件
    const wasmPath = require.resolve(`tree-sitter-wasms/out/${wasmFile}`);
    const fs = require('node:fs');
    const wasmBytes = fs.readFileSync(wasmPath).buffer as ArrayBuffer;
    const lang = await Parser.Language.load(wasmBytes);
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

function extractTopLevelNodes(root: SyntaxNode, langId: string): SyntaxNode[] {
  const queries = LANG_QUERIES[langId];
  if (!queries) return [root];
  const result: SyntaxNode[] = [];
  collectNodes(root, queries, result);
  if (result.length === 0) return [root];
  return result.sort((a, b) => a.startPosition.row - b.startPosition.row);
}

// ─────────── 超大函数二次切分 ───────────

const MAX_CHUNK_CHARS = 1600;
const MIN_CHUNK_CHARS = 80;

function splitLargeNode(node: SyntaxNode, filePath: string, maxChars: number): TextChunk[] {
  const lines = node.text.split('\n');
  const result: TextChunk[] = [];
  const baseLine = node.startPosition.row;
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
    const text = lines.slice(cursor, end).join('\n');
    result.push({
      filePath,
      startLine: baseLine + cursor + 1,
      endLine: baseLine + end,
      text,
    });
    cursor = end;
    if (cursor >= lines.length) break;
  }
  return result;
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
    return chunkVueSfc(filePath, content, options);
  }

  // 尝试 AST 切分；失败时回退
  try {
    await ensureWasmModule();
    const parser = await getParser(langId);
    if (!parser) {
      return chunkText(filePath, content, options);
    }

    const tree = parser.parse(content);
    const root = tree.rootNode;
    const nodes = extractTopLevelNodes(root, langId);

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

    parser.delete();

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
function chunkVueSfc(
  filePath: string,
  content: string,
  options: ChunkOptions = {},
): TextChunk[] {
  // 尝试用 tree-sitter 解析
  const astChunks = chunkVueSfcWithTreeSitter(filePath, content, options);
  if (astChunks) return astChunks;

  // 回退到正则按标签块分割
  return chunkVueSfcRegex(filePath, content, options);
}

/**
 * 用 tree-sitter-vue WASM 解析 Vue SFC 并切分。
 * 返回 null 表示 tree-sitter 不可用，调用方应回退到正则。
 */
function chunkVueSfcWithTreeSitter(
  filePath: string,
  content: string,
  options: ChunkOptions = {},
): TextChunk[] | null {
  if (!parserInitialized) return null;

  try {
    const Parser = require('web-tree-sitter');
    const parser = new Parser();
    const wasmFile = LANG_TO_WASM.vue!;
    const wasmPath = require.resolve(`tree-sitter-wasms/out/${wasmFile}`);
    const fs = require('node:fs');
    const wasmBytes = fs.readFileSync(wasmPath).buffer as ArrayBuffer;
    const lang = Parser.Language.load(wasmBytes);
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
          const lines = scriptContent.split('\n');
          for (let i = 0; i < lines.length; i += 40) {
            const slice = lines.slice(i, i + 40).join('\n');
            chunks.push({
              filePath,
              startLine: scriptNode.startPosition.row + 1 + i,
              endLine: Math.min(
                scriptNode.startPosition.row + 1 + i + 39,
                scriptNode.endPosition.row + 1,
              ),
              text: `[vue-script:${i + 1}-${Math.min(i + 40, lines.length)}]\n${slice}`,
            });
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
        // 按行拆分
        const lines = scriptText.split('\n');
        for (let i = 0; i < lines.length; i += 40) {
          const slice = lines.slice(i, i + 40).join('\n');
          const chunkStart = lineOffset + i;
          chunks.push({
            filePath,
            startLine: chunkStart,
            endLine: chunkStart + Math.min(40, lines.length - i) - 1,
            text: `[vue-script:${i + 1}-${Math.min(i + 40, lines.length)}]\n${slice}`,
          });
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
