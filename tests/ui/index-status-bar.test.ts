/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-1.0.1-D · index-status-bar 单测
 *
 * 验证：
 *  1) init 前调用 setIndexStatusBar 是 no-op（不抛）
 *  2) init 后每种状态映射正确 text / show/hide
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initIndexStatusBar,
  setIndexStatusBar,
  disposeIndexStatusBar,
} from '../../src/ui/index-status-bar.js';
import * as vscode from '../__mocks__/vscode.js';

interface FakeItem {
  text: string;
  command: string;
  tooltip: unknown;
  backgroundColor: unknown;
  name: string;
  shown: boolean;
  show: () => void;
  hide: () => void;
  dispose: () => void;
}

/** 用 spy 版的 createStatusBarItem 替换 mock 的默认 */
function installSpyStatusBar(): FakeItem {
  const item: FakeItem = {
    text: '',
    command: '',
    tooltip: '',
    backgroundColor: undefined,
    name: '',
    shown: false,
    show() {
      this.shown = true;
    },
    hide() {
      this.shown = false;
    },
    dispose() {
      this.shown = false;
    },
  };
  (vscode.window as unknown as { createStatusBarItem: () => FakeItem }).createStatusBarItem =
    () => item;
  return item;
}

function makeFakeContext(): import('vscode').ExtensionContext {
  return {
    subscriptions: [] as Array<{ dispose: () => void }>,
  } as unknown as import('vscode').ExtensionContext;
}

describe('index-status-bar (B-1.0.1-D)', () => {
  beforeEach(() => {
    disposeIndexStatusBar(); // 清理上一个 case 的残留
  });

  afterEach(() => {
    disposeIndexStatusBar();
  });

  it('setIndexStatusBar before init is a no-op (does not throw)', () => {
    expect(() => setIndexStatusBar('ready', { fileCount: 10 })).not.toThrow();
  });

  it('ready state shows with database icon and fileCount', () => {
    const item = installSpyStatusBar();
    initIndexStatusBar(makeFakeContext());
    setIndexStatusBar('ready', { fileCount: 123 });
    expect(item.shown).toBe(true);
    expect(item.text).toContain('123');
    expect(item.text).toContain('database');
    expect(item.backgroundColor).toBeUndefined();
  });

  it('indexing state shows spinner and warning background', () => {
    const item = installSpyStatusBar();
    initIndexStatusBar(makeFakeContext());
    setIndexStatusBar('indexing', { message: 'scanning...' });
    expect(item.shown).toBe(true);
    expect(item.text).toContain('sync~spin');
    expect(item.backgroundColor).toBeDefined();
    // ThemeColor 实例的 id
    expect((item.backgroundColor as { id: string }).id).toBe(
      'statusBarItem.warningBackground',
    );
  });

  it('empty state shows warning icon and error background', () => {
    const item = installSpyStatusBar();
    initIndexStatusBar(makeFakeContext());
    setIndexStatusBar('empty', { fileCount: 0 });
    expect(item.shown).toBe(true);
    expect(item.text).toContain('warning');
    expect((item.backgroundColor as { id: string }).id).toBe(
      'statusBarItem.errorBackground',
    );
  });

  it('error state shows error icon and error background', () => {
    const item = installSpyStatusBar();
    initIndexStatusBar(makeFakeContext());
    setIndexStatusBar('error', { message: 'boom' });
    expect(item.shown).toBe(true);
    expect(item.text).toContain('error');
    expect((item.backgroundColor as { id: string }).id).toBe(
      'statusBarItem.errorBackground',
    );
  });

  it('no-workspace state hides the status bar item', () => {
    const item = installSpyStatusBar();
    initIndexStatusBar(makeFakeContext());
    setIndexStatusBar('ready', { fileCount: 1 });
    expect(item.shown).toBe(true);
    setIndexStatusBar('no-workspace');
    expect(item.shown).toBe(false);
  });

  it('command is wired to dualMind.reindexCodebase', () => {
    const item = installSpyStatusBar();
    initIndexStatusBar(makeFakeContext());
    expect(item.command).toBe('dualMind.reindexCodebase');
  });

  it('init is idempotent (second init does not create a new item)', () => {
    installSpyStatusBar();
    const ctx = makeFakeContext();
    initIndexStatusBar(ctx);
    const n1 = (ctx.subscriptions as Array<unknown>).length;
    initIndexStatusBar(ctx);
    const n2 = (ctx.subscriptions as Array<unknown>).length;
    expect(n2).toBe(n1);
  });
});
