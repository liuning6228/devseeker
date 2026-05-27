/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * EditorChangeBar —— 编辑器底部状态栏：文件变更导航 + 同意/拒绝
 *
 * 功能：
 * - 显示 "DevSeeker: N files changed" 状态栏项
 * - 上一个/下一个 文件导航按钮
 * - 同意(Accept All) / 拒绝(Reject All) 按钮
 * - 点击导航时自动打开对应文件编辑器并滚动到第一个待处理 hunk
 *
 * 按钮布局（从左到右）：
 *   0. 标签  "DevSeeker: N files changed"
 *   1. 上一个（多文件时显示）
 *   2. 下一个（多文件时显示）
 *   3. 同意
 *   4. 拒绝
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { InlineDiffController } from './inline-diff-decorator.js';
import { getLogger } from '../infra/logger.js';

const log = getLogger('editor-change-bar');

interface ChangedFileEntry {
  relPath: string;
  absPath: string;
  added: number;
  removed: number;
}

export class EditorChangeBar implements vscode.Disposable {
  private readonly items: vscode.StatusBarItem[] = [];
  private changedFiles: ChangedFileEntry[] = [];
  private currentFileIdx = -1;
  private visible = false;

  constructor(private readonly inlineDiffController: InlineDiffController) {
    // 0. 主标签 "DevSeeker: N files changed"
    const labelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
    labelItem.name = 'DevSeeker Changes';
    labelItem.text = '$(files) DevSeeker: 0 files changed';
    labelItem.tooltip = 'DevSeeker 文件变更概览';
    this.items.push(labelItem);

    // 1. 上一个文件
    const prevItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 29);
    prevItem.name = 'DevSeeker Prev File';
    prevItem.text = '$(arrow-left) 上一个';
    prevItem.tooltip = '查看上一个修改的文件';
    prevItem.command = 'devSeeker.changeBar.prevFile';
    this.items.push(prevItem);

    // 2. 下一个文件
    const nextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 28);
    nextItem.name = 'DevSeeker Next File';
    nextItem.text = '$(arrow-right) 下一个';
    nextItem.tooltip = '查看下一个修改的文件';
    nextItem.command = 'devSeeker.changeBar.nextFile';
    this.items.push(nextItem);

    // 3. 同意
    const acceptItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 27);
    acceptItem.name = 'DevSeeker Accept All';
    acceptItem.text = '$(check) 同意';
    acceptItem.tooltip = '接受所有文件变更';
    acceptItem.command = 'devSeeker.changeBar.acceptAll';
    this.items.push(acceptItem);

    // 4. 拒绝
    const rejectItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 26);
    rejectItem.name = 'DevSeeker Reject All';
    rejectItem.text = '$(close) 拒绝';
    rejectItem.tooltip = '拒绝所有文件变更（回滚到原始内容）';
    rejectItem.command = 'devSeeker.changeBar.rejectAll';
    this.items.push(rejectItem);
  }

  /** 注册命令（在 extension.ts 中调用） */
  registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('devSeeker.changeBar.prevFile', () => this.navigateToPrevFile()),
      vscode.commands.registerCommand('devSeeker.changeBar.nextFile', () => this.navigateToNextFile()),
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
    this.updateBar();
  }

  /** 移除一个文件变更条目（Webview Accept/Reject 时调用） */
  removeFile(relPath: string): void {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const idx = this.changedFiles.findIndex((f) => f.relPath === relPath || (wsRoot && f.absPath === path.resolve(wsRoot, relPath)));
    if (idx >= 0) {
      this.changedFiles.splice(idx, 1);
      // 调整 currentFileIdx
      if (this.currentFileIdx >= this.changedFiles.length) {
        this.currentFileIdx = Math.max(0, this.changedFiles.length - 1);
      }
      this.updateBar();
    }
  }

  /** 更新状态栏显示 */
  private updateBar(): void {
    const count = this.changedFiles.length;
    if (count === 0) {
      this.hide();
      return;
    }

    // 更新主标签
    this.items[0]!.text = `$(files) DevSeeker: ${count} file${count > 1 ? 's' : ''} changed`;
    if (this.currentFileIdx >= 0 && this.currentFileIdx < count) {
      const cur = this.changedFiles[this.currentFileIdx]!;
      this.items[0]!.tooltip = `当前: ${cur.relPath} (+${cur.added} -${cur.removed})`;
    }

    // 导航按钮：多个文件时显示
    if (count > 1) {
      this.items[1]!.text = '$(arrow-left) 上一个';
      this.items[2]!.text = '$(arrow-right) 下一个';
    }

    this.show();
  }

  /** 导航到下一个文件 */
  private async navigateToNextFile(): Promise<void> {
    if (this.changedFiles.length === 0) return;
    this.currentFileIdx = (this.currentFileIdx + 1) % this.changedFiles.length;
    await this.openCurrentFile();
    this.updateBar();
  }

  /** 导航到上一个文件 */
  private async navigateToPrevFile(): Promise<void> {
    if (this.changedFiles.length === 0) return;
    this.currentFileIdx = (this.currentFileIdx - 1 + this.changedFiles.length) % this.changedFiles.length;
    await this.openCurrentFile();
    this.updateBar();
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

  /** 接受所有变更：移除装饰，保留文件内容 */
  private async acceptAll(): Promise<void> {
    await this.inlineDiffController.acceptAllFiles();
    this.clear();
    vscode.window.showInformationMessage('DevSeeker: 所有文件变更已接受');
  }

  /** 拒绝所有变更：回滚所有文件到原始内容，移除装饰 */
  private async rejectAll(): Promise<void> {
    await this.inlineDiffController.rejectAllFiles();
    this.clear();
    vscode.window.showInformationMessage('DevSeeker: 所有文件变更已拒绝（已恢复原始内容）');
  }

  /** 清除所有状态 */
  clear(): void {
    this.changedFiles = [];
    this.currentFileIdx = -1;
    this.hide();
  }

  private show(): void {
    // 标签、同意、拒绝始终显示
    this.items[0]!.show();
    this.items[3]!.show();
    this.items[4]!.show();
    // 导航按钮仅在多文件时显示
    if (this.changedFiles.length > 1) {
      this.items[1]!.show();
      this.items[2]!.show();
    } else {
      this.items[1]!.hide();
      this.items[2]!.hide();
    }
    this.visible = true;
  }

  private hide(): void {
    for (const item of this.items) {
      item.hide();
    }
    this.visible = false;
  }

  /** 当任务结束时由外部调用 */
  onTaskEnd(): void {
    // no-op: 暂停逻辑已移除
  }

  dispose(): void {
    for (const item of this.items) {
      item.dispose();
    }
    this.items.length = 0;
  }
}
