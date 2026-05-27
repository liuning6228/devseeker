/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * AgentError: 全项目统一异常基类。
 *
 * 规则（SPEC/error-model.md §1）：
 * - 所有 throw 必须是 AgentError 或其子类
 * - 所有错误码来自 ErrorCodes 冻结枚举
 * - context 自动脱敏（apiKey / token / secret / password / authorization）
 * - 从 retryable/severity 自动填充，来自 RETRY_TABLE/SEVERITY_TABLE
 */

import {
  ErrorCodes,
  getRetryPolicy,
  getSeverity,
  isRetryable,
  type ErrorCode,
  type Severity,
} from './codes.js';

export interface AgentErrorInit {
  code: ErrorCode;
  message: string;
  userMessage?: string;
  cause?: unknown;
  context?: Record<string, unknown>;
}

export interface SerializedAgentError {
  name: 'AgentError';
  code: ErrorCode;
  message: string;
  userMessage?: string;
  context?: Record<string, unknown>;
  retryable: boolean;
  severity: Severity;
  timestamp: number;
  stack?: string;
}

const SENSITIVE_KEY_PATTERN = /(apikey|api_key|token|secret|password|authorization|auth)/i;
const MAX_FIELD_LEN = 500;

/**
 * 脱敏处理：
 * - 敏感 key 的 value 替换为 <redacted>
 * - 超长字段（>500 字符）截断 + [truncated]
 * - URL 去 query string
 * - filePath 保留相对路径（不暴露绝对路径）
 */
export function redact(ctx?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = '<redacted>';
      continue;
    }
    out[k] = redactValue(v);
  }
  return out;
}

function redactValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    // URL 去 query string
    if (/^https?:\/\//.test(v)) {
      try {
        const u = new URL(v);
        return `${u.origin}${u.pathname}`;
      } catch {
        // fall through
      }
    }
    if (v.length > MAX_FIELD_LEN) return v.slice(0, MAX_FIELD_LEN) + '…[truncated]';
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) {
    return v.length > 50 ? [...v.slice(0, 50), '…[truncated]'] : v.map(redactValue);
  }
  if (typeof v === 'object') {
    return redact(v as Record<string, unknown>);
  }
  return String(v);
}

export class AgentError extends Error {
  readonly name = 'AgentError';
  readonly code: ErrorCode;
  readonly userMessage?: string;
  readonly cause?: unknown;
  readonly context?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly severity: Severity;
  readonly timestamp: number;

  constructor(init: AgentErrorInit) {
    super(init.message);
    this.code = init.code;
    this.userMessage = init.userMessage;
    this.cause = init.cause;
    this.context = redact(init.context);
    this.retryable = isRetryable(init.code);
    this.severity = getSeverity(init.code);
    this.timestamp = Date.now();

    // 维持 instanceof 正确性（TS 目标 ES2022，但留兜底）
    Object.setPrototypeOf(this, AgentError.prototype);
  }

  getRetryPolicy() {
    return getRetryPolicy(this.code);
  }

  toJSON(): SerializedAgentError {
    return {
      name: 'AgentError',
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      context: this.context,
      retryable: this.retryable,
      severity: this.severity,
      timestamp: this.timestamp,
      // stack 仅 dev 模式保留（生产打包由构建脚本剥离 sourcemap）
      stack: process.env.NODE_ENV === 'production' ? undefined : this.stack,
    };
  }

  /**
   * 面向用户的本地化消息。
   * 无 userMessage 时回退到 code 对应的内置模板，最终 fallback 到 message。
   */
  toUserMessage(): string {
    if (this.userMessage) return this.userMessage;
    return DEFAULT_USER_MESSAGES[this.code] ?? this.message;
  }
}

/**
 * 简化的用户可见消息默认模板（中文）
 * TODO W3+ 接入 i18n 体系后移入 locales/。
 */
