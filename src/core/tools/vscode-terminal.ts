/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * VS Code 真实终端管理器
 *
 * 替代 TerminalPool 的 child_process.spawn 伪终端，
 * 使用 VS Code 集成终端 + Shell Integration API 执行命令。
 *
 * 参考 Cline 实现：
 * - VscodeTerminalRegistry: 终端实例注册表
 * - VscodeTerminalProcess: 命令执行 + 输出流读取
 * - VscodeTerminalManager: 终端生命周期管理 + 复用
 *
 * Shell Integration API:
 * - terminal.shellIntegration.executeCommand(cmd) → { read(): AsyncIterable<string> }
 * - OSC 633;D;exitCode 序列提供退出码
 * - 无 shellIntegration 时降级到 child_process.spawn
 */

import * as vscode from 'vscode';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { platform } from 'node:os';
import { getLogger } from '../../infra/logger.js';
import { classifyCommand, type CommandSafety } from './safety-classifier.js';
import type { ITerminalPool, TerminalSnapshot, TerminalStatus, SpawnOptions } from './terminal-pool.js';

const log = getLogger('terminal.vscode');

// ─────────── ANSI 剥离 ───────────

function ansiRegex({ onlyFirst = false } = {}): RegExp {
  const ST = '(?:\\u0007|\\u001B\\u005C|\\u009C)';
  const pattern = [
    `[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?${ST})`,
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|');
  return new RegExp(pattern, onlyFirst ? undefined : 'g');
}

export function stripAnsi(str: string): string {
  return str.replace(ansiRegex(), '');
}

// ─────────── 常量 ───────────

const SHELL_INTEGRATION_TIMEOUT_MS = 4000;
const SHELL_INTEGRATION_POLL_MS = 100;
const MAX_FULL_OUTPUT_SIZE = 1024 * 1024; // 1MB
const MAX_UNRETRIEVED_LINES = 500;
const TRUNCATE_KEEP_LINES = 100;
const FALLBACK_WAIT_MS = 3000;

// VS Code 1.93+ 已内置 Terminal.shellIntegration 类型，无需 declare module 扩展

// ─────────── TerminalRegistry ───────────

export interface TerminalInfo {
  id: number;
  terminal: vscode.Terminal;
  busy: boolean;
  lastCommand: string;
  shellPath?: string;
  lastActive: number;
  pendingCwdChange?: string;
  cwdResolved?: { resolve: () => void; reject: (err: Error) => void };
}

/**
 * 管理所有 VS Code Terminal 实例。
 * 跟踪 busy/idle 状态，支持终端复用。
 */
export class TerminalRegistry {
  private static terminals: TerminalInfo[] = [];
  private static nextId = 1;

  static createTerminal(cwd?: string | vscode.Uri, shellPath?: string, name?: string): TerminalInfo {
    const terminalOptions: vscode.TerminalOptions = {
      cwd,
      name: name ?? 'DevSeeker',
      env: { DUALMIND_ACTIVE: 'true' },
    };
    if (shellPath) {
      terminalOptions.shellPath = shellPath;
    }
    const terminal = vscode.window.createTerminal(terminalOptions);
    terminal.show(true); // preserveFocus=true: 让终端在面板中可见（有视觉槽位），但不抢焦点
    TerminalRegistry.nextId++;
    const info: TerminalInfo = {
      id: TerminalRegistry.nextId,
      terminal,
      busy: false,
      lastCommand: '',
      shellPath,
      lastActive: Date.now(),
    };
    TerminalRegistry.terminals.push(info);
    return info;
  }

  static getTerminal(id: number): TerminalInfo | undefined {
    const info = TerminalRegistry.terminals.find((t) => t.id === id);
    if (info && TerminalRegistry.isTerminalClosed(info.terminal)) {
      TerminalRegistry.removeTerminal(id);
      return undefined;
    }
    return info;
  }

  static updateTerminal(id: number, updates: Partial<TerminalInfo>): void {
    const info = TerminalRegistry.getTerminal(id);
    if (info) {
      Object.assign(info, updates);
    }
  }

  static removeTerminal(id: number): void {
    TerminalRegistry.terminals = TerminalRegistry.terminals.filter((t) => t.id !== id);
  }

  static getAllTerminals(): TerminalInfo[] {
    TerminalRegistry.terminals = TerminalRegistry.terminals.filter(
      (t) => !TerminalRegistry.isTerminalClosed(t.terminal),
    );
    return TerminalRegistry.terminals;
  }

  private static isTerminalClosed(terminal: vscode.Terminal): boolean {
    return terminal.exitStatus !== undefined;
  }
}

// ─────────── TerminalProcess ───────────

export interface TerminalCompletionDetails {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

interface TerminalProcessEvents {
  line: [line: string];
  completed: [details?: TerminalCompletionDetails];
  continue: [];
  no_shell_integration: [];
}

/**
 * 封装一次 VS Code 终端命令执行。
 * 有 shellIntegration 时通过 executeCommand().read() 流式读取输出；
 * 无 shellIntegration 时降级到 child_process.spawn。
 */
export class TerminalProcess extends EventEmitter<TerminalProcessEvents> {
  private isListening = true;
  private buffer = '';
  private fullOutput = '';
  private lastRetrievedIndex = 0;
  private exitCode: number | null | undefined = undefined;
  private signal: NodeJS.Signals | null = null;
  /** onDidEndTerminalShellExecution 事件 exitCode（兜底） */
  private eventExitCodePromise: Promise<number | undefined> | undefined;
  /** 超时/continue 时标记，让 for await 循环能主动 break */
  private aborted = false;

  /**
   * 在 VS Code 终端中执行命令并流式读取输出。
   */
  async run(terminal: vscode.Terminal, command: string): Promise<void> {
    this.exitCode = undefined;
    this.signal = null;

    if (terminal.shellIntegration?.executeCommand) {
      const execution = terminal.shellIntegration.executeCommand(command);

      // 注册 onDidEndTerminalShellExecution 作为 exitCode 第二来源（兜底）
      // stream 中 OSC 633;D 序列是第一来源
      this.eventExitCodePromise = new Promise<number | undefined>((resolve) => {
        const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
          if (event.execution === execution) {
            disposable.dispose();
            resolve(event.exitCode);
          }
        });
        // 120s safety：防止事件从不触发导致内存泄漏
        const safety = setTimeout(() => { disposable.dispose(); resolve(undefined); }, 120_000);
        safety.unref?.();
      });

      const stream = execution.read();
      let isFirstChunk = true;
      let didOutputNonCommand = false;
      let didEmitEmptyLine = false;
      // 标准 for await...of 消费 stream —— Cline 方案
      // stream 自然结束即命令完成，不再需要 Promise.race / idle timeout
      // 注意：emitIfChunk 已确保每次 chunk 都立即 emit（不等待换行），
      // 因此不再需要 idleFlushTimer。
      // 超时/continue 时标记 aborted，让循环能主动 break，
      // 避免 pipe/&& 命令不发射 633;D 导致 stream 永不休止。
      for await (const rawChunk of stream) {
        if (this.aborted) break;
        // 从流数据解析 OSC 633;D;exitCode（第一 exitCode 来源）
        const completionMatches = [...rawChunk.matchAll(/\]633;D(?:;(-?\d+))?/g)];
        const latestMatch = completionMatches[completionMatches.length - 1];
        let commandDone = false;
        if (latestMatch) {
          commandDone = true;
          if (latestMatch[1] !== undefined) {
            const parsed = Number.parseInt(latestMatch[1], 10);
            if (Number.isInteger(parsed)) {
              this.exitCode = parsed;
            }
          } else {
            this.exitCode = 0;
          }
        }

        let data = rawChunk;

        // 首块数据：清理 VS Code shell integration 元数据
        if (isFirstChunk) {
          const outputBetweenSequences = this.removeLastLineArtifacts(
            data.match(/\]633;C([\s\S]*?)\]633;D/)?.[1] || '',
          ).trim();

          const vscodeSequenceRegex = /\x1b\]633;.[^\x07]*\x07/g;
          const lastMatch = [...data.matchAll(vscodeSequenceRegex)].pop();
          if (lastMatch && lastMatch.index !== undefined) {
            data = data.slice(lastMatch.index + lastMatch[0].length);
          }
          if (outputBetweenSequences) {
            data = outputBetweenSequences + '\n' + data;
          }

          data = stripAnsi(data);
          const lines = data ? data.split('\n') : [];
          if (lines.length > 0) {
            lines[0] = lines[0].replace(/[^\x20-\x7E]/g, '');
          }
          // 去重复首字符（终端 artifact）
          if (
            lines.length > 0 &&
            lines[0].length >= 2 &&
            lines[0][0] === lines[0][1] &&
            !['[', '{', '"', "'", '<', '('].includes(lines[0][0])
          ) {
            lines[0] = lines[0].slice(1);
          }
          if (lines.length > 0) {
            lines[0] = lines[0].replace(/^[\x00-\x1F%$>#\s]*/, '');
          }
          if (lines.length > 1) {
            lines[1] = lines[1].replace(/^[\x00-\x1F%$>#\s]*/, '');
          }
          data = lines.join('\n');
          isFirstChunk = false;
        } else {
          data = stripAnsi(data);
        }

        // Ctrl+C 检测
        if (data.includes('^C') || data.includes('\u0003')) {
          break;
        }

        // 跳过命令回显
        if (!didOutputNonCommand) {
          const lines = data.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (command.includes(lines[i].trim())) {
              lines.splice(i, 1);
              i--;
            } else {
              didOutputNonCommand = true;
              break;
            }
          }
          data = lines.join('\n');
        }

        if (!didEmitEmptyLine && !this.fullOutput && data) {
          this.emit('line', '');
          didEmitEmptyLine = true;
        }

        this.fullOutput += data;

        // 内存保护
        if (this.fullOutput.length > MAX_FULL_OUTPUT_SIZE) {
          this.fullOutput = this.fullOutput.slice(-MAX_FULL_OUTPUT_SIZE / 2);
          this.lastRetrievedIndex = 0;
        }

        if (this.isListening) {
          this.emitIfChunk(data);
          this.lastRetrievedIndex = this.fullOutput.length - this.buffer.length;
        }

        // 633;D 已到达，命令已完成，主动退出循环
        if (commandDone) {
          break;
        }
      }

      this.emitRemainingBufferIfListening();

      // 如果流数据中未解析到 exitCode，使用 onDidEndTerminalShellExecution 兜底
      if (this.exitCode === undefined) {
        // 只等很短时间（2s），避免 pipe/| 等命令不发射 633;D 导致无限等待。
        // onDidEndTerminalShellExecution 事件可能比 stream 结束晚很多，
        // 对于 tail/tee 等 pipe 命令，633;D 序列可能在 stream 关闭前几秒才到达，
        // 这里给 event 最多 2s 时间收集 exitCode。
        const eventExitCode = this.eventExitCodePromise
          ? await new Promise<number | undefined>((resolve) => {
              let settled = false;
              const safetyTimer = setTimeout(() => {
                if (settled) return;
                settled = true;
                resolve(undefined);
              }, 2000);
              safetyTimer.unref?.();
              this.eventExitCodePromise!.then((code) => {
                if (settled) return;
                settled = true;
                clearTimeout(safetyTimer);
                resolve(code);
              });
            })
          : undefined;
        if (eventExitCode !== undefined) {
          this.exitCode = eventExitCode;
        } else {
          // stream 已自然结束但 exitCode 仍未知 → 标记为 0（命令正常完成无输出）
          this.exitCode = 0;
        }
      }

      // 空输出回退：shell integration 捕获失败，用剪贴板快照（Cline fallback 方案）
      if (!this.fullOutput.trim()) {
        try {
          const clipboardSnapshot = await captureTerminalOutput();
          if (clipboardSnapshot) {
            this.fullOutput = clipboardSnapshot;
          }
        } catch (e) {
          log.warn({ err: String(e) }, 'clipboard fallback failed');
        }
      }

      this.emit('completed', this.getCompletionDetails());
      this.emit('continue');
    } else {
      // 无 shellIntegration → 降级
      log.warn('No shell integration available, falling back');
      this.emit('no_shell_integration');
      terminal.sendText(command, true);
      await new Promise((resolve) => setTimeout(resolve, FALLBACK_WAIT_MS));
      this.emit('completed', this.getCompletionDetails());
      this.emit('continue');
    }
  }

  continue(): void {
    this.aborted = true;
    this.emitRemainingBufferIfListening();
    this.isListening = false;
    this.removeAllListeners('line');
    this.emit('continue');
  }

  getUnretrievedOutput(): string {
    const unretrieved = this.fullOutput.slice(this.lastRetrievedIndex);
    this.lastRetrievedIndex = this.fullOutput.length;
    const lines = unretrieved.split('\n');
    if (lines.length > MAX_UNRETRIEVED_LINES) {
      const first = lines.slice(0, TRUNCATE_KEEP_LINES);
      const last = lines.slice(-TRUNCATE_KEEP_LINES);
      const skipped = lines.length - first.length - last.length;
      return this.removeLastLineArtifacts(
        [...first, `\n... (${skipped} lines truncated) ...\n`, ...last].join('\n'),
      );
    }
    return this.removeLastLineArtifacts(unretrieved);
  }

  getFullOutput(): string {
    return this.fullOutput;
  }

  getCompletionDetails(): TerminalCompletionDetails {
    return { exitCode: this.exitCode, signal: this.signal };
  }

  /**
   * emitIfChunk — 将 chunk 按行拆分后逐行 emit，最后一段即使无换行也立即 emit（不滞留）。
   * 替代 emitIfEol：消除了"末尾无 \\n 的文本滞留在 buffer 直到下一块 chunk 才发出"的延迟。
   */
  private emitIfChunk(chunk: string): void {
    if (!chunk) return;
    // 保留前一 chunk 末尾无换行的残余（若有则拼到头）
    let data = this.buffer + chunk;
    const lines = data.split('\n');
    // 最后一段可能不完整（无换行），放回 buffer 但不滞留立即 emit
    // 保留 buffer 用于跨 chunk 的"换行对齐"，但每块均无条件 emit 最后一段
    const lastLine = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed) {
        this.emit('line', trimmed);
      }
    }
    // 最后一段无条件 emit（即使无换行），消除无换行文本的滞留问题
    if (lastLine) {
      this.emit('line', lastLine);
    }
    // buffer 仅保留无换行的尾段用于下一块拼接，但不再等换行才 emit
    this.buffer = lastLine;
  }

  private emitRemainingBufferIfListening(): void {
    if (this.buffer && this.isListening) {
      const remaining = this.removeLastLineArtifacts(this.buffer);
      if (remaining) {
        this.emit('line', remaining);
      }
      this.buffer = '';
      this.lastRetrievedIndex = this.fullOutput.length;
    }
  }

  removeLastLineArtifacts(output: string): string {
    const lines = output.trimEnd().split('\n');
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      lines[lines.length - 1] = lastLine.replace(/[%$#>]\s*$/, '');
    }
    return lines.join('\n').trimEnd();
  }
}

