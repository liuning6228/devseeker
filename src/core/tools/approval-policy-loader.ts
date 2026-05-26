/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Approval Policy Loader（v1.8.0 · DESIGN §M9.5）
 *
 * 职责：
 * - 从 `.dualmind/approval-policy.yaml` 加载审批策略配置
 * - 提供工具名匹配（通配符 *）和命令模式匹配
 * - 监听文件变更自动重载
 *
 * YAML 格式：
 * ```yaml
 * version: 1
 * defaults:
 *   read_only: auto
 *   workspace_write: auto
 *   destructive: confirm
 *   network: auto
 *   external: confirm
 * overrides:
 *   - tool: "bash"
 *     policy: confirm
 *   - tool: "write_file"
 *     args_contains: "*.env"
 *     policy: confirm
 *   - tool: "slack.*"
 *     policy: confirm
 *   - tool: "npm publish"
 *     command_match: "npm publish"
 *     command_policy: deny
 * ```
 *
 * 优先级：command_policy > tool.policy > defaults
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('approval-policy-loader');

export type ApprovalDecision = 'auto' | 'confirm' | 'deny';

/**
 * 工具级覆写规则（来自 approval-policy.yaml overrides[]）
 */
export interface ToolOverride {
  /** 工具名/通配模式（支持 * 通配） */
  tool: string;
  /** 工具级策略覆写 */
  policy?: ApprovalDecision;
  /** 命令匹配模式（仅 bash 类工具有效） */
  command_match?: string;
  /** 命令级策略覆写（匹配 command_match 时生效） */
  command_policy?: ApprovalDecision;
  /** 参数包含模式（简化版，仅检查字符串参数是否包含） */
  args_contains?: string;
}

/**
 * YAML 配置文件结构
 */
export interface ApprovalPolicyConfig {
  version: number;
  defaults?: {
    read_only?: ApprovalDecision;
    workspace_write?: ApprovalDecision;
    destructive?: ApprovalDecision;
    network?: ApprovalDecision;
    external?: ApprovalDecision;
  };
  overrides?: ToolOverride[];
}

/**
 * 工具名通配匹配。
 * "slack.*" 匹配 "slack.send_message" 等。
 */
export function matchToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolName) return true;
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    const re = new RegExp(`^${escaped}$`);
    return re.test(toolName);
  }
  return false;
}

/**
 * 命令模式匹配（借鉴 Cline shell-quote 的思路，但保持轻量正则）。
 * 支持 * 通配、精确匹配。
 */
export function matchCommandPattern(command: string, pattern: string): boolean {
  if (!command || !pattern) return false;
  if (pattern === '*') return true;
  if (pattern === command) return true;
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    const re = new RegExp(`^${escaped}$`);
    return re.test(command);
  }
  return false;
}

/**
 * 默认策略路径：<workspaceRoot>/.dualmind/approval-policy.yaml
 */
export function getDefaultPolicyPath(workspaceRoot?: string): string | undefined {
  if (!workspaceRoot) return undefined;
  return path.join(workspaceRoot, '.dualmind', 'approval-policy.yaml');
}

/**
 * 加载并解析 approval-policy.yaml。
 * 文件不存在 → 返回空配置（使用默认策略）。
 * 格式错误 → 返回空配置 + 记 warn 日志（不阻断启动）。
 */
export async function loadPolicyYaml(workspaceRoot?: string): Promise<ApprovalPolicyConfig> {
  const filePath = getDefaultPolicyPath(workspaceRoot);
  if (!filePath) return { version: 1 };

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = parseYamlCompat(raw);
    if (!parsed || typeof parsed !== 'object') {
      log.warn({ file: filePath }, 'approval-policy.yaml 解析失败：非对象');
      return { version: 1 };
    }
    return parsed as unknown as ApprovalPolicyConfig;
  } catch (e: unknown) {
    // ENOENT = 未配置，正常
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1 };
    }
    log.warn({ file: filePath, err: String(e) }, 'approval-policy.yaml 读取失败');
    return { version: 1 };
  }
}

