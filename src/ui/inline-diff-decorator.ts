/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * InlineDiffDecorator —— 编辑器内联 hunk 级 Accept/Reject 浮条
 *
 * Phase 3 核心功能：
 * - 红绿装饰：添加行（绿色背景）、删除行（红色背景）
 * - hunk 级浮条：每个 hunk 首行上方显示 [✓ Accept] [✗ Reject] + 统计
 * - ↑ N/M ↓ 段间跳转：快捷键在 hunk 间导航
 * - Ctrl+Enter 采纳 / Ctrl+Backspace 拒绝
 *
 * 工作流程：
 * 1. panel.ts emitToolDiff 时通知 InlineDiffController
 * 2. Controller 解析 unified diff → hunks → 为每个 hunk 创建装饰
 * 3. 用户可在编辑器中直接 Accept/Reject 每个 hunk
 * 4. Accept：移除该 hunk 的装饰（文件已写入，无需操作）
 * 5. Reject：调用 revertHunk 回滚该 hunk，然后移除装饰
 */

import * as vscode from 'vscode';
import { parseUnifiedDiff, type Hunk, type ParsedDiff } from '../core/diff/hunk-parser.js';
import { revertHunk } from '../core/diff/hunk-reverter.js';
import { getLogger } from '../infra/logger.js';

const log = getLogger('inline-diff-decorator');

// ─────────── 装饰类型 ───────────

/** 添加行背景色（绿色） */
const addedLineType = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(40, 167, 69, 0.15)',
  isWholeLine: true,
  overviewRulerColor: 'rgba(40, 167, 69, 0.6)',
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

/** 删除行背景色（红色） — 用 after 装饰在上一行末尾显示 */
const removedLineType = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(248, 81, 73, 0.15)',
  isWholeLine: true,
  overviewRulerColor: 'rgba(248, 81, 73, 0.6)',
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

/** hunk 头浮条：显示 hunk 范围 + Accept/Reject 提示（模拟按钮外观） */
const hunkHeaderType = vscode.window.createTextEditorDecorationType({
  after: {
    color: new vscode.ThemeColor('editor.background'),
    backgroundColor: new vscode.ThemeColor('editorCodeLens.foreground'),
    border: '1px solid',
    borderColor: new vscode.ThemeColor('editorCodeLens.foreground'),
    margin: '0 0 0 16px',
  },
  isWholeLine: true,
});

/** 当前聚焦 hunk 高亮 */
const activeHunkType = vscode.window.createTextEditorDecorationType({
  border: '1px solid rgba(100, 150, 255, 0.4)',
  isWholeLine: true,
});

// ─────────── Hunk 装饰数据 ───────────

interface HunkDecoration {
  /** hunk 在 parsed diff 中的索引 */
  hunkIndex: number;
  /** 新文件中（after）的行范围（0-based） */
  newRange: vscode.Range;
  /** 仅 add 行的范围列表（用于绿色背景，不含 context 行） */
  addRanges: vscode.Range[];
  /** 旧文件中（before）删除行的行号列表（1-based） */
  deletedLineNumbers: number[];
  /** 装饰状态 */
  state: 'pending' | 'accepted' | 'rejected';
}

// ─────────── FileDecorator — 单文件的装饰管理 ───────────

class FileDecorator implements vscode.Disposable {
  private hunks: HunkDecoration[] = [];
  private parsedDiff: ParsedDiff | null = null;
  private activeHunkIdx = -1;
  private disposed = false;

  constructor(
    private readonly editor: vscode.TextEditor,
    private readonly absPath: string,
    private readonly relPath: string,
    private readonly onDispose: (absPath: string) => void,
  ) {}

  /** 应用 diff 装饰 */
  applyDiff(unified: string): void {
    this.parsedDiff = parseUnifiedDiff(unified);
    this.hunks = [];
    if (!this.parsedDiff || this.parsedDiff.hunks.length === 0) return;

    const doc = this.editor.document;
    const lineCount = doc.lineCount;

    for (const hunk of this.parsedDiff.hunks) {
      // hunk.newStart 是 1-based，转 0-based
      const startLine = Math.max(0, hunk.newStart - 1);
      const endLine = Math.min(lineCount - 1, startLine + hunk.newCount - 1);
      if (startLine >= lineCount) continue;

      // 计算仅 add 行的范围（不含 context 行）
      const addRanges: vscode.Range[] = [];
      let currentLine = startLine;
      for (const hline of hunk.lines) {
        if (hline.type === 'context') {
          currentLine++;
        } else if (hline.type === 'add') {
          if (currentLine < lineCount) {
            const lineEnd = doc.lineAt(currentLine).text.length;
            addRanges.push(new vscode.Range(currentLine, 0, currentLine, lineEnd));
          }
          currentLine++;
        }
        // del 行在新文件中不存在，不占行号
      }

      const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
      this.hunks.push({
        hunkIndex: hunk.index,
        newRange: range,
        deletedLineNumbers: [],
        state: 'pending',
        addRanges,
      });
    }

    this.render();
  }