// ─────────── 内部 Session（兼容 ITerminalPool） ───────────

interface ManagedSession {
  id: string;
  command: string;
  cwd: string;
  status: TerminalStatus;
  exitCode: number | null;
  signal: string | null;
  output: string;
  byteCount: number;
  truncated: boolean;
  startedAt: number;
  endedAt?: number;
  classify: CommandSafety;
  emitter: EventEmitter;
  terminalInfo?: TerminalInfo;
  process?: TerminalProcess;
  childProcess?: ChildProcess;
  killTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
}

// ─────────── VscodeTerminalManager ───────────

/**
 * VS Code 真实终端管理器，实现 ITerminalPool 接口。
 *
 * 优先使用 shellIntegration API 在 VS Code 集成终端中执行命令；
 * 无 shellIntegration 时降级到 child_process.spawn（保留伪终端语义）。
 */
export class VscodeTerminalManager implements ITerminalPool {
  private readonly sessions = new Map<string, ManagedSession>();
  private counter = 0;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * 沙箱单终端：整个会话只创建一次，所有非后台命令复用它。
   * shellIntegration.executeCommand() 天然保证输出隔离。
   */
  private sandboxTerminal: TerminalInfo | undefined;
  /** 创建沙箱终端时的工作区路径，用于重建时判断 */
  private sandboxCwd: string | undefined;
  /** 沙箱终端的 shellIntegration 是否已经确认就绪过 */
  private sandboxShellIntegrationReady = false;

