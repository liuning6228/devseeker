/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * InlineDiffDecorator —— 编辑器内联差异可视化（红/绿行）+ 文件级回滚能力
 *
 * 职责边界（v0.8.6 起）：
 * - 可视化：文件修改后自动打开并在编辑器内标出新增行（绿）/ 删除行（红）
 * - 回滚：为 DevSeeker 面板「Changed Files」的 ✗拒绝 提供逐 hunk 回滚（revertFile）
 * - 不再提供编辑器内的任何按钮/快捷键：审批入口统一收敛到 DevSeeker 面板
 *   （CodeLens 操作条、hunk 药丸浮条、Ctrl+Enter / Ctrl+Backspace / Alt+↑↓ 均已移除）
 *
 * 工作流程：
 * 1. panel.ts emitToolDiff 时通知 InlineDiffController（记录 diff 快照 + 应用装饰）
 * 2. 面板「拒绝」→ rejectFile：逐 hunk 回滚文件内容（倒序，避免行号漂移）
 * 3. 面板「接受」→ acceptFile：清除装饰与快照，保留文件内容
 * 4. 编辑器关闭再打开：按快照恢复红绿装饰（内容与 diff 匹配时）
 */

import * as vscode from 'vscode';
import { parseUnifiedDiff, type ParsedDiff } from '../core/diff/hunk-parser.js';
import { revertHunk } from '../core/diff/hunk-reverter.js';
import { getLogger } from '../infra/logger.js';
import { getNickname } from '../infra/nickname.js';

const log = getLogger('inline-diff-decorator');

// ─────────── 装饰类型 ───────────

/** 添加行背景色（绿色） */
const addedLineType = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(40, 167, 69, 0.15)',
  isWholeLine: true,
  overviewRulerColor: 'rgba(40, 167, 69, 0.6)',
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

/** 删除标记（红色） — VS Code 不支持虚行，被删内容无法直接渲染，改为标记删除发生的锚点行 */
const removedLineType = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(248, 81, 73, 0.15)',
  isWholeLine: true,
  overviewRulerColor: 'rgba(248, 81, 73, 0.6)',
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

// ─────────── Hunk 装饰数据 ───────────

interface HunkDecoration {
  /** hunk 在 parsed diff 中的索引 */
  hunkIndex: number;
  /** 新文件中（after）的行范围（0-based） */
  newRange: vscode.Range;
  /** 仅 add 行的范围列表（用于绿色背景，不含 context 行） */
  addRanges: vscode.Range[];
  /** 装饰状态 */
  state: 'pending' | 'accepted' | 'rejected';
}

// ─────────── FileDecorator — 单文件的装饰管理 ───────────

class FileDecorator implements vscode.Disposable {
  private hunks: HunkDecoration[] = [];
  private parsedDiff: ParsedDiff | null = null;
  private disposed = false;

