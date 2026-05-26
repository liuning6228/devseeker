/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * MCP (Model Context Protocol) · JSON-RPC 2.0 types + MCP methods
 *
 * W9.5 · MCP Client 协议层（§M14.4）
 *
 * 参考：https://modelcontextprotocol.io/specification/
 * - 通信：JSON-RPC 2.0
 * - Transport：stdio（line-delimited JSON）/ HTTP+SSE（本轮 stdio only）
 * - 握手：initialize → initialized (notification) → tools/list → tools/call
 */

// ─────────── JSON-RPC 2.0 types ───────────

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcError;

export function isJsonRpcRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return (m as JsonRpcRequest).method !== undefined && (m as JsonRpcRequest).id !== undefined;
}
export function isJsonRpcNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return (m as JsonRpcNotification).method !== undefined && (m as JsonRpcRequest).id === undefined;
}
export function isJsonRpcResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return (
    (m as JsonRpcSuccess).result !== undefined || (m as JsonRpcError).error !== undefined
  );
}

// ─────────── MCP methods (subset we need) ───────────

export const MCP_METHOD = {
  INITIALIZE: 'initialize',
  INITIALIZED: 'notifications/initialized',
  TOOLS_LIST: 'tools/list',
  TOOLS_CALL: 'tools/call',
  PING: 'ping',
} as const;

export const MCP_PROTOCOL_VERSION = '2024-11-05';

// ─────────── MCP message shapes ───────────

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
    [k: string]: unknown;
  };
  clientInfo: { name: string; version: string };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
    [k: string]: unknown;
  };
  serverInfo: { name: string; version: string };
  instructions?: string;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolsListResult {
  tools: McpToolDefinition[];
  nextCursor?: string;
}

export interface McpToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export type McpContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } };

export interface McpToolsCallResult {
  content: McpContentItem[];
  isError?: boolean;
}
