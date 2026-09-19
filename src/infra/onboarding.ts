/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 首启向导（Onboarding）状态判定。
 *
 * 判定源：globalState（跨工作区共享，与昵称存储同源）。
 * - ONBOARDING_COMPLETED_KEY：向导完成/跳过后写入；
 * - NICKNAME_STATE_KEY：兼容旧版升级——旧版在扩展激活时弹出昵称输入框，
 *   且无论用户是否输入都会写入昵称 key，因此"昵称 key 已存在"等价于
 *   "老用户已走过首启流程"，不再显示向导。
 */

import { NICKNAME_STATE_KEY } from './nickname.js';

/** 首启向导完成标记（globalState key） */
export const ONBOARDING_COMPLETED_KEY = 'devSeeker.onboardingCompleted.v1';

/** globalState 读取的最小接口（便于测试注入，避免 vscode 依赖） */
export interface GlobalStateLike {
  get<T>(key: string): T | undefined;
}

/**
 * 是否首次运行（需要显示首启向导）。
 * 完成标记或昵称任一存在 → 非首启。
 */
export function isFirstRun(globalState: GlobalStateLike): boolean {
  return (
    !globalState.get<boolean>(ONBOARDING_COMPLETED_KEY) &&
    !globalState.get<string>(NICKNAME_STATE_KEY)
  );
}
