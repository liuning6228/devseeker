/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * AGENT.md 解析器（W14.4）
 *
 * 解析方式同 skills parser：YAML-lite frontmatter + markdown body。
 * 缺失 frontmatter → description / tools / max_turns 全部留空；body 作为 systemPrompt。
 */

import * as path from 'node:path';
import type { AgentFrontmatter, AgentParseResult, ParsedCustomAgent } from './types.js';

const FM_DELIM_RE = /^---\s*$/;

export function parseAgentFile(filePath: string, raw: string): AgentParseResult {
  const { frontmatter, body } = splitFrontmatter(raw);
  let fm: AgentFrontmatter = {};
  if (frontmatter !== undefined) {
    const parsed = parseYamlLite(frontmatter);
    if (parsed.error) return { error: parsed.error };
    fm = parsed.value;
  }

  const systemPrompt = body.trim();
  if (!systemPrompt) {
    return { error: `Agent body is empty: ${filePath}` };
  }

  const name = deriveName(fm.name, filePath);
  if (!name) {
    return { error: `Agent name missing and could not be derived from path: ${filePath}` };
  }

  const description = (fm.description ?? '').trim();
  const toolNames = fm.tools ? parseToolList(fm.tools) : undefined;
  const maxTurns =
    typeof fm.max_turns === 'number' && Number.isFinite(fm.max_turns) && fm.max_turns > 0
      ? Math.floor(fm.max_turns)
      : undefined;

  const agent: ParsedCustomAgent = {
    name,
    description,
    systemPrompt,
    filePath,
    ...(toolNames ? { toolNames } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
  return { agent };
}

// ─────────── helpers ───────────

function splitFrontmatter(raw: string): { frontmatter?: string; body: string } {
  const lines = raw.split(/\r?\n/);
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
  return {
    frontmatter: lines.slice(start, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
  };
}

function parseYamlLite(text: string): { value: AgentFrontmatter; error?: string } {
  const out: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      return { value: {}, error: `Invalid frontmatter line: ${raw}` };
    }
    out[m[1]] = parseScalar(m[2].trim());
  }
  return { value: out as AgentFrontmatter };
}

function parseScalar(v: string): unknown {
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.length >= 2) {
    const f = v[0];
    const l = v[v.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) return v.slice(1, -1);
  }
  return v;
}

function deriveName(explicit: string | undefined, filePath: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const base = path.basename(filePath);
  // 通常形如 .dualmind/agents/<agent-name>/AGENT.md → 取父目录名
  if (/^agent\.mdx?$/i.test(base)) {
    const parent = path.basename(path.dirname(filePath));
    if (parent && parent !== '.' && parent !== 'agents') return parent;
  }
  // 回退：文件名去扩展
  return base.replace(/\.mdx?$/i, '');
}

/**
 * 解析 `tools` frontmatter：逗号（或分号 / 空白）分隔成 name[]。
 * 保留空数组（用户明确"无任何工具"），loader 侧若为 undefined 才注入默认。
 */
export function parseToolList(raw: string): readonly string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
