/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * T3 记忆模块树注入（检索差距弥补计划）单测：
 * - buildMemoryTreeBlock 纯函数（格式 / 截断 / 零注入）
 * - PrefetchEngine 双产线（consumeHit / consumeTreeHit 互斥消费）
 */

import { describe, it, expect } from 'vitest';
import { buildMemoryTreeBlock } from '../../src/core/memory/explore-inject.js';
import { PrefetchEngine } from '../../src/core/memory/prefetch.js';
import type { MemoryRecord } from '../../src/core/memory/types.js';

let seq = 0;
function mkRecord(
  title: string,
  category: string,
  keywords: string[],
  content = '',
): MemoryRecord {
  seq += 1;
  const now = Date.now() - seq;
  return {
    id: `mem_${now}_${seq}`,
    title,
    category: category as MemoryRecord['category'],
    content,
    keywords,
    scope: 'workspace',
    createdAt: now,
    updatedAt: now,
  };
}

describe('buildMemoryTreeBlock', () => {
  const records = [
    mkRecord('Vite 构建配置', 'project_build_configuration', ['vite', 'build', '配置']),
    mkRecord('LSP 桥设计', 'project_architecture', ['lsp', 'bridge', 'vscode']),
    mkRecord('发布流程', 'development_practice_specification', ['vsix', '发布', 'gitcode']),
    mkRecord('登录注册无关', 'task_summary_experience', ['auth', 'login'], '与主题完全无关的内容'),
  ];

  it('命中时输出 <memory_tree> 块（开/闭标签 + 分类标题行 + 引导注释）', () => {
    const block = buildMemoryTreeBlock(records, ['lsp', 'vite']);
    expect(block).toBeDefined();
    expect(block!.startsWith('<memory_tree>')).toBe(true);
    expect(block!.endsWith('</memory_tree>')).toBe(true);
    expect(block).toContain('(与当前任务相关的记忆分类骨架');
    // 按 category 聚合输出：vite → project_build_configuration，lsp → project_architecture
    expect(block).toContain('- [project_build_configuration] Vite 构建配置');
    expect(block).toContain('- [project_architecture] LSP 桥设计');
    // 无关记录不进骨架
    expect(block).not.toContain('登录注册无关');
  });

  it('category 聚合：同名分类合并到一个组、组内按得分降序', () => {
    const sameCat = [
      mkRecord('B 主题', 'user_behavior', ['主题']),
      mkRecord('A 主题', 'user_behavior', ['主题']),
    ];
    const block = buildMemoryTreeBlock(sameCat, ['主题']);
    const idxA = block!.indexOf('A 主题');
    const idxB = block!.indexOf('B 主题');
    // 两条同分（title+keywords 双命中），稳定排序保持 records 顺序（B 在前 A 在后）
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxB).toBeLessThan(idxA);
  });

  it('maxTitles 截断标题行数量', () => {
    const many = [
      mkRecord('主题1', 'task_summary_experience', ['主题']),
      mkRecord('主题2', 'task_summary_experience', ['主题']),
      mkRecord('主题3', 'task_summary_experience', ['主题']),
      mkRecord('主题4', 'task_summary_experience', ['主题']),
      mkRecord('主题5', 'task_summary_experience', ['主题']),
    ];
    const block = buildMemoryTreeBlock(many, ['主题'], { maxTitles: 3 });
    const titleLines = block!.split('\n').filter((l) => l.startsWith('- ['));
    expect(titleLines).toHaveLength(3);
  });

  it('minScore 过滤低分命中', () => {
    // content 单关键词命中得分 = (0.1/1)*2 = 0.2，恰好等于默认阈值 0.2（边界 >= 放行）
    const contentOnly = mkRecord('深藏记录', 'task_summary_experience', [], '关键词xyz在正文里');
    const blockDefault = buildMemoryTreeBlock([contentOnly], ['关键词xyz']);
    expect(blockDefault).toBeDefined();
    // minScore 抬到 0.5 → content-only 0.2 被过滤
    const blockHigh = buildMemoryTreeBlock([contentOnly], ['关键词xyz'], { minScore: 0.5 });
    expect(blockHigh).toBeUndefined();
    // title 命中得 1.0 → minScore=0.5 放行
    const strong = mkRecord('关键词xyz 主题', 'task_summary_experience', ['关键词xyz']);
    const blockStrong = buildMemoryTreeBlock([strong], ['关键词xyz'], { minScore: 0.5 });
    expect(blockStrong).toBeDefined();
  });

  it('无命中 → undefined（零注入）', () => {
    expect(buildMemoryTreeBlock(records, ['totally-unrelated-word'])).toBeUndefined();
  });

  it('空 records / 无效 query（切词为空）→ undefined', () => {
    expect(buildMemoryTreeBlock([], ['lsp'])).toBeUndefined();
    expect(buildMemoryTreeBlock(records, ['a', 'b'])).toBeUndefined();
    expect(buildMemoryTreeBlock(records, '')).toBeUndefined();
  });

  it('字符串与词数组 query 输出一致', () => {
    const fromStr = buildMemoryTreeBlock(records, 'lsp bridge vite 配置');
    const fromArr = buildMemoryTreeBlock(records, ['lsp', 'bridge', 'vite', '配置']);
    expect(fromStr).toBe(fromArr);
  });
});

