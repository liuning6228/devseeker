/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * VSCodeLspBridge —— 基于 VSCode 内置 LSP 命令的桥接实现
 *
 * 走 `vscode.commands.executeCommand('vscode.executeXxxProvider', ...)`，
 * 这样不需要启动独立的 language server 进程，VSCode 内置 / 其他扩展注册的
 * LSP provider 会自动响应。
 *
 * 坐标约定：
 * - 对外（工具层）：1-based 行列
 * - 对内（VSCode Position）：0-based 行列
 * - 路径对外：相对 workspaceRoot 的 POSIX 分隔符
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import type {
  LspBridge,
  LspLocation,
  LspPosition,
  LspRange,
  LspSymbol,
  CallHierarchyEntry,
} from './bridge.js';
import { mapSymbolKind } from './bridge.js';
import { AgentError, ErrorCodes } from '../errors/index.js';

export interface VSCodeLspBridgeOptions {
  /** 工作区绝对根路径 */
  workspaceRoot: string;
  /** 单次 LSP 调用超时 ms，默认 8000 */
  timeoutMs?: number;
}

/** VSCode 内置 LSP 命令 */
const CMD = {
  DEFINITION: 'vscode.executeDefinitionProvider',
  REFERENCES: 'vscode.executeReferenceProvider',
  DOC_SYMBOLS: 'vscode.executeDocumentSymbolProvider',
  WS_SYMBOLS: 'vscode.executeWorkspaceSymbolProvider',
  IMPLEMENTATION: 'vscode.executeImplementationProvider',
  PREPARE_CALL_HIERARCHY: 'vscode.prepareCallHierarchy',
  INCOMING_CALLS: 'vscode.provideIncomingCalls',
  OUTGOING_CALLS: 'vscode.provideOutgoingCalls',
} as const;

type RawLocation = vscode.Location | vscode.LocationLink;
type RawSymbol = vscode.DocumentSymbol | vscode.SymbolInformation;

export class VSCodeLspBridge implements LspBridge {
  private readonly workspaceRoot: string;
  private readonly timeoutMs: number;

