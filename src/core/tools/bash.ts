/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * bash 工具（跨平台：Windows=PowerShell / POSIX=sh）
 *
 * 来源：DESIGN §M9.2 destructive 工具（但 MVP 通过黑名单放行常见命令）
 *
 * 行为：
 * - 在 workspaceRoot 下执行单行命令
 * - 超时上限 120s，默认 30s
 * - 合并 stdout/stderr 输出，总量 >32KB 时截断
 * - 命中危险模式黑名单（rm -rf / format / shutdown / git reset --hard 等）→ 拒绝
 *
 * 安全：
 * - cwd 默认 = workspaceRoot；允许 cwd 参数但必须在工作区内
 * - 不暴露 shell=true 默认环境（Windows 用 powershell -NoProfile -NonInteractive）
 * - 取消信号：signal.abort → kill 子进程
 *
 * 注意：
 * - 本工具 safetyLevel='destructive'，但 dangerous=false，因此 ToolRunner 不走审批拦截
 * - 后续接入 UI 审批后，应切换为 dangerous=true，移除本地黑名单
 */

import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { promises as fs } from 'node:fs';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';
import { getLogger } from '../../infra/logger.js';
import { classifyCommand, findBlacklistReason } from './safety-classifier.js';
import type { ITerminalPool } from './terminal-pool.js';
import { VscodeTerminalManager } from './vscode-terminal.js';
import {
  detectSandboxingError,
  makeAuditEntry,
  type SandboxApprovalGate,
  type SandboxAuditSink,
} from './sandbox.js';

const log = getLogger('tool.bash');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 32 * 1024; // 32 KB

/** 危险命令正则黑名单 —— 命中即拒绝 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // 递归删除
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|-[a-zA-Z]*f[a-zA-Z]*r)/i, reason: 'rm -r/-rf 禁止使用' },
  { pattern: /\brimraf\b/i, reason: 'rimraf 禁止使用' },
  { pattern: /\brmdir\s+\/s/i, reason: 'rmdir /s 禁止使用' },
  { pattern: /\bremove-item\b[^|;&]*\s-(recurse|force)/i, reason: 'Remove-Item -Recurse/-Force 禁止使用' },
  { pattern: /\bdel\s+\/s\b/i, reason: 'del /s 禁止使用' },
  // 磁盘破坏
  { pattern: /\b(mkfs|format)\b/i, reason: 'mkfs/format 禁止使用' },
  { pattern: /\bdd\s+if=/i, reason: 'dd 禁止使用' },
  // 系统控制
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'shutdown/reboot 禁止使用' },
  // git 危险操作
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'git reset --hard 禁止使用' },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/i, reason: 'git clean -f 禁止使用' },
  { pattern: /\bgit\s+push\b[^|;&]*--force\b/i, reason: 'git push --force 禁止使用' },
  { pattern: /\bgit\s+push\b[^|;&]*\s-f(\s|$)/i, reason: 'git push -f 禁止使用' },
  // 全局安装
  { pattern: /\bsudo\b/i, reason: 'sudo 禁止使用' },
  // 下载后执行
  { pattern: /\b(curl|wget|iwr|invoke-webrequest)\b[^|;&]*\|[^|;&]*\b(bash|sh|pwsh|powershell|cmd)\b/i,
    reason: 'curl|bash / wget|sh 管道执行远程脚本禁止使用' },
];

export interface BashArgs {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  /** W7b4a: true → 走 TerminalPool 立即返回 terminal_id，不阻塞 tool_call */
  is_background?: boolean;
  /** W7b4a: 显式声明危险命令，强制走 confirm（DESIGN §M9.6.1） */
  has_risk?: boolean;
  /** W9.13: 请求沙箱升级（DESIGN §M9.6.2） */
  required_permissions?: 'all';
  /** W9.13: 解析的命令名数组，便于审计 */
  command_names?: string[];
  /**
   * 终端执行模式：
   * - 'user_visible'：在用户可见终端执行（执行过程展示在终端面板）、捕获输出
   * - 缺省或 'sandbox'：在沙箱终端执行（隐藏终端面板）
   */
  terminalMode?: 'sandbox' | 'user_visible';
}

