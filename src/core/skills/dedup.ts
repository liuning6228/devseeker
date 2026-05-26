/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * SkillDedupTracker（W9.11）
 *
 * 目的：§M9.3.1 "ALREADY LOADED" 协议 + 60s 防抖
 *  - 在一个会话内（或滑窗时间内），同一 skill 短时间内被 LLM 重复调用时，
 *    用精简提示取代重复展开完整 SKILL.md 正文，节省 context。
 *  - 允许注入 now() 供测试控制时间。
 *
 * 行为：
 *  - markTriggered(name) 记录 skill 最近一次实际触发的时间戳
 *  - isLoadedRecently(name, thresholdMs=60_000) 判定是否在防抖窗内
 *  - reset()/clear() 在会话 reset 时清空
 *  - 线程内单例由上层持有（panel.ts 拥有）
 */

export interface SkillDedupTrackerOptions {
  /** 防抖窗（ms），默认 60_000 */
  debounceMs?: number;
  /** 注入 now()（ms since epoch），默认 Date.now */
  now?: () => number;
}

export const DEFAULT_SKILL_DEDUP_MS = 60_000;

export class SkillDedupTracker {
  private readonly lastTriggerAt = new Map<string, number>();
  private readonly debounceMs: number;
  private readonly now: () => number;

  constructor(opts: SkillDedupTrackerOptions = {}) {
    this.debounceMs = Math.max(0, opts.debounceMs ?? DEFAULT_SKILL_DEDUP_MS);
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * 判断指定 skill 是否在防抖窗口内被加载过。
   * @param name skill name
   * @param thresholdMs 可选覆盖 debounceMs
   */
  isLoadedRecently(name: string, thresholdMs?: number): boolean {
    const last = this.lastTriggerAt.get(name);
    if (last === undefined) return false;
    const window = thresholdMs ?? this.debounceMs;
    if (window <= 0) return false;
    return this.now() - last < window;
  }

  /**
   * 标记 skill 已被真正触发（即加载并展开完整指令），更新 last timestamp。
   */
  markTriggered(name: string): void {
    this.lastTriggerAt.set(name, this.now());
  }

  /**
   * 查询某 skill 自上次触发以来的毫秒数；未触发过返回 -1。
   */
  ageMs(name: string): number {
    const last = this.lastTriggerAt.get(name);
    if (last === undefined) return -1;
    return Math.max(0, this.now() - last);
  }

  /** 清除某个 skill 的记录 */
  forget(name: string): void {
    this.lastTriggerAt.delete(name);
  }

  /** 全量清空（会话 reset / 切换时） */
  clear(): void {
    this.lastTriggerAt.clear();
  }

  /** 调试用：导出全部记录（readonly） */
  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.lastTriggerAt);
  }

  get debounceWindowMs(): number {
    return this.debounceMs;
  }
}

/**
 * 构造 ALREADY LOADED 提示文本（§M9.3.1）。
 * 复用在 SkillTool 去重命中路径与 reminder-injector。
 */
export function buildAlreadyLoadedReminder(name: string, ageMs: number): string {
  const secs = Math.max(0, Math.floor(ageMs / 1000));
  return [
    `<command-name>${name}</command-name>`,
    `The skill "${name}" was loaded ${secs}s ago in this session.`,
    'Per the ALREADY LOADED protocol: DO NOT re-invoke `skill(skill="' + name + '", ...)`.',
    'Follow the previously loaded instructions directly.',
    '',
    'IMPORTANT: Execute the skill instructions now using the available tools. Do NOT respond with only text.',
  ].join('\n');
}