/**
 * 简易 YAML 解析器（零依赖，避免添加 js-yaml 包）。
 * 仅支持本方案需要的子集：
 * - 顶层键值对（key: value）
 * - 嵌套缩进对象
 * - 列表（- item）
 * - 注释（#）
 * - 字符串值（不含引号转义需求）
 *
 * 完整 YAML 超出本实现范围，遇无法解析的语法返回空对象并记 warn。
 */
function parseYamlCompat(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = raw.split('\n');
  const stack: Array<{ indent: number; key: string; obj: Record<string, unknown>; isList?: boolean }> = [];
  let currentObj = result;
  let currentList: unknown[] | null = null;
  let lastListKey = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimEnd();

    // 空行/纯注释行跳过
    if (trimmed.trim() === '' || /^\s*#/.test(trimmed.trim())) continue;

    const indent = line.length - trimmed.length;

    // 从栈里弹回正确的缩进层级
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      const frame = stack.pop()!;
      if (frame.isList && stack.length > 0) {
        // 列表结束后，回到父对象
      }
    }

    // 列表项: "- key: value" 或 "- value"
    const listMatch = trimmed.trim().match(/^-\s+(.*)$/);
    if (listMatch) {
      const content = listMatch[1]!.trim();
      // 若当前上下文有列表，直接追加
      if (currentList !== null) {
        // 尝试解析键值对 "key: value"
        const kv = content.match(/^(\S+):\s*(.*)$/);
        if (kv) {
          const item: Record<string, unknown> = {};
          item[kv[1]!] = parseYamlValue(kv[2]!.trim());
          currentList.push(item);
        } else {
          currentList.push(parseYamlValue(content));
        }
      }
      continue;
    }

    // 列表定义: "key:" 然后下层有 "- item"
    // 先检测当前行是否是 "key:"
    const listDefMatch = trimmed.trim().match(/^(\S+):\s*$/);
    if (listDefMatch) {
      const key = listDefMatch[1]!;
      // 查看下一行是否是列表项
      const nextLine = i + 1 < lines.length ? lines[i + 1]!.trim() : '';
      if (nextLine.startsWith('- ')) {
        currentList = [];
        currentObj[key] = currentList;
        lastListKey = key;
        stack.push({ indent, key, obj: currentObj });
        continue;
      }
    }

    // 键值对: "key: value" 或 "key:"
    const kvMatch = trimmed.trim().match(/^(\S+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1]!;
      const value = kvMatch[2]!.trim();

      // 如果是当前对象（顶层或栈顶对象）
      if (value === '' || value === '|' || value === '>') {
        // 多行值或嵌套块标记，新建子对象
        const child: Record<string, unknown> = {};
        currentObj[key] = child;
        stack.push({ indent, key, obj: currentObj });
        currentObj = child;
        currentList = null;
      } else {
        currentObj[key] = parseYamlValue(value);
        currentList = null;
      }
    }
  }

  return result;
}

function parseYamlValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}

/**
 * 加载并解析策略文件，返回标准化的覆写规则和默认值。
 */
export async function loadApprovalPolicy(
  workspaceRoot?: string,
): Promise<{
  overrides: ToolOverride[];
  policyTable?: Partial<import('./approval-policy.js').ApprovalPolicyTable>;
}> {
  const config = await loadPolicyYaml(workspaceRoot);
  const overrides: ToolOverride[] = [];

  if (config.overrides) {
    for (const o of config.overrides) {
      if (typeof o.tool === 'string') {
        overrides.push({
          tool: o.tool,
          policy: o.policy,
          command_match: o.command_match,
          command_policy: o.command_policy,
          args_contains: o.args_contains,
        });
      }
    }
  }

  return {
    overrides,
    policyTable: config.defaults as Partial<import('./approval-policy.js').ApprovalPolicyTable> | undefined,
  };
}
