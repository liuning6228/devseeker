/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * DualMind VSCode 扩展入口
 *
 * W1 最小激活路径：
 * - activate() 时初始化 logger
 * - 注册命令：dualMind.openPanel / dualMind.showLogs
 * - 创建 StatusBar 指示器
 * - deactivate() 时 flush 日志
 *
 * W2+ 会在此文件注入：Provider Registry、TaskLoop、Webview 面板、路由器等。
 */

import * as vscode from 'vscode';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { initLogger, getLogger, closeLogger, type LogLevel } from './infra/logger.js';
import { perfProbe } from './infra/perf-probe.js';
import { AgentError, toAgentError } from './core/errors/index.js';
import { DualMindChatPanel } from './webview/panel.js';
import { openContextPanel } from './webview/panels/context-panel.js';
import { openCostPanel } from './webview/panels/cost-panel.js';
import { openRulesPanel } from './webview/panels/rules-panel.js';
import { openLogsPanel } from './webview/panels/logs-panel.js';
import { openCheckpointsPanel } from './webview/panels/checkpoints-panel.js';
import { openHooksPanel } from './webview/panels/hooks-panel.js';
import { openGitPanel } from './webview/panels/git-panel.js';
import { openPreviewPanelInteractive } from './webview/panels/preview-panel.js';
import { formatDomPickedForChat } from './webview/panels/preview-bridge-protocol.js';
import { maybeAutoReindex } from './core/index/auto-indexer.js';
import { initIndexStatusBar, setIndexStatusBar } from './ui/index-status-bar.js';
import { InlineDiffController } from './ui/inline-diff-decorator.js';
import { EditorChangeBar } from './ui/editor-change-bar.js';
import { DIFF_VIEW_URI_SCHEME } from './ui/streaming-diff-view.js';
import { openSqliteDatabase, defaultSqlitePath } from './core/storage/sqlite-db.js';

let statusBarItem: vscode.StatusBarItem | undefined;
/** 存储 process 全局监听器引用，deactivate 时移除防止泄漏 */
let unhandledRejectionHandler: ((reason: unknown) => void) | undefined;
let uncaughtExceptionHandler: ((error: Error) => void) | undefined;

