/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Toolset 引擎 —— 输入 toolsets 名列表 → 白名单 Set
 *
 * 职责：
 * 1. 接收 ToolsetName[] → 展开为工具白名单 Set
 * 2. `all` 通配符：返回通配标记（调用方替换为全部工具）
 * 3. 去重：重复工具名只出现一次
 * 4. 未知 toolset throw：不做静默忽略
 *
 * DESIGN-1.md §4.2 · §5 Phase A Step 2
 */

import type { ToolsetName } from './types.js';
import { TOOLSETS, DELEGATE_BLOCKED_TOOLS } from './types.js';

/** 通配符结果标记 */
export const WILDCARD_ALL = ['*'] as const;

/**
 * 解析 toolsets 列表为白名单。
 *
 * @param names - toolsets 名列表
 * @returns 工具名 Set（已去重）
 * @throws 若包含未知 toolset 名
 */
export function resolveToolsets(names: ToolsetName[]): Set<string> {
  if (!Array.isArray(names) || names.length === 0) {
    throw new TypeError('resolveToolsets: names must be a non-empty array');
  }

  const result = new Set<string>();

  for (const name of names) {
    const tools = TOOLSETS[name];
    if (!tools) {
      const known = Object.keys(TOOLSETS).join(', ');
      throw new Error(`resolveToolsets: unknown toolset "${name}". Known: ${known}`);
    }

    if (tools.length === 1 && tools[0] === '*') {
      // all 通配符 —— 不在此展开，调用方负责
      result.add('*');
    } else {
      for (const t of tools) {
        result.add(t);
      }
    }
  }

  return result;
}

/**
 * 对白名单应用 DELEGATE_BLOCKED_TOOLS 过滤。
 * 移除永远不可用的工具。
 */
export function applyBlockedTools(allowed: Set<string>): Set<string> {
  const blocked = new Set(DELEGATE_BLOCKED_TOOLS);
  const result = new Set<string>();
  for (const t of allowed) {
    if (!blocked.has(t)) result.add(t);
  }
  return result;
}