  /** Accept 当前聚焦 hunk */
  acceptActiveHunk(): void {
    if (this.activeHunkIdx >= 0 && this.activeHunkIdx < this.hunks.length) {
      this.hunks[this.activeHunkIdx].state = 'accepted';
      this.render();
      this.navigateNext();
      this.checkAllDone();
    }
  }

  /** Reject 当前聚焦 hunk（回滚到原始内容） */
  async rejectActiveHunk(): Promise<void> {
    if (!this.parsedDiff || this.activeHunkIdx < 0 || this.activeHunkIdx >= this.hunks.length) return;
    const hunk = this.parsedDiff.hunks[this.activeHunkIdx];
    if (!hunk) return;

    try {
      const result = await revertHunk(this.absPath, hunk);
      if (result.ok) {
        this.hunks[this.activeHunkIdx].state = 'rejected';
        this.render();
        this.navigateNext();
        this.checkAllDone();
        log.info({ relPath: this.relPath, hunkIdx: this.activeHunkIdx }, 'hunk rejected successfully');
      } else {
        vscode.window.showWarningMessage(`Hunk 回滚失败：${result.message}`);
      }
    } catch (e) {
      log.warn({ err: String(e), relPath: this.relPath }, 'hunk reject failed');
      vscode.window.showWarningMessage(`Hunk 回滚出错：${String(e)}`);
    }
  }

  /** Accept 全部 pending hunks */
  acceptAll(): void {
    for (const h of this.hunks) {
      if (h.state === 'pending') h.state = 'accepted';
    }
    this.render();
    this.clearAll();
  }

  /** Reject 全部 pending hunks */
  async rejectAll(): Promise<void> {
    if (!this.parsedDiff) return;
    for (let i = 0; i < this.hunks.length; i++) {
      if (this.hunks[i].state !== 'pending') continue;
      const hunk = this.parsedDiff.hunks[i];
      if (!hunk) continue;
      try {
        await revertHunk(this.absPath, hunk);
        this.hunks[i].state = 'rejected';
      } catch {
        // 继续处理其他 hunk
      }
    }
    this.render();
    this.clearAll();
  }

  /** 跳转到下一个 hunk */
  navigateNext(): void {
    if (this.hunks.length === 0) return;
    // 从当前 hunk 开始找下一个 pending 的
    const start = this.activeHunkIdx + 1;
    for (let i = 0; i < this.hunks.length; i++) {
      const idx = (start + i) % this.hunks.length;
      if (this.hunks[idx].state === 'pending') {
        this.activeHunkIdx = idx;
        this.revealHunk(idx);
        this.render();
        return;
      }
    }
    // 没有 pending 的了，保持当前位置
    this.render();
  }

  /** 跳转到上一个 hunk */
  navigatePrev(): void {
    if (this.hunks.length === 0) return;
    const start = this.activeHunkIdx - 1;
    for (let i = 0; i < this.hunks.length; i++) {
      const idx = (start - i + this.hunks.length) % this.hunks.length;
      if (this.hunks[idx].state === 'pending') {
        this.activeHunkIdx = idx;
        this.revealHunk(idx);
        this.render();
        return;
      }
    }
    this.render();
  }

  /** 获取状态信息 */
  getStatus(): { total: number; pending: number; accepted: number; rejected: number; activeIdx: number } {
    let pending = 0, accepted = 0, rejected = 0;
    for (const h of this.hunks) {
      if (h.state === 'pending') pending++;
      else if (h.state === 'accepted') accepted++;
      else if (h.state === 'rejected') rejected++;
    }
    return { total: this.hunks.length, pending, accepted, rejected, activeIdx: this.activeHunkIdx };
  }

