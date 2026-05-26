/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W14.1+W14.2 · KnowledgeIndex + search_knowledge 工具单测
 *
 * 覆盖：
 *   1. 知识库目录缺失 → create 抛 KNOWLEDGE_BASE_EMPTY
 *   2. 路径是文件而非目录 → 同样抛 KNOWLEDGE_BASE_EMPTY
 *   3. 正常目录 + 多个 .md → reindex 建索引，size > 0，search 命中
 *   4. 非 .md 文件被忽略（.txt/.json 不进索引）
 *   5. 持久化：二次 create 可直接从 store 加载
 *
 * 工具层（search_knowledge）：
 *   6. query 空 → hard fail TOOL_ARGS_INVALID
 *   7. getIndex reject KNOWLEDGE_BASE_EMPTY → ok:true + indexState=not_initialized + 引导文案
 *   8. 索引 size=0 → ok:true + indexState=not_ready
 *   9. 正常命中 → ok:true + display.source==='knowledge' + hits 字段
 *  10. 任意其它错误 → hard fail TOOL_EXEC_FAILED
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { KnowledgeIndex } from '../../src/core/knowledge/knowledge-index.js';
import {
  defaultKnowledgeIndexPath,
  defaultKnowledgeRoot,
} from '../../src/core/knowledge/store-path.js';
import { SearchKnowledgeTool } from '../../src/core/tools/search_knowledge.js';
import type { ToolContext } from '../../src/core/tools/types.js';
import type { IndexReader, SearchResult } from '../../src/core/index/codebase-index.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

function makeCtx(): ToolContext {
  const ctrl = new AbortController();
  return {
    signal: ctrl.signal,
    cwd: 'c:\\ws',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as ToolContext;
}

async function mkdirTmp(prefix: string): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return base;
}

describe('W14.1 · store-path 约定', () => {
  it('defaultKnowledgeRoot 指向 .dualmind/knowledge', () => {
    const p = defaultKnowledgeRoot('/ws');
    expect(p).toMatch(/[\\\/]\.dualmind[\\\/]knowledge$/);
  });

  it('defaultKnowledgeIndexPath 指向 .dualmind/knowledge-index.json', () => {
    const p = defaultKnowledgeIndexPath('/ws');
    expect(p).toMatch(/[\\\/]\.dualmind[\\\/]knowledge-index\.json$/);
  });
});

