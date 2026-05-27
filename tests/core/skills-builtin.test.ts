/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 内置种子 Skills 单测（W8.7）
 *
 * 覆盖：
 * - BUILTIN_SKILLS 结构完整性（name / description / content）
 * - 五个种子 skill 存在：commit / review / fix-bug / research / refactor
 * - SkillLoader 注入 builtin：无 workspace 目录也能加载
 * - workspace 同名 skill 覆盖 builtin（用户版优先）
 * - 没有 workspace skill 时，builtin 保留
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import {
  SkillLoader,
  BUILTIN_SKILLS,
  BUILTIN_SKILL_NAMES,
} from '../../src/core/skills/index.js';

describe('BUILTIN_SKILLS structure', () => {
  it('contains five seed skills', () => {
    expect(BUILTIN_SKILL_NAMES).toEqual(['commit', 'review', 'fix-bug', 'research', 'refactor']);
    expect(BUILTIN_SKILLS).toHaveLength(5);
  });

  it('each builtin has non-empty name/description/content and virtual filePath', () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.name).toBeTruthy();
      expect(s.description.length).toBeGreaterThan(10);
      expect(s.content.length).toBeGreaterThan(100);
      expect(s.filePath).toMatch(/^<builtin>\//);
    }
  });

  it('is frozen / immutable array', () => {
    expect(Object.isFrozen(BUILTIN_SKILLS)).toBe(true);
    expect(Object.isFrozen(BUILTIN_SKILL_NAMES)).toBe(true);
  });

  it('commit skill content references conventional commits', () => {
    const commit = BUILTIN_SKILLS.find((s) => s.name === 'commit');
    expect(commit).toBeDefined();
    expect(commit!.content).toMatch(/Conventional Commits/i);
    expect(commit!.content).toMatch(/git status/);
  });

  it('review skill content references evidence format path#Lxx', () => {
    const review = BUILTIN_SKILLS.find((s) => s.name === 'review');
    expect(review).toBeDefined();
    expect(review!.content).toMatch(/path#L/);
  });

  it('fix-bug skill enforces minimal diff + verification', () => {
    const fix = BUILTIN_SKILLS.find((s) => s.name === 'fix-bug');
    expect(fix).toBeDefined();
    expect(fix!.content).toMatch(/最小(\s*)diff/);
    expect(fix!.content).toMatch(/验证/);
  });

  it('research skill prefers Research subagent dispatch', () => {
    const research = BUILTIN_SKILLS.find((s) => s.name === 'research');
    expect(research).toBeDefined();
    expect(research!.content).toMatch(/Research/);
    expect(research!.content).toMatch(/Agent\(/);
  });

  it('refactor skill enforces five-step SOP (SCAN/PLAN/BATCH/VERIFY/REPORT)', () => {
    const refactor = BUILTIN_SKILLS.find((s) => s.name === 'refactor');
    expect(refactor).toBeDefined();
    expect(refactor!.content).toMatch(/SCAN/);
    expect(refactor!.content).toMatch(/PLAN/);
    expect(refactor!.content).toMatch(/BATCH/);
    expect(refactor!.content).toMatch(/VERIFY/);
    expect(refactor!.content).toMatch(/REPORT/);
  });
});

describe('SkillLoader + builtin injection', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'skills-builtin-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeFile(rel: string, body: string) {
    const full = join(dir, rel);
    await fs.mkdir(join(dir, rel, '..'), { recursive: true });
    await fs.writeFile(full, body, 'utf8');
  }

  it('exposes builtin when workspace dir is absent', async () => {
    const loader = new SkillLoader({
      workspaceRoot: undefined,
      skillsDir: join(dir, 'nope'),
      builtinSkills: BUILTIN_SKILLS,
    });
    const { skills } = await loader.load();
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['commit', 'fix-bug', 'refactor', 'research', 'review']);
  });

  it('exposes builtin when workspace dir exists but empty', async () => {
    const loader = new SkillLoader({
      workspaceRoot: undefined,
      skillsDir: dir,
      builtinSkills: BUILTIN_SKILLS,
    });
    const { skills } = await loader.load();
    expect(skills.map((s) => s.name).sort()).toEqual([
      'commit',
      'fix-bug',
      'refactor',
      'research',
      'review',
    ]);
  });

  it('workspace skill overrides builtin by same name', async () => {
    await writeFile(
      'commit/SKILL.md',
      '---\ndescription: User overridden commit\n---\nMy custom commit workflow',
    );
    const loader = new SkillLoader({
      workspaceRoot: undefined,
      skillsDir: dir,
      builtinSkills: BUILTIN_SKILLS,
    });
    const { skills } = await loader.load();
    const commit = skills.find((s) => s.name === 'commit');
    expect(commit?.description).toBe('User overridden commit');
    expect(commit?.content).toContain('My custom commit workflow');
    // 其他 builtin 保留
    expect(skills.find((s) => s.name === 'review')).toBeDefined();
    expect(skills.find((s) => s.name === 'research')).toBeDefined();
    expect(skills.find((s) => s.name === 'fix-bug')).toBeDefined();
  });

  it('workspace skill with new name coexists with builtin', async () => {
    await writeFile('deploy/SKILL.md', '---\ndescription: Deploy\n---\nRun deploy script');
    const loader = new SkillLoader({
      workspaceRoot: undefined,
      skillsDir: dir,
      builtinSkills: BUILTIN_SKILLS,
    });
    const { skills } = await loader.load();
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['commit', 'deploy', 'fix-bug', 'refactor', 'research', 'review']);
  });

  it('without builtinSkills option: W4 behavior unchanged (empty when no workspace)', async () => {
    const loader = new SkillLoader({
      workspaceRoot: undefined,
      skillsDir: join(dir, 'missing'),
    });
    const { skills } = await loader.load();
    expect(skills).toEqual([]);
  });

  it('findByName works for builtin', async () => {
    const loader = new SkillLoader({
      workspaceRoot: undefined,
      skillsDir: join(dir, 'nope'),
      builtinSkills: BUILTIN_SKILLS,
    });
    await loader.load();
    expect(loader.findByName('commit')?.filePath).toMatch(/^<builtin>/);
    expect(loader.findByName('research')).toBeDefined();
    expect(loader.findByName('unknown')).toBeUndefined();
  });
});
