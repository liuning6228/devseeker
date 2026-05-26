/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * StreamingDiffViewProvider — 在 tool_args_delta 阶段实时渲染 Diff 编辑器
 *
 * P0-7 v3: 虚拟 URI + 临时文件 + WorkspaceEdit
 *
 * 架构：
 * - 左侧：虚拟 URI（dualmind-diff:filename?base64(originalContent)），由 TextDocumentContentProvider 提供
 * - 右侧：临时文件（workspaceRoot/.dualmind/tmp/filename.tmp），用 WorkspaceEdit 修改
 *
 * 为什么要用临时文件而不是目标文件：
 * - StreamingFileWriter 同时在用 fs.writeFile 写目标文件
 * - 如果 Diff 右侧也修改目标文件（WorkspaceEdit），两者冲突 → dirty 状态 → write_file 失败 → 崩溃
 * - 用临时文件隔离：Diff 只改临时文件，write_file 只改目标文件，互不干扰
 *
 * 流程：
 * 1. tool_start → open(relPath) → 创建临时文件 → 打开 Diff 编辑器
 * 2. tool_args_delta → update(partialArgs) → WorkspaceEdit.replace 修改临时文件
 * 3. tool_end / tool_exec_end → close() → 关闭 Diff 编辑器 → 删除临时文件
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { extractPartialContent } from '../core/tools/streaming-file-writer.js';
import { getLogger } from '../infra/logger.js';

const log = getLogger('streaming-diff-view');

// ─────────── 虚拟 URI scheme ───────────

/** Diff 编辑器左侧原始内容使用的 URI scheme */
export const DIFF_VIEW_URI_SCHEME = 'dualmind-diff';

/** Diff 编辑器标签页标题后缀 */
const DIFF_VIEW_LABEL_CHANGES = "Original ↔ DualMind's Changes";

/** 临时文件目录名 */
const TMP_DIR_NAME = '.dualmind';

// ─────────── 装饰类型 ───────────

/** 当前写入行高亮（黄色边框，参考 Roo Code） */
const activeLineType = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(255, 255, 0, 0.3)',
  border: '1px solid rgba(255, 255, 0, 0.5)',
  isWholeLine: true,
});

/** 未写入区域灰覆盖（右侧编辑器中尚未生成的部分用灰色背景表示） */
const fadedOverlayType = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(255, 255, 0, 0.1)',
  opacity: '0.4',
  isWholeLine: true,
});

// ─────────── StreamingDiffViewProvider ───────────

export class StreamingDiffViewProvider implements vscode.Disposable {
  private readonly workspaceRoot: string;
  /** 当前活跃的 Diff 编辑器（右侧临时文件） */
  private activeDiffEditor: vscode.TextEditor | null = null;
  /** 原始文件内容（Diff 左侧） */
  private originalContent = '';
  /** 当前正在编辑的相对路径 */
  private activeRelPath = '';
  /** 当前正在编辑的绝对路径（目标文件） */
  private activeAbsPath = '';
  /** 临时文件 URI（Diff 右侧） */
  private tempFileUri: vscode.Uri | null = null;
  /** 临时文件绝对路径 */
  private tempFilePath = '';
  /** 是否处于编辑状态 */
  private isEditing = false;
  /** toolCallId → relPath 映射（支持多个并发工具调用） */
  private readonly activeToolCalls = new Map<string, string>();
  /** 已流式传输的完整行数组（用于增量更新和 final 截断） */
  private streamedLines: string[] = [];
  /** C10: 用户切换编辑器时的监听器 */
  private onDidChangeEditorDisposable: vscode.Disposable | null = null;

