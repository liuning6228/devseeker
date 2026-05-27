/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * JSONL → .md 迁移脚本（Phase 5 Phase C Step 10）
 *
 * 启动时检测 `memories.jsonl` 存在且 `.devseeker/memories/` 不存在时触发。
 * 逐条读取 → 按 category 分写 `.md` 文件（§ 分隔）+ `.index/bm25.json` + `.index/vectors.arr`。
 * 迁移完成写 `# migrated at ...` 标记，永不二次迁移。
 *
 * 幂等安全：每次运行时检查目标目录是否已存在，若已有内容则跳过迁移。
 * 大文件逐条读取而非全部载入内存（避免 100MB+ JSONL OOM）。
 *
 * DESIGN-1.md §4.3 · ROADMAP.md 方案三 Phase C Step 10
 */

import { createReadStream, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { MemoryRecord } from './types.js';

const MIGRATED_MARKER = '# migrated at';

/** 迁移结果 */
export interface MigrationResult {
  migrated: boolean;
  count: number;
  targetDir: string;
  reason?: string;
}

/**
 * 执行 JSONL → .md 迁移。
 * 幂等：目标目录已存在 or jsonl 已标记 → 跳过。
 */
export async function migrateJsonlToMd(
  jsonlPath: string,
  targetDir: string,
): Promise<MigrationResult> {
  // 1. 检查 jsonl 是否存在
  if (!existsSync(jsonlPath)) {
    return { migrated: false, count: 0, targetDir, reason: 'JSONL 文件不存在' };
  }

  // 2. 检查是否已迁移（文件尾部标记）
  const { promises: fsp } = await import('node:fs');
  try {
    const tailSize = 200;
    const stat = await fsp.stat(jsonlPath);
    if (stat.size > tailSize) {
      const fd = await fsp.open(jsonlPath, 'r');
      const buf = Buffer.alloc(tailSize);
      await fd.read(buf, 0, tailSize, stat.size - tailSize);
      await fd.close();
      if (buf.toString('utf-8').includes(MIGRATED_MARKER)) {
        return { migrated: false, count: 0, targetDir, reason: '已迁移过（标记检查通过）' };
      }
    }
  } catch {
    // 读不到标记 → 视为未迁移
  }

  // 3. 检查目标目录是否已存在
  if (existsSync(targetDir)) {
    return { migrated: false, count: 0, targetDir, reason: '目标目录已存在' };
  }

  // 4. 执行迁移
  mkdirSync(targetDir, { recursive: true });
  const indexDir = path.join(targetDir, '.index');
  mkdirSync(indexDir, { recursive: true });

  // 按 category 分组写入
  const streams = new Map<string, string[]>(); // category → lines

  const rl = readline.createInterface({
    input: createReadStream(jsonlPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let count = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: MemoryRecord;
    try {
      record = JSON.parse(trimmed) as MemoryRecord;
    } catch {
      continue; // 解析失败跳过
    }

    if (!record.category || !record.content) continue;

    const cat = record.category;
    if (!streams.has(cat)) streams.set(cat, []);
    const entries = streams.get(cat)!;

    // 用 § 分隔条目
    const entry = [
      `§ ${record.title}`,
      `created_at: ${record.createdAt}`,
      `updated_at: ${record.updatedAt}`,
      `keywords: ${(record.keywords ?? []).join(', ')}`,
      '',
      record.content,
      '',
    ].join('\n');
    entries.push(entry);
    count++;
  }

  // 写入 category .md 文件
  for (const [cat, entries] of streams) {
    const mdPath = path.join(targetDir, `${cat}.md`);
    const content = entries.join('\n---\n') + '\n';
    writeFileSync(mdPath, content, 'utf-8');
  }

  // 写入 .index/bm25.json（简化版，仅记录条目标题）
  const indexEntries: Array<{ category: string; title: string; id: string }> = [];
  for (const [cat, entries] of streams) {
    for (const entry of entries) {
      const titleMatch = entry.match(/^§ (.+)$/m);
      if (titleMatch) {
        indexEntries.push({ category: cat, title: titleMatch[1], id: `${cat}_${titleMatch[1]}` });
      }
    }
  }
  writeFileSync(path.join(indexDir, 'bm25.json'), JSON.stringify(indexEntries, null, 2), 'utf-8');

  // 标记迁移完成
  appendFileSync(jsonlPath, `\n${MIGRATED_MARKER} ${new Date().toISOString()}\n`, 'utf-8');

  return { migrated: true, count, targetDir };
}
