/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * GraphIndex —— 代码图索引（P2）
 *
 * 基于 tree-sitter AST 解析，构建函数/类/模块级别的调用关系图。
 * 数据持久化到 SQLite（与 CodebaseIndex 共用 devseeker-index.sqlite）。
 *
 * 能力：
 *   - findCallers：查询某符号被谁调用（跨文件）
 *   - findCallees：查询某函数调用了哪些符号
 *   - findRelatedModules：查询模块上下游依赖
 *   - getCallChain：获取符号的 N 层调用链
 *
 * 增量更新：
 *   - updateFile：文件变更后重新解析并更新该文件的符号和调用关系
 *   - removeFile：文件删除时清理相关数据
 *
 * 防爆限制：
 *   - 最多 50,000 符号
 *   - 最多 200,000 调用关系
 */

import type { SqliteDatabaseLike } from '../storage/sqlite-db.js';
import type { SearchResult } from './codebase-index.js';
import type { SearchSource } from './fusion-searcher.js';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('index.graph-index');

// ─────────── 类型定义 ───────────

/** 符号类型 */
export type SymbolKind = 'function' | 'class' | 'method' | 'interface';

/** 符号引用（查询结果） */
export interface SymbolRef {
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  scope?: string;
}

/** 调用关系记录（提取器输出） */
export interface ExtractedCall {
  calleeName: string;
  callLine: number;
}

/** 符号定义记录（提取器输出） */
export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  calls: ExtractedCall[];
}

/** import 记录（提取器输出） */
export interface ExtractedImport {
  targetFile: string;
  symbols: string[];
}

/** 文件提取结果（graph-extractor 输出） */
export interface FileExtractionResult {
  filePath: string;
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
}

/** 调用链节点 */
export interface CallChainNode {
  symbol: SymbolRef;
  callees: CallChainNode[];
}

/** 图索引配置 */
export interface GraphIndexOptions {
  /** 最大符号数 */
  maxSymbols?: number;
  /** 最大调用关系数 */
  maxCalls?: number;
}

// ─────────── Schema ───────────

const GRAPH_SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS graph_symbols (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  scope      TEXT,
  UNIQUE(file_path, name, start_line)
);