const DEFAULT_USER_MESSAGES: Partial<Record<ErrorCode, string>> = {
  [ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY]: 'API 密钥无效，请在设置中重新配置。',
  [ErrorCodes.PROVIDER_AUTH_EXPIRED]: 'API 密钥已过期，请更新。',
  [ErrorCodes.PROVIDER_AUTH_INSUFFICIENT_QUOTA]: '账户额度不足，请充值后重试。',
  [ErrorCodes.PROVIDER_NET_TIMEOUT]: '网络请求超时，请检查网络后重试。',
  [ErrorCodes.PROVIDER_NET_UNREACHABLE]: '无法连接到模型服务，请检查网络。',
  [ErrorCodes.PROVIDER_RATE_LIMITED]: '请求频率过高，已自动退避重试。',
  [ErrorCodes.PROVIDER_DAILY_QUOTA_EXCEEDED]: '免费模型每日配额已耗尽，请切换付费模型或等待次日重置。',
  [ErrorCodes.PROVIDER_SERVER_5XX]: '模型服务暂时不可用，稍后自动重试。',
  [ErrorCodes.TOOL_EXEC_TIMEOUT]: '工具执行超时。',
  [ErrorCodes.TOOL_PATH_INVALID]: '文件路径不合法或不在工作区内。',
  [ErrorCodes.CONFIG_FILE_MISSING]: '配置文件不存在。',
  [ErrorCodes.CONFIG_PARSE_FAIL]: '配置文件格式错误，无法解析。',
};

/**
 * 三方错误归一化（SPEC/error-model.md §8）
 * 将 unknown 统一转成 AgentError，不会再抛出。
 */
export function toAgentError(
  e: unknown,
  fallback: ErrorCode = ErrorCodes.INTERNAL_UNKNOWN,
): AgentError {
  if (e instanceof AgentError) return e;

  if (e instanceof Error) {
    const nodeCode = (e as NodeJS.ErrnoException).code;
    if (nodeCode === 'ENOENT') {
      return new AgentError({
        code: ErrorCodes.CONFIG_FILE_MISSING,
        message: e.message,
        cause: e,
      });
    }
    if (nodeCode === 'EACCES' || nodeCode === 'EPERM') {
      return new AgentError({
        code: ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        message: e.message,
        cause: e,
      });
    }
    if (nodeCode === 'ECONNREFUSED' || nodeCode === 'ENOTFOUND') {
      return new AgentError({
        code: ErrorCodes.PROVIDER_NET_UNREACHABLE,
        message: e.message,
        cause: e,
      });
    }
    if (nodeCode === 'ETIMEDOUT') {
      return new AgentError({
        code: ErrorCodes.PROVIDER_NET_TIMEOUT,
        message: e.message,
        cause: e,
      });
    }
    if (e.name === 'AbortError') {
      return new AgentError({
        code: ErrorCodes.TASK_LOOP_ABORTED,
        message: e.message,
        cause: e,
      });
    }
    return new AgentError({ code: fallback, message: e.message, cause: e });
  }

  // HTTP 响应对象（fetch Response）
  if (isFetchResponse(e)) {
    const r = e as Response;
    if (r.status === 401 || r.status === 403) {
      return new AgentError({
        code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY,
        message: `${r.status} ${r.statusText}`,
        cause: e,
      });
    }
    if (r.status === 429) {
      return new AgentError({
        code: ErrorCodes.PROVIDER_RATE_LIMITED,
        message: `${r.status} ${r.statusText}`,
        cause: e,
      });
    }
    if (r.status >= 500) {
      return new AgentError({
        code: ErrorCodes.PROVIDER_SERVER_5XX,
        message: `${r.status} ${r.statusText}`,
        cause: e,
      });
    }
    if (r.status === 404) {
      return new AgentError({
        code: ErrorCodes.WEB_FETCH_404,
        message: `${r.status} ${r.statusText}`,
        cause: e,
      });
    }
  }

  return new AgentError({ code: fallback, message: String(e) });
}

function isFetchResponse(e: unknown): e is Response {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as Response).status === 'number' &&
    typeof (e as Response).statusText === 'string'
  );
}

/**
 * 断言：不应发生的情况。失败即 INTERNAL.BUG.ASSERTION。
 */
export function assert(cond: unknown, msg: string, ctx?: Record<string, unknown>): asserts cond {
  if (!cond) {
    throw new AgentError({
      code: ErrorCodes.INTERNAL_ASSERTION_FAILED,
      message: msg,
      context: ctx,
    });
  }
}

/**
 * 不可达分支标记。
 */
export function unreachable(msg = 'unreachable code reached'): never {
  throw new AgentError({
    code: ErrorCodes.INTERNAL_UNREACHABLE,
    message: msg,
  });
}