  /** 渲染所有装饰 */
  private render(): void {
    if (this.disposed || !this.parsedDiff) return;

    const addedRanges: vscode.Range[] = [];
    const removedRanges: vscode.Range[] = [];
    const hunkHeaderOptions: vscode.DecorationOptions[] = [];
    const activeRanges: vscode.Range[] = [];

    const doc = this.editor.document;
    const lineCount = doc.lineCount;

    for (let i = 0; i < this.hunks.length; i++) {
      const hd = this.hunks[i];
      const hunk = this.parsedDiff!.hunks[i];
      if (!hunk) continue;
      if (hd.state !== 'pending') continue;

      // 添加行：只标绿 add 行（不含 context 行）
      addedRanges.push(...hd.addRanges);

      // 删除行：从 hunk.lines 中提取 del 行，映射到 after 文件中的位置
      // 删除行在 after 文件中不存在，我们把它们作为虚行附加在 hunk 首行
      // VS Code 不支持真正的"虚行"，改用 after 装饰在 hunk 首行显示删除行信息

      // hunk 头浮条
      const stats = { added: 0, removed: 0 };
      for (const line of hunk.lines) {
        if (line.type === 'add') stats.added++;
        if (line.type === 'del') stats.removed++;
      }
      const isFirstLine = hd.newRange.start.line < lineCount;
      if (isFirstLine) {
        const pos = new vscode.Position(hd.newRange.start.line, 0);
        hunkHeaderOptions.push({
          range: new vscode.Range(pos, pos),
          hoverMessage: new vscode.MarkdownString(
            `**Hunk ${i + 1}/${this.hunks.length}** · +${stats.added} -${stats.removed}\n\n` +
            `[Accept (Ctrl+Enter)](command:dualMind.inlineDiff.accept) · [Reject (Ctrl+Backspace)](command:dualMind.inlineDiff.reject)`
          ),
          renderOptions: {
            after: {
              contentText: `  ↑ ${i + 1}/${this.hunks.length} ↓   拒绝 Ctrl+⌫   采纳 Ctrl+Enter   +${stats.added}/-${stats.removed}  `,
              color: new vscode.ThemeColor('editor.background'),
              backgroundColor: new vscode.ThemeColor('editorCodeLens.foreground'),
              border: '1px solid',
              borderColor: new vscode.ThemeColor('editorCodeLens.foreground'),
              margin: '0 0 0 16px',
            },
          },
        });
      }

      // 活跃 hunk 高亮
      if (i === this.activeHunkIdx) {
        activeRanges.push(hd.newRange);
      }
    }

    try {
      this.editor.setDecorations(addedLineType, addedRanges);
      this.editor.setDecorations(removedLineType, removedRanges);
      this.editor.setDecorations(hunkHeaderType, hunkHeaderOptions);
      this.editor.setDecorations(activeHunkType, activeRanges);
    } catch {
      // 编辑器可能已关闭
    }
  }

  /** 滚动到指定 hunk */
  private revealHunk(idx: number): void {
    if (idx < 0 || idx >= this.hunks.length) return;
    const range = this.hunks[idx].newRange;
    this.editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  /** 全部处理完毕 → 清除装饰 */
  private checkAllDone(): void {
    const allDone = this.hunks.every((h) => h.state !== 'pending');
    if (allDone) {
      this.clearAll();
    }
  }

  /** 清除所有装饰 */
  private clearAll(): void {
    try {
      this.editor.setDecorations(addedLineType, []);
      this.editor.setDecorations(removedLineType, []);
      this.editor.setDecorations(hunkHeaderType, []);
      this.editor.setDecorations(activeHunkType, []);
    } catch {
      // ignore
    }
    this.onDispose(this.absPath);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.editor.setDecorations(addedLineType, []);
      this.editor.setDecorations(removedLineType, []);
      this.editor.setDecorations(hunkHeaderType, []);
      this.editor.setDecorations(activeHunkType, []);
    } catch {
      // ignore
    }
  }
}

// ─────────── InlineDiffController — 全局控制器 ───────────

/** 大文件保护：超过此行数的文件跳过内联装饰（防止 Extension Host 卡死） */
const MAX_LINES_FOR_INLINE_DIFF = 2000;

export class InlineDiffController implements vscode.Disposable {
  private readonly decorators = new Map<string, FileDecorator>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    // 注册命令
    this.disposables.push(
      vscode.commands.registerCommand('dualMind.inlineDiff.accept', () => this.acceptActive()),
      vscode.commands.registerCommand('dualMind.inlineDiff.reject', () => this.rejectActive()),
      vscode.commands.registerCommand('dualMind.inlineDiff.acceptAll', () => this.acceptAll()),
      vscode.commands.registerCommand('dualMind.inlineDiff.rejectAll', () => this.rejectAll()),
      vscode.commands.registerCommand('dualMind.inlineDiff.nextHunk', () => this.navigateNext()),
      vscode.commands.registerCommand('dualMind.inlineDiff.prevHunk', () => this.navigatePrev()),
    );

