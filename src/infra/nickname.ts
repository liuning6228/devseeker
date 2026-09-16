/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 昵称单例 —— 用户自定义的助手名称
 *
 * 持久化：globalState（key = NICKNAME_STATE_KEY），由 extension.activate() 初始化。
 * 内存快照：模块级缓存，供 UI 层（状态栏 / Diff 视图 / 通知文案）同步读取，
 * 避免把 ExtensionContext 一路透传到深层模块。
 *
 * 默认名称：'DevSeeker'（未设置 / 留空 / 纯空白时回退）。
 *
 * 使用范围约定：
 * - 助手自称（消息标签、通知、Diff 标签、子代理 prompt）→ 使用昵称
 * - 产品名 / 功能名（面板标题、命令名、日志、`.devseeker` 路径）→ 保持 "DevSeeker"
 */

export const DEFAULT_NICKNAME = 'DevSeeker';

/** globalState 存储键 */
export const NICKNAME_STATE_KEY = 'devSeeker.nickname';

/** 兼容 vscode.Memento 的最小接口（便于单测） */
export interface NicknameMementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: string): Thenable<void> | Promise<void>;
}

let cachedNickname: string = DEFAULT_NICKNAME;

/** 规范化：trim + 空值回退默认名称 */
export function normalizeNickname(value: string | undefined | null): string {
  const v = (value ?? '').trim();
  return v.length > 0 ? v : DEFAULT_NICKNAME;
}

/** 激活时从 memento 载入内存快照（返回载入结果） */
export function initNickname(memento: NicknameMementoLike): string {
  cachedNickname = normalizeNickname(memento.get<string>(NICKNAME_STATE_KEY, DEFAULT_NICKNAME));
  return cachedNickname;
}

/**
 * 更新昵称：内存快照 + memento 持久化。
 * 内存先行（UI 立即可见）；持久化失败不抛错（重启后回退旧值，不阻断主流程）。
 */
export async function updateNickname(
  memento: NicknameMementoLike,
  value: string | undefined | null,
): Promise<string> {
  const next = normalizeNickname(value);
  cachedNickname = next;
  try {
    await memento.update(NICKNAME_STATE_KEY, next);
  } catch {
    /* ignore: 持久化失败不阻断 */
  }
  return next;
}

/** 读取当前昵称（同步内存快照） */
export function getNickname(): string {
  return cachedNickname;
}

/**
 * 子代理 prompt 人格化：把身份句中的 "of DevSeeker" 替换为 "of {nickname}"。
 *
 * 只替换 "of DevSeeker" 这一身份模式，避免误伤产品名引用
 * （如 Guide prompt 中的 "configure / use DevSeeker"）。
 */
export function applyNicknameToSubagentPrompt(prompt: string, nickname?: string): string {
  const name = normalizeNickname(nickname ?? cachedNickname);
  if (name === DEFAULT_NICKNAME) return prompt;
  return prompt.replaceAll('of DevSeeker', `of ${name}`);
}

/** 单测辅助：重置内存快照 */
export function resetNicknameForTest(): void {
  cachedNickname = DEFAULT_NICKNAME;
}
