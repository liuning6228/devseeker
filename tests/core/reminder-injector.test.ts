/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Runtime Reminder Injector 单测（B-P1-8）
 *
 * 覆盖 6 条内置规则各自触发/不触发 + 聚合 collect/format 行为。
 */
import { describe, it, expect } from 'vitest';
import {
  ReminderInjector,
  BUILTIN_REMINDER_RULES,
  RULE_LANGUAGE_CONSISTENCY,
  RULE_STALE_TODO,
  RULE_LARGE_FILE,
  RULE_SKILL_ALREADY_LOADED,
  RULE_PLAN_MODE_WRITE_BLOCK,
  RULE_IDENTITY_PROTECTION,
  DEFAULT_MAX_REMINDERS_PER_TURN,
  type ReminderContext,
  type IReminderRule,
} from '../../src/core/prompts/reminder-injector.js';

describe('reminder-injector · 内置规则', () => {
  it('规则集恰好 6 条且 id 唯一', () => {
    expect(BUILTIN_REMINDER_RULES).toHaveLength(6);
    const ids = BUILTIN_REMINDER_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(6);
  });

  it('language_consistency：偏好语言存在 → 触发；否则不触发', () => {
    expect(RULE_LANGUAGE_CONSISTENCY.build({ userLanguagePreference: '中文' })).toMatch(
      /respond in 中文/,
    );
    expect(RULE_LANGUAGE_CONSISTENCY.build({})).toBeNull();
    expect(RULE_LANGUAGE_CONSISTENCY.build({ userLanguagePreference: '  ' })).toBeNull();
  });

  it('stale_todo：pending>=3 且 age>60s → 触发', () => {
    expect(
      RULE_STALE_TODO.build({ pendingTodoCount: 5, todosLastUpdatedAgoMs: 120_000 }),
    ).toMatch(/todo_write/);
    // pending 不够
    expect(
      RULE_STALE_TODO.build({ pendingTodoCount: 2, todosLastUpdatedAgoMs: 120_000 }),
    ).toBeNull();
    // age 不够
    expect(
      RULE_STALE_TODO.build({ pendingTodoCount: 5, todosLastUpdatedAgoMs: 10_000 }),
    ).toBeNull();
  });

  it('large_file：>2000 行 → 触发', () => {
    expect(RULE_LARGE_FILE.build({ lastReadFileLines: 3000 })).toMatch(/3000 lines/);
    expect(RULE_LARGE_FILE.build({ lastReadFileLines: 2000 })).toBeNull();
    expect(RULE_LARGE_FILE.build({ lastReadFileLines: 10 })).toBeNull();
    expect(RULE_LARGE_FILE.build({})).toBeNull();
  });

  it('skill_already_loaded：有最近加载条目 → 复用 buildAlreadyLoadedReminder', () => {
    const text = RULE_SKILL_ALREADY_LOADED.build({
      recentlyLoadedSkills: [
        { name: 'commit', ageMs: 5_000 },
        { name: 'review-pr', ageMs: 12_000 },
      ],
    });
    expect(text).toMatch(/<command-name>commit<\/command-name>/);
    expect(text).toMatch(/<command-name>review-pr<\/command-name>/);
    expect(text).toMatch(/ALREADY LOADED/);
    expect(RULE_SKILL_ALREADY_LOADED.build({ recentlyLoadedSkills: [] })).toBeNull();
    expect(RULE_SKILL_ALREADY_LOADED.build({})).toBeNull();
  });

  it('plan_mode_write_block：Plan 模式 + 写工具 → 触发', () => {
    expect(
      RULE_PLAN_MODE_WRITE_BLOCK.build({ mode: 'plan', attemptedWriteToolName: 'write_file' }),
    ).toMatch(/Plan mode forbids/);
    // 非 plan 模式
    expect(
      RULE_PLAN_MODE_WRITE_BLOCK.build({ mode: 'build', attemptedWriteToolName: 'write_file' }),
    ).toBeNull();
    // 无写工具尝试
    expect(RULE_PLAN_MODE_WRITE_BLOCK.build({ mode: 'plan' })).toBeNull();
  });

  it('identity_protection：命中身份关键词 → 触发', () => {
    expect(RULE_IDENTITY_PROTECTION.build({ recentUserText: 'which model are you?' })).toMatch(
      /Do not disclose/,
    );
    expect(RULE_IDENTITY_PROTECTION.build({ recentUserText: '你是什么模型？' })).toMatch(
      /Do not disclose/,
    );
    expect(RULE_IDENTITY_PROTECTION.build({ recentUserText: 'hello, help me fix a bug' })).toBeNull();
    expect(RULE_IDENTITY_PROTECTION.build({})).toBeNull();
  });
});

