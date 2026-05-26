/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * fetch_rules 工具单测（W4 批次 3）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { FetchRulesTool } from '../../src/core/tools/fetch_rules.js';
import { RuleLoader } from '../../src/core/rules/index.js';

let dir: string;
let loader: RuleLoader;

async function writeFile(rel: string, body: string) {
  const full = join(dir, rel);
  await fs.mkdir(join(dir, rel, '..'), { recursive: true });
  await fs.writeFile(full, body, 'utf8');
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'fr-'));
  await writeFile('always.md', '---\nkind: always_on\n---\nalways body');
  await writeFile(
    'md.md',
    '---\nname: md\nkind: model_decision\ndescription: model-picked\n---\nmodel body',
  );
  await writeFile('py-style.md', '---\nkind: glob\nglob: "**/*.py"\n---\npy body');
  loader = new RuleLoader({ workspaceRoot: undefined, rulesDir: dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function mkCtx(aborted = false) {
  const ctl = new AbortController();
  if (aborted) ctl.abort();
  return {
    workspaceRoot: undefined,
    signal: ctl.signal,
    taskId: 't',
    toolCallId: 'tc',
  };
}

describe('FetchRulesTool', () => {
  it('rejects missing rule_names', async () => {
    const tool = new FetchRulesTool({ getLoader: () => loader });
    const r = await tool.execute({ rule_names: [] } as any, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toContain('TOOL.ARGS');
  });

  it('fails when loader not ready', async () => {
    const tool = new FetchRulesTool({ getLoader: () => undefined });
    const r = await tool.execute({ rule_names: ['md'] }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toContain('PERMISSION');
  });

  it('fetches model_decision rule by name', async () => {
    const tool = new FetchRulesTool({ getLoader: () => loader });
    const r = await tool.execute({ rule_names: ['md'] }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('## md');
    expect(r.content).toContain('model body');
    expect((r.display as any).hits).toHaveLength(1);
    expect((r.display as any).missing).toEqual([]);
    expect((r.display as any).forbidden).toEqual([]);
  });

  it('reports missing names', async () => {
    const tool = new FetchRulesTool({ getLoader: () => loader });
    const r = await tool.execute({ rule_names: ['nope'] }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('missing=1');
    expect((r.display as any).missing).toEqual(['nope']);
  });

  it('forbids non-model_decision rules by default', async () => {
    const tool = new FetchRulesTool({ getLoader: () => loader });
    const r = await tool.execute({ rule_names: ['always', 'py-style'] }, mkCtx());
    expect((r.display as any).forbidden).toEqual(['always', 'py-style']);
    expect((r.display as any).hits).toEqual([]);
  });

  it('include_all=true lifts restriction', async () => {
    const tool = new FetchRulesTool({ getLoader: () => loader });
    const r = await tool.execute({ rule_names: ['always', 'py-style'], include_all: true }, mkCtx());
    expect((r.display as any).hits.map((h: any) => h.name).sort()).toEqual(['always', 'py-style']);
    expect((r.display as any).forbidden).toEqual([]);
  });

  it('mixed hits + missing + forbidden', async () => {
    const tool = new FetchRulesTool({ getLoader: () => loader });
    const r = await tool.execute({ rule_names: ['md', 'always', 'nope'] }, mkCtx());
    const d = r.display as any;
    expect(d.hits.map((h: any) => h.name)).toEqual(['md']);
    expect(d.forbidden).toEqual(['always']);
    expect(d.missing).toEqual(['nope']);
  });
});