    // 监听编辑器切换 → 更新 inlineDiffActive 上下文
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        vscode.commands.executeCommand(
          'setContext', 'dualMind.inlineDiffActive',
          editor ? this.decorators.has(editor.document.uri.fsPath) : false,
        );
      }),
    );

    // 监听编辑器关闭 → 清理
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        const visiblePaths = new Set(editors.map((e) => e.document.uri.fsPath));
        for (const [absPath, decorator] of this.decorators) {
          if (!visiblePaths.has(absPath)) {
            decorator.dispose();
            this.decorators.delete(absPath);
          }
        }
      }),
    );
  }

  /** 接收 tool_diff 数据，为对应文件创建装饰 */
  async onToolDiff(absPath: string, relPath: string, unified: string): Promise<void> {
    // 大文件保护：统计 hunk 数量，过多时跳过内联装饰
    const hunkCount = (unified.match(/^@@/gm) || []).length;
    if (hunkCount > MAX_LINES_FOR_INLINE_DIFF) {
      log.info(
        { relPath, hunkCount, max: MAX_LINES_FOR_INLINE_DIFF },
        'inline diff skipped: too many hunks (large file protection)',
      );
      return;
    }

    // 找到打开该文件的编辑器
    let editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === absPath,
    );
    // 延迟重试：openTextDocument + showTextDocument 是 async，编辑器可能还未 visible
    if (!editor) {
      await new Promise((r) => setTimeout(r, 300));
      editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.fsPath === absPath,
      );
    }
    if (!editor) {
      log.debug({ relPath }, 'no visible editor for diff after retry, skipping inline decoration');
      return;
    }

    // 大文件保护：文件行数过多时跳过
    if (editor.document.lineCount > MAX_LINES_FOR_INLINE_DIFF) {
      log.info(
        { relPath, lineCount: editor.document.lineCount, max: MAX_LINES_FOR_INLINE_DIFF },
        'inline diff skipped: file too large (Extension Host protection)',
      );
      return;
    }

    // 已有装饰 → 更新
    let decorator = this.decorators.get(absPath);
    if (decorator) {
      decorator.applyDiff(unified);
    } else {
      decorator = new FileDecorator(editor, absPath, relPath, (path) => {
        this.decorators.delete(path);
      });
      decorator.applyDiff(unified);
      this.decorators.set(absPath, decorator);
    }

    // 自动跳转到第一个 hunk
    decorator.navigateNext();

    // 显示状态栏提示
    const status = decorator.getStatus();
    vscode.window.setStatusBarMessage(
      `DualMind Diff: ${relPath} — Hunk ${status.activeIdx + 1}/${status.total}  (${status.pending} pending)  Ctrl+Enter Accept · Ctrl+Backspace Reject`,
      5000,
    );

    log.info({ relPath, hunkCount: status.total }, 'inline diff decorations applied');

    // 设置 inlineDiffActive 上下文 → 激活快捷键
    vscode.commands.executeCommand('setContext', 'dualMind.inlineDiffActive', true);
  }

  private getActiveDecorator(): FileDecorator | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    return this.decorators.get(editor.document.uri.fsPath);
  }

  private acceptActive(): void {
    this.getActiveDecorator()?.acceptActiveHunk();
  }

  private rejectActive(): void {
    this.getActiveDecorator()?.rejectActiveHunk();
  }

  private acceptAll(): void {
    this.getActiveDecorator()?.acceptAll();
  }

  private rejectAll(): void {
    this.getActiveDecorator()?.rejectAll();
  }

  private navigateNext(): void {
    this.getActiveDecorator()?.navigateNext();
  }

  private navigatePrev(): void {
    this.getActiveDecorator()?.navigatePrev();
  }

  /** 跳转到指定文件的第一个 pending hunk（供 EditorChangeBar 调用） */
  navigateToFirstHunk(absPath: string): void {
    const decorator = this.decorators.get(absPath);
    if (decorator) {
      // 将 activeHunkIdx 重置并导航到第一个 pending
      decorator.navigateNext();
    }
  }

  /** 对所有已装饰文件执行 Accept All（供 EditorChangeBar 调用） */
  async acceptAllFiles(): Promise<void> {
    for (const decorator of this.decorators.values()) {
      decorator.acceptAll();
    }
  }

  /** 对所有已装饰文件执行 Reject All（供 EditorChangeBar 调用） */
  async rejectAllFiles(): Promise<void> {
    for (const decorator of this.decorators.values()) {
      await decorator.rejectAll();
    }
  }

  /** 获取当前所有已装饰文件路径（供 EditorChangeBar 调用） */
  getDecoratedPaths(): string[] {
    return Array.from(this.decorators.keys());
  }

  dispose(): void {
    for (const d of this.decorators.values()) d.dispose();
    this.decorators.clear();
    for (const d of this.disposables) d.dispose();
  }
}
