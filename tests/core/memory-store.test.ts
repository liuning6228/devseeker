/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * MemoryStore 单测（W4 批次 2）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/core/memory/store.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

let tmpRoot: string;
let globalRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'mem-ws-'));
  globalRoot = await fs.mkdtemp(join(os.tmpdir(), 'mem-gl-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(globalRoot, { recursive: true, force: true });
});

function makeStore(withWorkspace = true): MemoryStore {
  return new MemoryStore({
    workspaceRoot: withWorkspace ? tmpRoot : undefined,
    globalRoot,
  });
}

describe('MemoryStore', () => {
  it('rejects system category on create', async () => {
    const store = makeStore();
    await expect(
      store.create({
        title: 'x',
        content: 'x',
        category: 'task_summary_experience',
        keywords: [],
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.MEMORY_CATEGORY_NOT_WRITABLE });
  });

  it('rejects invalid category', async () => {
    const store = makeStore();
    await expect(
      store.create({
        title: 'x',
        content: 'x',
        category: 'not_a_real_category',
        keywords: [],
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.MEMORY_CATEGORY_INVALID });
  });

  it('rejects empty title / content', async () => {
    const store = makeStore();
    await expect(
      store.create({ title: '  ', content: 'x', category: 'user_info', keywords: [] }),
    ).rejects.toMatchObject({ code: ErrorCodes.TOOL_ARGS_INVALID });
    await expect(
      store.create({ title: 'x', content: '', category: 'user_info', keywords: [] }),
    ).rejects.toMatchObject({ code: ErrorCodes.TOOL_ARGS_INVALID });
  });

  it('creates writable category and persists to workspace JSONL', async () => {
    const store = makeStore();
    const rec = await store.create({
      title: '用户名',
      content: '用户的名字是小明',
      category: 'user_info',
      keywords: ['name', 'user', 'person', 'alias'], // ≥ 4 keywords 不触发自动抽取
    });
    expect(rec.id).toMatch(/^mem_/);
    expect(rec.scope).toBe('workspace');
    expect(rec.keywords).toEqual(['name', 'user', 'person', 'alias']);

    const file = await fs.readFile(
      join(tmpRoot, '.devseeker', 'memories.jsonl'),
      'utf-8',
    );
    expect(file).toContain('"title":"用户名"');
    expect(file).toContain('"scope":"workspace"');
  });

  it('persists global scope to globalRoot', async () => {
    const store = makeStore();
    await store.create({
      title: 'g',
      content: 'g-content',
      category: 'expert_experience',
      keywords: ['g'],
      scope: 'global',
    });
    const file = await fs.readFile(
      join(globalRoot, '.devseeker', 'memories.jsonl'),
      'utf-8',
    );
    expect(file).toContain('"scope":"global"');
  });

  it('deduplicates keywords (case-insensitive)', async () => {
    const store = makeStore();
    const r = await store.create({
      title: 't',
      content: 'c',
      category: 'user_info',
      keywords: ['Name', 'name', 'NAME', 'Age'],
    });
    expect(r.keywords).toEqual(['Name', 'Age']);
  });

  it('updates existing memory by id', async () => {
    const store = makeStore();
    const r = await store.create({
      title: 't',
      content: 'c',
      category: 'user_info',
      keywords: [],
    });
    const updated = await store.update(r.id, { content: 'c2', keywords: ['a'] });
    expect(updated.content).toBe('c2');
    expect(updated.keywords).toEqual(['a']);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(r.updatedAt);
  });

  it('update on non-existent id throws MEMORY_ID_NOT_FOUND', async () => {
    const store = makeStore();
    await expect(store.update('missing', { title: 'x' })).rejects.toMatchObject({
      code: ErrorCodes.MEMORY_ID_NOT_FOUND,
    });
  });

  it('remove deletes and persists', async () => {
    const store = makeStore();
    const r = await store.create({
      title: 't',
      content: 'c',
      category: 'user_info',
      keywords: [],
    });
    await store.remove(r.id);
    expect(await store.getById(r.id)).toBeUndefined();
    const file = await fs.readFile(
      join(tmpRoot, '.devseeker', 'memories.jsonl'),
      'utf-8',
    );
    expect(file).not.toContain(r.id);
  });

  it('reload from disk preserves data', async () => {
    const s1 = makeStore();
    await s1.create({
      title: 'persisted',
      content: 'c',
      category: 'project_tech_stack',
      keywords: ['x'],
    });

    const s2 = makeStore();
    const list = await s2.list();
    expect(list.length).toBe(1);
    expect(list[0].title).toBe('persisted');
  });

  it('rejects workspace scope when no workspaceRoot', async () => {
    const store = makeStore(false);
    await expect(
      store.create({
        title: 't',
        content: 'c',
        category: 'user_info',
        keywords: [],
        scope: 'workspace',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.MEMORY_CATEGORY_NOT_WRITABLE });
  });

  it('list filters by category and scope', async () => {
    const store = makeStore();
    await store.create({
      title: 'a',
      content: 'c',
      category: 'user_info',
      keywords: [],
    });
    await store.create({
      title: 'b',
      content: 'c',
      category: 'project_tech_stack',
      keywords: [],
    });
    await store.create({
      title: 'g',
      content: 'c',
      category: 'expert_experience',
      keywords: [],
      scope: 'global',
    });

    expect((await store.list({ category: 'user_info' })).length).toBe(1);
    expect((await store.list({ scope: 'workspace' })).length).toBe(2);
    expect((await store.list({ scope: 'global' })).length).toBe(1);
  });
});

describe('MemoryStore.createSystem', () => {
  it('允许写入 SYSTEM_CATEGORIES（create 不允许的）', async () => {
    const store = makeStore();
    const rec = await store.createSystem({
      title: '任务总结',
      content: '完成了 XX 功能的开发，涉及 5 个文件',
      category: 'task_summary_experience',
      keywords: ['task', 'summary'],
    });
    expect(rec.id).toMatch(/^mem_/);
    expect(rec.category).toBe('task_summary_experience');
    expect(rec.scope).toBe('workspace');
  });

  it('拒绝非法类别（与 create 一致）', async () => {
    const store = makeStore();
    await expect(
      store.createSystem({
        title: 'x',
        content: 'x',
        category: 'not_a_real_category',
        keywords: [],
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.MEMORY_CATEGORY_INVALID });
  });

  it('拒绝空 title / content', async () => {
    const store = makeStore();
    await expect(
      store.createSystem({ title: '', content: 'x', category: 'task_summary_experience', keywords: [] }),
    ).rejects.toMatchObject({ code: ErrorCodes.TOOL_ARGS_INVALID });
  });

  it('持久化到 JSONL 且可重新加载', async () => {
    const s1 = makeStore();
    await s1.createSystem({
      title: 'session-summary',
      content: '本次会话完成了 P0 功能开发',
      category: 'task_summary_experience',
      keywords: ['p0', 'session'],
    });

    const s2 = makeStore();
    const list = await s2.list({ category: 'task_summary_experience' });
    expect(list.length).toBe(1);
    expect(list[0].title).toBe('session-summary');
  });

  it('也允许写入 WRITABLE_CATEGORIES（不限制）', async () => {
    const store = makeStore();
    const rec = await store.createSystem({
      title: 'common pitfall',
      content: '注意 search_replace 要去掉行号前缀',
      category: 'common_pitfalls_experience',
      keywords: ['search_replace', 'prefix'],
    });
    expect(rec.category).toBe('common_pitfalls_experience');
  });
});
