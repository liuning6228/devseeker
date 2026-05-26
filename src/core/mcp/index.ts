/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * MCP · barrel export（W9.5–W9.8）
 */

export {
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcSuccess,
  type JsonRpcError,
  type JsonRpcResponse,
  type JsonRpcMessage,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  MCP_METHOD,
  MCP_PROTOCOL_VERSION,
  type McpInitializeParams,
  type McpInitializeResult,
  type McpToolDefinition,
  type McpToolsListResult,
  type McpToolsCallParams,
  type McpContentItem,
  type McpToolsCallResult,
} from './protocol.js';
export {
  type ITransport,
  TransportBase,
  LineFramer,
  type TransportMessageHandler,
  type TransportErrorHandler,
  type TransportCloseHandler,
} from './transport.js';
export { StdioTransport, type StdioTransportOptions } from './stdio-transport.js';
export { McpClient, type McpClientOptions } from './client.js';
export {
  McpToolAdapter,
  type McpToolAdapterOptions,
  namespaceToolName,
  formatMcpContent,
} from './tool-adapter.js';
export {
  type McpTransportType,
  type McpServerConfig,
  type McpConfig,
  type McpConfigLoadResult,
  type McpConfigLoadOptions,
  expandVariables,
  parseMcpConfig,
  loadMcpConfigFile,
} from './config.js';
export {
  McpRegistry,
  type McpRegistryOptions,
  type McpServerState,
  type McpServerStatus,
} from './registry.js';
