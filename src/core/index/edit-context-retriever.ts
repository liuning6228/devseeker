/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * EditContextRetriever —— 编辑前自动检索上下文（§8.15.1）
 *
 * 职责：
 * - 在 search_replace / write_file 执行前，从 CodebaseIndex 检索目标文件的
 *   符号声明信息和同级目录的导出列表
 * - 注入到 system prompt L2 层，帮助 LLM 写出正确的引用
 * - CodebaseIndex 不可用时返回空结果（不阻塞编辑流程）
 */

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'const' | 'type' | 'interface';
  /** 函数/类签名（简略，如 "function dateFormat(date: Date, format: string): string"） */
  signature: string;
  /** 定义起始行（1-based） */
  startLine: number;
}

export interface NearbyExportInfo {
  filePath: string;
  exports: string[];
}

export interface EditContextResult {
  filePath: string;
  symbols: SymbolInfo[];
  nearbyExports: NearbyExportInfo[];
}

/**
 * 从 CodebaseIndex 中提取文件的符号声明信息。
 * 仅在 IndexReader 实现了额外 `getSymbols` 方法时可用。
 * 当前为简化实现：对索引的 search 做针对性查询。
 *
 * @param filePath 目标文件相对路径
 * @param codebaseIndex 索引实例（可能 undefined）
 */
async function extractSymbols(
  filePath: string,
  codebaseIndex?: { search(query: string, topK?: number): Promise<{ filePath: string; text: string; startLine: number }[]> },
): Promise<SymbolInfo[]> {
  if (!codebaseIndex) return [];
  try {
    const hits = await codebaseIndex.search(`file:${filePath}`, 10);
    const symbols: SymbolInfo[] = [];
    for (const h of hits) {
      if (h.filePath !== filePath) continue;
      // 从 chunk 文本中提取函数/类声明第一行
      const firstLine = h.text.split('\n')[0]?.trim() ?? '';
      // 匹配 export function / export class / export const / export type / export interface
      const symMatch = firstLine.match(
        /^export\s+(function|class|const|type|interface)\s+(\w+)/,
      );
      if (symMatch) {
        symbols.push({
          name: symMatch[2]!,
          kind: symMatch[1] as SymbolInfo['kind'],
          signature: firstLine,
          startLine: h.startLine,
        });
      }
      if (symbols.length >= 8) break; // 最多 8 个符号
    }
    return symbols;
  } catch {
    return [];
  }
}

/**
 * 扫描目标文件同级目录，收集相邻文件的导出列表。
 * @param filePath 目标文件相对路径
 * @param workspaceRoot 工作区根路径
 */
async function extractNearbyExports(
  filePath: string,
  workspaceRoot: string,
): Promise<NearbyExportInfo[]> {
  const { dirname, resolve, relative } = await import('node:path');
  const { promises: fs } = await import('node:fs');
  const dir = dirname(resolve(workspaceRoot, filePath));
  const results: NearbyExportInfo[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (count >= 5) break; // 最多 5 个文件
      if (!entry.isFile()) continue;
      const ext = entry.name.split('.').pop();
      if (!ext || !['ts', 'tsx', 'js', 'jsx'].includes(ext)) continue;
      if (entry.name === filePath.split('/').pop()) continue; // 跳过自身

      const absPath = resolve(dir, entry.name);
      try {
        const content = await fs.readFile(absPath, 'utf-8');
        // 提取 exports（正则快速扫描，非 AST）
        const exports: string[] = [];
        const exportRegex = /^export\s+(?:default\s+)?(?:function|class|const|type|interface)\s+(\w+)/gm;
        let m: RegExpExecArray | null;
        while ((m = exportRegex.exec(content)) !== null) {
          exports.push(m[1]!);
        }
        const relPath = relative(workspaceRoot, absPath).replace(/\\/g, '/');
        results.push({ filePath: relPath, exports });
        count++;
      } catch {
        continue;
      }
    }
  } catch {
    // 目录不存在或无权限 → 返回空
  }

  return results;
}

/**
 * 在编辑操作前检索目标文件的语义上下文（§8.15.1）。
 *
 * @param filePath 目标文件相对路径
 * @param workspaceRoot 工作区根路径
 * @param codebaseIndex CodebaseIndex 实例（可选）
 * @returns 上下文结果，或 null（无可注入内容）
 */
export async function retrieveEditContext(
  filePath: string,
  workspaceRoot: string,
  codebaseIndex?: { search(query: string, topK?: number): Promise<{ filePath: string; text: string; startLine: number }[]> },
): Promise<EditContextResult | null> {
  const [symbols, nearbyExports] = await Promise.all([
    extractSymbols(filePath, codebaseIndex),
    extractNearbyExports(filePath, workspaceRoot),
  ]);

  if (symbols.length === 0 && nearbyExports.length === 0) return null;

  return { filePath, symbols, nearbyExports };
}

/** Token 估算（简单字符/4 估算） */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 格式化 EditContextResult 为 XML，控制在 500 tokens 以内 */
export function formatEditContext(ctx: EditContextResult): string {
  const parts: string[] = [`<edit_context file="${ctx.filePath}">`];

  for (const sym of ctx.symbols) {
    if (estimateTokens(parts.join('\n')) >= 450) break; // 留 50 token 给尾巴
    parts.push(`<symbol name="${sym.name}" kind="${sym.kind}">${escapeXml(sym.signature)}</symbol>`);
  }

  if (ctx.nearbyExports.length > 0) {
    const nearbyLines = ctx.nearbyExports.map(
      (n) => `${n.filePath} exports: ${n.exports.join(', ')}`,
    );
    let nearbyText = nearbyLines.slice(0, 3).join('\n'); // 最多 3 个文件
    if (nearbyLines.length > 3) nearbyText += `\n…及 ${nearbyLines.length - 3} 个文件`;
    parts.push(`<nearby_exports>${escapeXml(nearbyText)}</nearby_exports>`);
  }

  parts.push('</edit_context>');
  return parts.join('\n');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
