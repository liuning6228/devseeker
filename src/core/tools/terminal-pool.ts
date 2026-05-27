/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * TerminalPool —— 后台子进程池（DESIGN §M9.6.2 / §M9.6.3）
 *
 * 用途：
 * - `bash` 工具 `is_background=true` 时，spawn 后立即返回 `terminal_id`；
 * - `get_terminal_output` 按 id 读取 stdout/stderr 聚合输出；
 * - CancellationToken.cancel 时统一 kill 所有 running session（或指定 id）。
 *
 * 设计要点：
 * - 单例在 `extension.ts` 创建，跨工具调用共享
 * - 每个 session 保留最新 `MAX_BUFFER_BYTES` 的 ring buffer
 * - 自动回收：session 结束后保留结果至 `TTL_MS`，期间仍可 `get`；之后自动 sweep
 * - 不重新发明生命周期：直接用 `child_process.spawn`，取消走 SIGTERM → 2s → SIGKILL 兜底
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { platform } from 'node:os';
import { getLogger } from '../../infra/logger.js';
import { classifyCommand, type CommandSafety } from './safety-classifier.js';

const log = getLogger('terminal.pool');

const MAX_BUFFER_BYTES = 128 * 1024; // 128 KB / session
const TTL_MS = 10 * 60_000; // 10 分钟后清理已结束的 session
const SWEEP_INTERVAL_MS = 60_000;

export type TerminalStatus = 'running' | 'exited' | 'killed' | 'error';

export interface SpawnOptions {
  command: string;
  cwd: string;
  /** 允许调用方自定义环境；缺省 = process.env */
  env?: NodeJS.ProcessEnv;
  /** 超时（ms）；缺省不超时（直到进程自然结束或被 kill） */
  timeoutMs?: number;
  /** 每收到一行输出时的回调（用于实时推送终端输出到 UI） */
  onLine?: (line: string) => void;
}

export interface TerminalSnapshot {
  id: string;
  status: TerminalStatus;
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  byteCount: number;
  truncated: boolean;
  /** 合并的 stdout+stderr 文本（UTF-8 解码的 ring buffer） */
  output: string;
  /** 自 spawn 起经过的毫秒数 */
  elapsedMs: number;
  /** spawn 时间戳（ms） */
  startedAt: number;
  /** exit/kill 时间戳（ms），running 时为 undefined */
  endedAt?: number;
  classify: CommandSafety;
}

export interface ITerminalPool {
  spawn(opts: SpawnOptions): Promise<TerminalSnapshot>;
  get(id: string): TerminalSnapshot | undefined;
  list(): TerminalSnapshot[];
  kill(id: string): boolean;
  killAll(): number;
  /** 等待指定 session 结束或超时（ms）；返回最终 snapshot */
  waitFor(id: string, timeoutMs: number): Promise<TerminalSnapshot | undefined>;
  dispose(): void;
}

interface Session {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcess | null;
  status: TerminalStatus;
  exitCode: number | null;
  signal: string | null;
  chunks: Buffer[];
  byteCount: number;
  truncated: boolean;
  startedAt: number;
  endedAt?: number;
  classify: CommandSafety;
  emitter: EventEmitter;
  killTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
}

export class TerminalPool implements ITerminalPool {
  private readonly sessions = new Map<string, Session>();
  private counter = 0;
  private sweepTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  spawn(opts: SpawnOptions): Promise<TerminalSnapshot> {
    if (this.disposed) {
      throw new Error('TerminalPool has been disposed');
    }
    const command = (opts.command ?? '').trim();
    if (!command) throw new Error('command 不能为空');

    const id = this.nextId();
    const classify = classifyCommand(command);

    const isWindows = platform() === 'win32';
    const shell = isWindows ? 'powershell.exe' : '/bin/sh';
    const shellArgs = isWindows
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `& { ${command} }; exit $LASTEXITCODE`,
        ]
      : ['-c', command];

