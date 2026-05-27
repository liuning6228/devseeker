/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Approval Audit Sink（v1.8.0 · DESIGN §M9.5）
 *
 * 审批决策审计日志。
 * 所有工具调用经过 decideApproval 后，将决策结果记录到审计日志。
 *
 * 存储格式：JSON Lines（.jsonl）
 * 路径：<workspaceRoot>/.devseeker/audit/approval.jsonl
 *
 * 单条格式：
 * ```jsonl
 * {"ts":"2026-05-09T00:30:00Z","tool":"bash","level":"destructive","decision":"confirm","approved":true,"reason":"按 ToolSafetyLevel.destructive 默认策略","argsPreview":"{...}","durationMs":42}
 * ```
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * 单条审计记录
 */
export interface ApprovalAuditEntry {
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 工具名 */
  toolName: string;
  /** 安全等级 */
  safetyLevel: string;
  /** 决策结果：auto / confirm / deny */
  decision: string;
  /** 是否批准执行（仅 confirm 决策有意义） */
  approved: boolean;
  /** 决策原因 */
  reason: string;
  /** 参数预览（截断 ≤ 200 字符） */
  argsPreview: string;
  /** 工具执行耗时（ms） */
  durationMs: number;
}

/**
 * 审计日志写入抽象
 */
export interface ApprovalAuditSink {
  append(entry: ApprovalAuditEntry): Promise<void>;
}

/**
 * 默认实现：追加写 <workspaceRoot>/.devseeker/audit/approval.jsonl
 */
export class FileApprovalAuditSink implements ApprovalAuditSink {
  private readonly dir: string;
  private readonly file: string;

  constructor(workspaceRoot: string) {
    this.dir = path.join(workspaceRoot, '.devseeker', 'audit');
    this.file = path.join(this.dir, 'approval.jsonl');
  }

  async append(entry: ApprovalAuditEntry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(this.file, line, 'utf8');
  }
}

/**
 * 内存 sink，单测用
 */
export class InMemoryApprovalAuditSink implements ApprovalAuditSink {
  readonly entries: ApprovalAuditEntry[] = [];

  async append(entry: ApprovalAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}
