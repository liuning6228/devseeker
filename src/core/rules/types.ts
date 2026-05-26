/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Rules 子系统类型定义（W4 批次 3）
 *
 * 对齐 Qoder rules：
 * - always_on：每次都注入 system prompt
 * - glob：按当前打开文件/变更文件的 glob 匹配触发
 * - model_decision：仅通过 fetch_rules 工具显式按 name 拉取
 */

export type RuleKind = 'always_on' | 'glob' | 'model_decision';

/**
 * 规则来源（DESIGN §M13.3）。
 * - `global`：`~/.dualmind/rules/`（跨项目默认规则）
 * - `workspace`：`<workspaceRoot>/.dualmind/rules/`（项目级）
 * - `nested`：子目录（如 monorepo 的 package）自带的 `.dualmind/rules/`（MVP 保留字段，暂未扫描）
 *
 * 同名规则按 `nested > workspace > global` 就近覆盖。
 */
export type RuleSource = 'global' | 'workspace' | 'nested';

export interface RuleFrontmatter {
  /** 可选：唯一名。缺省从文件名派生（去扩展名） */
  name?: string;
  /** 类型：默认 always_on */
  kind?: RuleKind;
  /** 一句话描述，model_decision 类型展示给模型用 */
  description?: string;
  /** kind='glob' 时的匹配模式列表；单字符串自动包装为数组 */
  glob?: string | string[];
  /** 优先级：数字越大越靠前；默认 0 */
  priority?: number;
}

export interface Rule {
  /** 规则唯一 name（名字冲突时后加载覆盖） */
  name: string;
  kind: RuleKind;
  description?: string;
  /** kind === 'glob' 时的模式列表 */
  globs: string[];
  priority: number;
  /** markdown 正文（不含 frontmatter） */
  content: string;
  /** 来源文件绝对路径（调试用） */
  filePath: string;
  /** 来源层级（§M13.3 多层继承） */
  source: RuleSource;
}

export interface RuleParseResult {
  rule?: Rule;
  error?: string;
}
