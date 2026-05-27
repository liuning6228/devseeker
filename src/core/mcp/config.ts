/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * MCP 配置加载 + 变量展开（W9.7）
 *
 * 支持：
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"],
 *         "env": { "API_KEY": "${env.FS_API_KEY}" },
 *         "transport": "stdio",
 *         "cwd": "${workspaceFolder}",
 *         "disabled": false
 *       }
 *     }
 *   }
 *
 * 变量展开：
 * - `${workspaceFolder}` → 传入的 workspaceRoot
 * - `${env.NAME}` → 传入的 envLookup（默认 process.env）；未找到返回空字符串
 *
 * 当前仅支持 stdio；`transport: "sse"` 会在 loader 层忽略并写入 warnings。
 */

import * as fs from 'node:fs/promises';
import { ErrorCodes } from '../errors/index.js';

export type McpTransportType = 'stdio' | 'sse';

export interface McpServerConfig {
  name: string;
  transport: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** SSE only（未来） */
  url?: string;
  disabled?: boolean;
}

export interface McpConfig {
  servers: McpServerConfig[];
  warnings: string[];
}

export interface McpConfigLoadResult {
  config: McpConfig;
  /** 解析错误（致命）；若为 undefined 表示 OK */
  errorCode?: string;
  errorMessage?: string;
}

export interface McpConfigLoadOptions {
  workspaceRoot?: string;
  envLookup?: (name: string) => string | undefined;
}

/** 展开 ${workspaceFolder} 与 ${env.NAME} */
export function expandVariables(
  input: string,
  opts: { workspaceRoot?: string; envLookup?: (name: string) => string | undefined } = {},
): string {
  const envLookup = opts.envLookup ?? ((n: string) => process.env[n]);
  return input.replace(/\$\{([^}]+)\}/g, (_, raw: string) => {
    const key = raw.trim();
    if (key === 'workspaceFolder') return opts.workspaceRoot ?? '';
    if (key.startsWith('env.')) {
      const envName = key.slice(4).trim();
      if (!envName) return '';
      return envLookup(envName) ?? '';
    }
    // 未知变量：保留原样（易于排查）
    return `\${${raw}}`;
  });
}

function expandString(v: unknown, o: McpConfigLoadOptions): string {
  if (typeof v !== 'string') return '';
  return expandVariables(v, o);
}

/** 解析 mcp.json 原始对象（不做 IO），返回规范化 McpConfig */
export function parseMcpConfig(
  raw: unknown,
  opts: McpConfigLoadOptions = {},
): McpConfigLoadResult {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return {
      config: { servers: [], warnings },
      errorCode: ErrorCodes.CONFIG_SCHEMA_INVALID,
      errorMessage: 'mcp.json must be a JSON object',
    };
  }
  const root = raw as Record<string, unknown>;
  const serversObj = root.mcpServers ?? root.servers;
  if (!serversObj || typeof serversObj !== 'object') {
    return { config: { servers: [], warnings: ['no mcpServers key; nothing to load'] } };
  }
  const servers: McpServerConfig[] = [];
  for (const [name, entryRaw] of Object.entries(serversObj as Record<string, unknown>)) {
    if (!entryRaw || typeof entryRaw !== 'object') {
      warnings.push(`server "${name}": skipped (not an object)`);
      continue;
    }
    const e = entryRaw as Record<string, unknown>;
    const transport = (typeof e.transport === 'string' ? e.transport : 'stdio') as McpTransportType;
    if (transport !== 'stdio' && transport !== 'sse') {
      warnings.push(`server "${name}": unknown transport "${String(e.transport)}"; skipped`);
      continue;
    }
    if (transport === 'sse') {
      warnings.push(`server "${name}": SSE transport not yet supported in this build; skipped`);
      continue;
    }
    if (typeof e.command !== 'string' || !e.command.trim()) {
      warnings.push(`server "${name}": missing command; skipped`);
      continue;
    }
    const argsRaw = Array.isArray(e.args) ? (e.args as unknown[]) : [];
    const args = argsRaw.map((a) => expandString(a, opts)).filter((s) => s.length > 0);
    const envRaw = (e.env && typeof e.env === 'object' ? e.env : {}) as Record<string, unknown>;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(envRaw)) {
      env[k] = expandString(v, opts);
    }
    const cwd = typeof e.cwd === 'string' ? expandString(e.cwd, opts) : undefined;
    const disabled = e.disabled === true;
    servers.push({
      name,
      transport,
      command: expandString(e.command, opts),
      args,
      env,
      cwd: cwd && cwd.length > 0 ? cwd : undefined,
      disabled,
    });
  }
  return { config: { servers, warnings } };
}

/** 从文件加载 mcp.json */
export async function loadMcpConfigFile(
  filePath: string,
  opts: McpConfigLoadOptions = {},
): Promise<McpConfigLoadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    return {
      config: { servers: [], warnings: [] },
      errorCode: ErrorCodes.CONFIG_FILE_MISSING,
      errorMessage: `mcp.json not readable: ${String(e)}`,
    };
  }
  // 剥 UTF-8 BOM
  let withoutBom = raw;
  const warnings: string[] = [];
  if (raw.charCodeAt(0) === 0xfeff) {
    withoutBom = raw.slice(1);
    warnings.push(`mcp.json started with UTF-8 BOM; stripped`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutBom);
  } catch (e) {
    return {
      config: { servers: [], warnings },
      errorCode: ErrorCodes.CONFIG_PARSE_FAIL,
      errorMessage: `mcp.json JSON parse failed: ${String(e)}`,
    };
  }
  const res = parseMcpConfig(parsed, opts);
  res.config.warnings.unshift(...warnings);
  return res;
}
