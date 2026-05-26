/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-1.0.1-D · 代码库索引状态栏（三态图标）
 *
 * 职责：
 *  - 在 VSCode 右下角显示索引状态：
 *      🟢 ready      已建索引，显示已索引文件数
 *      🟡 indexing   正在建索引/首次扫描中
 *      🔴 empty      索引未建立或扫到 0 files
 *      ⚪ no-workspace  未打开工作区（隐藏）
 *  - 点击跳到 `dualMind.reindexCodebase` 命令
 *
 * 设计：
 *  - 单例 + 纯函数 setState()：panel.ts 与 auto-indexer.ts 都能调用
 *  - 不依赖 webview panel；activate 时注册即可
 */

import * as vscode from 'vscode';

export type IndexState = 'ready' | 'indexing' | 'empty' | 'no-workspace' | 'error';

export interface IndexStateInfo {
  fileCount?: number;
  message?: string;
}

let item: vscode.StatusBarItem | undefined;

/** activate 时调用一次，注册 status bar item。 */
export function initIndexStatusBar(context: vscode.ExtensionContext): void {
  if (item) return;
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  item.command = 'dualMind.reindexCodebase';
  item.name = 'DualMind 代码库索引';
  context.subscriptions.push(item);
  // 默认 no-workspace（等首次 pushIndexStatus / auto-indexer 更新）
  setIndexStatusBar('no-workspace');
}

/** 任何一侧（panel / auto-indexer）都可以调用来更新状态。 */
export function setIndexStatusBar(state: IndexState, info: IndexStateInfo = {}): void {
  if (!item) return; // 未 init（测试环境或未 activate）

  switch (state) {
    case 'ready': {
      const n = info.fileCount ?? 0;
      item.text = `$(database) 索引 ${n}`;
      item.tooltip = new vscode.MarkdownString(
        `**DualMind 代码库索引：已就绪** 🟢\n\n已索引 **${n}** 个文件。\n\n点击重建索引。`,
      );
      // 用 statusBarItem.color 无障碍属性保持默认（VSCode 主题友好）
      item.backgroundColor = undefined;
      item.show();
      break;
    }
    case 'indexing': {
      item.text = `$(sync~spin) 索引中…`;
      item.tooltip = new vscode.MarkdownString(
        `**DualMind 代码库索引：正在建立** 🟡\n\n${info.message ?? '扫描并向量化中…'}`,
      );
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      item.show();
      break;
    }
    case 'empty': {
      item.text = `$(warning) 索引未建`;
      item.tooltip = new vscode.MarkdownString(
        `**DualMind 代码库索引：未建立 / 空** 🔴\n\n` +
          (info.message ?? '点击运行 Reindex Codebase 重新扫描。'),
      );
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      item.show();
      break;
    }
    case 'error': {
      item.text = `$(error) 索引异常`;
      item.tooltip = new vscode.MarkdownString(
        `**DualMind 代码库索引：异常** 🔴\n\n${info.message ?? '请查看输出面板日志。'}`,
      );
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      item.show();
      break;
    }
    case 'no-workspace':
    default: {
      item.backgroundColor = undefined;
      item.hide();
      break;
    }
  }
}

/** 测试/析构用。 */
export function disposeIndexStatusBar(): void {
  item?.dispose();
  item = undefined;
}
