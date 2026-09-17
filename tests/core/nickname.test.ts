/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 昵称模块单测（src/infra/nickname.ts）
 *
 * 覆盖：
 * - normalizeNickname：trim / 超长截断 / 空值回退默认名
 * - initNickname / updateNickname：memento 持久化往返（fake memento，无 vscode 依赖）
 * - applyNicknameToSubagentPrompt：默认名不替换（字节恒等）/ 自定义替换 / 产品名引用不受影响
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_NICKNAME,
  MAX_NICKNAME_LENGTH,
  normalizeNickname,
  initNickname,
  updateNickname,
  getNickname,
  applyNicknameToSubagentPrompt,
  resetNicknameForTest,
  NICKNAME_STATE_KEY,
} from '../../src/infra/nickname.js';

/** 内存版 memento（对齐 NicknameMementoLike） */
function fakeMemento(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(NICKNAME_STATE_KEY, initial);
  return {
    get<T>(key: string, defaultValue: T): T {
      return (store.has(key) ? (store.get(key) as unknown as T) : defaultValue);
    },
    async update(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    _store: store,
  };
}

afterEach(() => {
  resetNicknameForTest();
});

describe('normalizeNickname', () => {
  it('空值 / undefined / null → 默认名', () => {
    expect(normalizeNickname('')).toBe(DEFAULT_NICKNAME);
    expect(normalizeNickname(undefined)).toBe(DEFAULT_NICKNAME);
    expect(normalizeNickname(null)).toBe(DEFAULT_NICKNAME);
  });

  it('纯空白 → 默认名', () => {
    expect(normalizeNickname('   \t  ')).toBe(DEFAULT_NICKNAME);
  });

  it('正常值 trim 后保留', () => {
    expect(normalizeNickname('  小D  ')).toBe('小D');
  });

  it('超长截断到 MAX_NICKNAME_LENGTH', () => {
    const long = 'A'.repeat(MAX_NICKNAME_LENGTH + 10);
    expect(normalizeNickname(long)).toHaveLength(MAX_NICKNAME_LENGTH);
  });

  it('超长截断按码点计算（emoji 不被截成半个代理对）', () => {
    const emoji = '😀';
    const out = normalizeNickname(emoji.repeat(MAX_NICKNAME_LENGTH + 5));
    expect(Array.from(out)).toHaveLength(MAX_NICKNAME_LENGTH);
    expect(out).toBe(emoji.repeat(MAX_NICKNAME_LENGTH));
    // 无孤立代理对（半个 emoji）：UTF-16 长度 = 码点数 × 2
    expect(out.length).toBe(MAX_NICKNAME_LENGTH * 2);
  });

  it('边界：23 字符 + 1 emoji（恰 24 码点）完整保留', () => {
    const input = 'A'.repeat(MAX_NICKNAME_LENGTH - 1) + '😀';
    expect(normalizeNickname(input)).toBe(input);
  });

  it('恰好等于上限不截断', () => {
    const exact = 'B'.repeat(MAX_NICKNAME_LENGTH);
    expect(normalizeNickname(exact)).toBe(exact);
  });
});

describe('initNickname / updateNickname', () => {
  it('memento 无值时初始化为默认名并回写内存快照', () => {
    expect(initNickname(fakeMemento())).toBe(DEFAULT_NICKNAME);
    expect(getNickname()).toBe(DEFAULT_NICKNAME);
  });

  it('memento 已有自定义值时载入', () => {
    expect(initNickname(fakeMemento('小助手'))).toBe('小助手');
    expect(getNickname()).toBe('小助手');
  });

  it('updateNickname 持久化 + 规范化 + 同步内存快照', async () => {
    const m = fakeMemento();
    const v = await updateNickname(m, '  阿飞  ');
    expect(v).toBe('阿飞');
    expect(m.get<string>(NICKNAME_STATE_KEY, '')).toBe('阿飞');
    expect(getNickname()).toBe('阿飞');
  });

  it('updateNickname 空值回退默认名', async () => {
    const m = fakeMemento('旧名字');
    const v = await updateNickname(m, '   ');
    expect(v).toBe(DEFAULT_NICKNAME);
    expect(m.get<string>(NICKNAME_STATE_KEY, '')).toBe(DEFAULT_NICKNAME);
  });

  it('updateNickname 超长输入截断后持久化', async () => {
    const m = fakeMemento();
    const v = await updateNickname(m, 'X'.repeat(100));
    expect(v).toHaveLength(MAX_NICKNAME_LENGTH);
  });
});

describe('applyNicknameToSubagentPrompt', () => {
  const PROMPT = 'You are the **Browser** subagent of DevSeeker.\nScope: browse the web.';

  it('默认昵称 → 原样返回（字节恒等）', () => {
    expect(applyNicknameToSubagentPrompt(PROMPT, DEFAULT_NICKNAME)).toBe(PROMPT);
  });

  it('自定义昵称 → 替换身份句 "of DevSeeker"', () => {
    const out = applyNicknameToSubagentPrompt(PROMPT, '小D');
    expect(out).toContain('subagent of 小D.');
    expect(out).not.toContain('of DevSeeker');
  });

  it('产品名引用（configure / use DevSeeker）不受影响', () => {
    const guide =
      'You are the **Guide** subagent of DevSeeker — a product-guide agent.\n' +
      'Scope: answer "how do I configure / use DevSeeker" questions.';
    const out = applyNicknameToSubagentPrompt(guide, '小D');
    expect(out).toContain('subagent of 小D');
    expect(out).toContain('configure / use DevSeeker');
  });

  it('未传昵称时读取内存快照（默认名 → 不替换）', () => {
    expect(applyNicknameToSubagentPrompt(PROMPT)).toBe(PROMPT);
  });
});
