/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * SkillLoader（W4 批次 4）
 *
 * 职责：
 * - 扫描 `<workspaceRoot>/.dualmind/skills/` 下的 SKILL.md
 *   - 推荐：`.dualmind/skills/<skill-name>/SKILL.md`
 *   - 兼容：`.dualmind/skills/<any>.md`（仅一级，name 取文件名）
 * - 按 name 去重（同名后加载覆盖）
 * - 排序：name 升序
 * - 解析失败降级写 errors，不抛
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseSkillFile } from './parser.js';
import type { Skill } from './types.js';

export interface SkillLoadResult {
  skills: Skill[];
  errors: Array<{ file: string; message: string }>;
}

export interface SkillLoaderOptions {
  workspaceRoot: string | undefined;
  /** 自定义 skills 根目录（测试用）。默认 `<workspaceRoot>/.dualmind/skills` */
  skillsDir?: string;
  /**
   * 内置种子 skills（W8.7）。
   * 加载顺序：builtin 先入化 → workspace `.dualmind/skills/` 后覆盖同名。
   * 留空数组 / undefined 表示不注入 builtin（向后兼容 W4 行为）。
   */
  builtinSkills?: readonly Skill[];
}

export class SkillLoader {
  private skills: Skill[] = [];
  private errors: SkillLoadResult['errors'] = [];
  private loaded = false;

  constructor(private readonly opts: SkillLoaderOptions) {}

  get skillsDir(): string | undefined {
    if (this.opts.skillsDir) return this.opts.skillsDir;
    if (!this.opts.workspaceRoot) return undefined;
    return path.join(this.opts.workspaceRoot, '.dualmind', 'skills');
  }

  async load(force = false): Promise<SkillLoadResult> {
    if (this.loaded && !force) {
      return { skills: this.skills.slice(), errors: this.errors.slice() };
    }
    this.skills = [];
    this.errors = [];
    const byName = new Map<string, Skill>();

    // 1) 内置种子 skills 先入化（W8.7）
    for (const s of this.opts.builtinSkills ?? []) {
      byName.set(s.name, s);
    }

    const dir = this.skillsDir;
    if (!dir) {
      this.skills = Array.from(byName.values()).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      this.loaded = true;
      return { skills: this.skills.slice(), errors: [] };
    }
    try {
      await fs.access(dir);
    } catch {
      // workspace skills 目录不存在 → 只保留 builtin
      this.skills = Array.from(byName.values()).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      this.loaded = true;
      return { skills: this.skills.slice(), errors: [] };
    }

    // 2) workspace skills 后入，同名覆盖 builtin
    const files = await collectSkillFiles(dir);
    for (const f of files) {
      let raw: string;
      try {
        raw = await fs.readFile(f, 'utf8');
      } catch (e) {
        this.errors.push({ file: f, message: `read failed: ${String(e)}` });
        continue;
      }
      const { skill, error } = parseSkillFile(f, raw);
      if (error || !skill) {
        this.errors.push({ file: f, message: error ?? 'unknown parse error' });
        continue;
      }
      byName.set(skill.name, skill);
    }
    this.skills = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    this.loaded = true;
    return { skills: this.skills.slice(), errors: this.errors.slice() };
  }

  list(): Skill[] {
    return this.skills.slice();
  }

  findByName(name: string): Skill | undefined {
    return this.skills.find((s) => s.name === name);
  }

  getErrors(): SkillLoadResult['errors'] {
    return this.errors.slice();
  }

  invalidate(): void {
    this.loaded = false;
  }
}

// ─────────── helpers ───────────

async function collectSkillFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // 子目录：查找 SKILL.md / SKILL.mdx
      try {
        const kids = await fs.readdir(full, { withFileTypes: true });
        for (const k of kids) {
          if (k.isFile() && /^skill\.mdx?$/i.test(k.name)) {
            out.push(path.join(full, k.name));
          }
        }
      } catch {
        /* ignore unreadable subdir */
      }
    } else if (e.isFile() && /\.mdx?$/i.test(e.name)) {
      // 兼容扁平布局：.dualmind/skills/<name>.md
      out.push(full);
    }
  }
  return out.sort();
}
