/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * VSCodeProblemsBridge —— 基于 vscode.languages.getDiagnostics 的实现（W7e1）
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  type DiagnosticItem,
  type GetDiagnosticsOptions,
  type ProblemsBridge,
  SEVERITY_ORDER,
  mapSeverity,
} from './bridge.js';

export interface VSCodeProblemsBridgeOptions {
  /** 工作区绝对根路径 */
  workspaceRoot: string;
}

export class VSCodeProblemsBridge implements ProblemsBridge {
  private readonly workspaceRoot: string;

  constructor(opts: VSCodeProblemsBridgeOptions) {
    this.workspaceRoot = opts.workspaceRoot;
  }

  async getDiagnostics(opts: GetDiagnosticsOptions = {}): Promise<DiagnosticItem[]> {
    const minLv = SEVERITY_ORDER[opts.minSeverity ?? 'hint'];

    const entries: [vscode.Uri, readonly vscode.Diagnostic[]][] = [];
    if (opts.filePaths && opts.filePaths.length > 0) {
      for (const fp of opts.filePaths) {
        const abs = path.isAbsolute(fp) ? fp : path.resolve(this.workspaceRoot, fp);
        const uri = vscode.Uri.file(abs);
        entries.push([uri, vscode.languages.getDiagnostics(uri)]);
      }
    } else {
      for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        entries.push([uri, diags]);
      }
    }

    const out: DiagnosticItem[] = [];
    for (const [uri, diags] of entries) {
      if (!diags || diags.length === 0) continue;
      const relPath = this.toRelPath(uri);
      for (const d of diags) {
        const sev = mapSeverity(d.severity);
        if (SEVERITY_ORDER[sev] > minLv) continue;
        const item: DiagnosticItem = {
          filePath: relPath,
          severity: sev,
          message: d.message,
          line: d.range.start.line + 1,
          character: d.range.start.character + 1,
          endLine: d.range.end.line + 1,
          endCharacter: d.range.end.character + 1,
        };
        if (d.source) item.source = d.source;
        if (d.code !== undefined && d.code !== null) {
          item.code = typeof d.code === 'object' ? String(d.code.value) : d.code;
        }
        out.push(item);
      }
    }
    // 按 (severity, file, line) 排序，便于人类阅读
    out.sort((a, b) => {
      const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (s !== 0) return s;
      const f = a.filePath.localeCompare(b.filePath);
      if (f !== 0) return f;
      return a.line - b.line;
    });
    return out;
  }

  private toRelPath(uri: vscode.Uri): string {
    if (uri.scheme !== 'file') return uri.toString();
    const abs = uri.fsPath;
    let rel = path.relative(this.workspaceRoot, abs);
    if (!rel || rel.startsWith('..')) rel = abs;
    return rel.split(path.sep).join('/');
  }
}
