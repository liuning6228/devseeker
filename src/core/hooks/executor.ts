/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Hook 命令执行器（W5 批次 1）
 *
 * 用系统默认 shell 执行命令，stdin 传入 JSON payload，收集 stdout/stderr 与 exit code。
 * 支持超时 kill、AbortSignal 取消。
 *
 * 设计要点：
 * - 使用 `shell: true` 由 OS 默认解释（Windows: cmd；Unix: /bin/sh）
 * - stdout / stderr 软上限 64 KB，超出截断保留尾部
 * - exit != 0 视为失败；timeout → timedOut=true & exitCode=-1
 */

import { spawn } from 'node:child_process';
import type { HookPayload, HookRunResult, HookSpec } from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface RunHookOptions {
  workspaceRoot?: string;
  signal?: AbortSignal;
}

export async function runHookCommand(
  spec: HookSpec,
  payload: HookPayload,
  opts: RunHookOptions = {},
): Promise<HookRunResult> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = resolveCwd(spec.cwd, opts.workspaceRoot);
  const startedAt = Date.now();

  return new Promise<HookRunResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, {
        shell: true,
        cwd,
        env: {
          ...process.env,
          DUALMIND_HOOK_EVENT: payload.event,
          DUALMIND_HOOK_TASK_ID: payload.taskId,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({
        spec,
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: `spawn failed: ${String(e)}`,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const abortHandler = () => {
      if (finished) return;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    opts.signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout?.on('data', (buf: Buffer) => {
      stdout = appendTail(stdout, buf.toString('utf8'));
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderr = appendTail(stderr, buf.toString('utf8'));
    });
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abortHandler);
      resolve({
        spec,
        ok: false,
        exitCode: -1,
        stdout,
        stderr: stderr || String(err),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abortHandler);
      const exitCode = timedOut ? -1 : code ?? -1;
      resolve({
        spec,
        ok: !timedOut && exitCode === 0,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    // Pipe payload to stdin (best effort).
    try {
      const body = JSON.stringify(payload);
      child.stdin?.write(body);
      child.stdin?.end();
    } catch {
      /* ignore */
    }
  });
}

// ─────────── helpers ───────────

function resolveCwd(specCwd: string | undefined, workspaceRoot: string | undefined): string | undefined {
  if (!specCwd) return workspaceRoot;
  if (isAbsolute(specCwd)) return specCwd;
  if (!workspaceRoot) return specCwd;
  return joinPath(workspaceRoot, specCwd);
}

function isAbsolute(p: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/)/.test(p);
}

function joinPath(a: string, b: string): string {
  const sep = a.includes('\\') && !a.includes('/') ? '\\' : '/';
  const trimmed = a.endsWith('/') || a.endsWith('\\') ? a.slice(0, -1) : a;
  const head = b.startsWith('/') || b.startsWith('\\') ? b.slice(1) : b;
  return trimmed + sep + head;
}

function appendTail(acc: string, chunk: string): string {
  const next = acc + chunk;
  if (next.length <= MAX_OUTPUT_BYTES) return next;
  return next.slice(next.length - MAX_OUTPUT_BYTES);
}
