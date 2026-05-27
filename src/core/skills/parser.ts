/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * SKILL.md 解析器（W4 批次 4）
 *
 * 解析方式同 rules parser：YAML-lite frontmatter + markdown body。
 * - 缺失 frontmatter → description 为空串，content 为全文
 * - name 缺失时由路径派生（目录名优先；单文件 skill 取文件名）
 */

import * as path from 'node:path';
import type { Skill, SkillParseResult, SkillFrontmatter } from './types.js';

const FM_DELIM_RE = /^---\s*$/;

export function parseSkillFile(filePath: string, raw: string): SkillParseResult {
  const { frontmatter, body } = splitFrontmatter(raw);
  let fm: SkillFrontmatter = {};
  if (frontmatter !== undefined) {
    const parsed = parseYamlLite(frontmatter);
    if (parsed.error) return { error: parsed.error };
    fm = parsed.value;
  }

  const content = body.trim();
  if (!content) {
    return { error: `Skill body is empty: ${filePath}` };
  }

  const name = deriveName(fm.name, filePath);
  if (!name) {
    return { error: `Skill name missing and could not be derived from path: ${filePath}` };
  }

  const skill: Skill = {
    name,
    description: (fm.description ?? '').trim(),
    argumentsHint: fm.arguments?.trim() || undefined,
    content,
    filePath,
  };
  return { skill };
}

// ─────────── helpers (duplicated from rules parser to keep modules independent) ───────────

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

function parseYamlLite(text: string): { value: SkillFrontmatter; error?: string } {
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
  return { value: out as SkillFrontmatter };
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
  // 通常形如 .devseeker/skills/<skill-name>/SKILL.md → 取父目录名
  if (/^skill\.mdx?$/i.test(base)) {
    const parent = path.basename(path.dirname(filePath));
    if (parent && parent !== '.' && parent !== 'skills') return parent;
  }
  // 回退：文件名去扩展
  return base.replace(/\.mdx?$/i, '');
}
