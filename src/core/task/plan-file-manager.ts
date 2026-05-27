/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Plan 文件管理（Phase 5 Phase B Step 5 + Step 9）
 *
 * Cline 风格：
 * - getPlanSlug()：单词生成 + 唯一性检查（10 次重试）
 * - getPlanFilePath()：{slug}.md / {slug}-agent-{agentId}.md（fork 隔离）
 * - getPlan()：读取 plan 文件
 * - copyPlanForResume()：从 file snapshot / message history 两级回退恢复
 * - copyPlanForFork()：fork 会话生成新 slug，防止文件冲突
 * - getPlansDirectory()：可配置（默认 docs/plans/）
 *
 * 复用 create_plan.ts 的 slug/hash 逻辑。
 *
 * DESIGN-1.md §4.1 · ROADMAP.md 方案二 Phase B Step 5+9
 */

import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { slugifyPlanName, planHash } from '../tools/create_plan.js';

const DEFAULT_PLANS_DIR = join('docs', 'plans');
const MAX_SLUG_RETRIES = 10;

/** Plan 状态 */
export type PlanFileStatus = 'draft' | 'approved' | 'in_progress' | 'completed';

/** Plan 文件元数据 */
export interface PlanMeta {
  id: string;
  slug: string;
  title: string;
  status: PlanFileStatus;
  filePath: string;
  createdAt: number;
}

/**
 * 生成唯一 slug（最多 10 次重试）。
 * 使用 slugifyPlanName + 短 hash 确保唯一。
 */
export async function getPlanSlug(
  name: string,
  overview: string,
  wsRoot: string,
  plansDirRel: string = DEFAULT_PLANS_DIR,
): Promise<string> {
  const plansDir = resolve(wsRoot, plansDirRel);
  const slug = slugifyPlanName(name);
  const hash = planHash(name, overview);
  const base = `${slug}_${hash}`;

  // 先检查 base 是否已存在
  const basePath = resolve(plansDir, `${base}.md`);
  try {
    await fs.access(basePath);
    // 已存在 → 尝试加后缀
    for (let i = 0; i < MAX_SLUG_RETRIES; i++) {
      const alt = `${base}_${i}`;
      const altPath = resolve(plansDir, `${alt}.md`);
      try {
        await fs.access(altPath);
        continue; // 仍有冲突
      } catch {
        return alt;
      }
    }
    throw new Error(`无法生成唯一 plan slug：尝试 ${MAX_SLUG_RETRIES} 次仍有冲突`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return base;
    }
    throw e;
  }
}

/**
 * 获取 plan 文件路径。
 * agentId 不为空时生成 fork 隔离路径。
 */
export function getPlanFilePath(
  slug: string,
  wsRoot: string,
  agentId?: string,
  plansDirRel: string = DEFAULT_PLANS_DIR,
): string {
  const plansDir = resolve(wsRoot, plansDirRel);
  const suffix = agentId ? `-agent-${agentId}` : '';
  return resolve(plansDir, `${slug}${suffix}.md`);
}

/** 读取 plan 文件内容 */
export async function getPlan(
  slug: string,
  wsRoot: string,
  agentId?: string,
): Promise<{ content: string; meta: PlanMeta } | null> {
  const filePath = getPlanFilePath(slug, wsRoot, agentId);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const meta = parsePlanMeta(slug, filePath, content);
    return { content, meta };
  } catch {
    return null;
  }
}

/**
 * 解析 plan 文件的 frontmatter，提取元数据。
 */
export function parsePlanMeta(slug: string, filePath: string, content: string): PlanMeta {
  const frontMatch = content.match(/^---\n([\s\S]*?)\n---/);
  let title = slug;
  let status: PlanFileStatus = 'draft';
  let createdAt = Date.now();

  if (frontMatch) {
    const front = frontMatch[1];
    const titleMatch = front.match(/^#\s+(.+)$/m);
    if (titleMatch) title = titleMatch[1].trim();
    const statusMatch = front.match(/^status:\s*(.+)$/m);
    if (statusMatch) {
      const s = statusMatch[1].trim().toLowerCase() as PlanFileStatus;
      if (['draft', 'approved', 'in_progress', 'completed'].includes(s)) status = s;
    }
    const createdMatch = front.match(/^created_at:\s*(\d+)$/m);
    if (createdMatch) createdAt = parseInt(createdMatch[1], 10);
  }

  const id = `${slug}_${planHash(slug, title)}`.slice(0, 24);

  return { id, slug, title, status, filePath, createdAt };
}

/**
 * 两级恢复：file snapshot → message history fallback。
 * 优先从磁盘读 plan 文件，fallback 尝试从消息历史中搜索 <approved_plan>。
 */
export async function copyPlanForResume(
  slug: string,
  wsRoot: string,
  historyMessages?: string[],
): Promise<{ content: string; source: 'file' | 'history' } | null> {
  // 一级：文件系统
  const fromFile = await getPlan(slug, wsRoot);
  if (fromFile && fromFile.meta.status === 'in_progress') {
    return { content: fromFile.content, source: 'file' };
  }

  // 二级：消息历史
  if (historyMessages && historyMessages.length > 0) {
    for (const msg of historyMessages) {
      const match = msg.match(/<approved_plan[\s\S]*?<\/approved_plan>/);
      if (match) {
        const xml = match[0];
        const planIdMatch = xml.match(/plan_id="([^"]+)"/);
        if (planIdMatch && planIdMatch[1].includes(slug)) {
          return { content: xml, source: 'history' };
        }
      }
    }
  }

  return null;
}

/** fork 隔离：为子代理生成独立的 slug */
export function copyPlanForFork(slug: string, agentId: string): string {
  return `${slug}-fork-${agentId}`;
}
