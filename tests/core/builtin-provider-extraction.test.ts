/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * BuiltinMemoryProvider 自动提炼集成单测（P0）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { BuiltinMemoryProvider } from '../../src/core/memory/builtin-provider.js';
import type { MemoryExtractorFn } from '../../src/core/memory/extraction-prompt.js';

let tmpRoot: string;
let globalRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'mem-builtin-'));
  globalRoot = await fs.mkdtemp(join(os.tmpdir(), 'mem-builtin-gl-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(globalRoot, { recursive: true, force: true });
});

function makeProvider(extractor?: MemoryExtractorFn): BuiltinMemoryProvider {
  return new BuiltinMemoryProvider(
    { workspaceRoot: tmpRoot, globalRoot },
    extractor ? { extractor } : undefined,
  );
}

/** 构造一个返回指定 JSON 的 fake extractor */
function fakeExtractor(response: string): MemoryExtractorFn {
  return async (_prompt: string, _maxTokens: number) => response;
}

/** 构造一个记录调用次数的 fake extractor */
function countingExtractor(response: string, callLog: number[]): MemoryExtractorFn {
  return async (prompt: string, maxTokens: number) => {
    callLog.push(1);
    return response;
  };
}

describe('BuiltinMemoryProvider.syncTurn', () => {
  it('无 extractor 时 → 静默跳过', async () => {
    const provider = makeProvider();
    await provider.initialize('test-session');
    // 不应抛错
    await provider.syncTurn('用户问题', '助手回复');
    const list = await provider.list();
    expect(list).toHaveLength(0);
  });

  it('短文本 → 启发式跳过，不调用 LLM', async () => {
    const callLog: number[] = [];
    const provider = makeProvider(countingExtractor('[]', callLog));
    await provider.initialize('test-session');
    await provider.syncTurn('ok', '好的');
    expect(callLog).toHaveLength(0);
  });

  it('值得提取的对话 → 调用 LLM 并写入记忆', async () => {
    const memJson = JSON.stringify([
      {
        title: 'search_replace 行号前缀',
        content: 'search_replace 时必须去掉 read_file 的行号前缀，否则会报错',
        category: 'common_pitfalls_experience',
        keywords: ['search_replace', 'prefix', 'line-number'],
      },
    ]);
    const provider = makeProvider(fakeExtractor(memJson));
    await provider.initialize('test-session');

    await provider.syncTurn(
      '搜索替换报错了',
      '这个错误是因为 read_file 返回的内容每行带行号前缀，search_replace 时需要去掉这些前缀',
    );

    // 等待异步写入完成
    const list = await provider.list();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].title).toBe('search_replace 行号前缀');
    expect(list[0].category).toBe('common_pitfalls_experience');
  });

  it('LLM 返回空数组 → 不写入', async () => {
    const provider = makeProvider(fakeExtractor('[]'));
    await provider.initialize('test-session');
    await provider.syncTurn(
      '请解释一下这段代码',
      '这是一段很长的解释...\n'.repeat(50),
    );
    const list = await provider.list();
    expect(list).toHaveLength(0);
  });

  it('LLM 抛错 → 静默降级，不阻断', async () => {
    const badExtractor: MemoryExtractorFn = async () => {
      throw new Error('LLM unavailable');
    };
    const provider = makeProvider(badExtractor);
    await provider.initialize('test-session');
    // 不应抛错
    await provider.syncTurn(
      '遇到了一个 error',
      '这个错误的原因是这样的...',
    );
    const list = await provider.list();
    expect(list).toHaveLength(0);
  });

  it('超过 SYNC_TURN_MAX_MEMORIES 条 → 截断', async () => {
    const memJson = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({
        title: `m${i}`,
        content: `content-${i}-`.repeat(20),
        category: 'tool_experience',
        keywords: ['k'],
      })),
    );
    const provider = makeProvider(fakeExtractor(memJson));
    await provider.initialize('test-session');
    await provider.syncTurn(
      '工具使用问题',
      '这是一个包含工具使用经验的长回复...\n'.repeat(50),
    );
    const list = await provider.list();
    // SYNC_TURN_MAX_MEMORIES = 3
    expect(list.length).toBeLessThanOrEqual(3);
  });
});

describe('BuiltinMemoryProvider.onSessionEnd', () => {
  it('无 extractor 时 → 静默跳过', async () => {
    const provider = makeProvider();
    await provider.initialize('test-session');
    await provider.onSessionEnd([
      { role: 'user', content: '任务' },
      { role: 'assistant', content: '完成' },
    ]);
    const list = await provider.list();
    expect(list).toHaveLength(0);
  });

  it('空 messages → 跳过', async () => {
    const callLog: number[] = [];
    const provider = makeProvider(countingExtractor('[]', callLog));
    await provider.initialize('test-session');
    await provider.onSessionEnd([]);
    expect(callLog).toHaveLength(0);
  });

  it('正常提取任务总结', async () => {
    const memJson = JSON.stringify([
      {
        title: 'P0 记忆提炼功能开发',
        content: '完成了 syncTurn 和 onSessionEnd 的实现，涉及 extraction-prompt.ts 和 builtin-provider.ts',
        category: 'task_summary_experience',
        keywords: ['P0', 'memory', 'extraction'],
      },
    ]);
    const provider = makeProvider(fakeExtractor(memJson));
    await provider.initialize('test-session');

    await provider.onSessionEnd([
      { role: 'user', content: '实现 P0 记忆自动提炼' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'read_file', arguments: '{"path":"src/core/memory/builtin-provider.ts"}' } },
          { function: { name: 'search_replace', arguments: '{"file_path":"src/core/memory/builtin-provider.ts"}' } },
        ],
      },
      { role: 'assistant', content: '已完成 syncTurn 和 onSessionEnd 的实现' },
    ]);

    const list = await provider.list();
    expect(list.length).toBeGreaterThanOrEqual(1);
    const summary = list.find((m) => m.category === 'task_summary_experience');
    expect(summary).toBeDefined();
    expect(summary!.title).toBe('P0 记忆提炼功能开发');
  });

  it('超过 SESSION_END_MAX_MEMORIES 条 → 截断', async () => {
    const memJson = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({
        title: `m${i}`,
        content: `content-${i}-`.repeat(20),
        category: 'task_summary_experience',
        keywords: ['k'],
      })),
    );
    const provider = makeProvider(fakeExtractor(memJson));
    await provider.initialize('test-session');

    await provider.onSessionEnd([
      { role: 'user', content: '大任务' },
      { role: 'assistant', content: '完成了很多工作'.repeat(100) },
    ]);

    const list = await provider.list();
    // SESSION_END_MAX_MEMORIES = 5
    expect(list.length).toBeLessThanOrEqual(5);
  });
});
