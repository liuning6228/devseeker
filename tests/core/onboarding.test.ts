/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 首启向导状态判定单测（src/infra/onboarding.ts）
 *
 * 覆盖：
 * - 全新用户（完成标记与昵称 key 均无）→ 首次运行
 * - 已完成向导（完成标记存在）→ 非首次
 * - 旧版升级用户（仅昵称 key 存在——旧版激活时必写入）→ 非首次（不重弹向导）
 */

import { describe, it, expect } from 'vitest';
import {
  isFirstRun,
  ONBOARDING_COMPLETED_KEY,
  type GlobalStateLike,
} from '../../src/infra/onboarding.js';
import { NICKNAME_STATE_KEY } from '../../src/infra/nickname.js';

/** 内存版 globalState（对齐 GlobalStateLike） */
function fakeGlobalState(entries: Record<string, unknown> = {}): GlobalStateLike {
  return {
    get<T>(key: string): T | undefined {
      return entries[key] as T | undefined;
    },
  };
}

describe('isFirstRun', () => {
  it('全新用户（两 key 均无）→ 首次运行', () => {
    expect(isFirstRun(fakeGlobalState())).toBe(true);
  });

  it('已完成向导（完成标记存在）→ 非首次', () => {
    expect(isFirstRun(fakeGlobalState({ [ONBOARDING_COMPLETED_KEY]: true }))).toBe(false);
  });

  it('旧版升级用户（仅昵称 key 存在，无完成标记）→ 非首次（不重弹向导）', () => {
    expect(isFirstRun(fakeGlobalState({ [NICKNAME_STATE_KEY]: 'DevSeeker' }))).toBe(false);
  });

  it('两 key 均存在（向导完成后又设置昵称）→ 非首次', () => {
    expect(
      isFirstRun(
        fakeGlobalState({ [ONBOARDING_COMPLETED_KEY]: true, [NICKNAME_STATE_KEY]: '小D' }),
      ),
    ).toBe(false);
  });
});
