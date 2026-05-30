/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Skills 子系统类型定义（W4 批次 4）
 *
 * 对齐   Skills：
 * - 每个 skill 一个目录：`.devseeker/skills/<skill-name>/SKILL.md`
 * - SKILL.md 带 frontmatter（name / description / arguments 提示）
 * - 正文是给 LLM 的任务指令模板
 * - 调用方式：LLM 调用 `skill(name, args?)` 工具 → 工具把 SKILL.md 正文 + args 作为结果返回
 */

export interface SkillFrontmatter {
  /** 可选：唯一名。缺省从目录名/文件名派生 */
  name?: string;
  /** 一句话描述，展示给模型用以判断何时调用 */
  description?: string;
  /**
   * arguments 用法示例或语法描述；仅用于展示，工具本身不约束 args 结构
   * 例如：'<pr-number>' / 'topic: 要评审的主题'
   */
  arguments?: string;
}

export interface Skill {
  /** 唯一 name */
  name: string;
  description: string;
  /** arguments 示例/说明；未提供时为 undefined */
  argumentsHint?: string;
  /** SKILL.md 正文（不含 frontmatter），作为给 LLM 的任务指令 */
  content: string;
  /** 来源文件绝对路径 */
  filePath: string;
}

export interface SkillParseResult {
  skill?: Skill;
  error?: string;
}
