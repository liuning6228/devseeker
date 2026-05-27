/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * RuleLoader（W4 批次 3 · W7b1 扩展）
 *
 * 职责：
 * - 扫描多层 rules 目录（DESIGN §M13.3）：
 *     global     = `~/.devseeker/rules/`（跨项目默认）
 *     workspace  = `<workspaceRoot>/.devseeker/rules/`（项目级）
 *     nested     = `<subdir>/.devseeker/rules/`（MVP 保留字段，暂未扫描）
 * - 就近覆盖：同名规则按 `nested > workspace > global` 选胜者
 * - 每个规则打上 `source` 标签，便于 UI / 调试展示
 * - 排序：按 `priority` 降序，同 priority 按 name 升序
 * - 损坏文件降级：解析失败写 `errors`，不抛出，其余规则照常加载
 *
 * 对齐 DESIGN §M13.4 的 `IRuleLoader` 接口：暴露 getAlwaysOn /
 * getForFiles / getCandidatesForModel 三方法，供 SystemPrompt
 * 注入器与 `fetch_rules` 工具取用。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseRuleFile } from './parser.js';
import type { Rule, RuleSource } from './types.js';
import { matchAnyGlob, toPosixPath } from './glob.js';

export interface LoadResult {
  rules: Rule[];
  errors: Array<{ file: string; message: string }>;
}

export interface RuleLoaderOptions {
  workspaceRoot: string | undefined;
  /** 自定义 workspace rules 目录（测试用）。默认 `<workspaceRoot>/.devseeker/rules` */
  rulesDir?: string;
  /**
   * 全局 rules 目录（DESIGN §M13.3）。默认 `~/.devseeker/rules`。
   * 传空字符串可显式关闭 global 扫描（测试用）。
   */
  globalRulesDir?: string;
}

/** 来源优先级：nested > workspace > global。数值越大越优先。 */
const SOURCE_RANK: Record<RuleSource, number> = {
  nested: 2,
  workspace: 1,
  global: 0,
};

export class RuleLoader {
  private rules: Rule[] = [];
  private errors: LoadResult['errors'] = [];
  private loaded = false;

  constructor(private readonly opts: RuleLoaderOptions) {}

  /** workspace 规则目录绝对路径；未打开工作区 + 未显式指定 dir 时返回 undefined */
  get rulesDir(): string | undefined {
    if (this.opts.rulesDir) return this.opts.rulesDir;
    if (!this.opts.workspaceRoot) return undefined;
    return path.join(this.opts.workspaceRoot, '.devseeker', 'rules');
  }

  /** global 规则目录绝对路径；传空字符串关闭 */
  get globalRulesDir(): string | undefined {
    if (this.opts.globalRulesDir === '') return undefined;
    if (this.opts.globalRulesDir) return this.opts.globalRulesDir;
    return path.join(os.homedir(), '.devseeker', 'rules');
  }

  async load(force = false): Promise<LoadResult> {
    if (this.loaded && !force) {
      return { rules: this.rules.slice(), errors: this.errors.slice() };
    }
    this.rules = [];
    this.errors = [];

    // 按源依次加载（顺序不重要，最终按 source rank 就近覆盖）
    const byName = new Map<string, Rule>();
    const globalDir = this.globalRulesDir;
    if (globalDir) {
      await this.loadFromDir(globalDir, 'global', byName);
    }
    const workspaceDir = this.rulesDir;
    if (workspaceDir) {
      await this.loadFromDir(workspaceDir, 'workspace', byName);
    }
    // nested：MVP 保留，等未来启用子目录扫描时在此处追加

    this.rules = Array.from(byName.values()).sort(compareRule);
    this.loaded = true;
    return { rules: this.rules.slice(), errors: this.errors.slice() };
  }

  list(): Rule[] {
    return this.rules.slice();
  }

  getErrors(): LoadResult['errors'] {
    return this.errors.slice();
  }

  invalidate(): void {
    this.loaded = false;
  }

  // ─────────── IRuleLoader 接口（DESIGN §M13.4） ───────────

  /**
   * 永远注入的规则，按 priority desc 排序。
   * always_on 不依赖 glob / model_decision 触发。
   */
  getAlwaysOn(): Rule[] {
    return this.rules.filter((r) => r.kind === 'always_on').sort(compareRule);
  }

  /**
   * 按文件路径匹配 glob 规则。
   * @param filePaths 相对工作区的路径列表（POSIX 风格优先；自动归一）
   */
  getForFiles(filePaths: readonly string[]): Rule[] {
    if (!filePaths.length) return [];
    const normalized = filePaths.map((f) => toPosixPath(f));
    return this.rules
      .filter(
        (r) => r.kind === 'glob' && r.globs.length > 0 && normalized.some((f) => matchAnyGlob(r.globs, f)),
      )
      .sort(compareRule);
  }

  /** model_decision 规则清单，供 fetch_rules / SystemPrompt 列出"可按需加载" */
  getCandidatesForModel(): Rule[] {
    return this.rules.filter((r) => r.kind === 'model_decision').sort(compareRule);
  }

  // ─────────── 内部 ───────────

  private async loadFromDir(
    dir: string,
    source: RuleSource,
    byName: Map<string, Rule>,
  ): Promise<void> {
    try {
      await fs.access(dir);
    } catch {
      return; // 目录不存在：跳过
    }
    const files = await collectMdFiles(dir);
    for (const f of files) {
      let raw: string;
      try {
        raw = await fs.readFile(f, 'utf8');
      } catch (e) {
        this.errors.push({ file: f, message: `read failed: ${String(e)}` });
        continue;
      }
      const { rule, error } = parseRuleFile(f, raw, source);
      if (error || !rule) {
        this.errors.push({ file: f, message: error ?? 'unknown parse error' });
        continue;
      }
      const existing = byName.get(rule.name);
      if (!existing) {
        byName.set(rule.name, rule);
        continue;
      }
      // 就近覆盖：source rank 高的胜；同 source 时 priority 高的胜；再同则后来者胜
      const incomingRank = SOURCE_RANK[rule.source];
      const existingRank = SOURCE_RANK[existing.source];
      if (incomingRank > existingRank) {
        byName.set(rule.name, rule);
      } else if (incomingRank === existingRank && rule.priority > existing.priority) {
        byName.set(rule.name, rule);
      }
    }
  }
}

// ─────────── helpers ───────────

async function collectMdFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && /\.mdx?$/i.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function compareRule(a: Rule, b: Rule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.name.localeCompare(b.name);
}
