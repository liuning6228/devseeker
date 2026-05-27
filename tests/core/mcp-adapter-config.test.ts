/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W9.6 + W9.7 · MCP tool adapter + config 测试
 */

import { describe, it, expect } from 'vitest';
import {
  McpToolAdapter,
  namespaceToolName,
  formatMcpContent,
  parseMcpConfig,
  expandVariables,
} from '../../src/core/mcp/index.js';
import type { McpClient, McpContentItem } from '../../src/core/mcp/index.js';

// ─────────── namespaceToolName / formatMcpContent ───────────

describe('namespaceToolName', () => {
  it('joins with dot by default', () => {
    expect(namespaceToolName('fs', 'read_file')).toBe('fs.read_file');
  });
  it('honors custom separator', () => {
    expect(namespaceToolName('fs', 'read_file', '/')).toBe('fs/read_file');
  });
});

describe('formatMcpContent', () => {
  it('concatenates text items', () => {
    const items: McpContentItem[] = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
    ];
    expect(formatMcpContent(items)).toBe('Hello\nWorld');
  });
  it('labels image + resource items', () => {
    const items: McpContentItem[] = [
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file:///x', mimeType: 'text/plain', text: 'hi' } },
    ];
    const out = formatMcpContent(items);
    expect(out).toContain('image: image/png');
    expect(out).toContain('resource: file:///x');
    expect(out).toContain('hi');
  });
});

// ─────────── McpToolAdapter ───────────

function makeFakeClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    isInitialized: true,
    serverMetadata: undefined,
    initialize: async () => ({} as any),
    listTools: async () => [],
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ping: async () => {},
    onNotification: () => () => {},
    close: async () => {},
    ...overrides,
  } as unknown as McpClient;
}

describe('McpToolAdapter', () => {
  it('produces namespaced name and decorated description', () => {
    const client = makeFakeClient();
    const adapter = new McpToolAdapter({
      serverAlias: 'filesystem',
      toolDef: { name: 'read_file', description: 'Read a file' },
      getClient: () => client,
    });
    expect(adapter.name).toBe('filesystem.read_file');
    expect(adapter.description).toContain('[mcp:filesystem]');
    expect(adapter.description).toContain('Read a file');
    expect(adapter.safetyLevel).toBe('external');
  });

  it('calls client and serializes content', async () => {
    let capturedName = '';
    let capturedArgs: unknown;
    const client = makeFakeClient({
      callTool: async (n, a) => {
        capturedName = n;
        capturedArgs = a;
        return { content: [{ type: 'text', text: 'file contents' }] };
      },
    });
    const adapter = new McpToolAdapter({
      serverAlias: 'fs',
      toolDef: { name: 'read_file' },
      getClient: () => client,
    });
    const res = await adapter.execute({ path: '/x' }, {} as any);
    expect(capturedName).toBe('read_file');
    expect(capturedArgs).toEqual({ path: '/x' });
    expect(res.ok).toBe(true);
    expect(res.content).toBe('file contents');
  });

  it('returns error when disabled', async () => {
    const client = makeFakeClient();
    const adapter = new McpToolAdapter({
      serverAlias: 'fs',
      toolDef: { name: 'x' },
      getClient: () => client,
      isDisabled: () => true,
    });
    const res = await adapter.execute({}, {} as any);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('MCP.HEALTH.FAIL');
    expect(res.content).toContain('disabled');
  });

  it('returns error when client missing / not initialized', async () => {
    const adapter = new McpToolAdapter({
      serverAlias: 'fs',
      toolDef: { name: 'x' },
      getClient: () => undefined,
    });
    const res = await adapter.execute({}, {} as any);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('MCP.HEALTH.FAIL');
  });

  it('propagates MCP errors with code', async () => {
    const client = makeFakeClient({
      callTool: async () => {
        const e = new Error('tool exploded') as any;
        e.code = 'MCP.TOOL.FAIL';
        throw e;
      },
    });
    const adapter = new McpToolAdapter({
      serverAlias: 'fs',
      toolDef: { name: 'x' },
      getClient: () => client,
    });
    const res = await adapter.execute({}, {} as any);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('MCP.TOOL.FAIL');
    expect(res.content).toContain('tool exploded');
  });

  it('flags isError results as failure', async () => {
    const client = makeFakeClient({
      callTool: async () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }),
    });
    const adapter = new McpToolAdapter({
      serverAlias: 'fs',
      toolDef: { name: 'x' },
      getClient: () => client,
    });
    const res = await adapter.execute({}, {} as any);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('MCP.TOOL.FAIL');
    expect(res.content).toContain('nope');
  });

  it('falls back to empty schema when inputSchema missing', () => {
    const adapter = new McpToolAdapter({
      serverAlias: 's',
      toolDef: { name: 't' },
      getClient: () => makeFakeClient(),
    });
    expect((adapter.parameters as any).type).toBe('object');
  });
});

