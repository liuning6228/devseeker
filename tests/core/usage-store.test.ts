/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * UsageJsonlStore 单测
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UsageJsonlStore, todayStartMs } from '../../src/core/cost/usage-store.js';
import type { IUsageRecord } from '../../src/core/cost/types.js';

let tmpFile: string;

function rec(over: Partial<IUsageRecord> = {}): IUsageRecord {
  return {
    ts: Date.now(),
    provider: 'deepseek-v4',
    operation: 'chat',
    cost: 0.01,
    currency: 'CNY',
    ...over,
  };
}

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-jsonl-'));
  tmpFile = path.join(dir, 'usage.jsonl');
});

afterEach(async () => {
  try {
    await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('UsageJsonlStore', () => {
  it('append writes one record per line', async () => {
    const s = new UsageJsonlStore({ filePath: tmpFile });
    await s.append(rec({ cost: 1 }));
    await s.append(rec({ cost: 2, operation: 'embed' }));
    const raw = await fs.readFile(tmpFile, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).cost).toBe(1);
    expect(JSON.parse(lines[1]!).operation).toBe('embed');
  });

  it('readAll returns empty when file does not exist', async () => {
    const s = new UsageJsonlStore({ filePath: tmpFile });
    expect(await s.readAll()).toEqual([]);
  });

  it('readAll skips corrupted lines', async () => {
    await fs.mkdir(path.dirname(tmpFile), { recursive: true });
    await fs.writeFile(
      tmpFile,
      [
        JSON.stringify(rec({ cost: 1 })),
        '!!not json!!',
        '', // empty
        JSON.stringify({ incomplete: true }), // missing fields
        JSON.stringify(rec({ cost: 2, currency: 'USD' })),
      ].join('\n'),
      'utf-8',
    );
    const s = new UsageJsonlStore({ filePath: tmpFile });
    const all = await s.readAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.cost).toBe(1);
    expect(all[1]!.currency).toBe('USD');
  });

  it('read filters by since / until / provider / operation / sessionId', async () => {
    const s = new UsageJsonlStore({ filePath: tmpFile });
    await s.append(rec({ ts: 100, provider: 'a', operation: 'chat', sessionId: 's1' }));
    await s.append(rec({ ts: 200, provider: 'b', operation: 'chat', sessionId: 's2' }));
    await s.append(rec({ ts: 300, provider: 'a', operation: 'embed', sessionId: 's1' }));

    expect((await s.read({ since: 150 })).map((r) => r.ts)).toEqual([200, 300]);
    expect((await s.read({ until: 200 })).map((r) => r.ts)).toEqual([100]);
    expect((await s.read({ provider: 'a' })).length).toBe(2);
    expect((await s.read({ operation: 'embed' })).length).toBe(1);
    expect((await s.read({ sessionId: 's1' })).length).toBe(2);
  });

  it('gc drops records older than cutoff and returns count', async () => {
    const s = new UsageJsonlStore({ filePath: tmpFile });
    await s.append(rec({ ts: 100 }));
    await s.append(rec({ ts: 200 }));
    await s.append(rec({ ts: 300 }));
    const removed = await s.gc(200);
    expect(removed).toBe(1);
    const remaining = await s.readAll();
    expect(remaining).toHaveLength(2);
    expect(remaining.every((r) => r.ts >= 200)).toBe(true);
  });

  it('gc returns 0 when nothing to drop', async () => {
    const s = new UsageJsonlStore({ filePath: tmpFile });
    await s.append(rec({ ts: 100 }));
    expect(await s.gc(50)).toBe(0);
  });

  it('clear empties the file', async () => {
    const s = new UsageJsonlStore({ filePath: tmpFile });
    await s.append(rec());
    await s.clear();
    expect(await s.readAll()).toEqual([]);
  });

  it('append creates parent dir when missing', async () => {
    const deep = path.join(path.dirname(tmpFile), 'deep', 'nested', 'usage.jsonl');
    const s = new UsageJsonlStore({ filePath: deep });
    await s.append(rec({ cost: 42 }));
    const all = await s.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.cost).toBe(42);
  });

  it('getFilePath returns the configured path', () => {
    const s = new UsageJsonlStore({ filePath: tmpFile });
    expect(s.getFilePath()).toBe(tmpFile);
  });

  it('default filePath resolves under home dir .dualmind', () => {
    const s = new UsageJsonlStore();
    const fp = s.getFilePath();
    expect(fp).toContain('.dualmind');
    expect(fp).toContain('usage.jsonl');
  });
});

describe('todayStartMs', () => {
  it('returns midnight of the same local day', () => {
    const now = new Date(2026, 4, 2, 15, 30, 45).getTime();
    const start = todayStartMs(now);
    const d = new Date(start);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getDate()).toBe(2);
  });

  it('uses Date.now by default', () => {
    const start = todayStartMs();
    expect(start).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - start).toBeLessThan(24 * 3600 * 1000);
  });
});