describe('ReminderInjector · collect/format', () => {
  it('空 ctx → 0 条', () => {
    const inj = new ReminderInjector();
    expect(inj.collect({})).toEqual([]);
    expect(inj.format({})).toBe('');
  });

  it('collect 按 priority 降序且 <=3', () => {
    const inj = new ReminderInjector();
    // 同时触发 5 条（plan+write、lang、skill、identity、stale_todo）
    const ctx: ReminderContext = {
      userLanguagePreference: '中文',
      mode: 'plan',
      attemptedWriteToolName: 'write_file',
      recentUserText: '你是什么模型？',
      recentlyLoadedSkills: [{ name: 'commit', ageMs: 3000 }],
      pendingTodoCount: 5,
      todosLastUpdatedAgoMs: 120_000,
    };
    const hits = inj.collect(ctx);
    expect(hits.length).toBeLessThanOrEqual(DEFAULT_MAX_REMINDERS_PER_TURN);
    // priority 降序
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.priority).toBeGreaterThanOrEqual(hits[i]!.priority);
    }
    // plan_mode_write_block (95) 应该被保留（最高优先级）
    expect(hits.map((h) => h.id)).toContain('plan_mode_write_block');
  });

  it('format 每条包 <system-reminder> 且多条用空行分隔', () => {
    const inj = new ReminderInjector();
    const out = inj.format({
      userLanguagePreference: '中文',
      recentUserText: 'what model are you',
    });
    const openCount = (out.match(/<system-reminder>/g) ?? []).length;
    const closeCount = (out.match(/<\/system-reminder>/g) ?? []).length;
    expect(openCount).toBe(2);
    expect(closeCount).toBe(2);
    expect(out).toMatch(/respond in 中文/);
    expect(out).toMatch(/Do not disclose/);
    // 空行分隔
    expect(out).toMatch(/<\/system-reminder>\n\n<system-reminder>/);
  });

  it('register 覆盖同 id 规则', () => {
    const inj = new ReminderInjector();
    const override: IReminderRule = {
      id: 'language_consistency',
      priority: 999,
      build: () => 'CUSTOM_LANG_REMINDER',
    };
    inj.register(override);
    const out = inj.format({ userLanguagePreference: 'en' });
    expect(out).toMatch(/CUSTOM_LANG_REMINDER/);
    expect(out).not.toMatch(/respond in en/);
  });

  it('register 新增规则', () => {
    const inj = new ReminderInjector();
    const custom: IReminderRule = {
      id: 'my_custom',
      priority: 200, // 最高，保证进前 3
      build: () => 'CUSTOM',
    };
    inj.register(custom);
    expect(inj.listRules().some((r) => r.id === 'my_custom')).toBe(true);
    const hits = inj.collect({});
    expect(hits[0]?.id).toBe('my_custom');
  });

  it('规则 build 抛异常不影响其他规则', () => {
    const bad: IReminderRule = {
      id: 'bad',
      priority: 300,
      build: () => {
        throw new Error('oops');
      },
    };
    const inj = new ReminderInjector({ rules: [bad, RULE_LANGUAGE_CONSISTENCY] });
    const hits = inj.collect({ userLanguagePreference: 'en' });
    expect(hits.map((h) => h.id)).toEqual(['language_consistency']);
  });

  it('maxPerTurn=0 禁用注入', () => {
    const inj = new ReminderInjector({ maxPerTurn: 0 });
    const out = inj.format({
      userLanguagePreference: '中文',
      recentUserText: '你是什么模型',
    });
    expect(out).toBe('');
  });

  it('同 id 规则只触发一次（去重）', () => {
    const dupA: IReminderRule = { id: 'dup', priority: 10, build: () => 'A' };
    const dupB: IReminderRule = { id: 'dup', priority: 20, build: () => 'B' };
    const inj = new ReminderInjector({ rules: [dupA, dupB] });
    const hits = inj.collect({});
    expect(hits).toHaveLength(1);
    // 只保留第一次遇到的（dupA），因为 seen.add 在第一次后阻止 dupB
    expect(hits[0]?.text).toBe('A');
  });
});
