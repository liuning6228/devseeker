/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * update_memory / search_memory 工具单测（W4 批次 2）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import {
  UpdateMemoryTool,
  SearchMemoryTool,
} from '../../src/core/tools/index.js';
import { MemoryStore } from '../../src/core/memory/store.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

let tmpRoot: string;
let globalRoot: string;
let store: MemoryStore;

function ctx(signal?: AbortSignal) {
  return {
    workspaceRoot: tmpRoot,
    signal: signal ?? new AbortController().signal,
    taskId: 't1',
    toolCallId: 'c1',
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'mt-ws-'));
  globalRoot = await fs.mkdtemp(join(os.tmpdir(), 'mt-gl-'));
  store = new MemoryStore({ workspaceRoot: tmpRoot, globalRoot });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(globalRoot, { recursive: true, force: true });
});

describe('UpdateMemoryTool', () => {
  it('fails on invalid action', async () => {
    const t = new UpdateMemoryTool({ getStore: () => store });
    const r = await t.execute({ action: 'foo' as any }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('fails when store not available', async () => {
    const t = new UpdateMemoryTool({ getStore: () => undefined });
    const r = await t.execute({ action: 'create' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
  });

  it('creates a memory and returns id', async () => {
    const t = new UpdateMemoryTool({ getStore: () => store });
    const r = await t.execute(
      {
        action: 'create',
        title: 'W1 完成',
        content: 'W1 MVP 已交付',
        category: 'task_summary_experience' as any, // 系统沉淀，应拒绝
        keywords: 'w1,mvp',
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.MEMORY_CATEGORY_NOT_WRITABLE);
  });

  it('creates with writable category', async () => {
    const t = new UpdateMemoryTool({ getStore: () => store });
    const r = await t.execute(
      {
        action: 'create',
        title: 'W1 完成',
        content: 'W1 MVP 已交付',
        category: 'expert_experience',
        keywords: 'w1,mvp',
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Created memory mem_');
    expect(r.content).toContain('keywords: w1, mvp');
    expect(r.display?.id).toMatch(/^mem_/);
  });

  it('update requires id', async () => {
    const t = new UpdateMemoryTool({ getStore: () => store });
    const r = await t.execute({ action: 'update', title: 'x' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('updates existing memory', async () => {
    const created = await store.create({
      title: 't',
      content: 'c',
      category: 'user_info',
      keywords: [],
    });
    const t = new UpdateMemoryTool({ getStore: () => store });
    const r = await t.execute(
      { action: 'update', id: created.id, content: 'c2' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain(`Updated memory ${created.id}`);
    const fresh = await store.getById(created.id);
    expect(fresh?.content).toBe('c2');
  });

  it('update on missing id throws MEMORY_ID_NOT_FOUND', async () => {
    const t = new UpdateMemoryTool({ getStore: () => store });
    const r = await t.execute({ action: 'update', id: 'no', title: 'x' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.MEMORY_ID_NOT_FOUND);
  });

  it('deletes existing memory', async () => {
    const created = await store.create({
      title: 't',
      content: 'c',
      category: 'user_info',
      keywords: [],
    });
    const t = new UpdateMemoryTool({ getStore: () => store });
    const r = await t.execute({ action: 'delete', id: created.id }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain(`Deleted memory ${created.id}`);
    expect(await store.getById(created.id)).toBeUndefined();
  });

  it('reports workspace_write safety level', () => {
    const t = new UpdateMemoryTool({ getStore: () => store });
    expect(t.safetyLevel).toBe('workspace_write');
  });
});

describe('SearchMemoryTool', () => {
  async function seed() {
    await store.create({
      title: 'DeepSeek reasoning bug',
      content: 'DeepSeek thinking content empty',
      category: 'common_pitfalls_experience',
      keywords: ['deepseek', 'reasoning'],
    });
    await store.create({
      title: 'W1 MVP 完成',
      content: 'W1 交付',
      category: 'expert_experience',
      keywords: ['w1', 'mvp'],
    });
    await store.create({
      title: 'user name',
      content: '小明',
      category: 'user_info',
      keywords: ['name'],
    });
  }

  it('fails when store not available', async () => {
    const t = new SearchMemoryTool({ getStore: () => undefined });
    const r = await t.execute({ depth: 'shallow', query: 'x' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
  });

  it('fetch by exact title', async () => {
    await seed();
    const t = new SearchMemoryTool({ getStore: () => store });
    const r = await t.execute(
      { depth: 'fetch', query: 'W1 MVP 完成' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('[expert_experience] W1 MVP 完成');
    expect(r.display?.count).toBe(1);
  });

  it('shallow by keywords', async () => {
    await seed();
    const t = new SearchMemoryTool({ getStore: () => store });
    const r = await t.execute(
      { depth: 'shallow', query: '', keywords: 'deepseek' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('DeepSeek reasoning bug');
  });

  it('explore returns groups tree', async () => {
    const t = new SearchMemoryTool({ getStore: () => store });
    const r = await t.execute({ depth: 'explore', query: '' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Subgroups:');
    const groups = r.display?.groups as string[];
    expect(groups).toContain('user');
    expect(groups).toContain('experience');
  });

  it('explore with path lists titles', async () => {
    await seed();
    const t = new SearchMemoryTool({ getStore: () => store });
    const r = await t.execute({ depth: 'explore', query: 'user' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Titles:');
    expect(r.content).toContain('user name');
  });

  it('invalid depth yields INVALID_DEPTH', async () => {
    const t = new SearchMemoryTool({ getStore: () => store });
    const r = await t.execute({ depth: 'foo' as any, query: 'x' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.MEMORY_SEARCH_INVALID_DEPTH);
  });

  it('reports read_only safety level', () => {
    const t = new SearchMemoryTool({ getStore: () => store });
    expect(t.safetyLevel).toBe('read_only');
  });
});
