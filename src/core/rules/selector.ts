/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * RuleSelector（W4 批次 3）
 *
 * 职责：
 * - 从加载好的规则集合中筛选出需要注入 System Prompt 的规则
 * - 对比当前上下文（打开文件 / 变更文件列表）匹配 glob 规则
 * - model_decision 类型不在此处注入，仅通过 fetch_rules 工具按 name 拉取
 *
 * 输出：
 * - selectForPrompt(ctx): Rule[]  —— 按 priority 降序的 rule 列表
 * - renderForSystemPrompt(rules): string —— 拼好的 prompt 片段
 */

import { matchAnyGlob, toPosixPath } from './glob.js';
import type { Rule } from './types.js';

export interface SelectContext {
  /** 当前活动文件路径（相对工作区）；可选 */
  activeFile?: string;
  /** 最近打开/变更的文件路径列表（相对工作区）；可选 */
  recentFiles?: string[];
}

export function selectForPrompt(rules: Rule[], ctx: SelectContext = {}): Rule[] {
  const candidates: Rule[] = [];
  const filesForGlob = collectFiles(ctx);
  for (const r of rules) {
    if (r.kind === 'always_on') {
      candidates.push(r);
    } else if (r.kind === 'glob' && r.globs.length > 0 && filesForGlob.length > 0) {
      if (filesForGlob.some((f) => matchAnyGlob(r.globs, f))) {
        candidates.push(r);
      }
    }
    // model_decision 不自动注入
  }
  // §M13.6：always_on 无条件生效且稳定在前，glob 触发的规则紧随其后；
  // 同一 kind 内按 priority desc → name asc
  return candidates.sort((a, b) => {
    const kindRank = kindPriority(b.kind) - kindPriority(a.kind);
    if (kindRank !== 0) return kindRank;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.name.localeCompare(b.name);
  });
}

function kindPriority(kind: Rule['kind']): number {
  // always_on 优先（排在前面 → rank 大）
  if (kind === 'always_on') return 2;
  if (kind === 'glob') return 1;
  return 0;
}

export function renderForSystemPrompt(rules: Rule[]): string {
  if (rules.length === 0) return '';
  const blocks = rules.map((r) => {
    const header = `## Rule: ${r.name}${r.description ? ` — ${r.description}` : ''}`;
    return `${header}\n${r.content}`;
  });
  return ['# Project Rules', ...blocks].join('\n\n');
}

/** 仅列出 model_decision 规则（用于给 LLM 说明：可用 fetch_rules 按 name 拉取） */
export function listModelDecisionRules(rules: Rule[]): Array<{ name: string; description?: string }> {
  return rules
    .filter((r) => r.kind === 'model_decision')
    .map((r) => ({ name: r.name, description: r.description }));
}

function collectFiles(ctx: SelectContext): string[] {
  const out: string[] = [];
  if (ctx.activeFile) out.push(toPosixPath(ctx.activeFile));
  if (ctx.recentFiles) {
    for (const f of ctx.recentFiles) {
      const p = toPosixPath(f);
      if (!out.includes(p)) out.push(p);
    }
  }
  return out;
}