    const session: Session = {
      id,
      command,
      cwd: opts.cwd,
      child: null,
      status: 'running',
      exitCode: null,
      signal: null,
      chunks: [],
      byteCount: 0,
      truncated: false,
      startedAt: Date.now(),
      classify,
      emitter: new EventEmitter(),
    };
    this.sessions.set(id, session);

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
      this.appendChunk(session, Buffer.from(`spawn failed: ${(e as Error).message}\n`, 'utf-8'));
      session.emitter.emit('end');
      return Promise.resolve(toSnapshot(session));
    }

    session.child = child;

    child.stdout?.on('data', (buf: Buffer) => this.appendChunk(session, buf));
    child.stderr?.on('data', (buf: Buffer) => this.appendChunk(session, buf));

    child.on('error', (err) => {
      this.appendChunk(session, Buffer.from(`\n[error] ${err.message}\n`, 'utf-8'));
      if (session.status === 'running') {
        session.status = 'error';
        session.endedAt = Date.now();
        session.emitter.emit('end');
      }
    });

    // 优先监听 'exit'（进程死亡即触发，不依赖 stdio 关闭）。
    // Windows 下孙子进程继承 stdio 可能阻塞 'close'，因此 'exit' 更可靠。
    // 'close' 作为兜底（stdio 全部关闭后触发）。
    const onExitOrClose = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (session.endedAt !== undefined) return; // 幂等：已处理过
      if (session.killTimer) {
        clearTimeout(session.killTimer);
        session.killTimer = undefined;
      }
      if (session.timeoutTimer) {
        clearTimeout(session.timeoutTimer);
        session.timeoutTimer = undefined;
      }
      // 如果已经因 kill 被标记为 killed，保留状态；否则按 signal 判断
      if (session.status === 'running') {
        session.status = sig ? 'killed' : 'exited';
      }
      session.exitCode = code;
      session.signal = sig ?? null;
      session.endedAt = Date.now();
      session.emitter.emit('end');
      log.debug(
        { id, exitCode: code, signal: sig, status: session.status },
        'terminal session closed',
      );
    };
    child.on('exit', onExitOrClose);
    child.on('close', onExitOrClose);

    // 超时
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      session.timeoutTimer = setTimeout(() => {
        if (session.status === 'running') {
          log.info({ id, timeoutMs: opts.timeoutMs }, 'session timeout; killing');
          this.killSession(session);
        }
      }, opts.timeoutMs);
      session.timeoutTimer.unref?.();
    }

    return Promise.resolve(toSnapshot(session));
  }

  get(id: string): TerminalSnapshot | undefined {
    const s = this.sessions.get(id);
    return s ? toSnapshot(s) : undefined;
  }

  list(): TerminalSnapshot[] {
    return Array.from(this.sessions.values()).map(toSnapshot);
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
    if (s.status !== 'running') return toSnapshot(s);

    const effective = Math.max(0, Math.floor(timeoutMs));
    return await new Promise<TerminalSnapshot>((resolve) => {
      let settled = false;
      const onEnd = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(toSnapshot(s));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        s.emitter.off('end', onEnd);
        resolve(toSnapshot(s));
      }, effective);
      timer.unref?.();
      s.emitter.once('end', onEnd);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.killAll();
  }

  // ─────────── internals ───────────

  private nextId(): string {
    this.counter += 1;
    const rnd = Math.random().toString(36).slice(2, 6);
    return `term-${Date.now().toString(36)}-${this.counter}-${rnd}`;
  }

  private appendChunk(session: Session, buf: Buffer): void {
    if (session.truncated) {
      // 保留尾部：环形裁剪
      session.chunks.push(buf);
      session.byteCount += buf.length;
      let over = session.byteCount - MAX_BUFFER_BYTES;
      while (over > 0 && session.chunks.length > 0) {
        const head = session.chunks[0]!;
        if (head.length <= over) {
          session.chunks.shift();
          over -= head.length;
          session.byteCount -= head.length;
        } else {
          session.chunks[0] = head.subarray(over);
          session.byteCount -= over;
          over = 0;
        }
      }
      return;
    }
    session.chunks.push(buf);
    session.byteCount += buf.length;
    if (session.byteCount > MAX_BUFFER_BYTES) {
      session.truncated = true;
      // 裁剪到 MAX
      let over = session.byteCount - MAX_BUFFER_BYTES;
      while (over > 0 && session.chunks.length > 0) {
        const head = session.chunks[0]!;
        if (head.length <= over) {
          session.chunks.shift();
          over -= head.length;
          session.byteCount -= head.length;
        } else {
          session.chunks[0] = head.subarray(over);
          session.byteCount -= over;
          over = 0;
        }
      }
    }
  }

  private killSession(session: Session): void {
    const child = session.child;
    if (!child) return;
    // 提前标记，避免 exit 的 code=null/signal=null 反而退回 'exited'
    if (session.status === 'running') {
      session.status = 'killed';
    }
    const isWindows = platform() === 'win32';
    // Windows：PowerShell 包装 + node 子进程构成进程树，直接 child.kill 只杀 PS；
    // 用 taskkill /F /T 按 PID 杀整树，最可靠。
    if (isWindows && child.pid !== undefined) {
      try {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
          windowsHide: true,
        });
      } catch {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    session.killTimer = setTimeout(() => {
      try {
        if (isWindows && child.pid !== undefined) {
          spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
            windowsHide: true,
          });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* ignore */
      }
    }, 2000);
    session.killTimer.unref?.();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.status !== 'running' && s.endedAt !== undefined && now - s.endedAt > TTL_MS) {
        this.sessions.delete(id);
      }
    }
  }
}

function toSnapshot(s: Session): TerminalSnapshot {
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
    output: Buffer.concat(s.chunks).toString('utf-8'),
    elapsedMs: (endedAt ?? Date.now()) - s.startedAt,
    startedAt: s.startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    classify: s.classify,
  };
}
