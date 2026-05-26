/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W5b3 · CheckpointsTreeProvider 单测
 *
 * 覆盖：
 * - 无 session → InfoItem 占位
 * - 空列表 → InfoItem 占位
 * - 有数据 → CheckpointItem[]，按 createdAt 降序
 * - refresh() 触发 onDidChangeTreeData
 * - CheckpointItem 带默认点击命令与 contextValue
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CheckpointsTreeProvider,
  CheckpointItem,
  InfoItem,
  type CheckpointsDataSource,
} from '../../src/webview/checkpointsTree.js';
import type { CheckpointMeta } from '../../src/core/checkpoints/index.js';

function makeMeta(id: string, createdAt: number, label?: string): CheckpointMeta {
  return {
    id,
    sessionId: 's1',
    createdAt,
    ...(label !== undefined ? { label } : {}),
    messageCount: 3,
    fileCount: 1,
    totalBytes: 100,
  };
}

function makeSource(partial: Partial<CheckpointsDataSource>): CheckpointsDataSource {
  return {
    getCurrentSessionId: () => 's1',
    listCheckpoints: async () => [],
    ...partial,
  };
}

describe('CheckpointsTreeProvider', () => {
  it('returns InfoItem when no current session', async () => {
    const provider = new CheckpointsTreeProvider(
      makeSource({ getCurrentSessionId: () => undefined }),
    );
    const children = await provider.getChildren();
    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(InfoItem);
  });

  it('returns InfoItem when session exists but list is empty', async () => {
    const provider = new CheckpointsTreeProvider(
      makeSource({ listCheckpoints: async () => [] }),
    );
    const children = await provider.getChildren();
    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(InfoItem);
  });

  it('returns sorted CheckpointItem[] (newest first)', async () => {
    const older = makeMeta('cp-a', 1_000, 'older');
    const newer = makeMeta('cp-b', 2_000, 'newer');
    const provider = new CheckpointsTreeProvider(
      makeSource({ listCheckpoints: async () => [older, newer] }),
    );
    const children = await provider.getChildren();
    expect(children.length).toBe(2);
    expect(children[0]).toBeInstanceOf(CheckpointItem);
    expect((children[0] as CheckpointItem).meta.id).toBe('cp-b');
    expect((children[1] as CheckpointItem).meta.id).toBe('cp-a');
  });

  it('returns InfoItem when listCheckpoints throws', async () => {
    const provider = new CheckpointsTreeProvider(
      makeSource({ listCheckpoints: async () => {
        throw new Error('boom');
      } }),
    );
    const children = await provider.getChildren();
    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(InfoItem);
  });

  it('getChildren with element returns empty (flat tree)', async () => {
    const provider = new CheckpointsTreeProvider(makeSource({}));
    const item = new CheckpointItem(makeMeta('cp-x', 1));
    const children = await provider.getChildren(item);
    expect(children).toEqual([]);
  });

  it('refresh() fires onDidChangeTreeData listeners', () => {
    const provider = new CheckpointsTreeProvider(makeSource({}));
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('CheckpointItem has click-command, contextValue and icon', () => {
    const item = new CheckpointItem(makeMeta('cp-1', 1, 'my-label'));
    expect(item.id).toBe('cp-1');
    expect(item.contextValue).toBe('dualMindCheckpoint');
    expect(item.command?.command).toBe('dualMind.checkpoints.revertById');
    expect(item.command?.arguments?.[0]).toBe(item);
    expect(item.description).toContain('msgs');
    expect(item.description).toContain('files');
  });

  it('CheckpointItem label falls back to time when no label provided', () => {
    const item = new CheckpointItem(makeMeta('cp-2', Date.now()));
    expect(typeof item.label).toBe('string');
    expect((item.label as string).length).toBeGreaterThan(0);
  });

  it('getTreeItem returns element as-is', () => {
    const provider = new CheckpointsTreeProvider(makeSource({}));
    const item = new CheckpointItem(makeMeta('cp-1', 1));
    expect(provider.getTreeItem(item)).toBe(item);
  });
});
