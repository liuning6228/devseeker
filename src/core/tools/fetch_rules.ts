/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * fetch_rules 工具（W4 批次 3）
 *
 * 职责：按 name 数组拉取 model_decision 或任意规则全文。
 * - 只读工具
 * - 找不到的 name 逐条报 missing（不影响找到的输出）
 * - 默认只允许拉取 kind='model_decision' 的规则；include_all=true 放宽到任意 kind（调试用）
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { RuleLoader, Rule } from '../rules/index.js';
import { ErrorCodes } from '../errors/index.js';

export interface FetchRulesArgs {
  rule_names: string[];
  include_all?: boolean;
}

const parameters = {
  type: 'object',
  properties: {
    rule_names: {
      type: 'array',
      items: { type: 'string' },
      description: '要拉取的规则 name 列表；来自 System Prompt 中 model_decision 规则清单。',
    },
    include_all: {
      type: 'boolean',
      description: '是否允许拉取任意 kind 的规则（默认仅允许 model_decision）。',
    },
  },
  required: ['rule_names'],
  additionalProperties: false,
} as const;

export interface FetchRulesDeps {
  getLoader(): RuleLoader | undefined;
}

export class FetchRulesTool implements ITool<FetchRulesArgs, ToolResult> {
  readonly name = 'fetch_rules';
  readonly description =
    '按 name 拉取 project rules 的完整内容。默认仅允许 kind=model_decision 的规则（由 System Prompt 中规则清单公布）。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: FetchRulesDeps) {}

  async execute(args: FetchRulesArgs, _ctx: ToolContext): Promise<ToolResult> {
    if (!args || !Array.isArray(args.rule_names) || args.rule_names.length === 0) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'rule_names 必须为非空字符串数组');
    }
    const loader = this.deps.getLoader();
    if (!loader) {
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, 'RuleLoader 未就绪（未打开工作区？）');
    }
    await loader.load();
    const all = loader.list();
    const byName = new Map(all.map((r) => [r.name, r]));

    const includeAll = args.include_all === true;
    const hits: Rule[] = [];
    const missing: string[] = [];
    const forbidden: string[] = [];

    for (const raw of args.rule_names) {
      const name = String(raw).trim();
      if (!name) continue;
      const r = byName.get(name);
      if (!r) {
        missing.push(name);
        continue;
      }
      if (!includeAll && r.kind !== 'model_decision') {
        forbidden.push(name);
        continue;
      }
      hits.push(r);
    }

    const content = formatHits(hits, missing, forbidden);
    return {
      ok: true,
      content,
      display: {
        hits: hits.map((r) => ({ name: r.name, kind: r.kind, description: r.description })),
        missing,
        forbidden,
      },
    };
  }
}

// ─────────── helpers ───────────

function formatHits(hits: Rule[], missing: string[], forbidden: string[]): string {
  const lines: string[] = [];
  lines.push(`Fetched ${hits.length} rule(s); missing=${missing.length}; forbidden=${forbidden.length}`);
  if (missing.length) lines.push(`  missing: ${missing.join(', ')}`);
  if (forbidden.length)
    lines.push(`  forbidden (non-model_decision, set include_all=true to override): ${forbidden.join(', ')}`);
  lines.push('');
  for (const r of hits) {
    lines.push(`## ${r.name}  [kind=${r.kind}${r.description ? `, ${r.description}` : ''}]`);
    lines.push('```md');
    lines.push(r.content);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