  /** 节流：上次实际更新的时间戳 */
  private lastUpdateTime = 0;
  /** 节流：上次更新时的 content 长度（用于跳过无变化更新） */
  private lastUpdateContentLength = -1;
  /** 最小更新间隔（ms）
   * v3.1: 从 200ms 降至 100ms，配合增量行范围替换后 Extension Host 压力大幅降低 */
  private static readonly UPDATE_THROTTLE_MS = 100;
  /** 大文件保护阈值：超过此行数跳过实时 DiffView */
  private static readonly MAX_LINES_FOR_STREAMING = 500;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * tool_start 时调用：打开 Diff 编辑器。
   * @param toolCallId 工具调用 ID
   * @param relPath 相对文件路径
   * @param toolName 工具名称（仅 write_file / append_file 支持实时渲染）
   */
  async open(toolCallId: string, relPath: string, toolName: string): Promise<void> {
    // 方案 A：彻底禁用实时 Diff 编辑器，从根本上消除 Extension Host 阻塞风险。
    // 所有 diff 展示交由 webview 的 emitToolDiff 处理（panel.ts 中已有，不操作编辑器）。
    if (toolName !== 'write_file' && toolName !== 'append_file') return;

    if (this.isEditing && arePathsEqual(this.activeRelPath, relPath)) {
      log.debug({ toolCallId, relPath }, 'DiffView already open for same file, skipping');
      return;
    }
    if (this.isEditing) {
      const prevIds = Array.from(this.activeToolCalls.keys());
      for (const id of prevIds) {
        await this.close(id);
      }
    }

    this.activeRelPath = relPath;
    this.isEditing = true;
    this.activeToolCalls.set(toolCallId, relPath);

    log.info({ toolCallId, relPath }, 'StreamingDiffView: open (方案A，不渲染编辑器)');
  }

  /**
   * tool_args_delta / tool_end 时调用：实时更新 Diff 右侧内容（临时文件）。
   * v3.1: 改用 WorkspaceEdit 按行范围替换，避免 editor.edit() 全量字符替换导致的 Extension Host 卡死。
   * @param toolCallId 工具调用 ID
   * @param partialArgs 部分参数 JSON
   * @param isFinal 是否为最终更新（tool_end 时传 true）
   */
  async update(toolCallId: string, partialArgs: string, isFinal = false): Promise<void> {
    // 方案 A：彻底禁用实时 Diff 编辑器更新，从根本上消除 Extension Host 阻塞风险。
    // 所有 diff 展示交由 webview 的 emitToolDiff 处理。
    if (!this.isEditing) return;
    const trackedPath = this.activeToolCalls.get(toolCallId);
    if (!trackedPath) return;
    // 空操作：不执行任何编辑器 API 调用
  }

  /**
   * tool_end / tool_exec_end 时调用：关闭 Diff 编辑器并清理临时文件。
   * @param toolCallId 工具调用 ID
   */
  async close(toolCallId: string): Promise<void> {
    // 方案 A：彻底禁用实时 Diff 编辑器，只清理状态。
    if (!this.activeToolCalls.has(toolCallId)) return;
    this.activeToolCalls.delete(toolCallId);
    if (this.activeToolCalls.size > 0) return;
    this.isEditing = false;
    log.info({ toolCallId }, 'StreamingDiffView: close (方案A)');
  }

  /**
   * SSE 断裂时调用：关闭 Diff 编辑器，保留已写入内容。
   */
  onStreamBroken(): void {
    log.info('StreamingDiffView: stream broken, keeping diff view for user inspection');
    // 不主动关闭——让用户看到已生成的部分
    // 但停止监听编辑器切换
    this.disposeEditorChangeListener();
  }

  /** 检查是否有活跃的 Diff 编辑器 */
  get isOpen(): boolean {
    return this.isEditing;
  }

  // ─────────── 内部方法 ───────────