  constructor(opts: VSCodeLspBridgeOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  async goToDefinition(filePath: string, pos: LspPosition): Promise<LspLocation[]> {
    const uri = this.toUri(filePath);
    const vscodePos = toVscodePosition(pos);
    const locations = await this.exec<RawLocation[]>(CMD.DEFINITION, [uri, vscodePos]);
    return (locations ?? []).map((l) => this.fromRawLocation(l));
  }

  async findReferences(
    filePath: string,
    pos: LspPosition,
    _includeDeclaration = false,
  ): Promise<LspLocation[]> {
    // VSCode 的 executeReferenceProvider 不接受 includeDeclaration 参数（始终包含）
    // 这里忽略第三参数，保持接口一致性
    const uri = this.toUri(filePath);
    const vscodePos = toVscodePosition(pos);
    const locations = await this.exec<vscode.Location[]>(CMD.REFERENCES, [uri, vscodePos]);
    return (locations ?? []).map((l) => this.fromRawLocation(l));
  }

  async documentSymbols(filePath: string): Promise<LspSymbol[]> {
    const uri = this.toUri(filePath);
    const symbols = await this.exec<RawSymbol[]>(CMD.DOC_SYMBOLS, [uri]);
    if (!symbols) return [];
    const out: LspSymbol[] = [];
    for (const s of symbols) {
      this.collectSymbol(s, uri, undefined, out);
    }
    return out;
  }

  async workspaceSymbols(query: string, limit = 50): Promise<LspSymbol[]> {
    const symbols = await this.exec<vscode.SymbolInformation[]>(CMD.WS_SYMBOLS, [query]);
    if (!symbols) return [];
    return symbols.slice(0, Math.max(1, limit)).map((s) => ({
      name: s.name,
      kind: mapSymbolKind(s.kind),
      containerName: s.containerName || undefined,
      location: this.fromRawLocation(s.location),
    }));
  }

  // ─── W7e3: Implementation + Call Hierarchy ───

  async goToImplementation(filePath: string, pos: LspPosition): Promise<LspLocation[]> {
    const uri = this.toUri(filePath);
    const vscodePos = toVscodePosition(pos);
    const locations = await this.exec<RawLocation[]>(CMD.IMPLEMENTATION, [uri, vscodePos]);
    return (locations ?? []).map((l) => this.fromRawLocation(l));
  }

  async callHierarchy(
    filePath: string,
    pos: LspPosition,
    direction: 'incoming' | 'outgoing',
  ): Promise<CallHierarchyEntry[]> {
    const uri = this.toUri(filePath);
    const vscodePos = toVscodePosition(pos);

    // Step 1: prepareCallHierarchy → CallHierarchyItem[]
    const items = await this.exec<vscode.CallHierarchyItem[]>(
      CMD.PREPARE_CALL_HIERARCHY,
      [uri, vscodePos],
    );
    if (!items || items.length === 0) return [];

    // Step 2: 对每个 item 查 incoming / outgoing
    const cmd = direction === 'incoming' ? CMD.INCOMING_CALLS : CMD.OUTGOING_CALLS;
    const allEntries: CallHierarchyEntry[] = [];
    for (const item of items) {
      const calls = await this.exec<vscode.CallHierarchyIncomingCall[] | vscode.CallHierarchyOutgoingCall[]>(
        cmd,
        [item],
      );
      if (!calls) continue;
      for (const call of calls) {
        // incoming: .from ; outgoing: .to — 结构对称都有 name/kind/uri/range/selectionRange
        const peer = direction === 'incoming'
          ? (call as vscode.CallHierarchyIncomingCall).from
          : (call as vscode.CallHierarchyOutgoingCall).to;
        const fromRanges = direction === 'incoming'
          ? (call as vscode.CallHierarchyIncomingCall).fromRanges
          : (call as vscode.CallHierarchyOutgoingCall).fromRanges;
        allEntries.push({
          name: peer.name,
          kind: mapSymbolKind(peer.kind),
          location: {
            filePath: this.toRelPath(peer.uri),
            range: toLspRange(peer.selectionRange ?? peer.range),
          },
          fromRanges: fromRanges?.map((r) => toLspRange(r)),
        });
      }
    }
    return allEntries;
  }

  // ─────────── internals ───────────

  private toUri(filePath: string): vscode.Uri {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workspaceRoot, filePath);
    return vscode.Uri.file(abs);
  }

  private fromRawLocation(l: RawLocation): LspLocation {
    // LocationLink 形式（目标跳转）
    if ('targetUri' in l) {
      const uri = l.targetUri;
      const range = l.targetSelectionRange ?? l.targetRange;
      return {
        filePath: this.toRelPath(uri),
        range: toLspRange(range),
      };
    }
    // Location 形式
    return {
      filePath: this.toRelPath(l.uri),
      range: toLspRange(l.range),
    };
  }

  private toRelPath(uri: vscode.Uri): string {
    if (uri.scheme !== 'file') return uri.toString();
    const abs = uri.fsPath;
    let rel = path.relative(this.workspaceRoot, abs);
    if (!rel || rel.startsWith('..')) {
      // 工作区外 —— 保留绝对路径（POSIX）
      rel = abs;
    }
    return rel.split(path.sep).join('/');
  }

  private collectSymbol(
    s: RawSymbol,
    uri: vscode.Uri,
    container: string | undefined,
    out: LspSymbol[],
  ): void {
    // DocumentSymbol 有 children；SymbolInformation 没有
    if ('children' in s) {
      out.push({
        name: s.name,
        kind: mapSymbolKind(s.kind),
        containerName: container,
        location: {
          filePath: this.toRelPath(uri),
          range: toLspRange(s.selectionRange ?? s.range),
        },
      });
      for (const child of s.children ?? []) {
        this.collectSymbol(child, uri, s.name, out);
      }
    } else {
      out.push({
        name: s.name,
        kind: mapSymbolKind(s.kind),
        containerName: s.containerName || container,
        location: this.fromRawLocation(s.location),
      });
    }
  }