CREATE TABLE IF NOT EXISTS graph_calls (
  caller_id   INTEGER NOT NULL REFERENCES graph_symbols(id),
  callee_name TEXT NOT NULL,
  callee_id   INTEGER,
  call_line   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_imports (
  source_file TEXT NOT NULL,
  target_file TEXT NOT NULL,
  symbols     TEXT
);

CREATE INDEX IF NOT EXISTS idx_graph_sym_name ON graph_symbols(name);
CREATE INDEX IF NOT EXISTS idx_graph_sym_file ON graph_symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_graph_calls_caller ON graph_calls(caller_id);
CREATE INDEX IF NOT EXISTS idx_graph_calls_callee ON graph_calls(callee_id);
CREATE INDEX IF NOT EXISTS idx_graph_calls_callee_name ON graph_calls(callee_name);
CREATE INDEX IF NOT EXISTS idx_graph_imports_source ON graph_imports(source_file);
`;

// ─────────── 常量 ───────────

const DEFAULT_MAX_SYMBOLS = 50_000;
const DEFAULT_MAX_CALLS = 200_000;

// ─────────── GraphIndex ───────────

export class GraphIndex {
  private readonly db: SqliteDatabaseLike;
  private readonly maxSymbols: number;
  private readonly maxCalls: number;
  private _size = -1;

  private constructor(db: SqliteDatabaseLike, opts: GraphIndexOptions = {}) {
    this.db = db;
    this.maxSymbols = opts.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
    this.maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  }

  /**
   * 工厂：初始化 schema 并加载统计信息
   */
  static create(db: SqliteDatabaseLike, opts: GraphIndexOptions = {}): GraphIndex {
    db.exec(GRAPH_SCHEMA);
    const idx = new GraphIndex(db, opts);
    idx.refreshSize();
    return idx;
  }

  /** 当前符号数（> 0 表示索引就绪） */
  size(): number {
    return Math.max(0, this._size);
  }

  /** 从数据库刷新统计 */
  private refreshSize(): void {
    try {
      const row = this.db.prepare('SELECT COUNT(*) as cnt FROM graph_symbols').get() as
        | { cnt: number }
        | undefined;
      this._size = row?.cnt ?? 0;
    } catch {
      this._size = 0;
    }
  }

  // ─────────── 写入 ───────────

  /**
   * 更新单个文件的图数据（增量）
   *
   * 1. 删除该文件的旧符号和调用关系
   * 2. 插入新提取的符号和调用关系
   * 3. 刷新统计
   */
  updateFile(result: FileExtractionResult): void {
    const { filePath, symbols, imports } = result;

    // 防爆检查
    if (this._size + symbols.length > this.maxSymbols) {
      log.warn({ filePath, count: symbols.length }, 'symbol limit exceeded, skipping');
      return;
    }

    // 删除旧数据
    this.removeFileData(filePath);

    if (symbols.length === 0) {
      return;
    }

    // 插入新符号
    const insertSymbol = this.db.prepare(
      `INSERT INTO graph_symbols (name, kind, file_path, start_line, end_line, scope)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const insertCall = this.db.prepare(
      `INSERT INTO graph_calls (caller_id, callee_name, callee_id, call_line)
       VALUES (?, ?, ?, ?)`,
    );

    const insertImport = this.db.prepare(
      `INSERT INTO graph_imports (source_file, target_file, symbols)
       VALUES (?, ?, ?)`,
    );

    // 查询刚插入的符号 id（兼容 sql.js 不支持 lastInsertRowid）
    const findSymbolId = this.db.prepare(
      'SELECT id FROM graph_symbols WHERE file_path = ? AND name = ? AND start_line = ?',
    );

    // 收集新插入的符号 id 映射
    const nameToId = new Map<string, number>();

    for (const sym of symbols) {
      const scope = this.extractScope(filePath);
      insertSymbol.run(sym.name, sym.kind, filePath, sym.startLine, sym.endLine, scope);

      // 查询刚插入的 id
      const row = findSymbolId.get(filePath, sym.name, sym.startLine) as { id: number } | undefined;
      const symId = row?.id ?? 0;
      if (symId > 0) {
        nameToId.set(sym.name, symId);
      }

      // 插入该符号的调用关系
      for (const call of sym.calls) {
        const calleeId = nameToId.get(call.calleeName) ?? null;
        insertCall.run(symId, call.calleeName, calleeId, call.callLine);
      }
    }

    // 插入 import 关系
    for (const imp of imports) {
      insertImport.run(filePath, imp.targetFile, JSON.stringify(imp.symbols));
    }

    this.refreshSize();
  }

  /** 删除单个文件的所有图数据 */
  removeFileData(filePath: string): void {
    // 先查出该文件的所有符号 id
    const rows = this.db.prepare(
      'SELECT id FROM graph_symbols WHERE file_path = ?',
    ).all(filePath) as Array<{ id: number }>;

    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');

      // 删除相关调用关系
      this.db.prepare(
        `DELETE FROM graph_calls WHERE caller_id IN (${placeholders})`,
      ).run(...ids);

      // 清除其他文件中指向这些符号的 callee_id
      this.db.prepare(
        `UPDATE graph_calls SET callee_id = NULL WHERE callee_id IN (${placeholders})`,
      ).run(...ids);
    }

    // 删除符号
    this.db.prepare('DELETE FROM graph_symbols WHERE file_path = ?').run(filePath);

    // 删除 import
    this.db.prepare('DELETE FROM graph_imports WHERE source_file = ?').run(filePath);

    this.refreshSize();
  }

  /**
   * 跨文件解析：尝试将 callee_name 解析为 callee_id
   *
   * 在所有文件中查找同名符号，建立跨文件调用关系。
   * 应在所有文件 updateFile 完成后调用一次。
   */
  resolveCrossFileCalls(): void {
    // 查找所有 callee_id 为 NULL 的调用
    const unresolved = this.db.prepare(
      'SELECT rowid, callee_name FROM graph_calls WHERE callee_id IS NULL',
    ).all() as Array<{ rowid: number; callee_name: string }>;

    if (unresolved.length === 0) return;

    const updateCall = this.db.prepare(
      'UPDATE graph_calls SET callee_id = ? WHERE rowid = ?',
    );

    let resolved = 0;
    for (const { rowid, callee_name } of unresolved) {
      // 在所有文件中查找同名符号
      const sym = this.db.prepare(
        'SELECT id FROM graph_symbols WHERE name = ? LIMIT 1',
      ).get(callee_name) as { id: number } | undefined;

      if (sym) {
        updateCall.run(sym.id, rowid);
        resolved++;
      }
    }

    log.info({ unresolved: unresolved.length, resolved }, 'cross-file resolution done');
  }

  // ─────────── 查询 ───────────

  /** 查询某符号被哪些函数调用（callers） */
  findCallers(symbolName: string, filePath?: string): SymbolRef[] {
    let sql: string;
    let params: unknown[];

    if (filePath) {
      sql = `
        SELECT DISTINCT s.name, s.kind, s.file_path, s.start_line, s.end_line, s.scope
        FROM graph_calls c
        JOIN graph_symbols s ON s.id = c.caller_id
        WHERE c.callee_name = ? AND s.file_path = ?
        LIMIT 50
      `;
      params = [symbolName, filePath];
    } else {
      sql = `
        SELECT DISTINCT s.name, s.kind, s.file_path, s.start_line, s.end_line, s.scope
        FROM graph_calls c
        JOIN graph_symbols s ON s.id = c.caller_id
        WHERE c.callee_name = ?
        LIMIT 50
      `;
      params = [symbolName];
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      name: string; kind: string; file_path: string;
      start_line: number; end_line: number; scope: string | null;
    }>;

    return rows.map(r => ({
      name: r.name,
      kind: r.kind as SymbolKind,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      scope: r.scope ?? undefined,
    }));
  }

  /** 查询某函数调用了哪些符号（callees） */
  findCallees(symbolName: string, filePath?: string): SymbolRef[] {
    let sql: string;
    let params: unknown[];

    if (filePath) {
      sql = `
        SELECT c.callee_name, c.callee_id
        FROM graph_calls c
        JOIN graph_symbols s ON s.id = c.caller_id
        WHERE s.name = ? AND s.file_path = ?
      `;
      params = [symbolName, filePath];
    } else {
      sql = `
        SELECT c.callee_name, c.callee_id
        FROM graph_calls c
        JOIN graph_symbols s ON s.id = c.caller_id
        WHERE s.name = ?
      `;
      params = [symbolName];
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      callee_name: string; callee_id: number | null;
    }>;

    // 去重：同一 callee_name 可能有多条记录
    const seen = new Set<string>();
    const results: SymbolRef[] = [];

    for (const row of rows) {
      if (seen.has(row.callee_name)) continue;
      seen.add(row.callee_name);

      if (row.callee_id) {
        const sym = this.db.prepare(
          'SELECT name, kind, file_path, start_line, end_line, scope FROM graph_symbols WHERE id = ?',
        ).get(row.callee_id) as {
          name: string; kind: string; file_path: string;
          start_line: number; end_line: number; scope: string | null;
        } | undefined;
        if (sym) {
          results.push({
            name: sym.name,
            kind: sym.kind as SymbolKind,
            filePath: sym.file_path,
            startLine: sym.start_line,
            endLine: sym.end_line,
            scope: sym.scope ?? undefined,
          });
          continue;
        }
      }

      // callee_id 为空或查不到 → 尝试按名字在当前项目内查找
      const resolved = this.db.prepare(
        'SELECT name, kind, file_path, start_line, end_line, scope FROM graph_symbols WHERE name = ? LIMIT 1',
      ).get(row.callee_name) as {
        name: string; kind: string; file_path: string;
        start_line: number; end_line: number; scope: string | null;
      } | undefined;

      if (resolved) {
        results.push({
          name: resolved.name,
          kind: resolved.kind as SymbolKind,
          filePath: resolved.file_path,
          startLine: resolved.start_line,
          endLine: resolved.end_line,
          scope: resolved.scope ?? undefined,
        });
      } else {
        // 完全未解析 → 外部调用
        results.push({
          name: row.callee_name,
          kind: 'function',
          filePath: '<external>',
          startLine: 0,
          endLine: 0,
        });
      }
    }

    return results;
  }

  /** 查询某模块的上下游依赖 */
  findRelatedModules(dirPath: string): { upstream: string[]; downstream: string[] } {
    // downstream：该目录下的文件 import 了哪些外部文件
    const downRows = this.db.prepare(
      `SELECT DISTINCT target_file FROM graph_imports WHERE source_file LIKE ?`,
    ).all(`${dirPath}%`) as Array<{ target_file: string }>;

    // upstream：哪些外部文件 import 了该目录下的文件
    const upRows = this.db.prepare(
      `SELECT DISTINCT source_file FROM graph_imports WHERE target_file LIKE ?`,
    ).all(`${dirPath}%`) as Array<{ source_file: string }>;

    return {
      upstream: upRows.map(r => r.source_file),
      downstream: downRows.map(r => r.target_file),
    };
  }

  /** 获取符号的 N 层调用链（递归） */
  getCallChain(symbolName: string, depth: number = 2): CallChainNode[] {
    const visited = new Set<string>();
    return this.buildCallChain(symbolName, depth, visited);
  }

  private buildCallChain(symbolName: string, depth: number, visited: Set<string>): CallChainNode[] {
    if (depth <= 0 || visited.has(symbolName)) return [];
    visited.add(symbolName);

    // 查找该符号的定义
    const symbols = this.db.prepare(
      'SELECT id, name, kind, file_path, start_line, end_line, scope FROM graph_symbols WHERE name = ? LIMIT 5',
    ).all(symbolName) as Array<{
      id: number; name: string; kind: string; file_path: string;
      start_line: number; end_line: number; scope: string | null;
    }>;

    const results: CallChainNode[] = [];
    for (const sym of symbols) {
      const callees = this.findCallees(sym.name, sym.file_path);
      const calleeNodes: CallChainNode[] = [];
      for (const callee of callees) {
        if (callee.filePath === '<external>') continue;
        const subChain = this.buildCallChain(callee.name, depth - 1, visited);
        calleeNodes.push(...subChain);
      }

      results.push({
        symbol: {
          name: sym.name,
          kind: sym.kind as SymbolKind,
          filePath: sym.file_path,
          startLine: sym.start_line,
          endLine: sym.end_line,
          scope: sym.scope ?? undefined,
        },
        callees: calleeNodes,
      });
    }

    visited.delete(symbolName);
    return results;
  }

  // ─────────── 辅助 ───────────

  /** 从文件路径提取模块 scope（目录部分） */
  private extractScope(filePath: string): string {
    const lastSlash = filePath.lastIndexOf('/');
    return lastSlash > 0 ? filePath.substring(0, lastSlash) : '';
  }
}

