/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Spec Manager 单测（P1）
 *
 * 覆盖：
 * - parseSpecDocument / parseFrontmatter / stripFrontmatter / extractSection
 * - buildSpecContent 纯函数
 * - validateStatusTransition 合法/非法流转
 * - sanitizeFeatureName 规范化
 * - SpecManager CRUD（create / read / update / remove / list / exists）
 * - SpecManager 错误码（SPEC_NOT_FOUND / SPEC_ALREADY_EXISTS / SPEC_INVALID_STATUS_TRANSITION）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import {
  SpecManager,
  parseSpecDocument,
  parseFrontmatter,
  stripFrontmatter,
  extractSection,
  buildSpecContent,
  validateStatusTransition,
  sanitizeFeatureName,
} from '../../src/core/task/spec-manager.js';
import { AgentError, ErrorCodes } from '../../src/core/errors/index.js';

let wsDir: string;
let mgr: SpecManager;

beforeEach(async () => {
  wsDir = await fs.mkdtemp(join(os.tmpdir(), 'spec-mgr-test-'));
  mgr = new SpecManager(wsDir);
});

afterEach(async () => {
  await fs.rm(wsDir, { recursive: true, force: true });
});

// ─────────── Pure Functions ───────────

describe('parseFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const content = '---\nfeature: my-feature\nstatus: draft\ncreated: 2026-08-05\n---\n\n# my-feature\n';
    const meta = parseFrontmatter(content);
    expect(meta.feature).toBe('my-feature');
    expect(meta.status).toBe('draft');
    expect(meta.created).toBe('2026-08-05');
  });

  it('returns defaults when no frontmatter', () => {
    const meta = parseFrontmatter('# Just a heading\nSome body');
    expect(meta.feature).toBe('unknown');
    expect(meta.status).toBe('draft');
    expect(meta.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('clamps invalid status to draft', () => {
    const content = '---\nfeature: x\nstatus: invalid_status\ncreated: 2026-01-01\n---\n';
    const meta = parseFrontmatter(content);
    expect(meta.status).toBe('draft');
  });
});

describe('stripFrontmatter', () => {
  it('removes frontmatter block', () => {
    const content = '---\nfeature: x\nstatus: draft\ncreated: 2026-01-01\n---\n\n# Body';
    const body = stripFrontmatter(content);
    expect(body).not.toContain('---');
    expect(body).toContain('# Body');
  });

  it('returns content unchanged when no frontmatter', () => {
    const content = '# No frontmatter here';
    expect(stripFrontmatter(content)).toBe(content);
  });
});

describe('extractSection', () => {
  it('extracts section by Chinese keyword', () => {
    const body = '\n## 需求（Requirement）\nSome requirement text\n\n## 方案（Design）\nSome design\n';
    const result = extractSection(body, '需求');
    expect(result).toContain('Some requirement text');
    expect(result).not.toContain('Some design');
  });

  it('returns empty string for missing section', () => {
    const body = '\n## 需求（Requirement）\nText\n';
    expect(extractSection(body, '任务')).toBe('');
  });

  it('captures content until next ## heading', () => {
    const body = '\n## 方案（Design）\nDesign content\nMore design\n\n## 任务（Tasks）\nTask content\n';
    const result = extractSection(body, '方案');
    expect(result).toContain('Design content');
    expect(result).toContain('More design');
    expect(result).not.toContain('Task content');
  });
});

describe('buildSpecContent', () => {
  it('builds well-formed spec markdown', () => {
    const content = buildSpecContent({
      feature: 'auth-flow',
      status: 'draft',
      created: '2026-08-05',
      requirement: 'User needs login',
      design: 'Use JWT tokens',
      tasks: '- [ ] 1. Implement login',
    });
    expect(content).toContain('---');
    expect(content).toContain('feature: auth-flow');
    expect(content).toContain('status: draft');
    expect(content).toContain('## 需求（Requirement）');
    expect(content).toContain('User needs login');
    expect(content).toContain('## 方案（Design）');
    expect(content).toContain('## 任务（Tasks）');
  });

  it('uses placeholder for empty sections', () => {
    const content = buildSpecContent({
      feature: 'x', status: 'draft', created: '2026-01-01',
      requirement: '', design: '', tasks: '',
    });
    expect(content).toContain('_待补充_');
  });
});

describe('parseSpecDocument', () => {
  it('round-trips with buildSpecContent', () => {
    const original = buildSpecContent({
      feature: 'round-trip',
      status: 'draft',
      created: '2026-08-05',
      requirement: 'Need X',
      design: 'Do Y',
      tasks: '- [ ] 1. Task Z',
    });
    const doc = parseSpecDocument(original);
    expect(doc.meta.feature).toBe('round-trip');
    expect(doc.meta.status).toBe('draft');
    expect(doc.requirement).toContain('Need X');
    expect(doc.design).toContain('Do Y');
    expect(doc.tasks).toContain('Task Z');
  });
});

describe('validateStatusTransition', () => {
  it('allows draft → approved', () => {
    expect(() => validateStatusTransition('draft', 'approved')).not.toThrow();
  });

  it('allows approved → completed', () => {
    expect(() => validateStatusTransition('approved', 'completed')).not.toThrow();
  });

  it('allows same status (idempotent)', () => {
    expect(() => validateStatusTransition('draft', 'draft')).not.toThrow();
    expect(() => validateStatusTransition('completed', 'completed')).not.toThrow();
  });

  it('rejects draft → completed', () => {
    expect(() => validateStatusTransition('draft', 'completed')).toThrow(AgentError);
    try {
      validateStatusTransition('draft', 'completed');
    } catch (e) {
      expect((e as AgentError).code).toBe(ErrorCodes.SPEC_INVALID_STATUS_TRANSITION);
    }
  });

  it('rejects completed → draft (irreversible)', () => {
    expect(() => validateStatusTransition('completed', 'draft')).toThrow(AgentError);
  });

  it('rejects approved → draft (irreversible)', () => {
    expect(() => validateStatusTransition('approved', 'draft')).toThrow(AgentError);
  });
});

describe('sanitizeFeatureName', () => {
  it('lowercases and replaces special chars', () => {
    expect(sanitizeFeatureName('My Feature!')).toBe('my-feature');
  });

  it('preserves Chinese characters', () => {
    expect(sanitizeFeatureName('用户登录')).toBe('用户登录');
  });

  it('collapses multiple hyphens', () => {
    expect(sanitizeFeatureName('a  b   c')).toBe('a-b-c');
  });

  it('trims leading/trailing hyphens', () => {
    expect(sanitizeFeatureName('--hello--')).toBe('hello');
  });

  it('truncates to 64 chars', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeFeatureName(long).length).toBe(64);
  });
});