// 注册虚拟 URI scheme：Diff 编辑器左侧的"原始内容"文档
// 参考 Cline/Roo Code 的 TextDocumentContentProvider 方案：
// 左侧用 dualmind-diff:file?base64(originalContent)，右侧用 file://path
// 流式更新用 WorkspaceEdit.replace() 修改右侧文档，不触发文件系统事件
const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return Buffer.from(uri.query, 'base64').toString('utf-8');
  }
})();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // W12.3 · 冷启动探针起点（越早越好，捕获 logger init 之前的开销）
  perfProbe.markActivateStart();

  const workspaceRoot = getWorkspaceRoot();
  const logDir = workspaceRoot
    ? join(workspaceRoot, '.dualmind', 'logs')
    : join(context.globalStorageUri.fsPath, 'logs');

  const config = vscode.workspace.getConfiguration('dualMind');
  const level = (config.get<string>('logLevel') ?? 'info') as LogLevel;

  try {
    initLogger({
      logDir,
      level,
      dev: context.extensionMode === vscode.ExtensionMode.Development,
    });
  } catch (e) {
    // logger 初始化失败不阻塞扩展激活
    console.error('[DualMind] logger init failed:', e);
  }

  const log = getLogger('extension');
  log.info(
    {
      version: context.extension.packageJSON.version,
      mode: vscode.ExtensionMode[context.extensionMode],
      workspaceRoot,
      logDir,
    },
    'DualMind activating',
  );

  // P0-7 · 注册虚拟 URI scheme（流式 Diff 渲染左侧原始文档）
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider),
  );

  // 注册命令：打开主面板
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.openPanel', () => {
      log.info('command: openPanel');
      DualMindChatPanel.createOrShow(context);
    }),
  );

  // 注册命令：暂停/继续 Agent 任务（供 EditorChangeBar 调用）
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.pauseTask', () => {
      log.info('command: pauseTask');
      DualMindChatPanel.current?.pauseTask();
    }),
    vscode.commands.registerCommand('dualMind.resumeTask', () => {
      log.info('command: resumeTask');
      DualMindChatPanel.current?.resumeTask();
    }),
  );

  // 注册命令：重新激活已失效的 Tavily/Bocha API Key
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.reactivateSearchKeys', async () => {
      log.info('command: reactivateSearchKeys');
      const panel = DualMindChatPanel.current;
      if (!panel) {
        vscode.window.showWarningMessage('DualMind: 未打开面板，无法重激活 Key');
        return;
      }
      const result = panel.reactivateSearchKeys();
      if (result.tavily > 0 || result.bocha > 0) {
        const parts: string[] = [];
        if (result.tavily > 0) parts.push(`Tavily ${result.tavily} 个`);
        if (result.bocha > 0) parts.push(`Bocha ${result.bocha} 个`);
        vscode.window.showInformationMessage(`DualMind: 已重新激活 ${parts.join('、')} Key`);
      } else {
        vscode.window.showInformationMessage('DualMind: 没有需要重激活的失效 Key');
      }
    }),
  );

  // B-P1-14 · 注册命令：显示日志面板（替代原「打开 runtime.log」，该功能由面板内按钮提供）
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.showLogs', async () => {
      log.info('command: showLogs');
      try {
        await openLogsPanel(context);
      } catch (e) {
        const err = toAgentError(e);
        log.warn({ code: err.code, msg: err.message }, 'showLogs failed');
        vscode.window.showWarningMessage(`日志面板打开失败：${err.toUserMessage()}`);
      }
    }),
  );

  // B-P1-15 · 注册命令：显示 Checkpoint 时间线面板（Compare Diff + 多轮分组）
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.showCheckpointTimeline', async () => {
      log.info('command: showCheckpointTimeline');
      if (!DualMindChatPanel.current) {
        vscode.window.showWarningMessage('请先打开 DualMind 面板并开始一个会话后再查看 Checkpoint 时间线。');
        return;
      }
      const current = DualMindChatPanel.current;
      try {
        await openCheckpointsPanel(context, {
          getCurrentSessionId: () => current.getCurrentSessionId(),
          listCheckpoints: () => current.listCheckpoints(),
          getCheckpointDetails: (id: string) => current.getCheckpointDetails(id),
          revertCheckpoint: (id: string) => current.revertCheckpoint(id),
        });
      } catch (e) {
        const err = toAgentError(e);
        log.warn({ code: err.code, msg: err.message }, 'showCheckpointTimeline failed');
        vscode.window.showWarningMessage(`Checkpoint 时间线打开失败：${err.toUserMessage()}`);
      }
    }),
  );

  // 注册命令：重建代码库索引
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.reindex', async () => {
      log.info('command: reindex');
      DualMindChatPanel.createOrShow(context);
      try {
        await DualMindChatPanel.current!.reindexCodebase();
      } catch (e) {
        const err = toAgentError(e);
        log.error({ code: err.code, msg: err.message }, 'reindex failed');
        vscode.window.showErrorMessage(`索引失败：${err.toUserMessage()}`);
      }
    }),
  );

  // 注册命令：列出并回滚到某 checkpoint（W5b2b）
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.revertCheckpoint', async () => {
      log.info('command: revertCheckpoint');
      if (!DualMindChatPanel.current) {
        vscode.window.showWarningMessage('请先打开 DualMind 面板并开始一个会话后再使用 Revert。');
        return;
      }
      try {
        const list = await DualMindChatPanel.current.listCheckpoints();
        if (list.length === 0) {
          vscode.window.showInformationMessage('当前会话尚无 checkpoint。');
          return;
        }
        // 最新在前
        const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
        const items: (vscode.QuickPickItem & { id: string })[] = sorted.map((m) => ({
          id: m.id,
          label: `${new Date(m.createdAt).toLocaleString()} · ${m.label ?? '(无标签)'}`,
          description: `${m.messageCount} msgs · ${m.fileCount} files`,
          detail: m.id,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: '选择要回滚到的 checkpoint（会恢复对话历史与文件）',
          matchOnDescription: true,
        });
        if (!picked) return;
        const confirm = await vscode.window.showWarningMessage(
          `即将回滚到 checkpoint "${picked.label}"，当前未保存的改动会被覆盖。确认？`,
          { modal: true },
          '确认回滚',
        );
        if (confirm !== '确认回滚') return;
        const res = await DualMindChatPanel.current.revertCheckpoint(picked.id);
        if (!res) {
          vscode.window.showWarningMessage('回滚未执行（无当前会话）。');
          return;
        }
        vscode.window.showInformationMessage(
          `已回滚：恢复 ${res.filesApplied} 个文件，删除 ${res.filesDeleted} 个，跳过 ${res.filesSkipped} 个。`,
        );
      } catch (e) {
        const err = toAgentError(e);
        log.error({ code: err.code, msg: err.message }, 'revertCheckpoint failed');
        vscode.window.showErrorMessage(`回滚失败：${err.toUserMessage()}`);
      }
    }),
  );

  // StatusBar 指示器
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(rocket) DualMind';
  statusBarItem.tooltip = 'DualMind v' + context.extension.packageJSON.version;
  statusBarItem.command = 'dualMind.openPanel';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // W11.3 · 旧 showHooks 命令已被 B-P1-3 openHooksPanel 取代，下方重新注册。

  // W12.3 · 导出性能压测报告（PerfProbe dump → .dualmind/perf/perf-<ts>.json）
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.perf.exportReport', async () => {
      log.info('command: perf.exportReport');
      const report = perfProbe.dump();
      const perfDir = workspaceRoot
        ? join(workspaceRoot, '.dualmind', 'perf')
        : join(context.globalStorageUri.fsPath, 'perf');
      try {
        mkdirSync(perfDir, { recursive: true });
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const name = `perf-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
        const filePath = join(perfDir, name);
        writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
        log.info(
          { filePath, turns: report.summary.turnsCount },
          'perf report exported',
        );
        const fileUri = vscode.Uri.file(filePath);
        const pick = await vscode.window.showInformationMessage(
          `DualMind 性能报告已导出：${name}（${report.summary.turnsCount} 轮）`,
          '打开',
        );
        if (pick === '打开') {
          await vscode.window.showTextDocument(fileUri);
        }
      } catch (e) {
        const err = toAgentError(e);
        log.error({ code: err.code, msg: err.message }, 'perf.exportReport failed');
        vscode.window.showErrorMessage(`导出性能报告失败：${err.toUserMessage()}`);
      }
    }),
  );

  // B-P3-6 · 导出当前会话（或从列表挑一条）为 md/json，写入 .dualmind/sessions/<ts>-<title>.<ext>
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.session.export', async () => {
      log.info('command: session.export');
      if (!DualMindChatPanel.current) {
        DualMindChatPanel.createOrShow(context);
      }
      const panel = DualMindChatPanel.current;
      if (!panel) {
        void vscode.window.showWarningMessage('[DualMind] 面板未就绪');
        return;
      }
      const summaries = panel.listSessionSummaries();
      if (summaries.length === 0) {
        void vscode.window.showInformationMessage('[DualMind] 尚无可导出的会话');
        return;
      }
      // 选会话
      const pickSession = await vscode.window.showQuickPick(
        summaries
          .slice()
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((s) => ({
            label: s.title || '(untitled)',
            description: `${s.messageCount} msgs`,
            detail: new Date(s.updatedAt).toLocaleString(),
            id: s.id,
          })),
        { placeHolder: '选择要导出的会话' },
      );
      if (!pickSession) return;
      // 选格式
      const pickFormat = await vscode.window.showQuickPick(
        [
          { label: 'Markdown (.md)', value: 'md' as const },
          { label: 'JSON (.json)', value: 'json' as const },
        ],
        { placeHolder: '选择导出格式' },
      );
      if (!pickFormat) return;

      const result = panel.exportSessionContent(pickFormat.value, pickSession.id);
      if (!result) {
        void vscode.window.showErrorMessage('[DualMind] 会话内容为空或已失效');
        return;
      }
      const sessionsDir = workspaceRoot
        ? join(workspaceRoot, '.dualmind', 'sessions')
        : join(context.globalStorageUri.fsPath, 'sessions');
      try {
        mkdirSync(sessionsDir, { recursive: true });
        const d = new Date(result.session.updatedAt);
        const pad = (n: number) => String(n).padStart(2, '0');
        const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
        const safeTitle = (result.session.title || 'session')
          .replace(/[\\/:*?"<>|]/g, '_')
          .slice(0, 40)
          .trim() || 'session';
        const filePath = join(sessionsDir, `${ts}-${safeTitle}.${pickFormat.value}`);
        writeFileSync(filePath, result.content, 'utf8');
        log.info({ filePath, format: pickFormat.value }, 'session exported');
        const pick = await vscode.window.showInformationMessage(
          `DualMind 会话已导出：${filePath.split(/[\\/]/).pop()}`,
          '打开',
        );
        if (pick === '打开') {
          await vscode.window.showTextDocument(vscode.Uri.file(filePath));
        }
      } catch (e) {
        const err = toAgentError(e);
        log.error({ code: err.code, msg: err.message }, 'session.export failed');
        void vscode.window.showErrorMessage(`导出会话失败：${err.toUserMessage()}`);
      }
    }),
  );

  // B-P1-10 · 选区右键「Ask DualMind About Selection」
  // 从当前编辑器选区抽片段 → Panel.pushSelectedCode（会累积） → 切到 Ask Mode
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.askSelection', async () => {
      log.info('command: askSelection');
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage(
          '[DualMind] 请先打开一个文件并选中片段再调用 Ask Selection。',
        );
        return;
      }
      const doc = editor.document;
      const sel = editor.selection;
      if (sel.isEmpty) {
        void vscode.window.showWarningMessage(
          '[DualMind] 当前无选区（Ask Selection 要求隐式选区，空选区时请使用 Inline Edit）。',
        );
        return;
      }
      const range = new vscode.Range(sel.start, sel.end);
      const snippet = doc.getText(range);
      if (!snippet.trim()) {
        void vscode.window.showWarningMessage('[DualMind] 选区为空。');
        return;
      }
      const wsFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
      const rel = wsFolder ? vscode.workspace.asRelativePath(doc.uri, false) : doc.uri.fsPath;
      const startLine = range.start.line + 1;
      const endLine = range.end.line + 1;

      if (!DualMindChatPanel.current) DualMindChatPanel.createOrShow(context);
      const panel = DualMindChatPanel.current;
      if (!panel) {
        void vscode.window.showWarningMessage('[DualMind] 面板未就绪，请重试。');
        return;
      }
      panel.pushSelectedCode(
        { filePath: rel, startLine, endLine, text: snippet },
        { switchToAsk: true, prefillDraft: true },
      );
    }),
  );

  // W15.4 · Inline Edit 增强：上下文带入 + 历史 + 快捷应用
  // 把当前编辑器选区（或整行）连同周围上下文注入 <selected_codes>，
  // 同时将精简草稿推送到 Composer，设置 inlineEdit 标记限制工具范围。
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.inlineEdit', async () => {
      log.info('command: inlineEdit');
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage(
          '[DualMind] 请先打开一个代码文件并选择（或把光标放在）目标行再调用 Inline Edit。',
        );
        return;
      }
      const doc = editor.document;
      const sel = editor.selection;
      const isEmptySel = sel.isEmpty;
      // 空选区 → 默认取当前行
      const range = isEmptySel
        ? doc.lineAt(sel.active.line).range
        : new vscode.Range(sel.start, sel.end);
      const snippet = doc.getText(range);
      if (!snippet.trim()) {
        void vscode.window.showWarningMessage(
          '[DualMind] 当前选区/行为空，无内容可引用。',
        );
        return;
      }
      // 展示路径：相对于 workspaceRoot，多根场景 fallback 成带盘符的绝对路径
      const wsFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
      const rel = wsFolder
        ? vscode.workspace.asRelativePath(doc.uri, false)
        : doc.uri.fsPath;
      const startLine = range.start.line + 1; // 1-based
      const endLine = range.end.line + 1;
      const locHint =
        startLine === endLine ? `${rel}:${startLine}` : `${rel}:${startLine}-${endLine}`;
      const lang = doc.languageId || '';

      // ── W15.4a · 上下文带入：选区 ±5 行 + 文件头部 import 块 ──
      const CONTEXT_RADIUS = 5;
      const contextStartLine = Math.max(0, range.start.line - CONTEXT_RADIUS);
      const contextEndLine = Math.min(doc.lineCount - 1, range.end.line + CONTEXT_RADIUS);
      const contextRange = new vscode.Range(contextStartLine, 0, contextEndLine, doc.lineAt(contextEndLine).text.length);
      const contextText = doc.getText(contextRange);

      // 提取文件头部 import/require 块（前 60 行中匹配 import/require/use/using 的行）
      const importLines: string[] = [];
      const headEnd = Math.min(doc.lineCount, 60);
      for (let i = 0; i < headEnd; i++) {
        const line = doc.lineAt(i).text;
        if (/^\s*(import\s|from\s|require\s*\(|use\s+|using\s+)/.test(line)) {
          importLines.push(line);
        }
        // 一旦遇到非空非注释非 import 行且已有 import，停止
        if (importLines.length > 0 && line.trim() && !/^\s*(import|from|require|use|using|\/\/|\/\*|\*|#)/.test(line)) {
          break;
        }
      }
      const importBlock = importLines.length > 0 ? importLines.join('\n') : undefined;

      // 构建带上下文信息的完整选区文本（供 <selected_codes> 注入）
      const contextStart1 = contextStartLine + 1;
      const contextEnd1 = contextEndLine + 1;
      let fullSelectionText = contextText;
      if (importBlock && contextStartLine > headEnd) {
        // 上下文不含 import 块时额外拼接
        fullSelectionText = `// ── imports ──\n${importBlock}\n\n// ── surrounding context (${rel}:${contextStart1}-${contextEnd1}) ──\n${contextText}`;
      }

      if (!DualMindChatPanel.current) DualMindChatPanel.createOrShow(context);
      const panel = DualMindChatPanel.current;
      if (!panel) {
        void vscode.window.showWarningMessage('[DualMind] 面板未就绪，请重试。');
        return;
      }
      // W15.4a · 注入 <selected_codes> 到 L3（选区 + 上下文 + import）
      panel.pushSelectedCode(
        {
          filePath: rel,
          startLine: contextStart1,
          endLine: contextEnd1,
          text: fullSelectionText,
        },
        { switchToAsk: false, prefillDraft: false },
      );
      // W15.4c · 设置 Inline Edit 标记（下次 send 时消费：限制工具 + 注入约束）
      panel.setPendingInlineEdit(true);
      // W15.4b · 记录到 Inline Edit 历史
      panel.recordInlineEditHistory(rel, startLine, endLine, snippet);
      // W12.1 · Composer 草稿：精简提示（上下文已在 system prompt，此处仅引导）
      const draft = `请修改 ${locHint} 的选区片段：\n`;
      panel.prefillInput(draft, { isInlineEdit: true });
    }),
  );

  // B-P1-5 · Context 可视化面板（L0/L1/L2/L3 chars + tokens + cacheKeys + rules/skills/memories 摘要）
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.showContext', async () => {
      log.info('command: showContext');
      try {
        await openContextPanel(context, () => DualMindChatPanel.current?.getCurrentMode() ?? 'agent');
      } catch (e) {
        const err = toAgentError(e);
        log.error({ code: err.code, msg: err.message }, 'showContext failed');
        void vscode.window.showErrorMessage(`打开 Context 面板失败：${err.toUserMessage()}`);
      }
    }),
  );

  // B-P1-6 · Cost Panel UI（session/today/total KPI + Top-5 + 30d sparkline + recent usage）
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.showCost', async () => {
      log.info('command: showCost');
      try {
        await openCostPanel(
          context,
          () => DualMindChatPanel.current?.getCostSummaryPayload(),
          () => DualMindChatPanel.current?.getUsageStore(),
        );
      } catch (e) {
        const err = toAgentError(e);
        log.error({ code: err.code, msg: err.message }, 'showCost failed');
        void vscode.window.showErrorMessage(`打开 Cost 面板失败：${err.toUserMessage()}`);
      }
    }),
  );

  // B-P1-7 · Rules 管理 UI 面板（列出 global + workspace rules、解析 errors、打开对应 md）
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.showRules', async () => {
      log.info('command: showRules');
      try {
        await openRulesPanel(context);
      } catch (e) {
        const err = toAgentError(e);
        log.error({ code: err.code, msg: err.message }, 'showRules failed');
        void vscode.window.showErrorMessage(`打开 Rules 面板失败：${err.toUserMessage()}`);
      }
    }),
  );

  // B-P1-3 · Hooks 配置 UI 面板（hooks.json 预览 + 运行期订阅合并展示）
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.showHooks', async () => {
      log.info('command: showHooks');
      try {
        await openHooksPanel(context, () => DualMindChatPanel.current?.listLoadedHooks() ?? []);
      } catch (e) {
        const err = toAgentError(e);
        log.error({ code: err.code, msg: err.message }, 'showHooks failed');
        void vscode.window.showErrorMessage(`打开 Hooks 面板失败：${err.toUserMessage()}`);
      }
    }),
  );

  // B-P1-4 · Git 面板 UI（status/diff/log）
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.showGit', async () => {
      log.info('command: showGit');
      try {
        await openGitPanel(context);
      } catch (e) {
        const err = toAgentError(e);
        log.error({ code: err.code, msg: err.message }, 'showGit failed');
        void vscode.window.showErrorMessage(`打开 Git 面板失败：${err.toUserMessage()}`);
      }
    }),
  );

  // B-P1-1 + B-P1-2 · 真 Preview WebView 同时注册 DOM 拾取回调
  context.subscriptions.push(
    vscode.commands.registerCommand('dualMind.showPreview', async (presetUrl?: string) => {
      log.info({ presetUrl }, 'command: showPreview');
      try {
        await openPreviewPanelInteractive(context, presetUrl, async (payload) => {
          log.info({ selector: payload.selector, url: payload.pageUrl }, 'preview: domPicked');
          if (!DualMindChatPanel.current) DualMindChatPanel.createOrShow(context);
          const panel = DualMindChatPanel.current;
          if (!panel) return;
          panel.prefillInput(formatDomPickedForChat(payload));
        });
      } catch (e) {
        const err = toAgentError(e);
        log.error({ code: err.code, msg: err.message }, 'showPreview failed');
        void vscode.window.showErrorMessage(`打开 Preview 面板失败：${err.toUserMessage()}`);
      }
    }),
  );

  // 全局未捕获异常兆底
  unhandledRejectionHandler = (reason: unknown) => {
    // 已知外部来源（VS Code GitHub Auth Provider 等）的非关键拒绝，降级为 warn
    const reasonStr = reason instanceof Error ? reason.message : String(reason);
    if (/GitHubLoginFailed|LoginFailed/i.test(reasonStr)) {
      log.warn({ source: 'external', msg: reasonStr }, 'unhandledRejection (external, non-critical)');
      return;
    }
    const err = reason instanceof AgentError ? reason : toAgentError(reason);
    log.error({ code: err.code, msg: err.message, stack: err.stack }, 'unhandledRejection');
    // 不退出进程——Webview disposed 等场景不应导致扩展宿主崩溃
  };
  process.on('unhandledRejection', unhandledRejectionHandler);
  // W15.10 · 同步异常兆底：防止未捕获的同步异常导致扩展宿主进程崩溃
  uncaughtExceptionHandler = (error: Error) => {
    const err = error instanceof AgentError ? error : toAgentError(error);
    log.error({ code: err.code, msg: err.message, stack: err.stack }, 'uncaughtException');
    // 不退出进程——让 VS Code 扩展宿主继续运行，避免整窗口崩溃
  };
  process.on('uncaughtException', uncaughtExceptionHandler);

  // B-1.0.1-D · 索引状态栏（三态图标，点击跳 reindex）
  initIndexStatusBar(context);

  // Phase 3 · 编辑器内联 hunk 级 Accept/Reject 装饰器
  const inlineDiffController = new InlineDiffController(context);
  context.subscriptions.push(inlineDiffController);
  DualMindChatPanel.inlineDiffController = inlineDiffController;

  // EditorChangeBar · 编辑器底部状态栏：文件变更导航 + 同意/暂停
  const editorChangeBar = new EditorChangeBar(inlineDiffController);
  editorChangeBar.registerCommands(context);
  context.subscriptions.push(editorChangeBar);
  DualMindChatPanel.editorChangeBar = editorChangeBar;

  // B-1.0.1-A · 打开工作区自动后台索引（检测到项目标识文件且 24h 内未跑过时触发）
  // 全程不弹 UI、失败只打 log，不影响激活主路径
  // v1.8.3 · 索引库与会话库分离：auto-indexer 内部打开 dualmind-index.sqlite，
  //          不再需要外部传入 SQLite 连接
  const sessionDb = vscode.workspace.workspaceFolders?.[0]
    ? await openSqliteDatabase({ dbPath: defaultSqlitePath(vscode.workspace.workspaceFolders[0].uri.fsPath) })
    : undefined;
  if (sessionDb) {
    DualMindChatPanel.sharedSqliteDb = sessionDb;
  }
  void maybeAutoReindex({
    context,
    log,
    onStateChange: (state, info) => setIndexStatusBar(state, info),
  });

  log.info('DualMind activated successfully');
}

export async function deactivate(): Promise<void> {
  const log = getLogger('extension');
  log.info('DualMind deactivating');

  // 移除 process 全局监听器，防止重启后泄漏（每次 activate 都注册新监听器）
  if (unhandledRejectionHandler) {
    process.off('unhandledRejection', unhandledRejectionHandler);
    unhandledRejectionHandler = undefined;
  }
  if (uncaughtExceptionHandler) {
    process.off('uncaughtException', uncaughtExceptionHandler);
    uncaughtExceptionHandler = undefined;
  }

  statusBarItem?.dispose();
  statusBarItem = undefined;
  await closeLogger();
}

function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}
