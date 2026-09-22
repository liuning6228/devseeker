/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * InlineDiffController · diff 快照回滚回归测试（v0.8.6）
 *
 * 覆盖 0.8.5 引入快照机制后暴露/新增的三类缺陷：
 *  1) 多 hunk 文件级回滚必须倒序执行：单 hunk 回滚会改变其后行号，
 *     正向回滚会让后续 hunk 超出 revertHunk 的 ±5 行定位窗口而失败
 *  2) 已收敛（discard/accept）的文件不得再回滚：回滚应返回 ok=false 而非静默成功
 *  3) 文件内容偏离 diff 时不得恢复装饰：行号会错位（假装饰），
 *     且会把已收敛的 hunk 重新显示为 pending
 *
 * 说明：无编辑器路径（visibleTextEditors 为空）模拟"编辑器未打开/大文件跳过装饰"；
 * 有编辑器路径用最小 fake editor 驱动 FileDecorator 全链路。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InlineDiffController } from '../../src/ui/inline-diff-decorator.js';
import { makeUnifiedDiff } from '../../src/core/tools/diff-utils.js';
import * as vscodeMock from '../__mocks__/vscode.js';

/** 构造控制器（ExtensionContext 仅用于订阅收集，测试中不读字段） */
function makeController(): InlineDiffController {
  return new InlineDiffController({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
}

/**
 * 构造"两个 hunk、且第一个 hunk 位移 > 定位窗口(±5 行)"的 before/after。
 *  - hunk A：在 file-3 后插入 20 行（大位移）
 *  - hunk B：末行 zz → ZZ
 * 两处修改之间隔 30 行（> 2*context），确保 makeUnifiedDiff 切成两个独立 hunk。
 */
function buildDivergentCase(): { before: string; after: string } {
  const filler = Array.from({ length: 30 }, (_, i) => `filler-${i + 1}`);
  const beforeLines = ['file-1', 'file-2', 'file-3', ...filler, 'zz'];
  const inserted = Array.from({ length: 20 }, (_, i) => `inserted-${i + 1}`);
  const afterLines = ['file-1', 'file-2', 'file-3', ...inserted, ...filler, 'ZZ'];
  return {
    before: beforeLines.join('\n') + '\n',
    after: afterLines.join('\n') + '\n',
  };
}

/** 最小 fake editor：只实现 FileDecorator 用到的接口 */
interface FakeEditor {
  document: {
    uri: { fsPath: string };
    lineCount: number;
    lineAt: (line: number) => { text: string };
    getText: () => string;
  };
  decorationCalls: number;
  setDecorations: () => void;
  revealRange: () => void;
}

function makeFakeEditor(absPath: string, content: string): FakeEditor {
  const lines = content.split('\n');
  const editor: FakeEditor = {
    document: {
      uri: { fsPath: absPath },
      lineCount: lines.length,
      lineAt: (line: number) => ({ text: lines[line] ?? '' }),
      getText: () => content,
    },
    decorationCalls: 0,
    setDecorations: () => {
      editor.decorationCalls += 1;
    },
    revealRange: () => undefined,
  };
  return editor;
}

describe('InlineDiffController · 快照回滚', () => {
  let dir: string;
  let absPath: string;
  const relPath = 'src/example.ts';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv-inline-diff-'));
    absPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    (vscodeMock.window as { visibleTextEditors: unknown[] }).visibleTextEditors = [];
  });

  it('多 hunk 回滚（无编辑器快照路径）：首个 hunk 位移远超 ±5 定位窗口时仍能全部回滚', async () => {
    const { before, after } = buildDivergentCase();
    const diff = makeUnifiedDiff(before, after, { relPath });
    expect(diff.unified.match(/^@@/gm)?.length).toBe(2); // 前提：确实是两个 hunk

    // 磁盘上为 after 内容（模拟工具刚写入）
    fs.writeFileSync(absPath, after, 'utf-8');

    const controller = makeController();
    try {
      await controller.onToolDiff(absPath, relPath, diff.unified, after);
      const result = await controller.rejectFile(absPath);

      expect(result).toEqual({ ok: true });
      expect(fs.readFileSync(absPath, 'utf-8')).toBe(before);
    } finally {
      controller.dispose();
    }
  });

  it('多 hunk 回滚（编辑器装饰路径）：倒序回滚同样全部成功并清除装饰', async () => {
    const { before, after } = buildDivergentCase();
    const diff = makeUnifiedDiff(before, after, { relPath });
    fs.writeFileSync(absPath, after, 'utf-8');

    const fakeEditor = makeFakeEditor(absPath, after);
    (vscodeMock.window as { visibleTextEditors: unknown[] }).visibleTextEditors = [fakeEditor];

    const controller = makeController();
    try {
      await controller.onToolDiff(absPath, relPath, diff.unified, after);
      expect(fakeEditor.decorationCalls).toBeGreaterThan(0); // 装饰已应用

      const result = await controller.rejectFile(absPath);
      expect(result).toEqual({ ok: true });
      expect(fs.readFileSync(absPath, 'utf-8')).toBe(before);
      expect(controller.hasPending(absPath)).toBe(false);
    } finally {
      controller.dispose();
    }
  });

  it('内容偏离 diff 时不恢复装饰（避免行号错位假装饰）；内容匹配时恢复', async () => {
    const { before, after } = buildDivergentCase();
    const diff = makeUnifiedDiff(before, after, { relPath });
    fs.writeFileSync(absPath, after, 'utf-8');

    // 无编辑器 → 仅记录快照
    const controller = makeController();
    try {
      await controller.onToolDiff(absPath, relPath, diff.unified, after);

      // 场景 1：内容已偏离（外部编辑 / 单 hunk 回滚）→ 不得恢复装饰
      const divergedEditor = makeFakeEditor(absPath, before);
      vscodeMock.__fireVisibleTextEditors([divergedEditor]);
      expect(divergedEditor.decorationCalls).toBe(0);

      // 场景 2：内容与 diff 匹配 → 正常恢复装饰
      const matchedEditor = makeFakeEditor(absPath, after);
      vscodeMock.__fireVisibleTextEditors([divergedEditor, matchedEditor]);
      expect(matchedEditor.decorationCalls).toBeGreaterThan(0);
    } finally {
      controller.dispose();
    }
  });

  it('discardFile 之后不得再回滚（返回 ok=false，内容不变）', async () => {
    const { before, after } = buildDivergentCase();
    const diff = makeUnifiedDiff(before, after, { relPath });
    fs.writeFileSync(absPath, after, 'utf-8');

    const controller = makeController();
    try {
      await controller.onToolDiff(absPath, relPath, diff.unified, after);
      controller.discardFile(absPath); // 模拟 webview 侧 Accept/Reject 已清理

      const result = await controller.rejectFile(absPath);
      expect(result.ok).toBe(false);
      expect(fs.readFileSync(absPath, 'utf-8')).toBe(after); // 内容未被改动
    } finally {
      controller.dispose();
    }
  });

  it('acceptFile 保留内容并清空待处理状态（快照不可再回滚）', async () => {
    const { before, after } = buildDivergentCase();
    const diff = makeUnifiedDiff(before, after, { relPath });
    fs.writeFileSync(absPath, after, 'utf-8');

    const controller = makeController();
    try {
      await controller.onToolDiff(absPath, relPath, diff.unified, after);
      controller.acceptFile(absPath);

      expect(controller.hasPending(absPath)).toBe(false);
      expect(fs.readFileSync(absPath, 'utf-8')).toBe(after);
      expect((await controller.rejectFile(absPath)).ok).toBe(false);
    } finally {
      controller.dispose();
    }
  });
});