  private async exec<T>(command: string, args: unknown[]): Promise<T | undefined> {
    try {
      return await withTimeout(
        vscode.commands.executeCommand<T>(command, ...args),
        this.timeoutMs,
        command,
      );
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === ErrorCodes.LSP_TIMEOUT) {
        throw e;
      }
      throw new AgentError({
        code: ErrorCodes.LSP_OPERATION_UNSUPPORTED,
        message: `LSP 命令失败 ${command}：${err.message ?? String(e)}`,
        cause: e,
      });
    }
  }
}

// ─────────── helpers ───────────

function toVscodePosition(p: LspPosition): vscode.Position {
  // 1-based → 0-based
  const line = Math.max(0, (p.line | 0) - 1);
  const ch = Math.max(0, (p.character | 0) - 1);
  return new vscode.Position(line, ch);
}

function toLspRange(r: vscode.Range): LspRange {
  return {
    start: { line: r.start.line + 1, character: r.start.character + 1 },
    end: { line: r.end.line + 1, character: r.end.character + 1 },
  };
}

function withTimeout<T>(p: Thenable<T>, ms: number, cmd: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AgentError({
          code: ErrorCodes.LSP_TIMEOUT,
          message: `LSP ${cmd} 超时（${ms}ms）`,
        }),
      );
    }, ms);
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ─────────── §8.13 · 编辑后 Diagnostics 拉取 ───────────

export interface DiagnosticResult {
  filePath: string;
  line: number;       // 1-based
  column: number;     // 1-based
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  source?: string;
}

function severityToString(s: vscode.DiagnosticSeverity): DiagnosticResult['severity'] {
  switch (s) {
    case vscode.DiagnosticSeverity.Error: return 'error';
    case vscode.DiagnosticSeverity.Warning: return 'warning';
    case vscode.DiagnosticSeverity.Information: return 'info';
    case vscode.DiagnosticSeverity.Hint: return 'hint';
    default: return 'error';
  }
}

/**
 * 获取指定文件的 VSCode 诊断列表（§8.13）。
 * 走 VSCode 内置 languages.getDiagnostics API，
 * 返回所有 language server / 扩展注册的诊断。
 *
 * @param filePath 目标文件的绝对路径
 * @param minSeverity 最低严重级别，默认 Error
 * @returns 格式化后的诊断摘要列表
 */
export function getDiagnosticsForFile(
  filePath: string,
  minSeverity: vscode.DiagnosticSeverity = vscode.DiagnosticSeverity.Error,
): DiagnosticResult[] {
  try {
    const uri = vscode.Uri.file(filePath);
    const allDiagnostics = vscode.languages.getDiagnostics(uri);
    return allDiagnostics
      .filter(d => d.severity <= minSeverity)
      .map(d => ({
        filePath,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        message: d.message,
        severity: severityToString(d.severity),
        source: d.source,
      }));
  } catch {
    return [];
  }
}

/** 格式化为注入字符串 */
export function formatDiagnostics(results: DiagnosticResult[]): string {
  const MAX_SHOW = 5;
  const errors = results.filter(r => r.severity === 'error');
  if (errors.length === 0) return '';
  const lines = errors.slice(0, MAX_SHOW).map(r =>
    `${r.filePath}:${r.line}:${r.column} - ${r.message}${r.source ? ` (${r.source})` : ''}`,
  );
  if (errors.length > MAX_SHOW) {
    lines.push(`…及 ${errors.length - MAX_SHOW} 个问题`);
  }
  return `\n\n[LSP Diagnostics after edit]\n${lines.join('\n')}`;
}
