/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Custom agents 子系统类型定义（W14.4）
 *
 * 对齐 Skills 的目录布局与 parser 风格，但落地为 SubagentDefinition：
 *   `.devseeker/agents/<agent-name>/AGENT.md`
 *
 * AGENT.md frontmatter：
 *   name          可选，缺省取目录名
 *   description   一句话描述，给主 Agent 判断何时调起子代理
 *   tools         逗号分隔的工具 name 白名单（若缺省，使用默认只读子集）
 *   max_turns     整数，默认 15
 *
 * Body：子代理的 systemPrompt（不含主 Agent 的 rules/skills/memory）。
 */

export interface AgentFrontmatter {
  /** 可选：唯一名。缺省从目录名/文件名派生 */
  name?: string;
  /** 一句话描述 */
  description?: string;
  /** 逗号分隔的工具白名单（例如 "read_file, list_dir, search_codebase"） */
  tools?: string;
  /** 整数最大轮次，默认 15 */
  max_turns?: number;
}

export interface ParsedCustomAgent {
  /** slug（== 来源目录名），即 subagent_type */
  name: string;
  description: string;
  /** 解析后的工具白名单；若 frontmatter.tools 缺省则为 undefined，由 loader 注入默认值 */
  toolNames?: readonly string[];
  maxTurns?: number;
  /** AGENT.md 正文（即 systemPrompt） */
  systemPrompt: string;
  /** 来源文件绝对路径 */
  filePath: string;
}

export interface AgentParseResult {
  agent?: ParsedCustomAgent;
  error?: string;
}