// ─────────── expandVariables ───────────

describe('expandVariables', () => {
  it('expands ${workspaceFolder}', () => {
    expect(expandVariables('${workspaceFolder}/src', { workspaceRoot: '/w' })).toBe('/w/src');
  });
  it('expands ${env.NAME}', () => {
    const out = expandVariables('${env.TOKEN}/x', { envLookup: (n) => (n === 'TOKEN' ? 'abc' : undefined) });
    expect(out).toBe('abc/x');
  });
  it('keeps unknown variables literal', () => {
    const out = expandVariables('${weird}/x');
    expect(out).toBe('${weird}/x');
  });
  it('empty env var becomes empty string', () => {
    const out = expandVariables('${env.MISSING}/x', { envLookup: () => undefined });
    expect(out).toBe('/x');
  });
});

// ─────────── parseMcpConfig ───────────

describe('parseMcpConfig', () => {
  it('parses a valid mcpServers map with variable expansion', () => {
    const { config } = parseMcpConfig(
      {
        mcpServers: {
          fs: {
            command: 'node',
            args: ['server.js', '${workspaceFolder}'],
            env: { API_KEY: '${env.KEY}' },
            cwd: '${workspaceFolder}',
          },
        },
      },
      { workspaceRoot: '/ws', envLookup: () => 'secret' },
    );
    expect(config.servers).toHaveLength(1);
    const s = config.servers[0];
    expect(s.name).toBe('fs');
    expect(s.transport).toBe('stdio');
    expect(s.command).toBe('node');
    expect(s.args).toEqual(['server.js', '/ws']);
    expect(s.env).toEqual({ API_KEY: 'secret' });
    expect(s.cwd).toBe('/ws');
  });

  it('rejects non-object root', () => {
    const r = parseMcpConfig('bad', {});
    expect(r.errorCode).toBe('CONFIG.LOAD.SCHEMA_INVALID');
  });

  it('skips malformed server entries with warnings', () => {
    const { config } = parseMcpConfig({
      mcpServers: {
        broken: 'oops',
        missingCmd: {},
        nonStdio: { command: 'x', transport: 'websocket' },
        sse: { command: 'x', transport: 'sse' },
        ok: { command: 'ok' },
      },
    });
    expect(config.servers.map((s) => s.name)).toEqual(['ok']);
    expect(config.warnings.some((w) => w.includes('broken'))).toBe(true);
    expect(config.warnings.some((w) => w.includes('missingCmd'))).toBe(true);
    expect(config.warnings.some((w) => w.includes('nonStdio'))).toBe(true);
    expect(config.warnings.some((w) => w.includes('SSE transport'))).toBe(true);
  });

  it('honors disabled=true', () => {
    const { config } = parseMcpConfig({
      mcpServers: { a: { command: 'x', disabled: true } },
    });
    expect(config.servers[0].disabled).toBe(true);
  });

  it('handles missing mcpServers key gracefully', () => {
    const r = parseMcpConfig({});
    expect(r.errorCode).toBeUndefined();
    expect(r.config.servers).toHaveLength(0);
  });
});
