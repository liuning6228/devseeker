/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * fork-agent 单测
 *
 * 覆盖：B1, B2
 */

import { describe, it, expect } from 'vitest';
import { isInsideFork, createForkSnapshot, buildForkSystemPrompt, FORK_BOILERPLATE_TAG } from './fork-agent.js';

describe('isInsideFork', () => {
  it('含警戒标记返回 true', () => {
    expect(isInsideFork(`some prompt\n${FORK_BOILERPLATE_TAG}\nmore`)).toBe(true);
  });

  it('不含警戒标记返回 false', () => {
    expect(isInsideFork('normal prompt')).toBe(false);
  });
});

describe('createForkSnapshot', () => {
  it('浅复制消息数组', () => {
    const msgs = [{ role: 'user' as const, content: 'hello' }];
    const snap = createForkSnapshot(msgs);
    expect(snap).toEqual(msgs);
    expect(snap).not.toBe(msgs); // 不同引用
  });
});

describe('buildForkSystemPrompt', () => {
  it('追加警戒标记和深度警告', () => {
    const result = buildForkSystemPrompt('base prompt', 1, 2);
    expect(result).toContain(FORK_BOILERPLATE_TAG);
    expect(result).toContain('depth 1/2');
    expect(result).toContain('nested forks are forbidden');
  });
});
