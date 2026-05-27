/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * delegation-config 单测
 *
 * 覆盖：B4, B5
 */

import { describe, it, expect } from 'vitest';
import { normalizeIsolation, canSpawn, DEFAULT_ISOLATION } from './delegation-config.js';

describe('normalizeIsolation', () => {
  it('默认值', () => {
    const r = normalizeIsolation({});
    expect(r.maxDepth).toBe(2);
    expect(r.autoApprove).toBe(false);
    expect(r.timeoutSeconds).toBe(600);
    expect(r.maxChildren).toBe(3);
  });

  it('maxDepth 超 3 被钳位到 3', () => {
    const r = normalizeIsolation({ maxDepth: 10 });
    expect(r.maxDepth).toBe(3);
  });

  it('maxDepth 低于 1 被钳位到 1', () => {
    const r = normalizeIsolation({ maxDepth: 0 });
    expect(r.maxDepth).toBe(1);
  });
});

describe('canSpawn', () => {
  it('depth < maxDepth 时允许 spawn', () => {
    expect(canSpawn(0, 2)).toBe(true);
    expect(canSpawn(1, 2)).toBe(true);
  });

  it('depth >= maxDepth 时禁止 spawn', () => {
    expect(canSpawn(2, 2)).toBe(false);
    expect(canSpawn(3, 2)).toBe(false);
  });
});
