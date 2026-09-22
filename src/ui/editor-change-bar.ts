/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * EditorChangeBar —— 文件变更清单 + "文件上方操作条"的命令实现
 *
 * v0.8.5 起（对齐 Qoder 的文件上方按钮）：
 * - 移除原底部状态栏按钮（"{昵称}: N files changed" / 上一个 / 下一个 / 同意 / 拒绝）
 * - 按钮改为每个待处理文件编辑器顶部的 CodeLens 操作条（见 diff-action-lens.ts）：
 *     ← 上一个文件 | 下一个文件 → | ✓ 同意 | ✗ 拒绝
 * - 本类保留文件清单（导航顺序）与命令实现，并通过 onDidChange 通知操作条刷新
 *
 * 语义：
 * - 同意：接受"当前文件"的全部变更（清除装饰与 diff 快照，内容保留）
 * - 拒绝：拒绝"当前文件"的全部变更（逐 hunk 回滚到修改前）
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { InlineDiffController } from './inline-diff-decorator.js';
import { getLogger } from '../infra/logger.js';
import { getNickname } from '../infra/nickname.js';

const log = getLogger('editor-change-bar');

interface ChangedFileEntry {
  relPath: string;
  absPath: string;
  added: number;
  removed: number;
}

export class EditorChangeBar implements vscode.Disposable {
  private changedFiles: ChangedFileEntry[] = [];
  private currentFileIdx = -1;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** 文件清单变化事件（供 CodeLens 操作条刷新） */
  readonly onDidChange = this._onDidChange.event;

  /**
   * 编辑器侧操作条完成 接受/拒绝 后的回调（由 extension.ts 注入 → 同步 webview 卡片）。
   * 卡片契约 K5：编辑器动作与聊天卡片状态必须同源，避免两个入口显示不一致。
   */
  onFileResolved?: (relPath: string, action: 'accept' | 'reject', ok: boolean, message?: string) => void;

  constructor(private readonly inlineDiffController: InlineDiffController) {}