  /**
   * 打开 Diff 编辑器。
   * 左侧：虚拟 URI（dualmind-diff:filename?base64(originalContent)）
   * 右侧：临时文件（.dualmind/tmp/filename.diff.tmp）
   */
  private async openDiffEditor(): Promise<vscode.TextEditor> {
    if (!this.tempFileUri) throw new Error('tempFileUri not set');

    const fileName = path.basename(this.activeAbsPath);
    const fileExists = this.originalContent.length > 0;

    // 构造左侧虚拟 URI：将原始内容 base64 编码放入 query
    const originalUri = vscode.Uri.parse(
      `${DIFF_VIEW_URI_SCHEME}:${fileName.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F')}`,
    ).with({
      query: Buffer.from(this.originalContent).toString('base64'),
    });

    // 检查是否已有同文件的 Diff 编辑器打开（上一次被中断的情况）
    const diffTab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (tab) =>
          tab.input instanceof vscode.TabInputTextDiff &&
          (tab.input as vscode.TabInputTextDiff).original?.scheme === DIFF_VIEW_URI_SCHEME &&
          (tab.input as vscode.TabInputTextDiff).modified &&
          arePathsEqual((tab.input as vscode.TabInputTextDiff).modified.fsPath, this.tempFilePath),
      );

    if (diffTab && diffTab.input instanceof vscode.TabInputTextDiff) {
      // 复用已有的 Diff 编辑器
      const editor = await vscode.window.showTextDocument(diffTab.input.modified, { preserveFocus: true });
      // 初始化装饰：对全部行应用灰覆盖
      this.applyFadedOverlay(editor, 0);
      return editor;
    }

    // 先关闭目标文件的普通 tab（如果打开的话），避免干扰
    const targetUri = vscode.Uri.file(this.activeAbsPath);
    const existingTabs = vscode.window.tabGroups.all
      .flatMap((tg) => tg.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputText &&
          arePathsEqual(tab.input.uri.fsPath, targetUri.fsPath),
      );
    for (const tab of existingTabs) {
      if (!tab.isDirty) {
        try {
          await vscode.window.tabGroups.close(tab);
        } catch {
          // 忽略关闭失败
        }
      }
    }

