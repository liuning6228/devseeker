/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * SkillTool 单测（W4 批次 4）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { SkillTool } from '../../src/core/tools/skill.js';
import { SkillLoader } from '../../src/core/skills/index.js';

let dir: string;
let loader: SkillLoader;

async function writeFile(rel: string, body: string) {
  const full = join(dir, rel);
  await fs.mkdir(join(dir, rel, '..'), { recursive: true });
  await fs.writeFile(full, body, 'utf8');
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'skilltool-'));
  await writeFile(
    'commit/SKILL.md',
    '---\ndescription: Create conventional commit\narguments: "<topic>"\n---\nWrite a conventional commit for the current staged changes.\nUse the user-provided topic as the subject hint.',
  );
  await writeFile(
    'review/SKILL.md',
    '---\ndescription: Review a PR\n---\nReview carefully.',
  );
  loader = new SkillLoader({ workspaceRoot: undefined, skillsDir: dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function mkCtx() {
  const ctl = new AbortController();
  return { workspaceRoot: undefined, signal: ctl.signal, taskId: 't', toolCallId: 'tc' };
}

describe('SkillTool', () => {
  it('description contains trigger instruction', () => {
    const t = new SkillTool({ getLoader: () => loader });
    const desc = (t as any).description as string;
    expect(desc).toContain('必须先调用此工具加载完整指令');
    expect(desc).toContain('先加载 skill');
  });

  it('rejects empty skill name', async () => {
    const t = new SkillTool({ getLoader: () => loader });
    const r = await t.execute({ skill: '' } as any, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toContain('TOOL.ARGS');
  });

  it('fails when loader not ready', async () => {
    const t = new SkillTool({ getLoader: () => undefined });
    const r = await t.execute({ skill: 'commit' }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toContain('PERMISSION');
  });

  it('returns error with available list when skill missing', async () => {
    const t = new SkillTool({ getLoader: () => loader });
    const r = await t.execute({ skill: 'nope' }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.content).toContain('commit');
    expect(r.content).toContain('review');
  });

  it('renders skill body with provided args', async () => {
    const t = new SkillTool({ getLoader: () => loader });
    const r = await t.execute({ skill: 'commit', args: 'fix login bug' }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('# Skill invoked: commit');
    expect(r.content).toContain('## Invocation arguments');
    expect(r.content).toContain('fix login bug');
    expect(r.content).toContain('conventional commit');
    expect(r.content).toContain('MUST call one or more tools');
    expect(r.content).toContain('Do NOT respond with only text');
    expect(r.content).toContain('take concrete actions');
    expect((r.display as any).skill).toBe('commit');
    expect((r.display as any).argsProvided).toBe(true);
  });

  it('renders skill body with (none) when args empty', async () => {
    const t = new SkillTool({ getLoader: () => loader });
    const r = await t.execute({ skill: 'review' }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('(none)');
    expect((r.display as any).argsProvided).toBe(false);
  });

  it('trims skill name whitespace', async () => {
    const t = new SkillTool({ getLoader: () => loader });
    const r = await t.execute({ skill: '  commit  ' }, mkCtx());
    expect(r.ok).toBe(true);
    expect((r.display as any).skill).toBe('commit');
  });
});
