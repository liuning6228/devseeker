/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 沙箱升级协议（W9.13 · DESIGN §M9.6.2）
 *
 * 职责：
 * 1. `detectSandboxingError(output)` — 在命令合并输出中探测典型 "SANDBOXING" 特征，
 *    供 bash 工具在命令失败后提示模型：可能需要 `required_permissions='all'` 重试。
 * 2. `SandboxApprovalGate` — 当模型发起 `required_permissions='all'` 时触发的审批回调；
 *    返回 `{ approved: true }` 才允许执行；拒绝 → 工具返回 `TOOL_SANDBOX_ESCALATION_DENIED`。
 * 3. `SandboxAuditSink.append()` — 把每次 escalated=true 的命令追加到审计记录。
 *    MVP：写到 `<workspaceRoot>/.devseeker/audit/sandbox.jsonl`。
 *
 * 关键约定：
 * - escalation **不能** 绕过命令黑名单（rm -rf / format / shutdown / sudo ...）
 * - escalation 仅对"命令本身命中沙箱策略"有效；语法错/缺依赖不应请求升级
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** 典型"越界/权限不足"特征（不含黑名单命令自身的 "denied"） */
const SANDBOXING_PATTERNS: RegExp[] = [
  /\bSANDBOXING\b/i,
  /sandbox(?:ed|ing)?/i,
  /operation\s+not\s+permitted/i,
  /permission\s+denied/i,
  /eacces/i,
  /eperm/i,
  /access\s+is\s+denied/i, // PowerShell
  /read-only\s+file\s+system/i,
  /is\s+a\s+directory/i,
  /cannot\s+create\s+directory/i,
];

/** 单向探测：输出是否"看起来像"沙箱拦截的权限/越界错误 */
export function detectSandboxingError(output: string): boolean {
  if (!output) return false;
  const head = output.slice(0, 8 * 1024); // 仅看前 8KB，避免全量正则
  return SANDBOXING_PATTERNS.some((r) => r.test(head));
}

/** 审批请求 payload */
export interface SandboxEscalationRequest {
  command: string;
  commandNames: string[];
  cwd: string | undefined;
  reason?: string;
}

/** 审批结果 */
export interface SandboxEscalationDecision {
  approved: boolean;
  reason?: string;
}

/** 审批门回调（注入点；UI 未就绪时可默认拒绝） */
export type SandboxApprovalGate = (
  req: SandboxEscalationRequest,
) => Promise<SandboxEscalationDecision>;

/** 审计记录条目 */
export interface SandboxAuditEntry {
  timestamp: string; // ISO 8601
  command: string;
  commandNames: string[];
  cwd?: string;
  escalated: boolean; // W9.13 契约：恒 true（本日志专门记升级命令）
  approved: boolean;
  reason?: string;
  exitCode?: number;
  durationMs?: number;
  taskId?: string;
}

/** 审计写入抽象（方便测试注入 memory sink） */
export interface SandboxAuditSink {
  append(entry: SandboxAuditEntry): Promise<void>;
}

/** 默认实现：追加写 `<workspaceRoot>/.devseeker/audit/sandbox.jsonl` */
export class FileSandboxAuditSink implements SandboxAuditSink {
  constructor(private readonly workspaceRoot: string) {}

  async append(entry: SandboxAuditEntry): Promise<void> {
    const dir = path.join(this.workspaceRoot, '.devseeker', 'audit');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'sandbox.jsonl');
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(file, line, 'utf8');
  }
}

/** 内存 sink，单测用 */
export class InMemorySandboxAuditSink implements SandboxAuditSink {
  public readonly entries: SandboxAuditEntry[] = [];
  async append(entry: SandboxAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

/** 构造一条标准审计记录 */
export function makeAuditEntry(
  req: SandboxEscalationRequest,
  decision: SandboxEscalationDecision,
  extras: { exitCode?: number; durationMs?: number; taskId?: string } = {},
): SandboxAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    command: req.command,
    commandNames: req.commandNames,
    cwd: req.cwd,
    escalated: true,
    approved: decision.approved,
    reason: decision.reason ?? req.reason,
    ...(extras.exitCode !== undefined ? { exitCode: extras.exitCode } : {}),
    ...(extras.durationMs !== undefined ? { durationMs: extras.durationMs } : {}),
    ...(extras.taskId ? { taskId: extras.taskId } : {}),
  };
}
