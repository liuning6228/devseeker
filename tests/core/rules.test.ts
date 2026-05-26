/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Rules 解析器 + Loader + Selector 单测（W4 批次 3）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { parseRuleFile, RuleLoader } from '../../src/core/rules/index.js';
import { matchGlob, globToRegex } from '../../src/core/rules/glob.js';
import { selectForPrompt, renderForSystemPrompt, listModelDecisionRules } from '../../src/core/rules/selector.js';
import type { Rule } from '../../src/core/rules/types.js';

// ─────────── parser ───────────

describe('parseRuleFile', () => {
  it('parses rule without frontmatter as always_on', () => {
    const raw = '# Title\n\nsome content';
    const { rule, error } = parseRuleFile('/tmp/a.md', raw);
    expect(error).toBeUndefined();
    expect(rule).toBeDefined();
    expect(rule!.name).toBe('a');
    expect(rule!.kind).toBe('always_on');
    expect(rule!.content).toContain('some content');
    expect(rule!.priority).toBe(0);
  });

  it('parses frontmatter name/kind/priority/description', () => {
    const raw = `---\nname: my-rule\nkind: glob\nglob: ["**/*.ts", "**/*.tsx"]\npriority: 5\ndescription: ts style\n---\n# body\n`;
    const { rule, error } = parseRuleFile('/tmp/x.md', raw);
    expect(error).toBeUndefined();
    expect(rule!.name).toBe('my-rule');
    expect(rule!.kind).toBe('glob');
    expect(rule!.globs).toEqual(['**/*.ts', '**/*.tsx']);
    expect(rule!.priority).toBe(5);
    expect(rule!.description).toBe('ts style');
  });

  it('rejects unknown kind', () => {
    const raw = `---\nkind: magic\n---\nx`;
    const { error } = parseRuleFile('/tmp/bad.md', raw);
    expect(error).toMatch(/Unknown rule kind/);
  });

  it('rejects kind=glob without globs', () => {
    const raw = `---\nkind: glob\n---\nx`;
    const { error } = parseRuleFile('/tmp/bad.md', raw);
    expect(error).toMatch(/requires at least one glob/);
  });

  it('accepts single-string glob', () => {
    const raw = `---\nkind: glob\nglob: "**/*.py"\n---\nx`;
    const { rule } = parseRuleFile('/tmp/p.md', raw);
    expect(rule!.globs).toEqual(['**/*.py']);
  });

  it('derives name from filename when missing', () => {
    const { rule } = parseRuleFile('/tmp/rules/typescript-style.md', '# body');
    expect(rule!.name).toBe('typescript-style');
  });

  it('handles BOM / leading whitespace before frontmatter', () => {
    const raw = '\n\n---\nname: w\n---\nbody';
    const { rule } = parseRuleFile('/tmp/w.md', raw);
    expect(rule!.name).toBe('w');
  });

  it('reports invalid frontmatter line', () => {
    const raw = `---\nnot-a-pair\n---\nbody`;
    const { error } = parseRuleFile('/tmp/e.md', raw);
    expect(error).toMatch(/Invalid frontmatter line/);
  });
});

// ─────────── glob ───────────

