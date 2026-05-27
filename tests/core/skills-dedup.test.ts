/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W9.11 · SkillDedupTracker + SkillTool ALREADY LOADED 协议测试
 */

import { describe, it, expect } from 'vitest';
import {
  SkillDedupTracker,
  DEFAULT_SKILL_DEDUP_MS,
  buildAlreadyLoadedReminder,
} from '../../src/core/skills/index.js';
import { SkillTool } from '../../src/core/tools/skill.js';
import { SkillLoader } from '../../src/core/skills/loader.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// ─────────── SkillDedupTracker ───────────

describe('SkillDedupTracker', () => {
  it('defaults to 60s debounce window', () => {
    const t = new SkillDedupTracker();
    expect(t.debounceWindowMs).toBe(DEFAULT_SKILL_DEDUP_MS);
  });

  it('isLoadedRecently returns false for unknown skill', () => {
    const t = new SkillDedupTracker();
    expect(t.isLoadedRecently('unknown')).toBe(false);
    expect(t.ageMs('unknown')).toBe(-1);
  });

  it('marks and detects recent load within window', () => {
    let now = 1_000_000;
    const t = new SkillDedupTracker({ debounceMs: 60_000, now: () => now });
    t.markTriggered('commit');
    now += 1_000;
    expect(t.isLoadedRecently('commit')).toBe(true);
    expect(t.ageMs('commit')).toBe(1_000);
  });

  it('returns false after window elapses', () => {
    let now = 1_000_000;
    const t = new SkillDedupTracker({ debounceMs: 60_000, now: () => now });
    t.markTriggered('commit');
    now += 60_000; // boundary: window is strict less-than
    expect(t.isLoadedRecently('commit')).toBe(false);
    now += 1;
    expect(t.isLoadedRecently('commit')).toBe(false);
  });

  it('custom thresholdMs override wins', () => {
    let now = 1_000_000;
    const t = new SkillDedupTracker({ debounceMs: 60_000, now: () => now });
    t.markTriggered('x');
    now += 5_000;
    expect(t.isLoadedRecently('x', 1_000)).toBe(false); // narrower override
    expect(t.isLoadedRecently('x', 10_000)).toBe(true);
  });

  it('zero debounceMs disables dedup', () => {
    const t = new SkillDedupTracker({ debounceMs: 0 });
    t.markTriggered('a');
    expect(t.isLoadedRecently('a')).toBe(false);
  });

  it('forget / clear resets state', () => {
    const t = new SkillDedupTracker();
    t.markTriggered('a');
    t.markTriggered('b');
    expect(t.snapshot().size).toBe(2);
    t.forget('a');
    expect(t.snapshot().size).toBe(1);
    t.clear();
    expect(t.snapshot().size).toBe(0);
  });

  it('buildAlreadyLoadedReminder contains protocol tag and name', () => {
    const msg = buildAlreadyLoadedReminder('commit', 30_000);
    expect(msg).toContain('<command-name>commit</command-name>');
    expect(msg).toContain('30s ago');
    expect(msg).toContain('ALREADY LOADED');
    expect(msg).toContain('DO NOT re-invoke');
  });
});

// ─────────── SkillTool × dedup integration ───────────

async function makeTempSkill(name: string, body = 'Body') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `skills-dedup-${name}-`));
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir);
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill\n---\n${body}\n`,
    'utf8',
  );
  return dir;
}

describe('SkillTool × SkillDedupTracker', () => {
  it('first invocation returns full body and marks dedup', async () => {
    const dir = await makeTempSkill('foo', 'This is the real body');
    const loader = new SkillLoader({ workspaceRoot: undefined, skillsDir: dir });
    const dedup = new SkillDedupTracker();
    const tool = new SkillTool({ getLoader: () => loader, dedup });

    const res = await tool.execute({ skill: 'foo' }, {} as any);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('This is the real body');
    expect(res.content).toContain('# Skill invoked: foo');
    expect(dedup.isLoadedRecently('foo')).toBe(true);
  });

  it('second invocation within 60s returns ALREADY LOADED reminder (not full body)', async () => {
    const dir = await makeTempSkill('bar', 'THE-FULL-BODY-TOKEN');
    const loader = new SkillLoader({ workspaceRoot: undefined, skillsDir: dir });
    let now = 1_000_000;
    const dedup = new SkillDedupTracker({ debounceMs: 60_000, now: () => now });
    const tool = new SkillTool({ getLoader: () => loader, dedup });

    const first = await tool.execute({ skill: 'bar' }, {} as any);
    expect(first.ok).toBe(true);
    expect(first.content).toContain('THE-FULL-BODY-TOKEN');

    now += 10_000;
    const second = await tool.execute({ skill: 'bar' }, {} as any);
    expect(second.ok).toBe(true);
    // reminder 路径：不应再包含完整正文
    expect(second.content).not.toContain('THE-FULL-BODY-TOKEN');
    expect(second.content).toContain('<command-name>bar</command-name>');
    expect(second.content).toContain('10s ago');
    expect((second.display as any).dedup).toBe(true);
    expect((second.display as any).ageMs).toBe(10_000);
  });

  it('invocation after window elapses returns full body again', async () => {
    const dir = await makeTempSkill('baz', 'BODY');
    const loader = new SkillLoader({ workspaceRoot: undefined, skillsDir: dir });
    let now = 1_000_000;
    const dedup = new SkillDedupTracker({ debounceMs: 60_000, now: () => now });
    const tool = new SkillTool({ getLoader: () => loader, dedup });

    await tool.execute({ skill: 'baz' }, {} as any);
    now += 61_000;
    const later = await tool.execute({ skill: 'baz' }, {} as any);
    expect(later.content).toContain('# Skill invoked: baz');
    expect(later.content).toContain('BODY');
  });

  it('works without dedup dep (backward compatible)', async () => {
    const dir = await makeTempSkill('no-dedup', 'XYZ');
    const loader = new SkillLoader({ workspaceRoot: undefined, skillsDir: dir });
    const tool = new SkillTool({ getLoader: () => loader });
    const a = await tool.execute({ skill: 'no-dedup' }, {} as any);
    const b = await tool.execute({ skill: 'no-dedup' }, {} as any);
    expect(a.content).toContain('XYZ');
    expect(b.content).toContain('XYZ'); // 无 dedup 时不会去重
  });
});
