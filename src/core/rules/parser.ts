/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Rule Markdown 解析器（W4 批次 3）
 *
 * 支持 YAML-lite frontmatter（`---` 分隔），只支持扁平标量 + 字符串数组：
 *   ---
 *   name: typescript-style
 *   kind: glob
 *   glob: ["**\u002a/*.ts", "**\u002a/*.tsx"]
 *   priority: 10
 *   description: TypeScript 编码风格
 *   ---
 *   # TypeScript 代码风格
 *   ...
 *
 * 缺失 frontmatter 时：全文作为 content，默认 kind='always_on'，name 由 path 推断。
 */

import * as path from 'node:path';
import type { Rule, RuleFrontmatter, RuleKind, RuleParseResult, RuleSource } from './types.js';

const FM_DELIM_RE = /^---\s*$/;

export function parseRuleFile(
  filePath: string,
  raw: string,
  source: RuleSource = 'workspace',
): RuleParseResult {
  const { frontmatter, body } = splitFrontmatter(raw);
  let fm: RuleFrontmatter = {};
  if (frontmatter !== undefined) {
    const parsed = parseYamlLite(frontmatter);
    if (parsed.error) return { error: parsed.error };
    fm = parsed.value;
  }

  const name = deriveName(fm.name, filePath);
  const kind = normalizeKind(fm.kind);
  if (kind === null) {
    return { error: `Unknown rule kind: ${String(fm.kind)} (allowed: always_on / glob / model_decision)` };
  }

  const globs = normalizeGlobs(fm.glob);
  if (kind === 'glob' && globs.length === 0) {
    return { error: `kind='glob' requires at least one glob pattern` };
  }

  const priority = Number.isFinite(fm.priority) ? Number(fm.priority) : 0;

  const rule: Rule = {
    name,
    kind,
    description: fm.description?.trim() || undefined,
    globs,
    priority,
    content: body.trim(),
    filePath,
    source,
  };
  return { rule };
}

// ─────────── frontmatter 切分 ───────────

function splitFrontmatter(raw: string): { frontmatter?: string; body: string } {
  const lines = raw.split(/\r?\n/);
  // 允许文件开头有 BOM / 空行
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || !FM_DELIM_RE.test(lines[i])) {
    return { body: raw };
  }
  const start = i + 1;
  let end = -1;
  for (let j = start; j < lines.length; j++) {
    if (FM_DELIM_RE.test(lines[j])) {
      end = j;
      break;
    }
  }
  if (end === -1) return { body: raw };
  const frontmatter = lines.slice(start, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  return { frontmatter, body };
}

// ─────────── YAML-lite 解析 ───────────
// 仅支持：标量字符串 / 数字 / bool；`key: [v1, v2]` 数组字面量

function parseYamlLite(text: string): { value: RuleFrontmatter; error?: string } {
  const out: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      return { value: {}, error: `Invalid frontmatter line: ${raw}` };
    }
    const [, key, rawValue] = m;
    out[key] = parseScalar(rawValue.trim());
  }
  return { value: out as RuleFrontmatter };
}

function parseScalar(v: string): unknown {
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  // 数组字面量
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => stripQuotes(s.trim()));
  }
  // 数字
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  // 带引号字符串
  return stripQuotes(v);
}

function stripQuotes(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

// ─────────── 派生 / 归一化 ───────────

function deriveName(explicit: string | undefined, filePath: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const base = path.basename(filePath);
  return base.replace(/\.md$/i, '').replace(/\.mdx$/i, '');
}

function normalizeKind(input: unknown): RuleKind | null {
  if (input === undefined || input === null || input === '') return 'always_on';
  if (typeof input !== 'string') return null;
  const v = input.trim();
  if (v === 'always_on' || v === 'glob' || v === 'model_decision') return v;
  return null;
}

function normalizeGlobs(input: unknown): string[] {
  if (input === undefined || input === null || input === '') return [];
  if (Array.isArray(input)) {
    return input.map((s) => String(s).trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return [];
    // 允许逗号分隔
    return s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [];
}
