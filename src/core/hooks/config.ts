/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Hooks 配置加载 + 校验（W5 批次 1）
 *
 * 来源：`<workspaceRoot>/.dualmind/hooks.json`（JSONC 注释已剥离）
 * 不存在 → 空配置；解析失败 → 返回 error 不抛，由调用方决定降级策略。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HookConfig, HookSpec, HookEvent } from './types.js';

const VALID_EVENTS: ReadonlyArray<HookEvent> = [
  'pre_task',
  'post_task',
  'pre_tool_call',
  'post_tool_call',
  'on_error',
];

export interface LoadHookConfigResult {
  config: HookConfig;
  filePath?: string;
  error?: string;
}

/** 加载 hooks 配置。workspaceRoot 为 undefined 时返回空配置 */
export async function loadHookConfig(workspaceRoot: string | undefined): Promise<LoadHookConfigResult> {
  if (!workspaceRoot) return { config: { hooks: [] } };
  const filePath = path.join(workspaceRoot, '.dualmind', 'hooks.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return { config: { hooks: [] } };
  }
  return parseHookConfig(raw, filePath);
}

/** 纯函数：从 JSON 文本解析 + 校验。暴露给测试使用 */
export function parseHookConfig(raw: string, filePath?: string): LoadHookConfigResult {
  const stripped = stripJsonComments(raw).trim();
  if (!stripped) return { config: { hooks: [] }, filePath };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    return { config: { hooks: [] }, filePath, error: `JSON parse failed: ${String(e)}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { config: { hooks: [] }, filePath, error: 'root must be an object' };
  }
  const rawHooks = (parsed as { hooks?: unknown }).hooks;
  if (rawHooks === undefined) return { config: { hooks: [] }, filePath };
  if (!Array.isArray(rawHooks)) {
    return { config: { hooks: [] }, filePath, error: '"hooks" must be an array' };
  }

  const hooks: HookSpec[] = [];
  for (let i = 0; i < rawHooks.length; i++) {
    const h = rawHooks[i];
    const check = validateHookSpec(h, i);
    if (check.error) return { config: { hooks: [] }, filePath, error: check.error };
    hooks.push(check.spec!);
  }
  return { config: { hooks }, filePath };
}

// ─────────── internals ───────────

function validateHookSpec(raw: unknown, idx: number): { spec?: HookSpec; error?: string } {
  if (!raw || typeof raw !== 'object') return { error: `hooks[${idx}] must be an object` };
  const o = raw as Record<string, unknown>;

  const event = o.event;
  if (typeof event !== 'string' || !VALID_EVENTS.includes(event as HookEvent)) {
    return {
      error: `hooks[${idx}].event must be one of: ${VALID_EVENTS.join(', ')}`,
    };
  }
  const command = o.command;
  if (typeof command !== 'string' || !command.trim()) {
    return { error: `hooks[${idx}].command must be a non-empty string` };
  }

  const spec: HookSpec = {
    event: event as HookEvent,
    command,
  };

  if (o.match !== undefined) {
    if (!o.match || typeof o.match !== 'object') {
      return { error: `hooks[${idx}].match must be an object when provided` };
    }
    const m = o.match as Record<string, unknown>;
    const matcher: NonNullable<HookSpec['match']> = {};
    if (m.tool !== undefined) {
      if (typeof m.tool !== 'string' || !m.tool.trim()) {
        return { error: `hooks[${idx}].match.tool must be a non-empty string` };
      }
      matcher.tool = m.tool;
    }
    if (m.safetyLevel !== undefined) {
      const sl = m.safetyLevel;
      if (
        sl !== 'read_only' &&
        sl !== 'workspace_write' &&
        sl !== 'destructive' &&
        sl !== 'network' &&
        sl !== 'external'
      ) {
        return {
          error: `hooks[${idx}].match.safetyLevel must be one of: read_only | workspace_write | destructive | network | external`,
        };
      }
      matcher.safetyLevel = sl;
    }
    spec.match = matcher;
  }

  if (o.cwd !== undefined) {
    if (typeof o.cwd !== 'string' || !o.cwd.trim()) {
      return { error: `hooks[${idx}].cwd must be a non-empty string` };
    }
    spec.cwd = o.cwd;
  }
  if (o.timeoutMs !== undefined) {
    if (typeof o.timeoutMs !== 'number' || !Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) {
      return { error: `hooks[${idx}].timeoutMs must be a positive number` };
    }
    spec.timeoutMs = o.timeoutMs;
  }
  if (o.deny !== undefined) {
    if (typeof o.deny !== 'boolean') {
      return { error: `hooks[${idx}].deny must be a boolean` };
    }
    spec.deny = o.deny;
  }
  if (o.name !== undefined) {
    if (typeof o.name !== 'string') {
      return { error: `hooks[${idx}].name must be a string` };
    }
    spec.name = o.name;
  }

  return { spec };
}

/**
 * 轻量 JSONC 注释剥离（line + block），保留字符串内容。
 * 不支持 trailing comma（与 JSON 保持一致）。
 */
function stripJsonComments(src: string): string {
  let out = '';
  let i = 0;
  const len = src.length;
  let inString = false;
  let stringQuote = '"';
  let escape = false;
  while (i < len) {
    const c = src[i];
    if (inString) {
      out += c;
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === stringQuote) {
        inString = false;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringQuote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && i + 1 < len) {
      const n = src[i + 1];
      if (n === '/') {
        // line comment
        i += 2;
        while (i < len && src[i] !== '\n') i++;
        continue;
      }
      if (n === '*') {
        i += 2;
        while (i + 1 < len && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}