  constructor(
    private readonly editor: vscode.TextEditor,
    private readonly absPath: string,
    private readonly relPath: string,
    private readonly onDispose: (absPath: string, resolved: boolean) => void,
    /** hunk 收敛（accept/reject）回调：同步到 diff 快照，供重开恢复与无装饰回滚使用 */
    private readonly onHunkResolved: (hunkIndex: number) => void,
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
        state: 'pending',
        addRanges,
      });
    }

    this.render();
  }

  /** 恢复指定 hunk 的"已收敛"状态（重开文件时从快照还原；不改变文件内容） */
  markResolved(hunkIndexes: ReadonlySet<number>): void {
    if (!this.parsedDiff || hunkIndexes.size === 0) return;
    let changed = false;
    for (const hd of this.hunks) {
      if (hd.state === 'pending' && hunkIndexes.has(hd.hunkIndex)) {
        hd.state = 'accepted';
        changed = true;
      }
    }
    if (changed) this.render();
  }

  /** 接受整个文件（面板「接受」）：清除装饰，保留文件内容 */
  acceptAll(): void {
    for (const h of this.hunks) {
      if (h.state === 'pending') {
        h.state = 'accepted';
        this.onHunkResolved(h.hunkIndex);
      }
    }
    this.clearAll();
  }

  /** 拒绝整个文件（面板「拒绝」）：逐 hunk 回滚（返回实际结果：K5 · 失败不谎报成功） */
  async rejectAll(): Promise<{ ok: boolean; failed: number; message?: string }> {
    if (!this.parsedDiff) return { ok: true, failed: 0 };
    let failed = 0;
    let firstError = '';
    // 从后往前回滚：单 hunk 回滚会改变其后续行号，倒序可保证剩余 hunk 定位不受影响
    for (let i = this.hunks.length - 1; i >= 0; i--) {
      const hd = this.hunks[i];
      if (hd.state !== 'pending') continue;
      const hunk = this.parsedDiff.hunks[hd.hunkIndex];
      if (!hunk) continue;
      try {
        const result = await revertHunk(this.absPath, hunk);
        if (result.ok) {
          hd.state = 'rejected';
          this.onHunkResolved(hd.hunkIndex);
        } else {
          failed++;
          if (!firstError) firstError = result.message;
        }
      } catch (e) {
        failed++;
        if (!firstError) firstError = String(e);
      }
    }
    this.render();
    if (failed === 0) {
      this.clearAll();
      return { ok: true, failed: 0 };
    }
    log.warn({ relPath: this.relPath, failed, firstError }, 'rejectAll: partial failure');
    return { ok: false, failed, message: `${failed} 个 hunk 回滚失败：${firstError}` };
  }

  /** 滚动到第一个待处理 hunk（首次应用 diff 时的"跳到变更处"体验，非按钮/快捷键） */
  revealFirstHunk(): void {
    const first = this.hunks.find((h) => h.state === 'pending');
    if (!first) return;
    try {
      this.editor.revealRange(first.newRange, vscode.TextEditorRevealType.InCenter);
    } catch {
      // 编辑器可能已关闭
    }
  }

  /** 渲染红/绿差异装饰 */
  private render(): void {
    if (this.disposed || !this.parsedDiff) return;

    const addedRanges: vscode.Range[] = [];
    const removedRanges: vscode.Range[] = [];

    const doc = this.editor.document;
    const lineCount = doc.lineCount;

    for (const hd of this.hunks) {
      if (hd.state !== 'pending') continue;

      // 添加行：只标绿 add 行（不含 context 行）
      addedRanges.push(...hd.addRanges);

      // 删除行：VS Code 不支持"虚行"，删除行的文本无法直接渲染；
      // 改为在删除发生的锚点行标红（纯删除的 hunk 否则在编辑器里完全不可见）
      const hunk = this.parsedDiff.hunks[hd.hunkIndex];
      if (!hunk) continue;
      const hasDel = hunk.lines.some((l) => l.type === 'del');
      if (hasDel) {
        // 锚点：hunk 内第一段 del 在 after 文件中的对应行（即被删内容的后一行）
        let currentLine = Math.max(0, hunk.newStart - 1);
        let anchor = currentLine;
        for (const line of hunk.lines) {
          if (line.type === 'del') {
            anchor = Math.min(currentLine, Math.max(0, lineCount - 1));
            break;
          }
          if (line.type === 'context' || line.type === 'add') currentLine++;
        }
        const lineEnd = doc.lineAt(anchor).text.length;
        removedRanges.push(new vscode.Range(anchor, 0, anchor, lineEnd));
      }
    }

    try {
      this.editor.setDecorations(addedLineType, addedRanges);
      this.editor.setDecorations(removedLineType, removedRanges);
    } catch {
      // 编辑器可能已关闭
    }
  }

  /** 清除所有装饰（全部收敛：accept/reject 完成） */
  private clearAll(): void {
    try {
      this.editor.setDecorations(addedLineType, []);
      this.editor.setDecorations(removedLineType, []);
    } catch {
      // ignore
    }
    this.onDispose(this.absPath, true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.editor.setDecorations(addedLineType, []);
      this.editor.setDecorations(removedLineType, []);
    } catch {
      // ignore
    }
  }
}

// ─────────── InlineDiffController — 全局控制器 ───────────

/** 大文件保护：超过此行数的文件跳过内联装饰（防止 Extension Host 卡死） */
const MAX_LINES_FOR_INLINE_DIFF = 2000;

/**
 * 单文件待处理 diff 快照（编辑器关闭/装饰跳过时仍保留，用于重开恢复与回滚兜底）
 */
interface PendingDiffSnapshot {
  relPath: string;
  unified: string;
  /** hunk 总数（大文件保护判定，避免重开恢复时重复统计） */
  hunkCount: number;
  /** 已收敛（accept/reject）的 hunk 序号：无装饰回滚需跳过，重开恢复需保留其状态 */
  resolvedHunks: Set<number>;
  /**
   * diff 生成时 after 内容签名（长度 + 哈希，忽略 CRLF 差异）。
   * 重开恢复前校验编辑器内容是否仍与 diff 匹配——不匹配（外部编辑 / 单 hunk 已回滚）时
   * 不得再套用旧装饰：行号会错位，且会把已收敛的 hunk 重新显示为 pending。
   */
  afterSignature?: string;
}

