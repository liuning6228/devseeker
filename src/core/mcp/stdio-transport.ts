/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * MCP stdio transport — child_process-based（W9.5）
 *
 * 语义：
 * - spawn(command, args, env) 启动子进程
 * - 子进程 stdout 按 `\n` 分行解析 JSON-RPC 消息
 * - 子进程 stderr 合并到 onError（行流），避免漏诊断
 * - stdin 接受 JSON.stringify(msg) + '\n'
 * - exit / error 触发 onClose
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { JsonRpcMessage } from './protocol.js';
import { TransportBase, LineFramer } from './transport.js';

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 注入用：测试时替换 spawn（签名兼容 node:child_process 的 spawn） */
  spawnImpl?: typeof spawn;
}

export class StdioTransport extends TransportBase {
  private child: ChildProcess | null = null;
  private framer = new LineFramer();
  private readonly opts: StdioTransportOptions;

  constructor(opts: StdioTransportOptions) {
    super();
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const spawner = this.opts.spawnImpl ?? spawn;
    const spawnOpts: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.opts.env ?? {}) } as NodeJS.ProcessEnv,
      cwd: this.opts.cwd,
      windowsHide: true,
    };
    try {
      this.child = spawner(this.opts.command, this.opts.args ?? [], spawnOpts);
    } catch (e) {
      this.closed = true;
      this.emitError(toError(e));
      this.emitClose(`spawn failed: ${String(e)}`);
      return;
    }
    const child = this.child;
    if (!child) {
      this.closed = true;
      this.emitClose('spawn returned null');
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => {
      const msgs = this.framer.push(chunk);
      for (const m of msgs) this.emitMessage(m);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.trim()) this.emitError(new Error(`[stderr] ${text.trim()}`));
    });
    child.on('error', (err) => {
      this.emitError(err);
    });
    child.on('exit', (code, signal) => {
      if (this.closed) return;
      this.closed = true;
      this.emitClose(`child exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    });
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (!this.child || this.closed) {
      throw new Error('MCP stdio transport not open');
    }
    const line = JSON.stringify(msg) + '\n';
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin!.write(line, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(reason?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (!child) {
      this.emitClose(reason ?? 'close');
      return;
    }
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    // 软关闭 → 150ms 硬杀
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 150).unref?.();
    this.emitClose(reason ?? 'close');
  }
}

function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(String(e));
}