  /** 用户可见终端单例 */
  private userTerminal: TerminalInfo | undefined;
  /** 用户可见终端的工作区路径 */
  private userTerminalCwd: string | undefined;
  /** 用户可见终端的 shellIntegration 是否已经确认就绪过 */
  private userTerminalShellIntegrationReady = false;

  constructor() {
    // 注册 shell integration 事件监听（提升输出一致性）
    try {
      const disposable = (vscode.window as any).onDidStartTerminalShellExecution?.(
        async (e: any) => {
          e?.execution?.read();
        },
      );
      if (disposable) {
        this.disposables.push(disposable);
      }
    } catch {
      // 旧版 VS Code 不支持
    }
  }

  /**
   * 等待终端 shell integration 就绪（参考 Cline 实现）。
   * 新创建的终端需要 1-3 秒初始化 shell integration；
   * 如果不等待，executeCommand 为 undefined，命令会降级到不可见的 child_process.spawn。
   */
  private async waitForShellIntegration(terminal: vscode.Terminal): Promise<boolean> {
    if (terminal.shellIntegration?.executeCommand) return true;
    const deadline = Date.now() + SHELL_INTEGRATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SHELL_INTEGRATION_POLL_MS));
      if (terminal.shellIntegration?.executeCommand) return true;
    }
    return false;
  }

  async spawn(opts: SpawnOptions): Promise<TerminalSnapshot> {
    if (this.disposed) {
      throw new Error('VscodeTerminalManager has been disposed');
    }
    const command = (opts.command ?? '').trim();
    if (!command) throw new Error('command 不能为空');

    const id = this.nextId();
    const classify = classifyCommand(command);

    const session: ManagedSession = {
      id,
      command,
      cwd: opts.cwd,
      status: 'running',
      exitCode: null,
      signal: null,
      output: '',
      byteCount: 0,
      truncated: false,
      startedAt: Date.now(),
      classify,
      emitter: new EventEmitter(),
    };
    this.sessions.set(id, session);

    // 异步执行：创建终端 + 运行命令
    this.executeInTerminal(session, opts).catch((err) => {
      log.error({ id, err: String(err) }, 'executeInTerminal failed');
      if (session.status === 'running') {
        session.output += `\n[error] ${(err as Error).message}\n`;
        session.status = 'error';
        session.endedAt = Date.now();
        session.emitter.emit('end');
      }
    });

    return this.toSnapshot(session);
  }

  /**
   * 前台执行命令：在 VS Code 终端中可见执行，等待完成后返回完整输出。
   * 供 BashTool 非后台模式使用。
   *
   * 超时逻辑：1 层 Promise.race（参考 Cline CommandOrchestrator 方案）。
   * 超时 = 切背景模式（process.continue），非杀死。
   * 无 shell integration 时降级到 child_process.spawn。
   */
  async runCommand(opts: SpawnOptions): Promise<{
    output: string;
    exitCode: number | null;
    signal: string | null;
  }> {
    if (this.disposed) {
      throw new Error('VscodeTerminalManager has been disposed');
    }
    const command = (opts.command ?? '').trim();
    if (!command) throw new Error('command 不能为空');

    log.debug({ cmd: command.slice(0, 80), cwd: opts.cwd }, 'runCommand (foreground, terminal visible)');

    // 获取/创建 VS Code 终端（沙箱单终端）
    const terminalInfo = await this.getOrCreateTerminal(opts.cwd);

    // shellIntegration 已确认就绪过 → 直接执行，跳过 4s 等待
    let hasShellIntegration = this.sandboxShellIntegrationReady;
    if (!hasShellIntegration) {
      hasShellIntegration = await this.waitForShellIntegration(terminalInfo.terminal);
      this.sandboxShellIntegrationReady = hasShellIntegration;
    }

    if (!hasShellIntegration) {
      // 无 shell integration → 降级到 child_process（不可见但可靠）
      log.warn({ cwd: opts.cwd }, 'runCommand: no shell integration, falling back to child_process');
      return this.runCommandFallback(opts);
    }

    // 有 shell integration → 在沙箱终端中执行
    terminalInfo.busy = true;
    terminalInfo.lastCommand = command;
    terminalInfo.lastActive = Date.now();

    try {
      const process = new TerminalProcess();
      let output = '';

      process.on('line', (line) => {
        output += line + '\n';
        opts.onLine?.(line);
      });

      // 1 层超时：Promise.race（Cline 方案）
      // 超时 = process.continue() 切背景，不杀死
      let timedOut = false;
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const runPromise = process.run(terminalInfo.terminal, command);

      const timeoutPromise = new Promise<TerminalCompletionDetails>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          process.continue();
          resolve({ exitCode: null, signal: 'SIGTERM' });
        }, timeoutMs);
      });

      // Promise.race: 进程完成 vs 超时
      const completionPromise = new Promise<TerminalCompletionDetails>((resolve) => {
        process.once('completed', (details) => {
          resolve(details ?? {});
        });
      });

      const details = await Promise.race([completionPromise, timeoutPromise]);

      return {
        output: output.trimEnd(),
        exitCode: details.exitCode ?? null,
        signal: (details.signal as string) ?? null,
      };
    } finally {
      terminalInfo.busy = false;
    }
  }

  /**
   * 在用户可见终端中前台执行命令，等待完成后返回输出与退出码。
   * 终端实例复用（单例），用户手动关闭后自动重建。
   * 用于「终端运行」模式——用户在终端面板可见执行过程，输出仍被捕获。
   *
   * 与 runCommand 的区别：
   * - runCommand 使用沙箱终端（show(false)）
   * - runCommandOnUserTerminal 使用用户可见终端（show(true)）
   */
  async runCommandOnUserTerminal(opts: SpawnOptions): Promise<{
    output: string;
    exitCode: number | null;
    signal: string | null;
  }> {
    if (this.disposed) {
      throw new Error('VscodeTerminalManager has been disposed');
    }
    const command = (opts.command ?? '').trim();
    if (!command) throw new Error('command 不能为空');

    log.debug({ cmd: command.slice(0, 80), cwd: opts.cwd }, 'runCommandOnUserTerminal');

    const terminalInfo = await this.getOrCreateUserTerminal(opts.cwd);

    let hasShellIntegration = this.userTerminalShellIntegrationReady;
    if (!hasShellIntegration) {
      hasShellIntegration = await this.waitForShellIntegration(terminalInfo.terminal);
      this.userTerminalShellIntegrationReady = hasShellIntegration;
    }

    if (!hasShellIntegration) {
      log.warn({ cwd: opts.cwd }, 'runCommandOnUserTerminal: no shell integration, falling back to child_process');
      return this.runCommandFallback(opts);
    }

    // 确保用户能看到终端
    terminalInfo.terminal.show(true);

    terminalInfo.busy = true;
    terminalInfo.lastCommand = command;
    terminalInfo.lastActive = Date.now();

    try {
      const process = new TerminalProcess();
      let output = '';

      process.on('line', (line) => {
        output += line + '\n';
        opts.onLine?.(line);
      });

      let timedOut = false;
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const runPromise = process.run(terminalInfo.terminal, command);

      const timeoutPromise = new Promise<TerminalCompletionDetails>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          process.continue();
          resolve({ exitCode: null, signal: 'SIGTERM' });
        }, timeoutMs);
      });

      const completionPromise = new Promise<TerminalCompletionDetails>((resolve) => {
        process.once('completed', (details) => {
          resolve(details ?? {});
        });
      });

      const details = await Promise.race([completionPromise, timeoutPromise]);

      return {
        output: output.trimEnd(),
        exitCode: details.exitCode ?? null,
        signal: (details.signal as string) ?? null,
      };
    } finally {
      terminalInfo.busy = false;
    }
  }

  get(id: string): TerminalSnapshot | undefined {
    const s = this.sessions.get(id);
    return s ? this.toSnapshot(s) : undefined;
  }

  list(): TerminalSnapshot[] {
    return Array.from(this.sessions.values()).map((s) => this.toSnapshot(s));
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.status !== 'running') return false;
    this.killSession(s);
    return true;
  }

  killAll(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.status === 'running') {
        this.killSession(s);
        n += 1;
      }
    }
    return n;
  }

  async waitFor(id: string, timeoutMs: number): Promise<TerminalSnapshot | undefined> {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (s.status !== 'running') return this.toSnapshot(s);

    const effective = Math.max(0, Math.floor(timeoutMs));
    return await new Promise<TerminalSnapshot>((resolve) => {
      let settled = false;
      const onEnd = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(this.toSnapshot(s));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        s.emitter.off('end', onEnd);
        resolve(this.toSnapshot(s));
      }, effective);
      timer.unref?.();
      s.emitter.once('end', onEnd);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.killAll();
    this.disposables.forEach((d) => d.dispose());
    this.sandboxTerminal = undefined;
  }

  // ─────────── internals ───────────

  private nextId(): string {
    this.counter += 1;
    const rnd = Math.random().toString(36).slice(2, 6);
    return `vterm-${Date.now().toString(36)}-${this.counter}-${rnd}`;
  }

  /**
   * 获取或创建沙箱单终端。整个 `VscodeTerminalManager` 生命周期内只建一个终端，
   * 所有前台命令（runCommand / executeInTerminal）都复用它。
   *
   * cwd 参数仅在首次创建时生效；后续复用不再检查 cwd，
   * 因为 shellIntegration.executeCommand() 在每个命令独立工作目录。
   * 终端被用户手动关闭后会自动重建。
   */
  private async getOrCreateTerminal(cwd: string): Promise<TerminalInfo> {
    // 沙箱终端已存在且未关闭 → 直接复用
    if (this.sandboxTerminal && !this.isTerminalClosed(this.sandboxTerminal.terminal)) {
      return this.sandboxTerminal;
    }

    // 终端已关闭（被用户手动关闭了）→ 重建，shellIntegration 需重新确认
    log.info({ cwd }, 'Creating sandbox terminal (first time or was closed)');
    const info = TerminalRegistry.createTerminal(cwd, undefined, 'DevSeeker (沙箱)');
    // 沙箱终端创建后隐藏回终端面板，不抢前台焦点
    info.terminal.show(false);
    this.sandboxTerminal = info;
    this.sandboxCwd = cwd;
    this.sandboxShellIntegrationReady = false;
    return info;
  }

  /**
   * 获取或创建用户可见单终端。与沙箱终端独立。
   * 整个 `VscodeTerminalManager` 生命周期内只建一个。
   * 终端创建后 show(true) 让用户可见。
   */
  private async getOrCreateUserTerminal(cwd: string): Promise<TerminalInfo> {
    if (this.userTerminal && !this.isTerminalClosed(this.userTerminal.terminal)) {
      return this.userTerminal;
    }

    log.info({ cwd }, 'Creating user-visible terminal');
    const info = TerminalRegistry.createTerminal(cwd, undefined, 'DevSeeker (终端)');
    // 用户可见终端：显示在终端面板，不抢焦点但用户能看到
    info.terminal.show(true);
    this.userTerminal = info;
    this.userTerminalCwd = cwd;
    this.userTerminalShellIntegrationReady = false;
    return info;
  }

  /** 检查 VS Code 终端是否已关闭（exitStatus 非 undefined） */
  private isTerminalClosed(terminal: vscode.Terminal): boolean {
    return terminal.exitStatus !== undefined;
  }

  /**
   * 在指定的 VS Code 终端中异步执行命令（用于 is_background 模式或用户终端模式）。
   * 与 executeInTerminal 的区别：不通过 getOrCreateTerminal 获取沙箱终端，
   * 而是直接使用传入的 terminalInfo。
   */
  private async executeInTerminalWithInfo(session: ManagedSession, opts: SpawnOptions, terminalInfo: TerminalInfo): Promise<void> {
    session.terminalInfo = terminalInfo;

    // shellIntegration 已确认就绪过 → 跳过等待
    let hasShellIntegration = terminalInfo === this.sandboxTerminal
      ? this.sandboxShellIntegrationReady
      : await this.waitForShellIntegration(terminalInfo.terminal);

    if (hasShellIntegration) {
      terminalInfo.busy = true;
      terminalInfo.lastCommand = opts.command;
      terminalInfo.lastActive = Date.now();

      const process = new TerminalProcess();
      session.process = process;

      process.on('line', (line) => {
        session.output += line + '\n';
        session.byteCount = session.output.length;
        opts.onLine?.(line);
      });

      const completionPromise = new Promise<void>((resolve) => {
        process.once('completed', (details) => {
          session.exitCode = details?.exitCode ?? null;
          session.signal = (details?.signal as string) ?? null;
          resolve();
        });
      });

      const runPromise = process.run(terminalInfo.terminal, opts.command);

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        session.timeoutTimer = setTimeout(() => {
          if (session.status === 'running') {
            log.info({ id: session.id, timeoutMs: opts.timeoutMs }, 'session timeout; continuing');
            process.continue();
            process.emit('completed', { exitCode: null, signal: 'SIGTERM' });
          }
        }, opts.timeoutMs);
        session.timeoutTimer.unref?.();
      }

      await completionPromise;
      clearTimeout(session.timeoutTimer);

      if (session.status === 'running') {
        session.status = session.signal ? 'killed' : 'exited';
      }
      session.endedAt = Date.now();
      terminalInfo.busy = false;
      session.emitter.emit('end');

      void runPromise;
    } else {
      log.warn({ cwd: opts.cwd }, `Shell integration not available after ${SHELL_INTEGRATION_TIMEOUT_MS}ms, falling back`);
      await this.executeFallback(session, opts);
    }
  }

  /**
   * 在 VS Code 沙箱终端中异步执行命令（用于 is_background 模式）。
   */
  private async executeInTerminal(session: ManagedSession, opts: SpawnOptions): Promise<void> {
    const terminalInfo = await this.getOrCreateTerminal(opts.cwd);
    return this.executeInTerminalWithInfo(session, opts, terminalInfo);
  }

  /**
   * 在指定外部终端上创建后台 session 并执行命令。
   * 用于「终端运行」模式：命令在用户终端中执行，输出仍被系统捕获。
   */
  async spawnOnTerminal(terminal: vscode.Terminal, opts: SpawnOptions): Promise<TerminalSnapshot> {
    if (this.disposed) {
      throw new Error('VscodeTerminalManager has been disposed');
    }
    const command = (opts.command ?? '').trim();
    if (!command) throw new Error('command 不能为空');

    const id = this.nextId();
    const classify = classifyCommand(command);

    const session: ManagedSession = {
      id,
      command,
      cwd: opts.cwd,
      status: 'running',
      exitCode: null,
      signal: null,
      output: '',
      byteCount: 0,
      truncated: false,
      startedAt: Date.now(),
      classify,
      emitter: new EventEmitter(),
    };
    this.sessions.set(id, session);

    // 将 vscode.Terminal 包装为 TerminalInfo
    const terminalInfo: TerminalInfo = {
      id: -1, // 外部终端，无 registry id
      terminal,
      busy: false,
      lastCommand: '',
      lastActive: Date.now(),
    };

    this.executeInTerminalWithInfo(session, opts, terminalInfo).catch((err) => {
      log.error({ id, err: String(err) }, 'executeInTerminalWithInfo failed');
      if (session.status === 'running') {
        session.output += `\n[error] ${(err as Error).message}\n`;
        session.status = 'error';
        session.endedAt = Date.now();
        session.emitter.emit('end');
      }
    });

    return this.toSnapshot(session);
  }

  /**
   * 降级执行：使用 child_process.spawn（保留原 TerminalPool 行为）。
   */
  private async executeFallback(session: ManagedSession, opts: SpawnOptions): Promise<void> {
    const isWindows = platform() === 'win32';
    const shell = isWindows ? 'powershell.exe' : '/bin/sh';
    const shellArgs = isWindows
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${opts.command} }; exit $LASTEXITCODE`]
      : ['-c', opts.command];

    let child: ChildProcess;
    try {
      child = spawn(shell, shellArgs, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
      });
    } catch (e) {
      session.status = 'error';
      session.endedAt = Date.now();
      session.output += `spawn failed: ${(e as Error).message}\n`;
      session.emitter.emit('end');
      return;
    }

    session.childProcess = child;

    child.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf-8');
      session.output += text;
      session.byteCount = session.output.length;
      opts.onLine?.(text);
    });
    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf-8');
      session.output += text;
      session.byteCount = session.output.length;
      opts.onLine?.(text);
    });

    child.on('error', (err) => {
      session.output += `\n[error] ${err.message}\n`;
      if (session.status === 'running') {
        session.status = 'error';
        session.endedAt = Date.now();
        session.emitter.emit('end');
      }
    });

    const onExitOrClose = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (session.endedAt !== undefined) return;
      if (session.killTimer) {
        clearTimeout(session.killTimer);
        session.killTimer = undefined;
      }
      if (session.timeoutTimer) {
        clearTimeout(session.timeoutTimer);
        session.timeoutTimer = undefined;
      }
      if (session.status === 'running') {
        session.status = sig ? 'killed' : 'exited';
      }
      session.exitCode = code;
      session.signal = sig ?? null;
      session.endedAt = Date.now();
      session.emitter.emit('end');
    };
    child.on('exit', onExitOrClose);
    child.on('close', onExitOrClose);

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      session.timeoutTimer = setTimeout(() => {
        if (session.status === 'running') {
          this.killSession(session);
        }
      }, opts.timeoutMs);
      session.timeoutTimer.unref?.();
    }
  }

  /**
   * 前台降级执行（child_process.spawn），等待完成。
   */
  private runCommandFallback(opts: SpawnOptions): Promise<{
    output: string;
    exitCode: number | null;
    signal: string | null;
  }> {
    return new Promise((resolve) => {
      const isWindows = platform() === 'win32';
      const shell = isWindows ? 'powershell.exe' : '/bin/sh';
      const shellArgs = isWindows
        ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${opts.command} }; exit $LASTEXITCODE`]
        : ['-c', opts.command];

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      const child = spawn(shell, shellArgs, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
      });

      const append = (buf: Buffer) => {
        chunks.push(buf);
        totalBytes += buf.length;
      };
      const onLineFallback = opts.onLine;
      child.stdout?.on('data', (buf: Buffer) => {
        append(buf);
        if (onLineFallback) {
          const text = buf.toString('utf-8');
          onLineFallback(text);
        }
      });
      child.stderr?.on('data', (buf: Buffer) => {
        append(buf);
        if (onLineFallback) {
          const text = buf.toString('utf-8');
          onLineFallback(text);
        }
      });

      let timedOut = false;
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch { /* ignore */ }
            setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000).unref();
          }, opts.timeoutMs)
        : undefined;

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ output: `spawn failed: ${err.message}`, exitCode: null, signal: null });
      });

      child.on('close', (code, sig) => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks).toString('utf-8');
        resolve({
          output,
          exitCode: timedOut ? null : (code ?? (sig ? 128 : null)),
          signal: timedOut ? 'SIGTERM' : (sig as string | null),
        });
      });
    });
  }

  private killSession(session: ManagedSession): void {
    if (session.status === 'running') {
      session.status = 'killed';
    }

    // 如果有 VS Code 终端进程，发送 Ctrl+C
    if (session.terminalInfo) {
      try {
        session.terminalInfo.terminal.sendText('\x03', false); // Ctrl+C
      } catch { /* ignore */ }
      session.terminalInfo.busy = false;
    }

    // 如果有 child_process 降级进程，kill 它
    if (session.childProcess) {
      const child = session.childProcess;
      const isWindows = platform() === 'win32';
      if (isWindows && child.pid !== undefined) {
        try {
          spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
        } catch {
          try { child.kill(); } catch { /* ignore */ }
        }
      } else {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
      session.killTimer = setTimeout(() => {
        try {
          if (isWindows && child.pid !== undefined) {
            spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
          } else {
            child.kill('SIGKILL');
          }
        } catch { /* ignore */ }
      }, 2000);
      session.killTimer.unref?.();
    }

    // 如果有 TerminalProcess，continue 它
    if (session.process) {
      try { session.process.continue(); } catch { /* ignore */ }
    }

    session.endedAt = Date.now();
    session.emitter.emit('end');
  }

  private toSnapshot(s: ManagedSession): TerminalSnapshot {
    const endedAt = s.endedAt;
    return {
      id: s.id,
      status: s.status,
      command: s.command,
      cwd: s.cwd,
      exitCode: s.exitCode,
      signal: s.signal,
      byteCount: s.byteCount,
      truncated: s.truncated,
      output: s.output,
      elapsedMs: (endedAt ?? Date.now()) - s.startedAt,
      startedAt: s.startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      classify: s.classify,
    };
  }
}

// ─────────── 剪贴板回退辅助 ───────────

/**
 * 使用剪贴板快照获取终端当前内容（Cline fallback 方案）。
 * shell integration 捕获失败时回退到此方法。
 */
async function captureTerminalOutput(): Promise<string | undefined> {
  let originalClipboard: string | undefined;
  try {
    originalClipboard = await vscode.env.clipboard.readText();
  } catch {
    // 剪贴板读失败，skip
  }

  try {
    await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');

    const terminalContents = (await vscode.env.clipboard.readText()).trim();
    if (!terminalContents || terminalContents === originalClipboard) {
      return undefined;
    }
    return terminalContents;
  } catch (e) {
    log.warn({ err: String(e) }, 'captureTerminalOutput failed');
    return undefined;
  } finally {
    if (originalClipboard !== undefined) {
      try {
        await vscode.env.clipboard.writeText(originalClipboard);
      } catch { /* ignore */ }
    }
  }
}