/**
 * 内容签名（长度 + djb2 哈希，忽略 CRLF 差异）。
 * 仅用于"diff 与当前内容是否仍匹配"的判断，不做安全用途。
 */
function contentSignature(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0;
  }
  return `${normalized.length}:${hash}`;
}

export class InlineDiffController implements vscode.Disposable {
  private readonly decorators = new Map<string, FileDecorator>();
  /** absPath → 待处理 diff 快照（accept/reject 收敛后移除） */
  private readonly pendingDiffs = new Map<string, PendingDiffSnapshot>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    // 监听编辑器关闭/重新打开（快照保留）：
    // - 关闭：释放装饰，diff 快照保留
    // - 打开：文件有待处理快照 → 恢复红绿装饰（否则文件重开后差异标记全部消失）
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        const visiblePaths = new Set(editors.map((e) => e.document.uri.fsPath));
        for (const [absPath, decorator] of this.decorators) {
          if (!visiblePaths.has(absPath)) {
            decorator.dispose();
            this.decorators.delete(absPath);
          }
        }
        for (const editor of editors) {
          const absPath = editor.document.uri.fsPath;
          if (this.decorators.has(absPath)) continue;
          const snapshot = this.pendingDiffs.get(absPath);
          if (!snapshot) continue;
          // 大文件保护：与首次应用一致，重开恢复也跳过超大文件
          if (snapshot.hunkCount > MAX_LINES_FOR_INLINE_DIFF) continue;
          if (editor.document.lineCount > MAX_LINES_FOR_INLINE_DIFF) continue;
          // 内容已偏离 diff（外部编辑 / 单 hunk 已回滚）→ 不恢复装饰，避免行号错位的假装饰
          if (
            snapshot.afterSignature !== undefined &&
            contentSignature(editor.document.getText()) !== snapshot.afterSignature
          ) {
            log.debug({ relPath: snapshot.relPath }, 'reapply skipped: content diverged from diff');
            continue;
          }
          this.attachDecorator(
            editor,
            absPath,
            snapshot.relPath,
            snapshot.unified,
            false,
            snapshot.resolvedHunks,
          );
        }
      }),
    );
  }

  /**
   * 创建/刷新某文件的装饰器。
   * @param revealFirst 是否滚动到第一个 hunk（首次应用 diff 为 true；重开恢复为 false，避免抢滚动位置）
   * @param resolvedHunks 已收敛 hunk（重开恢复时还原其状态：不得重新显示为 pending）
   */
  private attachDecorator(
    editor: vscode.TextEditor,
    absPath: string,
    relPath: string,
    unified: string,
    revealFirst: boolean,
    resolvedHunks?: ReadonlySet<number>,
  ): void {
    const existing = this.decorators.get(absPath);
    if (existing) {
      existing.applyDiff(unified);
      if (resolvedHunks) existing.markResolved(resolvedHunks);
      if (revealFirst) existing.revealFirstHunk();
      return;
    }

    const decorator = new FileDecorator(
      editor,
      absPath,
      relPath,
      (path, resolved) => {
        this.decorators.delete(path);
        // 收敛（accept/reject 完成）→ 丢弃快照；编辑器关闭触发的 dispose 不走此回调，快照保留
        if (resolved) this.pendingDiffs.delete(path);
      },
      (hunkIndex) => this.pendingDiffs.get(absPath)?.resolvedHunks.add(hunkIndex),
    );
    decorator.applyDiff(unified);
    if (resolvedHunks) decorator.markResolved(resolvedHunks);
    this.decorators.set(absPath, decorator);
    if (revealFirst) decorator.revealFirstHunk();
  }

  /**
   * 接收 tool_diff 数据，为对应文件创建装饰。
   * @param afterContent 写入后的文件内容（可选）：用于记录签名，重开恢复前校验内容是否仍匹配
   */
  async onToolDiff(
    absPath: string,
    relPath: string,
    unified: string,
    afterContent?: string,
  ): Promise<void> {
    // 大文件保护：统计 hunk 数量，过多时跳过内联装饰
    const hunkCount = (unified.match(/^@@/gm) || []).length;

    // 先记录快照：即使装饰被跳过（大文件保护/编辑器未打开），"同意/拒绝"与重开恢复仍可用
    this.pendingDiffs.set(absPath, {
      relPath,
      unified,
      hunkCount,
      resolvedHunks: new Set<number>(),
      ...(afterContent !== undefined ? { afterSignature: contentSignature(afterContent) } : {}),
    });

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

    this.attachDecorator(
      editor,
      absPath,
      relPath,
      unified,
      true,
      this.pendingDiffs.get(absPath)?.resolvedHunks,
    );

    // 状态栏短暂提示（纯文字，无按钮/快捷键；审批入口在 DevSeeker 面板 Changed Files）
    vscode.window.setStatusBarMessage(
      `${getNickname()} Diff: ${relPath} — ${hunkCount} 处变更`,
      5000,
    );

    log.info({ relPath, hunkCount }, 'inline diff decorations applied');
  }

  /** 该文件是否存在待处理变更（装饰或快照） */
  hasPending(absPath: string): boolean {
    return this.decorators.has(absPath) || this.pendingDiffs.has(absPath);
  }

  /** 接受单文件全部变更：清除装饰与 diff 快照，保留文件当前内容 */
  acceptFile(absPath: string): void {
    const decorator = this.decorators.get(absPath);
    if (decorator) {
      // acceptAll → clearAll → onDispose(absPath, true)：同时清掉 decorators / pendingDiffs
      decorator.acceptAll();
    }
    // 兜底：无装饰（编辑器未打开/大文件跳过）时直接丢弃快照
    this.decorators.delete(absPath);
    this.pendingDiffs.delete(absPath);
  }

  /** 拒绝单文件变更：逐 hunk 回滚；无装饰时用 diff 快照兜底 */
  async rejectFile(absPath: string): Promise<{ ok: boolean; message?: string }> {
    const decorator = this.decorators.get(absPath);
    if (decorator) {
      const res = await decorator.rejectAll();
      if (res.ok) {
        this.decorators.delete(absPath);
        this.pendingDiffs.delete(absPath);
        return { ok: true };
      }
      return { ok: false, ...(res.message !== undefined ? { message: res.message } : {}) };
    }

    const snapshot = this.pendingDiffs.get(absPath);
    if (!snapshot) return { ok: false, message: '没有待处理的变更记录，无法回滚' };
    const parsed = parseUnifiedDiff(snapshot.unified);
    if (!parsed || parsed.hunks.length === 0) {
      return { ok: false, message: 'diff 解析失败，无法回滚' };
    }

    let failed = 0;
    let firstError = '';
    // 倒序回滚（单 hunk 回滚会改变其后续行号），并跳过已收敛的 hunk（避免重复回滚）
    for (let i = parsed.hunks.length - 1; i >= 0; i--) {
      const hunk = parsed.hunks[i];
      if (!hunk || snapshot.resolvedHunks.has(hunk.index)) continue;
      try {
        const result = await revertHunk(absPath, hunk);
        if (!result.ok) {
          failed++;
          if (!firstError) firstError = result.message;
        }
      } catch (e) {
        failed++;
        if (!firstError) firstError = String(e);
      }
    }
    if (failed === 0) {
      this.pendingDiffs.delete(absPath);
      return { ok: true };
    }
    return { ok: false, message: `${failed} 个 hunk 回滚失败（文件可能已被外部修改）：${firstError}` };
  }

  /** 丢弃某文件的全部待处理状态（装饰 + 快照），不改变文件内容 */
  discardFile(absPath: string): void {
    this.pendingDiffs.delete(absPath);
    const decorator = this.decorators.get(absPath);
    if (decorator) {
      decorator.dispose();
      this.decorators.delete(absPath);
    }
  }

  /** 丢弃所有待处理状态（装饰 + 快照），不改变文件内容 */
  discardAll(): void {
    for (const decorator of this.decorators.values()) decorator.dispose();
    this.decorators.clear();
    this.pendingDiffs.clear();
  }

  /** 对所有待处理文件执行 Accept All（供面板「Accept all」调用） */
  async acceptAllFiles(): Promise<void> {
    for (const decorator of Array.from(this.decorators.values())) {
      decorator.acceptAll();
    }
    // 无装饰的文件（编辑器未打开/大文件跳过）：直接丢弃快照
    this.decorators.clear();
    this.pendingDiffs.clear();
  }

  dispose(): void {
    for (const d of this.decorators.values()) d.dispose();
    this.decorators.clear();
    for (const d of this.disposables) d.dispose();
  }
}
