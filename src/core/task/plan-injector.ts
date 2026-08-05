/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Plan 注入器（Phase 5 Phase B Step 6 + P1 Spec 扩展）
 *
 * 读取 plan 文件 → 格式化为 `<approved_plan>` XML 块 → 追加到 system prompt L2 后。
 * 读取 spec 文件 → 格式化为 `<spec>` XML 块 → 追加到 system prompt。
 * 块约束 ≤ 2000 tokens，超限裁剪 files 列表。
 *
 * 注入位置：system prompt 的 L2（workspace context）之后，不破坏现有 layers。
 *
 * DESIGN-1.md §4.1 · ROADMAP.md 方案二 Phase B Step 6
 * spec-workflow-and-knowledge-engine.md §五
 */

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import type { SpecDocument } from './spec-manager.js';

const MAX_CHARS = 2000; // 约 500 tokens，留余量

/**
 * 格式化 plan 文件为 `<approved_plan>` XML 块。
 * 读取 docs/plans/<planId>.md → 解析 frontmatter + steps → 输出 XML。
 */
export async function formatApprovedPlanXml(
  planId: string,
  wsRoot: string,
): Promise<string> {
  const planPath = resolve(wsRoot, 'docs', 'plans', `${planId}.md`);
  let content: string;
  try {
    content = await fs.readFile(planPath, 'utf-8');
  } catch {
    return '';
  }

  // 解析 frontmatter 获取 title 和 status
  const frontMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  let title = planId;
  let status = 'in_progress';
  let body = content;

  if (frontMatch) {
    const front = frontMatch[1];
    const bodyRaw = frontMatch[2];
    const titleMatch = front.match(/^#\s+(.+)$/m);
    if (titleMatch) title = titleMatch[1].trim();
    const statusMatch = front.match(/^status:\s*(.+)$/m);
    if (statusMatch) status = statusMatch[1].trim();
    body = bodyRaw;
  }

  // 提取 steps（格式：## Step N 或 - step N 或 stepN: pending/done）
  const stepLines: string[] = [];
  const stepRegex = /(?:^|\n)(?:##\s+Step\s+(\d+)|step(\d+)\s*:\s*(\w+)|[-*]\s+(.+?)(?:\n|$))/gm;
  let stepMatch;
  while ((stepMatch = stepRegex.exec(body)) !== null) {
    const num = stepMatch[1] ?? stepMatch[2];
    const desc = stepMatch[4] ?? `${stepMatch[3] ?? ''}`;
    if (num || desc) {
      stepLines.push(`<step num="${num ?? '?'}" status="pending">${escapeXml(desc || `Step ${num}`)}</step>`);
    }
  }

  // 构建 XML
  let xml = `<approved_plan plan_id="${escapeXml(planId)}" title="${escapeXml(title)}" status="${escapeXml(status)}">\n`;

  // 从 body 中提取文件列表
  const fileMatches = body.matchAll(/[-*]\s+`?([\w\-./]+\.\w+)`?/g);
  for (const fm of fileMatches) {
    xml += `<file path="${escapeXml(fm[1])}" status="pending">${escapeXml(fm[1])}</file>\n`;
  }

  for (const sl of stepLines) {
    xml += sl + '\n';
  }

  xml += '</approved_plan>';

  // 超限裁剪
  if (xml.length > MAX_CHARS) {
    // 优先裁剪 file 行，保留 steps
    while (xml.length > MAX_CHARS && xml.includes('<file ')) {
      const lastFileIdx = xml.lastIndexOf('<file ');
      const endFileIdx = xml.indexOf('</file>', lastFileIdx);
      if (endFileIdx === -1) break;
      xml = xml.slice(0, lastFileIdx) + xml.slice(endFileIdx + 7);
      // 如果裁剪后还有多余换行，清理
      xml = xml.replace(/\n{2,}/g, '\n');
    }
    // 如果 still 超限，裁剪 step 描述
    if (xml.length > MAX_CHARS) {
      xml = xml.slice(0, MAX_CHARS - 20) + '\n...truncated\n</approved_plan>';
    }
  }

  return xml;
}

/** 拼接 system prompt 块：在 L2 后追加 approved_plan XML */
export function appendPlanToSystemPrompt(
  systemPrompt: string,
  planXml: string,
): string {
  if (!planXml) return systemPrompt;
  return systemPrompt.replace(/(\n*)$/, `\n${planXml}\n`);
}

// ─────────── Spec XML 格式化（P1） ───────────

/**
 * 将 SpecDocument 格式化为 `<spec>` XML 块，用于注入 system prompt。
 *
 * 格式：
 * ```xml
 * <spec feature="xxx" status="draft">
 *   <requirement>需求原文（截断至 800 字符）</requirement>
 *   <design>方案原文（截断至 800 字符）</design>
 *   <tasks>任务列表（截断至 400 字符）</tasks>
 * </spec>
 * ```
 */
export function formatSpecXml(doc: SpecDocument): string {
  const MAX_SECTION = 800;
  const MAX_TASKS = 400;

  const req = truncate(doc.requirement, MAX_SECTION);
  const design = truncate(doc.design, MAX_SECTION);
  const tasks = truncate(doc.tasks, MAX_TASKS);

  const parts: string[] = [];
  parts.push(
    `<spec feature="${escapeXml(doc.meta.feature)}" status="${escapeXml(doc.meta.status)}">`,
  );

  if (req) {
    parts.push(`  <requirement>${escapeXml(req)}</requirement>`);
  }
  if (design) {
    parts.push(`  <design>${escapeXml(design)}</design>`);
  }
  if (tasks) {
    parts.push(`  <tasks>${escapeXml(tasks)}</tasks>`);
  }

  parts.push('</spec>');

  const xml = parts.join('\n');

  // 整体超限裁剪
  if (xml.length > MAX_CHARS) {
    return xml.slice(0, MAX_CHARS - 22) + '\n...truncated\n</spec>';
  }
  return xml;
}

/**
 * 将 Spec 的任务列表格式化为精简的 checklist XML。
 * 用于注入 system prompt 让 Agent 知道当前进度。
 */
export function formatSpecTasksXml(doc: SpecDocument): string {
  if (!doc.tasks) return '';

  const lines = doc.tasks.split('\n');
  const taskItems: string[] = [];

  for (const line of lines) {
    // 匹配 `- [ ] 1. xxx` 或 `- [x] 1. xxx` 格式
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(?:\d+\.\s*)?(.+)$/);
    if (m) {
      const done = m[1] !== ' ';
      taskItems.push(
        `  <task done="${done}">${escapeXml(m[2].trim())}</task>`,
      );
    }
  }

  if (taskItems.length === 0) return '';

  return [
    `<spec_tasks feature="${escapeXml(doc.meta.feature)}">`,
    ...taskItems,
    '</spec_tasks>',
  ].join('\n');
}

/** 拼接 Spec XML 到 system prompt 末尾 */
export function appendSpecToSystemPrompt(
  systemPrompt: string,
  specXml: string,
): string {
  if (!specXml) return systemPrompt;
  return systemPrompt.replace(/(\n*)$/, `\n${specXml}\n`);
}

function truncate(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  return s.slice(0, max) + '...';
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