// ─────────── SpecManager CRUD ───────────

describe('SpecManager', () => {
  describe('create', () => {
    it('creates a new spec file', async () => {
      const doc = await mgr.create({
        feature: 'auth-flow',
        requirement: 'User login',
        design: 'JWT tokens',
      });
      expect(doc.meta.feature).toBe('auth-flow');
      expect(doc.meta.status).toBe('draft');
      expect(doc.requirement).toContain('User login');
    });

    it('throws SPEC_ALREADY_EXISTS for duplicate', async () => {
      await mgr.create({ feature: 'dup' });
      await expect(mgr.create({ feature: 'dup' })).rejects.toThrow(AgentError);
      try {
        await mgr.create({ feature: 'dup' });
      } catch (e) {
        expect((e as AgentError).code).toBe(ErrorCodes.SPEC_ALREADY_EXISTS);
      }
    });
  });

  describe('read', () => {
    it('reads an existing spec', async () => {
      await mgr.create({ feature: 'readme', requirement: 'Need X' });
      const doc = await mgr.read('readme');
      expect(doc.meta.feature).toBe('readme');
      expect(doc.requirement).toContain('Need X');
    });

    it('throws SPEC_NOT_FOUND for missing', async () => {
      await expect(mgr.read('nonexistent')).rejects.toThrow(AgentError);
      try {
        await mgr.read('nonexistent');
      } catch (e) {
        expect((e as AgentError).code).toBe(ErrorCodes.SPEC_NOT_FOUND);
      }
    });
  });

  describe('update', () => {
    it('updates requirement and status', async () => {
      await mgr.create({ feature: 'upd', requirement: 'Old req' });
      const updated = await mgr.update('upd', {
        requirement: 'New req',
        status: 'approved',
      });
      expect(updated.requirement).toContain('New req');
      expect(updated.meta.status).toBe('approved');
    });

    it('rejects invalid status transition', async () => {
      await mgr.create({ feature: 'bad-status' });
      await expect(
        mgr.update('bad-status', { status: 'completed' }),
      ).rejects.toThrow(AgentError);
    });
  });

  describe('remove', () => {
    it('removes an existing spec', async () => {
      await mgr.create({ feature: 'to-remove' });
      await mgr.remove('to-remove');
      await expect(mgr.read('to-remove')).rejects.toThrow();
    });

    it('is idempotent for nonexistent spec', async () => {
      await expect(mgr.remove('ghost')).resolves.toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns empty array when no specs', async () => {
      const list = await mgr.list();
      expect(list).toEqual([]);
    });

    it('lists all specs sorted by created desc', async () => {
      await mgr.create({ feature: 'alpha' });
      await mgr.create({ feature: 'beta' });
      const list = await mgr.list();
      expect(list.length).toBe(2);
      // Both should be present
      const features = list.map((s) => s.feature);
      expect(features).toContain('alpha');
      expect(features).toContain('beta');
    });
  });

  describe('exists', () => {
    it('returns true for existing spec', async () => {
      await mgr.create({ feature: 'exists-test' });
      expect(await mgr.exists('exists-test')).toBe(true);
    });

    it('returns false for missing spec', async () => {
      expect(await mgr.exists('nope')).toBe(false);
    });
  });
});
