/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Skills 解析器 + Loader 单测（W4 批次 4）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { parseSkillFile, SkillLoader } from '../../src/core/skills/index.js';

// ─────────── parser ───────────

describe('parseSkillFile', () => {
  it('derives name from parent dir when file is SKILL.md', () => {
    const { skill, error } = parseSkillFile('/tmp/skills/commit/SKILL.md', '# do it');
    expect(error).toBeUndefined();
    expect(skill!.name).toBe('commit');
  });

  it('derives name from filename for flat layout', () => {
    const { skill } = parseSkillFile('/tmp/skills/review.md', '# review code');
    expect(skill!.name).toBe('review');
  });

  it('parses description + arguments frontmatter', () => {
    const raw = `---\nname: pr-review\ndescription: Review a GitHub PR\narguments: "<pr-number>"\n---\nSteps:\n1. fetch diff`;
    const { skill } = parseSkillFile('/tmp/s/SKILL.md', raw);
    expect(skill!.name).toBe('pr-review');
    expect(skill!.description).toBe('Review a GitHub PR');
    expect(skill!.argumentsHint).toBe('<pr-number>');
    expect(skill!.content).toContain('fetch diff');
  });

  it('rejects empty body', () => {
    const { error } = parseSkillFile('/tmp/skills/empty/SKILL.md', '---\nname: x\n---\n\n');
    expect(error).toMatch(/Skill body is empty/);
  });

  it('rejects invalid frontmatter line', () => {
    const raw = `---\nnot-a-pair\n---\nx`;
    const { error } = parseSkillFile('/tmp/s/SKILL.md', raw);
    expect(error).toMatch(/Invalid frontmatter line/);
  });

  it('handles no frontmatter at all', () => {
    const { skill } = parseSkillFile('/tmp/a.md', '# just body');
    expect(skill!.description).toBe('');
    expect(skill!.argumentsHint).toBeUndefined();
    expect(skill!.content).toContain('just body');
  });
});

// ─────────── loader ───────────

describe('SkillLoader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'skills-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeFile(rel: string, body: string) {
    const full = join(dir, rel);
    await fs.mkdir(join(dir, rel, '..'), { recursive: true });
    await fs.writeFile(full, body, 'utf8');
  }

  it('returns empty when skills dir missing', async () => {
    const loader = new SkillLoader({ workspaceRoot: undefined, skillsDir: join(dir, 'nope') });
    const res = await loader.load();
    expect(res.skills).toEqual([]);
  });

  it('loads <name>/SKILL.md layout', async () => {
    await writeFile('commit/SKILL.md', '---\ndescription: Write commit\n---\nuse conventional commit');
    await writeFile('review/SKILL.md', '---\ndescription: Review PR\n---\ninspect diff');
    const loader = new SkillLoader({ workspaceRoot: undefined, skillsDir: dir });
    const { skills, errors } = await loader.load();
    expect(errors).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(['commit', 'review']);
    expect(skills[0].description).toBe('Write commit');
  });

  it('supports flat layout .md files', async () => {
    await writeFile('alpha.md', '# alpha body');
    await writeFile('beta.md', '# beta body');
    const loader = new SkillLoader({ workspaceRoot: undefined, skillsDir: dir });
    const { skills } = await loader.load();
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'beta']);
  });

  it('ignores non-SKILL files inside skill dirs', async () => {
    await writeFile('x/README.md', '# readme only');
    await writeFile('x/SKILL.md', '# real skill');
    const loader = new SkillLoader({ workspaceRoot: undefined, skillsDir: dir });
    const { skills } = await loader.load();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('x');
    expect(skills[0].content).toContain('real skill');
  });

  it('records parse errors and keeps good skills', async () => {
    await writeFile('good/SKILL.md', '# ok');
    await writeFile('bad/SKILL.md', '---\nnot-a-pair\n---\nx');
    const loader = new SkillLoader({ workspaceRoot: undefined, skillsDir: dir });
    const { skills, errors } = await loader.load();
    expect(skills.map((s) => s.name)).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toContain('bad');
  });

  it('dedup by name: later overrides', async () => {
    await writeFile('a/SKILL.md', '---\nname: shared\n---\nfirst');
    await writeFile('b/SKILL.md', '---\nname: shared\n---\nsecond');
    const loader = new SkillLoader({ workspaceRoot: undefined, skillsDir: dir });
    const { skills } = await loader.load();
    expect(skills).toHaveLength(1);
    expect(skills[0].content).toContain('second');
  });

  it('caches until invalidate()', async () => {
    await writeFile('a/SKILL.md', '# v1');
    const loader = new SkillLoader({ workspaceRoot: undefined, skillsDir: dir });
    const r1 = await loader.load();
    await writeFile('a/SKILL.md', '# v2');
    const r2 = await loader.load();
    expect(r1.skills[0].content).toBe(r2.skills[0].content);
    loader.invalidate();
    const r3 = await loader.load();
    expect(r3.skills[0].content).toContain('v2');
  });

  it('findByName returns skill or undefined', async () => {
    await writeFile('foo/SKILL.md', '# body');
    const loader = new SkillLoader({ workspaceRoot: undefined, skillsDir: dir });
    await loader.load();
    expect(loader.findByName('foo')?.name).toBe('foo');
    expect(loader.findByName('nope')).toBeUndefined();
  });
});
