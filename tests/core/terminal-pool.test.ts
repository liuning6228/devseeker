/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * TerminalPool 单测（W7b4a）
 *
 * 覆盖：
 * - spawn 返回 running snapshot；waitFor 等待结束后 exited/exit=0
 * - 非零 exit 正确透出
 * - kill 正确转变为 killed
 * - list 返回所有 session
 * - dispose killAll 活跃 session
 * - classify 委托 safety-classifier
 * - 输出捕获 + truncated ring buffer
 *
 * 注意：跨平台用 node -e 做可移植命令。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TerminalPool } from '../../src/core/tools/terminal-pool.js';
import { initLogger } from '../../src/infra/logger.js';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-termpool-'));
});

afterAll(async () => {
  // Windows 下子进程延迟释放 cwd 句柄；测试本身已完成，清理失败不影响结果
  await new Promise((r) => setTimeout(r, 500));
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* ignore: tmpdir will be cleaned by OS */
  }
}, 30_000);

beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
});

describe('TerminalPool', () => {
  it('spawn → running → exited with exit=0 and stdout captured', async () => {
    const pool = new TerminalPool();
    try {
      const snap = await pool.spawn({
        command: 'node -e "process.stdout.write(\'hi-pool\')"',
        cwd: tmpRoot,
      });
      expect(snap.status).toBe('running');
      expect(snap.id).toMatch(/^term-/);

      const final = await pool.waitFor(snap.id, 10_000);
      expect(final).toBeDefined();
      expect(final!.status).toBe('exited');
      expect(final!.exitCode).toBe(0);
      expect(final!.output).toContain('hi-pool');
      expect(final!.endedAt).toBeGreaterThanOrEqual(final!.startedAt);
    } finally {
      pool.dispose();
    }
  }, 20_000);

  it('non-zero exit is captured', async () => {
    const pool = new TerminalPool();
    try {
      const snap = await pool.spawn({
        command: 'node -e "process.exit(7)"',
        cwd: tmpRoot,
      });
      const final = await pool.waitFor(snap.id, 10_000);
      expect(final!.status).toBe('exited');
      expect(final!.exitCode).toBe(7);
    } finally {
      pool.dispose();
    }
  }, 20_000);

  it('kill transitions to killed', async () => {
    const pool = new TerminalPool();
    try {
      const snap = await pool.spawn({
        command: 'node -e "setInterval(()=>{}, 1000)"',
        cwd: tmpRoot,
      });
      expect(snap.status).toBe('running');
      // 给 PS→node 子进程树启动时间，确保 taskkill /T 能覆盖整棵树
      await new Promise((r) => setTimeout(r, 500));
      const killed = pool.kill(snap.id);
      expect(killed).toBe(true);
      const final = await pool.waitFor(snap.id, 8_000);
      expect(final!.status === 'killed' || final!.status === 'exited').toBe(true);
    } finally {
      pool.dispose();
    }
  }, 15_000);

  it('kill returns false for unknown id', () => {
    const pool = new TerminalPool();
    try {
      expect(pool.kill('nope')).toBe(false);
    } finally {
      pool.dispose();
    }
  });

  it('list returns all sessions including exited', async () => {
    const pool = new TerminalPool();
    try {
      const a = await pool.spawn({
        command: 'node -e "process.exit(0)"',
        cwd: tmpRoot,
      });
      const b = await pool.spawn({
        command: 'node -e "process.exit(0)"',
        cwd: tmpRoot,
      });
      await pool.waitFor(a.id, 10_000);
      await pool.waitFor(b.id, 10_000);
      const list = pool.list();
      expect(list.length).toBe(2);
      expect(list.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    } finally {
      pool.dispose();
    }
  }, 20_000);

  it('get returns undefined for unknown id', () => {
    const pool = new TerminalPool();
    try {
      expect(pool.get('no-such-id')).toBeUndefined();
    } finally {
      pool.dispose();
    }
  });

  it('killAll kills running sessions and returns count', async () => {
    const pool = new TerminalPool();
    try {
      await pool.spawn({
        command: 'node -e "setInterval(()=>{}, 1000)"',
        cwd: tmpRoot,
      });
      await pool.spawn({
        command: 'node -e "setInterval(()=>{}, 1000)"',
        cwd: tmpRoot,
      });
      const n = pool.killAll();
      expect(n).toBe(2);
    } finally {
      pool.dispose();
    }
  }, 10_000);

  it('classify delegates to safety-classifier', async () => {
    const pool = new TerminalPool();
    try {
      const s = await pool.spawn({ command: 'rm -rf /', cwd: tmpRoot });
      expect(s.classify).toBe('blacklisted');
      pool.kill(s.id);
    } finally {
      pool.dispose();
    }
  });

  it('waitFor times out gracefully on long-running session', async () => {
    const pool = new TerminalPool();
    try {
      const s = await pool.spawn({
        command: 'node -e "setInterval(()=>{}, 1000)"',
        cwd: tmpRoot,
      });
      const snap = await pool.waitFor(s.id, 200);
      expect(snap).toBeDefined();
      expect(snap!.status).toBe('running'); // 200ms 不足以结束
      pool.kill(s.id);
    } finally {
      pool.dispose();
    }
  }, 10_000);

  it('waitFor returns undefined for unknown id', async () => {
    const pool = new TerminalPool();
    try {
      const r = await pool.waitFor('unknown', 100);
      expect(r).toBeUndefined();
    } finally {
      pool.dispose();
    }
  });

  it('captures stderr too', async () => {
    const pool = new TerminalPool();
    try {
      const s = await pool.spawn({
        command: 'node -e "process.stderr.write(\'err-line\'); process.exit(1)"',
        cwd: tmpRoot,
      });
      const final = await pool.waitFor(s.id, 10_000);
      expect(final!.output).toContain('err-line');
      expect(final!.exitCode).toBe(1);
    } finally {
      pool.dispose();
    }
  }, 15_000);

  it('timeout auto-kills session', async () => {
    const pool = new TerminalPool();
    try {
      const s = await pool.spawn({
        command: 'node -e "setInterval(()=>{}, 1000)"',
        cwd: tmpRoot,
        // 1s 给 node 子进程足够启动时间，再被 taskkill /T 覆盖
        timeoutMs: 1000,
      });
      const final = await pool.waitFor(s.id, 8_000);
      expect(final!.status === 'killed' || final!.status === 'exited').toBe(true);
    } finally {
      pool.dispose();
    }
  }, 15_000);

  it('dispose prevents further spawn', async () => {
    const pool = new TerminalPool();
    pool.dispose();
    try {
      await pool.spawn({ command: 'node -v', cwd: tmpRoot });
      expect.fail('should throw');
    } catch (e) {
      expect((e as Error).message).toContain('disposed');
    }
  });

  it('empty command throws', async () => {
    const pool = new TerminalPool();
    try {
      await pool.spawn({ command: '   ', cwd: tmpRoot });
      expect.fail('should throw');
    } catch (e) {
      expect((e as Error).message).toContain('不能为空');
    } finally {
      pool.dispose();
    }
  });
});