describe('W14.1 · KnowledgeIndex.create', () => {
  let wsRoot: string;

  beforeEach(async () => {
    wsRoot = await mkdirTmp('dualmind-kb-');
  });

  afterEach(async () => {
    await fs.rm(wsRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('目录缺失 → 抛 KNOWLEDGE_BASE_EMPTY', async () => {
    await expect(KnowledgeIndex.create({ workspaceRoot: wsRoot })).rejects.toMatchObject({
      code: ErrorCodes.KNOWLEDGE_BASE_EMPTY,
    });
  });

  it('路径是文件而非目录 → 抛 KNOWLEDGE_BASE_EMPTY', async () => {
    const kbRoot = defaultKnowledgeRoot(wsRoot);
    await fs.mkdir(path.dirname(kbRoot), { recursive: true });
    await fs.writeFile(kbRoot, 'not a dir', 'utf-8');
    await expect(KnowledgeIndex.create({ workspaceRoot: wsRoot })).rejects.toMatchObject({
      code: ErrorCodes.KNOWLEDGE_BASE_EMPTY,
    });
  });

  it('空目录 → 成功返回空 index（size=0）', async () => {
    await fs.mkdir(defaultKnowledgeRoot(wsRoot), { recursive: true });
    const idx = await KnowledgeIndex.create({ workspaceRoot: wsRoot });
    expect(idx.size()).toBe(0);
    expect(idx.getKnowledgeRoot()).toBe(defaultKnowledgeRoot(wsRoot));
  });
});

describe('W14.1 · KnowledgeIndex reindex + search', () => {
  let wsRoot: string;
  let kbRoot: string;

  beforeEach(async () => {
    wsRoot = await mkdirTmp('dualmind-kb-');
    kbRoot = defaultKnowledgeRoot(wsRoot);
    await fs.mkdir(kbRoot, { recursive: true });
    // 注入文档
    await fs.writeFile(
      path.join(kbRoot, 'onboarding.md'),
      '# Onboarding\n\n新员工入职流程：提交身份证、签保密协议、领取设备 laptop。',
      'utf-8',
    );
    await fs.writeFile(
      path.join(kbRoot, 'oncall.md'),
      '# On-call 轮值规则\n\n每周轮换一次，工作日 9:00-21:00，值班表在飞书群。',
      'utf-8',
    );
    // 噪声文件：不应进索引
    await fs.writeFile(path.join(kbRoot, 'noise.json'), '{"k":"v"}', 'utf-8');
    await fs.writeFile(path.join(kbRoot, 'noise.txt'), 'should not be indexed', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(wsRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('reindex 后 size > 0 且只含 .md', async () => {
    const idx = await KnowledgeIndex.create({ workspaceRoot: wsRoot });
    const stats = await idx.reindex();
    expect(stats.filesScanned).toBe(2); // 2 个 md，json/txt 被过滤
    expect(idx.size()).toBeGreaterThan(0);
    const files = idx.listIndexedFiles();
    expect(files.every((f) => f.endsWith('.md'))).toBe(true);
  });

  it('search 命中关键词（中文）', async () => {
    const idx = await KnowledgeIndex.create({ workspaceRoot: wsRoot });
    await idx.reindex();
    const hits = await idx.search('轮值 值班', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.filePath).toMatch(/oncall\.md$/);
  });

  it('二次 create 从 store 加载（persistence）', async () => {
    const idx1 = await KnowledgeIndex.create({ workspaceRoot: wsRoot });
    await idx1.reindex();
    const size1 = idx1.size();
    expect(size1).toBeGreaterThan(0);

    // 关闭重新打开：不 reindex 也能 search
    const idx2 = await KnowledgeIndex.create({ workspaceRoot: wsRoot });
    expect(idx2.size()).toBe(size1);
    const hits = await idx2.search('入职', 3);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('W14.2 · SearchKnowledgeTool', () => {
  it('query 空 → hard fail TOOL_ARGS_INVALID', async () => {
    const tool = new SearchKnowledgeTool({
      getIndex: async () => mockEmptyReader(),
    });
    const r = await tool.execute({ query: '   ' }, makeCtx());
    expect(r.ok).toBe(false);
    expect((r as { errorCode?: string }).errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('getIndex reject KNOWLEDGE_BASE_EMPTY → 软降级 not_initialized', async () => {
    const tool = new SearchKnowledgeTool({
      getIndex: async () => {
        const e: { code: string; message: string } = {
          code: ErrorCodes.KNOWLEDGE_BASE_EMPTY,
          message: '知识库目录不存在：/fake/.dualmind/knowledge',
        };
        throw e;
      },
    });
    const r = await tool.execute({ query: 'onboarding' }, makeCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('not initialized');
    const display = (r as { display?: Record<string, unknown> }).display ?? {};
    expect(display['indexState']).toBe('not_initialized');
    expect(display['soft']).toBe(true);
    expect(display['source']).toBe('knowledge');
  });

  it('索引 size=0 → 软降级 not_ready', async () => {
    const tool = new SearchKnowledgeTool({
      getIndex: async () => mockEmptyReader(),
    });
    const r = await tool.execute({ query: 'onboarding' }, makeCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('not indexed');
    const display = (r as { display?: Record<string, unknown> }).display ?? {};
    expect(display['indexState']).toBe('not_ready');
  });

  it('正常命中 → content 含片段 + display.source=knowledge', async () => {
    const hits: SearchResult[] = [
      {
        filePath: 'onboarding.md',
        startLine: 1,
        endLine: 3,
        text: '# Onboarding\n\n新员工流程',
        score: 2.14,
      },
    ];
    const tool = new SearchKnowledgeTool({
      getIndex: async () =>
        ({
          size: () => 5,
          listIndexedFiles: () => ['onboarding.md'],
          search: async () => hits,
        }) satisfies IndexReader,
    });
    const r = await tool.execute({ query: 'onboarding', top_k: 3 }, makeCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('source=knowledge');
    expect(r.content).toContain('onboarding.md:1-3');
    const display = (r as { display?: Record<string, unknown> }).display ?? {};
    expect(display['source']).toBe('knowledge');
    expect(display['count']).toBe(1);
    const emitted = display['hits'] as Array<{ filePath: string }>;
    expect(emitted[0]!.filePath).toBe('onboarding.md');
  });

  it('search 抛 INDEX_NOT_READY → 软降级 not_ready', async () => {
    const tool = new SearchKnowledgeTool({
      getIndex: async () =>
        ({
          size: () => 5,
          listIndexedFiles: () => [],
          search: async () => {
            const e: { code: string; message: string } = {
              code: ErrorCodes.INDEX_NOT_READY,
              message: 'empty',
            };
            throw e;
          },
        }) satisfies IndexReader,
    });
    const r = await tool.execute({ query: 'x' }, makeCtx());
    expect(r.ok).toBe(true);
    const display = (r as { display?: Record<string, unknown> }).display ?? {};
    expect(display['indexState']).toBe('not_ready');
  });

  it('其它错误 → hard fail TOOL_EXEC_FAILED', async () => {
    const tool = new SearchKnowledgeTool({
      getIndex: async () => {
        throw new Error('disk I/O boom');
      },
    });
    const r = await tool.execute({ query: 'x' }, makeCtx());
    expect(r.ok).toBe(false);
    expect((r as { errorCode?: string }).errorCode).toBe(ErrorCodes.TOOL_EXEC_FAILED);
  });
});

// ─────────── helpers ───────────

function mockEmptyReader(): IndexReader {
  return {
    size: () => 0,
    listIndexedFiles: () => [],
    search: async () => [],
  };
}