const parameters = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description:
        '要执行的 shell 命令（Windows 使用 PowerShell，其他系统使用 sh）。禁用 rm -rf / format / shutdown / git reset --hard / sudo / curl|bash 等危险模式。',
    },
    cwd: {
      type: 'string',
      description:
        '工作目录，相对路径相对于工作区根。缺省 = 工作区根。',
    },
    timeout_ms: {
      type: 'integer',
      minimum: 1000,
      maximum: MAX_TIMEOUT_MS,
      description: `执行超时（毫秒），默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。is_background=true 时为命令最长存活时间，默认无上限。`,
    },
    is_background: {
      type: 'boolean',
      description:
        'true 则在后台运行并立即返回 terminal_id，可用 get_terminal_output 轮询；false（默认）阻塞直至结束或超时。长时间运行的服务（watch/dev server/tail）建议 true。',
    },
    has_risk: {
      type: 'boolean',
      description:
        '模型自评命令是否有潜在破坏性（删除/写入/提交/部署）。true 会触发 confirm 审批（即使命令未命中风险规则）。',
    },
    required_permissions: {
      type: 'string',
      enum: ['all'],
      description:
        "请求沙箱升级（DESIGN §M9.6.2）。仅当命令在沙箱内失败且模型确认为沙箱拦截导致时设为 'all'。会触发用户批准弹窗与 escalated=true 审计记录。不可用于绕过黑名单。",
    },
    command_names: {
      type: 'array',
      items: { type: 'string' },
      description: '解析的命令名数组（如 ["pip","install"]），便于沙箱审计和风险分类。',
    },
    terminalMode: {
      type: 'string',
      enum: ['sandbox', 'user_visible'],
      description:
        '终端执行模式：user_visible 在用户可见终端执行（显示在终端面板），sandbox 在隐藏的沙箱终端执行（默认）。通常不需要 LLM 手动传入，由 ToolRunner 根据审批决策自动设置。',
    },
  },
  required: ['command'],
  additionalProperties: false,
} as const;

/**
 * BashTool 依赖（可选：未注入则 is_background=true 会降级为同步执行并在输出里提示）。
 */
export interface BashToolDeps {
  terminalManager?: VscodeTerminalManager;
  /** W9.13: 沙箱升级审批门（required_permissions='all' 时触发） */
  sandboxGate?: SandboxApprovalGate;
  /** W9.13: 升级命令审计写入 */
  sandboxAudit?: SandboxAuditSink;
}

export class BashTool implements ITool<BashArgs, ToolResult> {
  readonly name = 'bash';
  readonly description =
    '在工作区根执行单行 shell 命令（Windows=PowerShell, 其他=sh）。返回合并的 stdout/stderr 与 exit code。有黑名单拦截（rm -rf、format、shutdown、git reset --hard、sudo 等）。is_background=true 时立即返回 terminal_id，可用 get_terminal_output 读取输出。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'destructive';
  // 由 ToolRunner 的 decideApproval 统一管理审批。
  // 工具级 dangerous 不再短路所有命令——safety-classifier 会按具体命令归类 safe/risky，
  // bash 工具本身只负责黑名单拦截（bash.ts execute 中 classifyCommand）。
  readonly dangerous = false;
  /**
   * 在 1 层超时架构下，executionTimeoutMs 直接设为 MAX_TIMEOUT_MS。
   * ToolRunner 的 withTimeout 作为兜底安全网，不再需要 +5000 垫片。
   */
  readonly executionTimeoutMs = MAX_TIMEOUT_MS;

  private readonly terminalManager: VscodeTerminalManager | undefined;
  private readonly sandboxGate: SandboxApprovalGate | undefined;
  private readonly sandboxAudit: SandboxAuditSink | undefined;

  constructor(deps?: BashToolDeps) {
    this.terminalManager = deps?.terminalManager;
    this.sandboxGate = deps?.sandboxGate;
    this.sandboxAudit = deps?.sandboxAudit;
  }