// ─────────── 搜索源适配器 ───────────

/**
 * 将 GraphIndex 适配为 FusionSearcher 的 SearchSource 接口。
 *
 * 搜索策略：从查询中提取标识符（驼峰/PascalCase/点分调用），
 * 对每个标识符查询 findCallers + findCallees，合并为 SearchResult。
 */
export class GraphSearchSource implements SearchSource {
  readonly name = 'graph';

  constructor(private readonly graph: GraphIndex) {}

  size(): number {
    return this.graph.size();
  }

  async search(query: string, topK: number): Promise<SearchResult[]> {
    if (this.graph.size() === 0) return [];

    // 从查询中提取标识符
    const identifiers = extractIdentifiers(query);
    if (identifiers.length === 0) return [];

    const seen = new Set<string>();
    const results: SearchResult[] = [];

    for (const id of identifiers) {
      // 查找该符号的 callers 和 callees
      const callers = this.graph.findCallers(id);
      const callees = this.graph.findCallees(id);

      for (const ref of [...callers, ...callees]) {
        if (ref.filePath === '<external>') continue;
        const key = `${ref.filePath}:${ref.startLine}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          filePath: ref.filePath,
          startLine: ref.startLine,
          endLine: ref.endLine,
          text: '', // 由 search_codebase 工具填充原文
          score: 0.5, // 图索引的分数固定为中间值，由 RRF 融合决定最终排序
        });

        if (results.length >= topK) break;
      }
      if (results.length >= topK) break;
    }

    return results;
  }
}

/** 从查询文本中提取可能的标识符（函数名/类名/方法调用） */
function extractIdentifiers(query: string): string[] {
  const ids: string[] = [];

  // PascalCase / camelCase 标识符
  const camelMatches = query.matchAll(/\b([a-z]+[A-Z][a-zA-Z]*)\b/g);
  for (const m of camelMatches) ids.push(m[1]);

  // 方法调用模式：identifier.identifier(
  const methodMatches = query.matchAll(/\b(\w+)\s*\(/g);
  for (const m of methodMatches) {
    const name = m[1];
    if (name.length > 1 && !ids.includes(name)) ids.push(name);
  }

  // 独立的大写开头标识符（类名）
  const pascalMatches = query.matchAll(/\b([A-Z][a-z]+[A-Z][a-zA-Z]*)\b/g);
  for (const m of pascalMatches) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }

  return ids.slice(0, 5); // 最多取 5 个标识符
}