    // 打开新的 Diff 编辑器
    return new Promise<vscode.TextEditor>((resolve, reject) => {
      const disposables: vscode.Disposable[] = [];
      const DIFF_EDITOR_TIMEOUT = 10_000; // ms

      const cleanup = () => {
        disposables.forEach((d) => d.dispose());
        disposables.length = 0;
      };

      // 超时保护
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Failed to open diff editor within ${DIFF_EDITOR_TIMEOUT / 1000}s`));
      }, DIFF_EDITOR_TIMEOUT);

      // 监听编辑器打开（右侧是临时文件）
      disposables.push(
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
          const editor = editors.find(
            (e) => arePathsEqual(e.document.uri.fsPath, this.tempFilePath),
          );
          if (editor) {
            clearTimeout(timeoutId);
            cleanup();
            // 初始化装饰：对全部行应用灰覆盖
            this.applyFadedOverlay(editor, 0);
            resolve(editor);
          }
        }),
      );

      // 执行 vscode.diff 命令
      vscode.commands
        .executeCommand(
          'vscode.diff',
          originalUri,
          this.tempFileUri,
          `${fileName}: ${fileExists ? DIFF_VIEW_LABEL_CHANGES : 'New File'} (Streaming)`,
          { preserveFocus: true },
        )
        .then(
          () => {
            // 命令执行成功，等待编辑器打开（由上面的监听器 resolve）
          },
          (err: any) => {
            clearTimeout(timeoutId);
            cleanup();
            reject(new Error(`Failed to execute diff command: ${err?.message ?? err}`));
          },
        );
    });
  }

  /**
   * v3.1: 执行内容更新 —— 改用 WorkspaceEdit 按行范围替换。
   * 参考 Roo-Code DiffViewProvider.update() 实现：
   * - endLine = accumulatedLines.length
   * - Range(0, 0, endLine, 0) 只替换到当前行，避免 O(n) 全量字符扫描
   * - final 时 truncateDocument() 截断旧内容残留
   * - final 时再做一次全量替换确保完全一致
   */
  private async applyUpdate(accumulatedContent: string, isFinal: boolean): Promise<void> {
    const editor = this.activeDiffEditor;
    if (!editor || !editor.document) return;
    if (!this.isEditing) return;

    const document = editor.document;
    const accumulatedLines = accumulatedContent.split('\n');

    if (!isFinal) {
      accumulatedLines.pop(); // 移除最后一个不完整行（流式生成中）
    }

    const endLine = accumulatedLines.length;
    const contentToReplace =
      accumulatedLines.slice(0, endLine).join('\n') + (accumulatedLines.length > 0 ? '\n' : '');

    // v3.1 关键变更：使用 WorkspaceEdit 按行范围替换，替代 editor.edit() 全量字符替换
    try {
      const edit = new vscode.WorkspaceEdit();
      const rangeToReplace = new vscode.Range(0, 0, endLine, 0);
      edit.replace(document.uri, rangeToReplace, contentToReplace);
      await vscode.workspace.applyEdit(edit);
    } catch (e) {
      log.warn({ err: String(e) }, 'WorkspaceEdit.applyEdit failed in streaming diff');
      return;
    }

    // 更新装饰：活跃行高亮 + 灰覆盖
    this.updateDecorations(endLine, document.lineCount);

    // 自动滚动（仅在当前视口外时滚动）
    try {
      const ranges = editor.visibleRanges;
      if (ranges.length > 0 && (ranges[0].start.line > endLine || ranges[0].end.line < endLine)) {
        const scrollLine = endLine + 4;
        editor.revealRange(
          new vscode.Range(scrollLine, 0, scrollLine, 0),
          vscode.TextEditorRevealType.InCenter,
        );
      }
    } catch {
      // 忽略滚动失败
    }

    // 更新 streamedLines 用于 final 截断和增量计算
    this.streamedLines = accumulatedLines;

    if (isFinal) {
      await this.finalizeUpdate(accumulatedContent);
    }
  }

  /**
   * v3.1: final 更新时的收尾工作。
   * 1. 截断文档中超出新内容的多余行（解决旧内容残留问题）
   * 2. 做一次最终全量替换确保内容完全一致（包括 trailing newline 等边界情况）
   * 3. 清理装饰器
   */
  private async finalizeUpdate(accumulatedContent: string): Promise<void> {
    const editor = this.activeDiffEditor;
    if (!editor || !editor.document) return;
    const document = editor.document;

    // 1. 截断：如果新内容比文档短，删除多余行
    if (this.streamedLines.length < document.lineCount) {
      try {
        const truncateEdit = new vscode.WorkspaceEdit();
        truncateEdit.delete(
          document.uri,
          new vscode.Range(this.streamedLines.length, 0, document.lineCount, 0),
        );
        await vscode.workspace.applyEdit(truncateEdit);
      } catch (e) {
        log.warn({ err: String(e) }, 'truncateDocument failed in streaming diff');
      }
    }

    // 2. 最终全量替换：确保 trailing newline 等边界情况完全一致
    try {
      const finalEdit = new vscode.WorkspaceEdit();
      finalEdit.replace(
        document.uri,
        new vscode.Range(0, 0, document.lineCount, 0),
        accumulatedContent,
      );
      await vscode.workspace.applyEdit(finalEdit);
    } catch (e) {
      log.warn({ err: String(e) }, 'finalEdit failed in streaming diff');
    }

    // 3. 清理装饰
    this.clearDecorations();
  }

  /** 更新装饰：活跃行高亮 + 灰覆盖 */
  private updateDecorations(activeLine: number, totalLines: number): void {
    if (!this.activeDiffEditor) return;

    // 活跃行
    const activeRange = new vscode.Range(activeLine, 0, activeLine, 0);

    // 灰覆盖：活跃行之后的所有行
    const fadedRanges: vscode.Range[] = [];
    if (activeLine + 1 < totalLines) {
      fadedRanges.push(new vscode.Range(activeLine + 1, 0, totalLines - 1, 0));
    }

    try {
      this.activeDiffEditor.setDecorations(activeLineType, [activeRange]);
      this.activeDiffEditor.setDecorations(fadedOverlayType, fadedRanges);
    } catch {
      // 编辑器可能已关闭
    }
  }

  /** 初始化灰覆盖（全部行） */
  private applyFadedOverlay(editor: vscode.TextEditor, afterLine: number): void {
    try {
      const lineCount = editor.document.lineCount;
      const fadedRanges: vscode.Range[] = [];
      if (afterLine < lineCount) {
        fadedRanges.push(new vscode.Range(afterLine, 0, lineCount - 1, 0));
      }
      editor.setDecorations(fadedOverlayType, fadedRanges);
      editor.setDecorations(activeLineType, []);
    } catch {
      // 忽略
    }
  }

  /** 清除所有装饰 */
  private clearDecorations(): void {
    if (!this.activeDiffEditor) return;
    try {
      this.activeDiffEditor.setDecorations(activeLineType, []);
      this.activeDiffEditor.setDecorations(fadedOverlayType, []);
    } catch {
      // 忽略
    }
  }

  /** 关闭所有 dualmind-diff 的 Diff 编辑器 tab（包括 dirty 的） */
  private async closeAllDiffViews(): Promise<void> {
    // 先清理装饰，避免在编辑器关闭后还尝试操作
    this.clearDecorations();

    // 临时置空 activeDiffEditor，防止后续 update/close 操作
    const editorRef = this.activeDiffEditor;
    this.activeDiffEditor = null;

    // 收集所有需要关闭的 Diff tab
    const tabsToClose = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => {
        // 匹配虚拟 URI scheme 的 Diff tab
        if (
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.original.scheme === DIFF_VIEW_URI_SCHEME
        ) {
          return true;
        }
        // Fallback: 按标签名匹配
        if (tab.label.includes(DIFF_VIEW_LABEL_CHANGES)) {
          return true;
        }
        return false;
      });

    log.info({ tabsToClose: tabsToClose.length }, 'closeAllDiffViews: closing diff tabs');

    // 强制关闭所有匹配的 tab（包括 dirty 的）
    for (const tab of tabsToClose) {
      try {
        await vscode.window.tabGroups.close(tab, true); // true = 强制关闭（不保存）
      } catch (e) {
        log.warn({ err: String(e), tabLabel: tab.label }, 'Failed to close diff tab');
      }
    }

    log.info('closeAllDiffViews: done');
  }

  /** 清理临时文件 */
  private async cleanupTempFile(): Promise<void> {
    if (this.tempFilePath) {
      try {
        await fs.unlink(this.tempFilePath);
      } catch {
        // 忽略（文件可能已被删除）
      }
    }
  }

  /**
   * C10: 注册编辑器切换监听。
   * 当用户在 DiffView 预览期间主动切换到其他文件编辑时，自动关闭 DiffView。
   */
  private registerEditorChangeListener(): void {
    this.disposeEditorChangeListener();
    this.onDidChangeEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!this.isEditing) return;
      // 用户切换到了非 Diff 编辑器的文件 → 自动关闭
      if (editor && this.tempFilePath) {
        const switchedToDiffSide =
          arePathsEqual(editor.document.uri.fsPath, this.tempFilePath) ||
          editor.document.uri.scheme === DIFF_VIEW_URI_SCHEME;
        if (!switchedToDiffSide) {
          log.info({ switchedTo: editor.document.uri.fsPath }, 'C10: user switched editor, auto-closing DiffView');
          const activeIds = Array.from(this.activeToolCalls.keys());
          for (const id of activeIds) {
            void this.close(id);
          }
        }
      }
    });
  }

  /** 清理编辑器切换监听器 */
  private disposeEditorChangeListener(): void {
    if (this.onDidChangeEditorDisposable) {
      this.onDidChangeEditorDisposable.dispose();
      this.onDidChangeEditorDisposable = null;
    }
  }

  dispose(): void {
    this.clearDecorations();
    this.disposeEditorChangeListener();
    void this.cleanupTempFile();
    this.activeDiffEditor = null;
    this.tempFileUri = null;
    this.tempFilePath = '';
    this.isEditing = false;
    this.streamedLines = [];
    this.lastUpdateContentLength = -1;
    this.lastUpdateTime = 0;
  }
}

// ─────────── 工具函数 ───────────

/** 比较两个路径是否相同（跨平台安全） */
function arePathsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