describe('PrefetchEngine · T3 双产线', () => {
  function makeEngine(list: () => Promise<MemoryRecord[]>) {
    return new PrefetchEngine(list);
  }

  it('同一条目可被 consumeHit / consumeTreeHit 各消费一次（互斥消费）', async () => {
    const records = [
      mkRecord('LSP 桥设计', 'project_architecture', ['lsp']),
      mkRecord('内核模块', 'project_architecture', ['lsp']),
    ];
    const engine = makeEngine(async () => records);
    engine.queuePrefetch('lsp 桥相关任务');
    await engine.flush();

    const hit = engine.consumeHit('lsp 桥相关任务');
    expect(hit).toContain('<prefetch>');
    expect(hit).toContain('- [project_architecture] LSP 桥设计');

    const treeHit = engine.consumeTreeHit('lsp 桥相关任务');
    expect(treeHit).toContain('<memory_tree>');
    expect(treeHit).toContain('- [project_architecture] LSP 桥设计');

    // 条目已被消费 → 不再命中
    expect(engine.consumeHit('lsp 桥相关任务')).toBe('');
    expect(engine.consumeTreeHit('lsp 桥相关任务')).toBe('');
  });

  it('先 consumeTreeHit 后 consumeHit 按字段互斥，不互相吞掉', async () => {
    const records = [mkRecord('发布流程', 'development_practice_specification', ['vsix'])];
    const engine = makeEngine(async () => records);
    engine.queuePrefetch('vsix 打包发布');
    await engine.flush();

    const treeHit = engine.consumeTreeHit('vsix 打包发布');
    expect(treeHit).toContain('<memory_tree>');
    // 字段级消费：树骨架已被拿走，result 字段仍可消费
    const hit = engine.consumeHit('vsix 打包发布');
    expect(hit).toContain('<prefetch>');
    expect(hit).toContain('- [development_practice_specification] 发布流程');
    // 两字段都消费完 → 条目移除，不再命中
    expect(engine.consumeHit('vsix 打包发布')).toBe('');
    expect(engine.consumeTreeHit('vsix 打包发布')).toBe('');
  });

  it('两条产线都为空 → 不缓存（零注入）', async () => {
    const noMatch = [mkRecord('无关记录', 'task_summary_experience', ['auth'])];
    const engine = makeEngine(async () => noMatch);
    engine.queuePrefetch('lsp 完全不相关词');
    await engine.flush();
    expect(engine.consumeHit('lsp 完全不相关词')).toBe('');
    expect(engine.consumeTreeHit('lsp 完全不相关词')).toBe('');
  });

  it('空记录的预取不缓存', async () => {
    const engine = makeEngine(async () => []);
    engine.queuePrefetch('anything');
    await engine.flush();
    expect(engine.consumeHit('anything')).toBe('');
    expect(engine.consumeTreeHit('anything')).toBe('');
  });
});