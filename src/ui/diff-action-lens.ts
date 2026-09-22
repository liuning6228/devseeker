/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * DiffActionLensProvider —— 文件顶部"变更操作条"（CodeLens）
 *
 * 在每个待处理变更文件的第一行上方渲染一行可点击按钮（对齐 Qoder 的文件上方操作条）：
 *   ← 上一个文件 | 下一个文件 → | ✓ 同意 | ✗ 拒绝
 *
 * 设计要点：
 * - 数据源为 EditorChangeBar 的文件清单（emitToolDiff / 会话恢复时写入）；
 *   清单变化 → onDidChangeCodeLenses 触发 VS Code 重新拉取 CodeLens
 * - 仅在多文件时显示"上一个/下一个"；单文件时只显示 同意/拒绝
 * - 同意/拒绝作用于"当前文件"（document.uri 作为参数传入命令）
 */

import * as vscode from 'vscode';
import { EditorChangeBar } from './editor-change-bar.js';
import { getNickname } from '../infra/nickname.js';

export class DiffActionLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly changeBar: EditorChangeBar) {
    this.disposables.push(
      // 文件清单变化（新增/移除/清空）→ 刷新操作条
      this.changeBar.onDidChange(() => this._onDidChangeCodeLenses.fire()),
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const absPath = document.uri.fsPath;
    if (!this.changeBar.hasFile(absPath)) return [];

    const range = new vscode.Range(0, 0, 0, 0);
    const lenses: vscode.CodeLens[] = [];
    const count = this.changeBar.getFileCount();
    const index = this.changeBar.getFileIndex(absPath);
    const position = count > 1 ? `（第 ${index + 1}/${count} 个修改文件）` : '';

    if (count > 1) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(arrow-left) 上一个文件',
          command: 'devSeeker.changeBar.prevFile',
          tooltip: `切换到上一个修改文件${position}`,
        }),
        new vscode.CodeLens(range, {
          title: '$(arrow-right) 下一个文件',
          command: 'devSeeker.changeBar.nextFile',
          tooltip: `切换到下一个修改文件${position}`,
        }),
      );
    }

    lenses.push(
      new vscode.CodeLens(range, {
        title: '$(check) 同意',
        command: 'devSeeker.changeBar.acceptFile',
        arguments: [document.uri],
        tooltip: `${getNickname()}：接受本文件的全部变更${position}`,
      }),
      new vscode.CodeLens(range, {
        title: '$(close) 拒绝',
        command: 'devSeeker.changeBar.rejectFile',
        arguments: [document.uri],
        tooltip: `${getNickname()}：拒绝本文件的变更（回滚到修改前）${position}`,
      }),
    );

    return lenses;
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