describe('glob', () => {
  it('matches simple extension patterns under any depth', () => {
    expect(matchGlob('**/*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('**/*.ts', 'a.ts')).toBe(true);
    expect(matchGlob('**/*.ts', 'src/a.js')).toBe(false);
  });

  it('single * does not cross directory', () => {
    expect(matchGlob('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/x/a.ts')).toBe(false);
  });

  it('bare pattern implicitly any-depth', () => {
    expect(matchGlob('*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('*.ts', 'a.ts')).toBe(true);
  });

  it('backslash path normalized', () => {
    expect(matchGlob('src/*.ts', 'src\\a.ts')).toBe(true);
  });

  it('escapes regex metachars', () => {
    const re = globToRegex('src/a.b+c.ts');
    expect(re.test('src/a.b+c.ts')).toBe(true);
    expect(re.test('src/aXb+c.ts')).toBe(false);
  });
});

// ─────────── loader ───────────

describe('RuleLoader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'rules-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeFile(rel: string, body: string) {
    const full = join(dir, rel);
    await fs.mkdir(join(dir, rel, '..'), { recursive: true });
    await fs.writeFile(full, body, 'utf8');
  }

  it('returns empty when rules dir missing', async () => {
    const loader = new RuleLoader({ workspaceRoot: undefined, rulesDir: join(dir, 'nope'), globalRulesDir: '' });
    const res = await loader.load();
    expect(res.rules).toEqual([]);
    expect(res.errors).toEqual([]);
  });

  it('loads all .md files with stable priority-desc / name-asc order', async () => {
    await writeFile('a.md', '---\npriority: 1\n---\nA');
    await writeFile('b.md', '---\npriority: 5\n---\nB');
    await writeFile('c.md', '---\npriority: 5\n---\nC');
    const loader = new RuleLoader({ workspaceRoot: undefined, rulesDir: dir, globalRulesDir: '' });
    const { rules } = await loader.load();
    expect(rules.map((r) => r.name)).toEqual(['b', 'c', 'a']);
  });

  it('records parse errors without dropping other rules', async () => {
    await writeFile('good.md', '# ok');
    await writeFile('bad.md', '---\nkind: magic\n---\nX');
    const loader = new RuleLoader({ workspaceRoot: undefined, rulesDir: dir, globalRulesDir: '' });
    const { rules, errors } = await loader.load();
    expect(rules.map((r) => r.name)).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toContain('bad.md');
  });

  it('deduplicates by name; higher priority wins', async () => {
    await writeFile('a/rule.md', '---\nname: shared\npriority: 1\n---\nlow');
    await writeFile('b/rule.md', '---\nname: shared\npriority: 10\n---\nhigh');
    const loader = new RuleLoader({ workspaceRoot: undefined, rulesDir: dir, globalRulesDir: '' });
    const { rules } = await loader.load();
    expect(rules).toHaveLength(1);
    expect(rules[0].content).toContain('high');
  });

  it('caches result until invalidate()', async () => {
    await writeFile('a.md', '# v1');
    const loader = new RuleLoader({ workspaceRoot: undefined, rulesDir: dir, globalRulesDir: '' });
    const r1 = await loader.load();
    await writeFile('a.md', '# v2');
    const r2 = await loader.load();
    expect(r1.rules[0].content).toBe(r2.rules[0].content); // cached
    loader.invalidate();
    const r3 = await loader.load();
    expect(r3.rules[0].content).toContain('v2');
  });

  // ─────────── W7b1：多源加载 + 就近覆盖 + source 字段 ───────────

  it('tags each rule with its source (workspace default)', async () => {
    await writeFile('a.md', '# workspace rule');
    const loader = new RuleLoader({
      workspaceRoot: undefined,
      rulesDir: dir,
      globalRulesDir: '',
    });
    const { rules } = await loader.load();
    expect(rules[0].source).toBe('workspace');
  });

  it('loads both global and workspace sources, tagging source correctly', async () => {
    const globalDir = await fs.mkdtemp(join(os.tmpdir(), 'rules-global-'));
    try {
      await fs.writeFile(join(globalDir, 'g.md'), '# global', 'utf8');
      await writeFile('w.md', '# workspace');
      const loader = new RuleLoader({
        workspaceRoot: undefined,
        rulesDir: dir,
        globalRulesDir: globalDir,
      });
      const { rules } = await loader.load();
      const byName = Object.fromEntries(rules.map((r) => [r.name, r]));
      expect(byName.g?.source).toBe('global');
      expect(byName.w?.source).toBe('workspace');
    } finally {
      await fs.rm(globalDir, { recursive: true, force: true });
    }
  });

  it('workspace overrides global for same-named rule (proximity)', async () => {
    const globalDir = await fs.mkdtemp(join(os.tmpdir(), 'rules-global-'));
    try {
      // global 有 priority=99 的同名；workspace 是 priority=1
      // 就近覆盖：workspace 胜（priority 不考虑跨源）
      await fs.writeFile(
        join(globalDir, 'shared.md'),
        '---\nname: shared\npriority: 99\n---\nGLOBAL',
        'utf8',
      );
      await writeFile('shared.md', '---\nname: shared\npriority: 1\n---\nWORKSPACE');
      const loader = new RuleLoader({
        workspaceRoot: undefined,
        rulesDir: dir,
        globalRulesDir: globalDir,
      });
      const { rules } = await loader.load();
      expect(rules).toHaveLength(1);
      expect(rules[0].source).toBe('workspace');
      expect(rules[0].content).toContain('WORKSPACE');
    } finally {
      await fs.rm(globalDir, { recursive: true, force: true });
    }
  });

  it('global-only rules are loaded when no workspace is open', async () => {
    const globalDir = await fs.mkdtemp(join(os.tmpdir(), 'rules-global-'));
    try {
      await fs.writeFile(join(globalDir, 'g.md'), '# g', 'utf8');
      const loader = new RuleLoader({
        workspaceRoot: undefined,
        globalRulesDir: globalDir,
      });
      const { rules } = await loader.load();
      expect(rules).toHaveLength(1);
      expect(rules[0].source).toBe('global');
    } finally {
      await fs.rm(globalDir, { recursive: true, force: true });
    }
  });

  // ─────────── W7b1：IRuleLoader 三方法 ───────────

  it('getAlwaysOn returns only always_on, sorted', async () => {
    await writeFile('a.md', '---\nname: a\nkind: always_on\npriority: 1\n---\na');
    await writeFile('b.md', '---\nname: b\nkind: always_on\npriority: 10\n---\nb');
    await writeFile('g.md', '---\nname: g\nkind: glob\nglob: "*.ts"\n---\ng');
    await writeFile('m.md', '---\nname: m\nkind: model_decision\ndescription: d\n---\nm');
    const loader = new RuleLoader({ workspaceRoot: undefined, rulesDir: dir, globalRulesDir: '' });
    await loader.load();
    const ao = loader.getAlwaysOn();
    expect(ao.map((r) => r.name)).toEqual(['b', 'a']); // priority desc
    expect(ao.every((r) => r.kind === 'always_on')).toBe(true);
  });

  it('getForFiles returns glob rules matching the paths', async () => {
    await writeFile('ts.md', '---\nname: ts\nkind: glob\nglob: "**/*.ts"\n---\nts');
    await writeFile('py.md', '---\nname: py\nkind: glob\nglob: "**/*.py"\n---\npy');
    await writeFile('a.md', '---\nname: a\nkind: always_on\n---\na'); // 不该出现
    const loader = new RuleLoader({ workspaceRoot: undefined, rulesDir: dir, globalRulesDir: '' });
    await loader.load();
    const hit = loader.getForFiles(['src/foo.ts']);
    expect(hit.map((r) => r.name)).toEqual(['ts']);
    expect(loader.getForFiles([])).toEqual([]);
    expect(loader.getForFiles(['README.md'])).toEqual([]);
  });

  it('getCandidatesForModel returns only model_decision', async () => {
    await writeFile('m1.md', '---\nname: m1\nkind: model_decision\ndescription: d1\n---\nm1');
    await writeFile('m2.md', '---\nname: m2\nkind: model_decision\ndescription: d2\npriority: 5\n---\nm2');
    await writeFile('a.md', '---\nname: a\nkind: always_on\n---\na');
    const loader = new RuleLoader({ workspaceRoot: undefined, rulesDir: dir, globalRulesDir: '' });
    await loader.load();
    const cand = loader.getCandidatesForModel();
    expect(cand.map((r) => r.name)).toEqual(['m2', 'm1']); // priority desc
    expect(cand.every((r) => r.kind === 'model_decision')).toBe(true);
  });
});

// ─────────── selector ───────────

function makeRule(p: Partial<Rule>): Rule {
  return {
    name: p.name ?? 'r',
    kind: p.kind ?? 'always_on',
    description: p.description,
    globs: p.globs ?? [],
    priority: p.priority ?? 0,
    content: p.content ?? 'body',
    filePath: p.filePath ?? '/tmp/r.md',
    source: p.source ?? 'workspace',
  };
}

describe('selectForPrompt', () => {
  it('always_on rules are always included', () => {
    const r = makeRule({ name: 'a', kind: 'always_on' });
    expect(selectForPrompt([r])).toEqual([r]);
  });

  it('glob rules require matching file', () => {
    const r = makeRule({ name: 'g', kind: 'glob', globs: ['**/*.ts'] });
    expect(selectForPrompt([r])).toEqual([]);
    expect(selectForPrompt([r], { activeFile: 'src/a.ts' })).toEqual([r]);
    expect(selectForPrompt([r], { recentFiles: ['src/a.ts'] })).toEqual([r]);
  });

  it('model_decision rules never auto-injected', () => {
    const r = makeRule({ name: 'md', kind: 'model_decision', description: 'x' });
    expect(selectForPrompt([r], { activeFile: 'any.ts' })).toEqual([]);
  });

  it('orders by priority desc then name asc', () => {
    const rs = [
      makeRule({ name: 'b', priority: 5 }),
      makeRule({ name: 'a', priority: 10 }),
      makeRule({ name: 'c', priority: 5 }),
    ];
    expect(selectForPrompt(rs).map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('renderForSystemPrompt', () => {
  it('renders header + body per rule', () => {
    const rs = [makeRule({ name: 'x', description: 'desc', content: 'hello' })];
    const out = renderForSystemPrompt(rs);
    expect(out).toContain('# Project Rules');
    expect(out).toContain('## Rule: x — desc');
    expect(out).toContain('hello');
  });

  it('empty rules → empty string', () => {
    expect(renderForSystemPrompt([])).toBe('');
  });
});

describe('listModelDecisionRules', () => {
  it('returns only model_decision rules', () => {
    const rs = [
      makeRule({ name: 'a', kind: 'always_on' }),
      makeRule({ name: 'b', kind: 'model_decision', description: 'B' }),
      makeRule({ name: 'c', kind: 'glob', globs: ['*.py'] }),
    ];
    const out = listModelDecisionRules(rs);
    expect(out).toEqual([{ name: 'b', description: 'B' }]);
  });
});