  async execute(args: BashArgs, ctx: ToolContext): Promise<ToolResult> {
    // 1. 参数校验
    if (!args || typeof args.command !== 'string' || !args.command.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'command 不能为空');
    }
    const command = args.command.trim();

    const timeout =
      typeof args.timeout_ms === 'number' && Number.isInteger(args.timeout_ms)
        ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, args.timeout_ms))
        : DEFAULT_TIMEOUT_MS;

    // 2. 命令级安全分级（classifier 为权威）
    const safety = classifyCommand(command);
    if (safety === 'blacklisted') {
      const reason = findBlacklistReason(command) ?? 'command blacklisted';
      return fail(
        ErrorCodes.TOOL_EXEC_UNSAFE_BLOCKED,
        `命令被安全策略拒绝：${reason}`,
      );
    }
    // 兼容：历史 DANGEROUS_PATTERNS 已被 classifier 覆盖（保留数组仅供阅读）
    void DANGEROUS_PATTERNS;

    // 2.1 W9.13 沙箱升级审批：required_permissions='all'
    //  - 黑名单已在上方拦截；此处仅处理 non-blacklisted 命令的 escalation
    //  - 没注入 sandboxGate 时：保守拒绝（UI 未就绪）
    const escalated = args.required_permissions === 'all';
    let escalationApproved = false;
    if (escalated) {
      const commandNames = Array.isArray(args.command_names)
        ? args.command_names.filter((s): s is string => typeof s === 'string')
        : [];
      if (!this.sandboxGate) {
        const denied = makeAuditEntry(
          { command, commandNames, cwd: args.cwd, reason: 'no gate configured' },
          { approved: false, reason: 'no sandbox gate configured' },
          { taskId: ctx.taskId },
        );
        await this.sandboxAudit?.append(denied).catch(() => undefined);
        return fail(
          ErrorCodes.TOOL_SANDBOX_ESCALATION_DENIED,
          '沙箱升级被拒绝：审批门未配置。请改用沙箱内命令。',
        );
      }
      const decision = await this.sandboxGate({
        command,
        commandNames,
        cwd: args.cwd,
      });
      const entry = makeAuditEntry(
        { command, commandNames, cwd: args.cwd },
        decision,
        { taskId: ctx.taskId },
      );
      await this.sandboxAudit?.append(entry).catch((e) =>
        log.warn({ err: String(e) }, 'sandbox audit append failed'),
      );
      if (!decision.approved) {
        return fail(
          ErrorCodes.TOOL_SANDBOX_ESCALATION_DENIED,
          `沙箱升级被用户拒绝${decision.reason ? `：${decision.reason}` : ''}`,
        );
      }
      escalationApproved = true;
      log.info(
        { cmd: preview(command), commandNames },
        'sandbox escalation approved',
      );
    }

    // 3. 工作区边界
    if (!ctx.workspaceRoot) {
      return fail(
        ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        '未打开工作区，无法执行命令',
      );
    }

    const rootReal = await safeRealpath(ctx.workspaceRoot);
    let cwdAbs = ctx.workspaceRoot;
    if (args.cwd && args.cwd.trim()) {
      cwdAbs = isAbsolute(args.cwd)
        ? resolvePath(args.cwd)
        : resolvePath(ctx.workspaceRoot, args.cwd);
      let cwdReal: string;
      try {
        cwdReal = await fs.realpath(cwdAbs);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return fail(ErrorCodes.TOOL_PATH_INVALID, `cwd 不存在：${args.cwd}`);
        }
        return fail(
          ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
          `cwd 访问失败：${(e as Error).message}`,
        );
      }
      const relCwd = relative(rootReal, cwdReal);
      if (relCwd.startsWith('..') || isAbsolute(relCwd)) {
        return fail(
          ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
          `拒绝在工作区外执行：cwd=${args.cwd}`,
        );
      }
      cwdAbs = cwdReal;
    }

    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    // 4. is_background 分支：走 VscodeTerminalManager 立即返回
    if (args.is_background === true) {
      if (!this.terminalManager) {
        return fail(
          ErrorCodes.TOOL_EXEC_FAILED,
          'is_background=true 需 VscodeTerminalManager 注入；当前未启用。请改用 is_background=false。',
        );
      }
      const timeoutOpt =
        typeof args.timeout_ms === 'number' && Number.isInteger(args.timeout_ms)
          ? Math.max(1000, args.timeout_ms)
          : undefined;
      const snapshot = await this.terminalManager.spawn({
        command,
        cwd: cwdAbs,
        ...(timeoutOpt !== undefined ? { timeoutMs: timeoutOpt } : {}),
      });
      const header =
        `$ ${preview(command)}\n` +
        `[background] terminal_id=${snapshot.id} status=${snapshot.status}\n` +
        `使用 get_terminal_output({ terminal_id: "${snapshot.id}" }) 读取输出。\n`;
      return {
        ok: true,
        content: header,
        display: {
          command,
          isBackground: true,
          terminalId: snapshot.id,
          status: snapshot.status,
          classify: snapshot.classify,
        },
      };
    }

    // 5. 前台执行：使用 VS Code 真实终端
    if (!this.terminalManager) {
      return fail(ErrorCodes.TOOL_EXEC_FAILED, '终端管理器未注入');
    }

    // 5a. terminalMode 分派：user_visible 走用户可见终端，sandbox（或缺省）走沙箱终端
    const useUserTerminal = args.terminalMode === 'user_visible';

    log.debug(
      { cmd: command, cwd: cwdAbs, timeout, terminalMode: useUserTerminal ? 'user_visible' : 'sandbox' },
      'bash tool executing in VS Code terminal',
    );

    try {
      const runOpts = {
        command,
        cwd: cwdAbs,
        timeoutMs: timeout,
        onLine: ctx.emitOutput ? (line: string) => ctx.emitOutput!(line + '\n') : undefined,
      };
      const result = useUserTerminal
        ? await this.terminalManager.runCommandOnUserTerminal(runOpts)
        : await this.terminalManager.runCommand(runOpts);

      if (ctx.signal.aborted) {
        return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
      }

      // exitCode 缺失且无 signal 时（流自然结束但 exitCode 未捕获到）不判失败
      // 有 signal (SIGTERM等) 时判为超时/被杀死
      const exitCode = result.exitCode;
      const hasSignal = result.signal !== null && result.signal !== undefined;
      const ok = hasSignal
        ? false
        : (exitCode === 0 || exitCode === null || exitCode === undefined);

      // W9.13 沙箱遇黑判定
      const sandboxingDetected = !ok && !escalationApproved && detectSandboxingError(result.output);

      const exitCodeStr = exitCode !== null && exitCode !== undefined ? String(exitCode) : 'unknown';
      const header =
        `$ ${preview(command)}\n` +
        `exit=${exitCodeStr}${result.signal ? ` signal=${result.signal}` : ''}` +
        `${escalationApproved ? ' [escalated]' : ''}\n` +
        `---\n`;
      const sandboxHint = sandboxingDetected
        ? `\n---\n> SANDBOXING suspected. If this failure is caused by sandbox restrictions (and NOT a syntax/dependency/logic error), you MAY retry the same command with required_permissions='all' to request a user approval.\n`
        : '';

      return {
        ok,
        content: header + result.output + sandboxHint,
        display: {
          command,
          exitCode,
          signal: result.signal as string | null,
          truncated: false,
          byteCount: result.output.length,
          ...(escalationApproved ? { escalated: true } : {}),
          ...(sandboxingDetected ? { sandboxingSuggested: true } : {}),
        },
        ...(ok
          ? {}
          : {
              errorCode: sandboxingDetected
                ? ErrorCodes.TOOL_SANDBOXING_DETECTED
                : ErrorCodes.TOOL_EXEC_FAILED,
            }),
      };
    } catch (err) {
      return fail(
        ErrorCodes.TOOL_EXEC_FAILED,
        `命令执行失败：${(err as Error).message}`,
      );
    }
  }
}

// ─────────── helpers ───────────

async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return resolvePath(p);
  }
}

function preview(cmd: string): string {
  return cmd.length <= 200 ? cmd : cmd.slice(0, 200) + '…';
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