  /** 注册命令（在 extension.ts 中调用） */
  registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('devSeeker.changeBar.prevFile', () => this.navigateToPrevFile()),
      vscode.commands.registerCommand('devSeeker.changeBar.nextFile', () => this.navigateToNextFile()),
      vscode.commands.registerCommand('devSeeker.changeBar.acceptFile', (uri?: vscode.Uri) =>
        this.acceptFile(uri),
      ),
      vscode.commands.registerCommand('devSeeker.changeBar.rejectFile', (uri?: vscode.Uri) =>
        this.rejectFile(uri),
      ),
      vscode.commands.registerCommand('devSeeker.changeBar.acceptAll', () => this.acceptAll()),
      vscode.commands.registerCommand('devSeeker.changeBar.rejectAll', () => this.rejectAll()),
    );
  }

  /** 添加一个文件变更条目 */
  addChangedFile(relPath: string, absPath: string, added: number, removed: number): void {
    const existing = this.changedFiles.find((f) => f.absPath === absPath);
    if (existing) {
      existing.added = added;
      existing.removed = removed;
    } else {
      this.changedFiles.push({ relPath, absPath, added, removed });
    }
    this.fire();
  }

  /** 移除一个文件变更条目（Webview Accept/Reject 时调用） */
  removeFile(relPath: string): void {
    const entry = this.findEntry(relPath);
    if (!entry) return;
    // 兜底清理控制器残留：无装饰场景下避免文件重开时装饰/操作条"复活"
    this.inlineDiffController.discardFile(entry.absPath);
    this.dropEntry(entry.relPath);
  }

  /** 该文件是否在变更清单中（供操作条判定是否渲染按钮） */
  hasFile(absPath: string): boolean {
    return this.changedFiles.some((f) => f.absPath === absPath);
  }

  /** 文件在清单中的序号（0-based；不在清单中返回 -1） */
  getFileIndex(absPath: string): number {
    return this.changedFiles.findIndex((f) => f.absPath === absPath);
  }

  /** 清单中的文件总数 */
  getFileCount(): number {
    return this.changedFiles.length;
  }

  /** 清除所有状态 */
  clear(): void {
    this.changedFiles = [];
    this.currentFileIdx = -1;
    this.inlineDiffController.discardAll();
    this.fire();
  }

  /** 当任务结束时由外部调用 */
  onTaskEnd(): void {
    // no-op: 暂停逻辑已移除
  }

  /** 导航到下一个文件 */
  private async navigateToNextFile(): Promise<void> {
    if (this.changedFiles.length === 0) return;
    this.currentFileIdx = (this.currentFileIdx + 1) % this.changedFiles.length;
    await this.openCurrentFile();
  }

  /** 导航到上一个文件 */
  private async navigateToPrevFile(): Promise<void> {
    if (this.changedFiles.length === 0) return;
    this.currentFileIdx =
      (this.currentFileIdx - 1 + this.changedFiles.length) % this.changedFiles.length;
    await this.openCurrentFile();
  }

  /** 同意当前文件：接受该文件全部变更（清除装饰，内容保留） */
  private async acceptFile(uri?: vscode.Uri): Promise<void> {
    const entry = this.resolveEntry(uri);
    if (!entry) return;

    this.inlineDiffController.acceptFile(entry.absPath);
    const removedIdx = this.dropEntry(entry.relPath);
    vscode.window.setStatusBarMessage(`${getNickname()}: 已同意 ${entry.relPath}`, 3000);
    this.onFileResolved?.(entry.relPath, 'accept', true);
    await this.openNextIfAny(removedIdx);
  }

  /** 拒绝当前文件：回滚该文件到修改前（逐 hunk 回滚） */
  private async rejectFile(uri?: vscode.Uri): Promise<void> {
    const entry = this.resolveEntry(uri);
    if (!entry) return;

    const result = await this.inlineDiffController.rejectFile(entry.absPath);
    if (!result.ok) {
      // K5：回滚失败不谎报"已拒绝"，保留清单条目允许重试
      vscode.window.showWarningMessage(
        `${getNickname()}: 拒绝 ${entry.relPath} 失败 — ${result.message ?? '未知错误'}`,
      );
      this.onFileResolved?.(entry.relPath, 'reject', false, result.message);
      return;
    }
    const removedIdx = this.dropEntry(entry.relPath);
    vscode.window.setStatusBarMessage(
      `${getNickname()}: 已拒绝 ${entry.relPath}（已恢复修改前内容）`,
      3000,
    );
    this.onFileResolved?.(entry.relPath, 'reject', true);
    await this.openNextIfAny(removedIdx);
  }

  /** 接受所有变更：移除装饰，保留文件内容 */
  private async acceptAll(): Promise<void> {
    await this.inlineDiffController.acceptAllFiles();
    this.clear();
    vscode.window.showInformationMessage(`${getNickname()}: 所有文件变更已接受`);
  }

  /** 拒绝所有变更：回滚所有文件到原始内容，移除装饰 */
  private async rejectAll(): Promise<void> {
    await this.inlineDiffController.rejectAllFiles();
    this.clear();
    vscode.window.showInformationMessage(`${getNickname()}: 所有文件变更已拒绝（已恢复原始内容）`);
  }

  /** 打开当前索引的文件 */
  private async openCurrentFile(): Promise<void> {
    const entry = this.changedFiles[this.currentFileIdx];
    if (!entry) return;

    try {
      const doc = await vscode.workspace.openTextDocument(entry.absPath);
      await vscode.window.showTextDocument(doc, {
        preserveFocus: false,
        preview: false,
        viewColumn: vscode.ViewColumn.Active,
      });
      this.inlineDiffController.navigateToFirstHunk(entry.absPath);
    } catch (e) {
      log.warn({ err: String(e), absPath: entry.absPath }, 'changeBar: failed to open file');
    }
  }

  /**
   * 处理完当前文件后：若还有待处理文件 → 自动打开"被移除条目原位置"上的文件（下一个）。
   * 保证"上一个/下一个文件"审核链路在操作条消失后仍然可用。
   */
  private async openNextIfAny(removedIdx: number): Promise<void> {
    if (this.changedFiles.length === 0) return;
    if (removedIdx >= 0 && removedIdx < this.changedFiles.length) {
      this.currentFileIdx = removedIdx;
    } else if (this.currentFileIdx < 0 || this.currentFileIdx >= this.changedFiles.length) {
      this.currentFileIdx = 0;
    }
    await this.openCurrentFile();
  }

  /** 由操作条传入的 uri（或活动编辑器）定位变更条目 */
  private resolveEntry(uri?: vscode.Uri): ChangedFileEntry | undefined {
    const absPath = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!absPath) return undefined;
    return this.changedFiles.find((f) => f.absPath === absPath);
  }

  /** 按 relPath（或 absPath）定位变更条目 */
  private findEntry(relPath: string): ChangedFileEntry | undefined {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return this.changedFiles.find(
      (f) =>
        f.relPath === relPath || (wsRoot !== undefined && f.absPath === path.resolve(wsRoot, relPath)),
    );
  }

  /** 仅从清单移除条目（控制器状态由调用方负责），并通知操作条刷新；返回被移除条目的序号 */
  private dropEntry(relPath: string): number {
    const idx = this.changedFiles.findIndex((f) => f.relPath === relPath);
    if (idx < 0) return -1;
    this.changedFiles.splice(idx, 1);
    if (this.currentFileIdx >= this.changedFiles.length) {
      this.currentFileIdx = Math.max(0, this.changedFiles.length - 1);
    }
    this.fire();
    return idx;
  }

  private fire(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
