/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * AgentLoader（W14.4）
 *
 * 职责：
 * - 扫描 `<workspaceRoot>/.devseeker/agents/` 下的 AGENT.md
 *   - 推荐：`.devseeker/agents/<agent-name>/AGENT.md`
 *   - 兼容：`.devseeker/agents/<any>.md`（仅一级，name 取文件名）
 * - 按 name 去重（同名后加载覆盖）
 * - 排序：name 升序
 * - 解析失败降级写 errors，不抛
 * - 内置 4 种 subagent type 为 reserved name：自定义 agent 同名 → 被过滤并记录错误
 * - 输出 SubagentDefinition[]，可直接喂给 createSubagentRegistry()
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseAgentFile } from './parser.js';
import type { ParsedCustomAgent } from './types.js';
import type { SubagentDefinition } from '../subagent/types.js';
import { ALL_BUILTIN_SUBAGENT_TYPES } from '../subagent/types.js';
import { WORKSPACE_DIR_NAME } from '../constants.js';

/**
 * 自定义 agent 缺省允许的工具白名单（只读 + 查询，不含 bash / write）。
 * 用户可在 frontmatter.tools 显式扩展或收窄。
 */
export const DEFAULT_CUSTOM_AGENT_TOOLS: readonly string[] = [
  'read_file',
  'list_dir',
  'search_codebase',
  'search_knowledge',
  'fetch_content',
  'read_url',
];

/** 自定义 agent 缺省 maxTurns（与 Browser/Guide 同档） */
export const DEFAULT_CUSTOM_AGENT_MAX_TURNS = 15;

export interface AgentLoadResult {
  agents: SubagentDefinition[];
  errors: Array<{ file: string; message: string }>;
}

export interface AgentLoaderOptions {
  workspaceRoot: string | undefined;
  /** 自定义 agents 根目录（测试用）。默认 `<workspaceRoot>/.devseeker/agents` */
  agentsDir?: string;
  /** 允许用户显式覆盖默认工具白名单（一般不需要） */
  defaultTools?: readonly string[];
}

export class AgentLoader {
  private agents: SubagentDefinition[] = [];
  private errors: AgentLoadResult['errors'] = [];
  private loaded = false;

  constructor(private readonly opts: AgentLoaderOptions) {}

  get agentsDir(): string | undefined {
    if (this.opts.agentsDir) return this.opts.agentsDir;
    if (!this.opts.workspaceRoot) return undefined;
    return path.join(this.opts.workspaceRoot, WORKSPACE_DIR_NAME, 'agents');
  }

  async load(force = false): Promise<AgentLoadResult> {
    if (this.loaded && !force) {
      return { agents: this.agents.slice(), errors: this.errors.slice() };
    }
    this.agents = [];
    this.errors = [];

    const dir = this.agentsDir;
    if (!dir) {
      this.loaded = true;
      return { agents: [], errors: [] };
    }
    try {
      await fs.access(dir);
    } catch {
      this.loaded = true;
      return { agents: [], errors: [] };
    }

    const files = await collectAgentFiles(dir);
    const byName = new Map<string, SubagentDefinition>();
    const reserved = new Set<string>(ALL_BUILTIN_SUBAGENT_TYPES);
    const defaults = this.opts.defaultTools ?? DEFAULT_CUSTOM_AGENT_TOOLS;

    for (const f of files) {
      let raw: string;
      try {
        raw = await fs.readFile(f, 'utf8');
      } catch (e) {
        this.errors.push({ file: f, message: `read failed: ${String(e)}` });
        continue;
      }
      const { agent, error } = parseAgentFile(f, raw);
      if (error || !agent) {
        this.errors.push({ file: f, message: error ?? 'unknown parse error' });
        continue;
      }
      if (reserved.has(agent.name)) {
        this.errors.push({
          file: f,
          message: `agent name "${agent.name}" 与内置 subagent 冲突，已忽略`,
        });
        continue;
      }
      byName.set(agent.name, toSubagentDefinition(agent, defaults));
    }

    this.agents = Array.from(byName.values()).sort((a, b) => a.type.localeCompare(b.type));
    this.loaded = true;
    return { agents: this.agents.slice(), errors: this.errors.slice() };
  }

  list(): SubagentDefinition[] {
    return this.agents.slice();
  }

  findByName(name: string): SubagentDefinition | undefined {
    return this.agents.find((a) => a.type === name);
  }

  getErrors(): AgentLoadResult['errors'] {
    return this.errors.slice();
  }

  invalidate(): void {
    this.loaded = false;
  }
}

// ─────────── helpers ───────────

export function toSubagentDefinition(
  parsed: ParsedCustomAgent,
  defaultTools: readonly string[],
): SubagentDefinition {
  const tools = parsed.toolNames ?? defaultTools;
  return {
    type: parsed.name,
    allowedTools: new Set<string>(tools),
    systemPrompt: parsed.systemPrompt,
    maxTurns: parsed.maxTurns ?? DEFAULT_CUSTOM_AGENT_MAX_TURNS,
    description: parsed.description || undefined,
    isBuiltin: false,
    filePath: parsed.filePath,
  };
}

async function collectAgentFiles(dir: string): Promise<string[]> {
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
      try {
        const kids = await fs.readdir(full, { withFileTypes: true });
        for (const k of kids) {
          if (k.isFile() && /^agent\.mdx?$/i.test(k.name)) {
            out.push(path.join(full, k.name));
          }
        }
      } catch {
        /* ignore unreadable subdir */
      }
    } else if (e.isFile() && /\.mdx?$/i.test(e.name)) {
      out.push(full);
    }
  }
  return out.sort();
}
