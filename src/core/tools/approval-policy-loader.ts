/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Approval Policy Loader（v1.8.0 · DESIGN §M9.5）
 *
 * 职责：
 * - 从 `.devseeker/approval-policy.yaml` 加载审批策略配置
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
  /** 命令安全级别限定：仅命令被 classifyCommand 归为该级别时本覆写生效（如「safe 命令自动放行」） */
  command_safety?: 'safe' | 'risky';
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
 * 默认策略路径：<workspaceRoot>/.devseeker/approval-policy.yaml
 */
export function getDefaultPolicyPath(workspaceRoot?: string): string | undefined {
  if (!workspaceRoot) return undefined;
  return path.join(workspaceRoot, '.devseeker', 'approval-policy.yaml');
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

  let lastListItem: Record<string, unknown> | null = null;
  let lastListItemIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimEnd();
    // 去除行首空白便于匹配；indent 必须按行首缩进计算
    // （原实现用 trimEnd 求缩进会把所有缩进行都判成 0，嵌套结构永远解析失败）
    const content = trimmed.trimStart();

    // 空行/纯注释行跳过
    if (content === '' || content.startsWith('#')) continue;

    const indent = trimmed.length - content.length;

    // 从栈里弹回正确的缩进层级（恢复父对象，嵌套对象结束后顶层键必须写回根对象）
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      const frame = stack.pop()!;
      currentObj = frame.obj;
      if (frame.key === lastListKey && frame.isList) {
        // 列表层级结束，后续缩进键值行不再并入列表项
        lastListItem = null;
        lastListItemIndent = -1;
      }
    }

    // 列表项: "- key: value" 或 "- value"
    const listMatch = content.match(/^-\s+(.*)$/);
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
          lastListItem = item;
          lastListItemIndent = indent;
        } else {
          currentList.push(parseYamlValue(content));
          lastListItem = null;
          lastListItemIndent = -1;
        }
      }
      continue;
    }

    // 列表定义: "key:" 然后下层有 "- item"
    // 先检测当前行是否是 "key:"
    const listDefMatch = content.match(/^(\S+):\s*$/);
    if (listDefMatch) {
      const key = listDefMatch[1]!;
      // 向下扫描（跳过空行/注释行）找下一内容行，判断是否列表项：
      // 否则 "overrides:" 后跟注释再跟 "- item" 会被误判为嵌套对象，列表项静默丢弃
      let j = i + 1;
      let nextContent = '';
      while (j < lines.length) {
        const c = lines[j]!.trim();
        if (c !== '' && !c.startsWith('#')) {
          nextContent = c;
          break;
        }
        j++;
      }
      if (nextContent.startsWith('- ')) {
        currentList = [];
        currentObj[key] = currentList;
        lastListKey = key;
        stack.push({ indent, key, obj: currentObj, isList: true });
        continue;
      }
    }

    // 键值对: "key: value" 或 "key:"
    const kvMatch = content.match(/^(\S+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1]!;
      const value = kvMatch[2]!.trim();

      // 列表项的续行键（缩进大于列表头且当前列表已弹出结束）：并入最后列表项对象
      if (lastListItem !== null && indent > lastListItemIndent && value !== '') {
        lastListItem[key] = parseYamlValue(value);
        continue;
      }

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
  // 双引号字符串（YAML 标准语义："./script.sh" 不含引号参与匹配）
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
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
          command_safety: o.command_safety,
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

/**
 * 设置页写回补丁：只包含 UI 管理的字段。
 * - defaults：read_only / workspace_write / network（destructive / external 由 yaml 保留原值）
 * - bashRead / bashWrite：映射为 bash 工具 + command_safety 命令级覆写
 */
export interface ApprovalPolicyWritePatch {
  defaults?: Partial<import('./approval-policy.js').ApprovalPolicyTable>;
  /** 命令安全级别 safe → auto（bash 只读命令自动执行）；undefined = 保留 yaml 现状 */
  bashRead?: boolean;
  /** 命令安全级别 risky → auto（bash 写命令自动执行）；undefined = 保留 yaml 现状 */
  bashWrite?: boolean;
}

/**
 * 序列化策略配置为 YAML（与 parseYamlCompat 子集互逆）。
 * 自动生成的 bash command_safety 规则与手写规则混合时可安全 round-trip。
 */
function serializePolicyYaml(config: ApprovalPolicyConfig): string {
  const lines: string[] = [
    '# DevSeeker 审批策略（设置页「审批」自动维护，可手工编辑）',
    '# 优先级：blacklisted deny > has_risk confirm > command_safety 覆写 > 工具覆写 > defaults',
    '# 命令级覆写示例：',
    '# overrides:',
    '#   - tool: bash',
    '#     command_safety: risky',
    '#     command_policy: auto',
    `version: ${config.version ?? 1}`,
  ];
  const defaults = config.defaults ?? {};
  const defaultKeys: Array<keyof NonNullable<ApprovalPolicyConfig['defaults']>> = [
    'read_only',
    'workspace_write',
    'destructive',
    'network',
    'external',
  ];
  const hasDefaults = defaultKeys.some((k) => defaults[k] !== undefined);
  if (hasDefaults) {
    lines.push('defaults:');
    for (const k of defaultKeys) {
      if (defaults[k] !== undefined) lines.push(`  ${k}: ${String(defaults[k])}`);
    }
  }
  if (config.overrides && config.overrides.length > 0) {
    lines.push('overrides:');
    for (const o of config.overrides) {
      lines.push(`  - tool: ${o.tool}`);
      if (o.command_safety) lines.push(`    command_safety: ${o.command_safety}`);
      if (o.command_match) lines.push(`    command_match: ${o.command_match}`);
      if (o.command_policy) lines.push(`    command_policy: ${o.command_policy}`);
      if (o.policy) lines.push(`    policy: ${o.policy}`);
      if (o.args_contains) lines.push(`    args_contains: ${o.args_contains}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * 将设置页补丁写回 .devseeker/approval-policy.yaml。
 * 保留 version 与手写 overrides（仅替换 UI 管理的 defaults 字段与 bash command_safety 规则）。
 */
export async function writeApprovalPolicy(
  workspaceRoot: string | undefined,
  patch: ApprovalPolicyWritePatch,
): Promise<void> {
  const filePath = getDefaultPolicyPath(workspaceRoot);
  if (!filePath) {
    throw new Error('未打开工作区，无法保存审批策略');
  }

  const existing = await loadPolicyYaml(workspaceRoot);
  const defaults = { ...(existing.defaults ?? {}), ...(patch.defaults ?? {}) };
  // 仅整体替换 UI 自动生成的 bash command_safety 规则
  // （tool=bash + command_safety + command_policy=auto 且无其余匹配字段）；
  // 手写规则（含 command_safety 配 deny/confirm、带 command_match/args_contains 的组合规则）保留
  const isUiBashRule = (o: ToolOverride): boolean =>
    o.tool === 'bash' &&
    o.command_safety !== undefined &&
    o.command_policy === 'auto' &&
    !o.command_match &&
    !o.args_contains &&
    !o.policy;
  // 三态语义：undefined = 未指定（保留 yaml 现状）。UI 单次点击只携带变更字段，
  // 若按 falsy 处理会连带删除另一侧规则，造成 bash 读/写开关互斥的表象
  const existingOverrides = existing.overrides ?? [];
  const prevBashRead = existingOverrides.some((o) => isUiBashRule(o) && o.command_safety === 'safe');
  const prevBashWrite = existingOverrides.some((o) => isUiBashRule(o) && o.command_safety === 'risky');
  const overrides = existingOverrides.filter((o) => !isUiBashRule(o));
  const bashRead = patch.bashRead ?? prevBashRead;
  const bashWrite = patch.bashWrite ?? prevBashWrite;
  if (bashRead) {
    overrides.push({ tool: 'bash', command_safety: 'safe', command_policy: 'auto' });
  }
  if (bashWrite) {
    overrides.push({ tool: 'bash', command_safety: 'risky', command_policy: 'auto' });
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, serializePolicyYaml({ version: existing.version ?? 1, defaults, overrides }), 'utf8');
  log.info({ file: filePath, patch }, 'approval-policy.yaml updated');
}
