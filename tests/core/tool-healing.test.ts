/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * tests/core/tool-healing.test.ts
 *
 * 覆盖 W7b5a 工具侧自愈模块（src/core/self-healing/tool-healing.ts）：
 * - canHeal 查询
 * - HealingTracker get/increment/reset/clear 边界
 * - HEALING_TABLE 5 条策略 buildHint 输出文本
 * - tryHeal 未命中 / 正常挂 hint / 超预算返回 null / origContent 拼接格式 / sanitize
 */

import { describe, it, expect } from 'vitest';
import {
  canHeal,
  HEALING_TABLE,
  HealingTracker,
  tryHeal,
} from '../../src/core/self-healing/tool-healing.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

describe('canHeal', () => {
  it('命中 HEALING_TABLE 的 5 个错误码返回 true', () => {
    expect(canHeal(ErrorCodes.TOOL_ARGS_INVALID_JSON)).toBe(true);
    expect(canHeal(ErrorCodes.TOOL_PATCH_UNIQUE_FAIL)).toBe(true);
    expect(canHeal(ErrorCodes.TOOL_PATCH_NO_MATCH)).toBe(true);
    expect(canHeal(ErrorCodes.TOOL_ARGS_INVALID)).toBe(true);
    expect(canHeal(ErrorCodes.TOOL_ARGS_MISSING_REQUIRED)).toBe(true);
  });

  it('未在表中的错误码返回 false', () => {
    expect(canHeal(ErrorCodes.PROVIDER_SERVER_5XX)).toBe(false);
    expect(canHeal('NOT_EXISTING_CODE')).toBe(false);
  });
});

describe('HealingTracker', () => {
  it('get 未命中返回 0', () => {
    const t = new HealingTracker();
    expect(t.get('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL)).toBe(0);
  });

  it('increment 返回 +1 后的次数且累加', () => {
    const t = new HealingTracker();
    expect(t.increment('read_file', ErrorCodes.TOOL_ARGS_INVALID_JSON)).toBe(1);
    expect(t.increment('read_file', ErrorCodes.TOOL_ARGS_INVALID_JSON)).toBe(2);
    expect(t.get('read_file', ErrorCodes.TOOL_ARGS_INVALID_JSON)).toBe(2);
  });

  it('不同 (toolName, code) 互相独立', () => {
    const t = new HealingTracker();
    t.increment('a', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    t.increment('a', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    t.increment('b', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    t.increment('a', ErrorCodes.TOOL_PATCH_NO_MATCH);
    expect(t.get('a', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL)).toBe(2);
    expect(t.get('b', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL)).toBe(1);
    expect(t.get('a', ErrorCodes.TOOL_PATCH_NO_MATCH)).toBe(1);
  });

  it('reset 清零指定 (toolName, code)，不影响其他', () => {
    const t = new HealingTracker();
    t.increment('a', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    t.increment('a', ErrorCodes.TOOL_PATCH_NO_MATCH);
    t.reset('a', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    expect(t.get('a', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL)).toBe(0);
    expect(t.get('a', ErrorCodes.TOOL_PATCH_NO_MATCH)).toBe(1);
  });

  it('clear 清空所有计数', () => {
    const t = new HealingTracker();
    t.increment('a', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    t.increment('b', ErrorCodes.TOOL_PATCH_NO_MATCH);
    t.clear();
    expect(t.get('a', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL)).toBe(0);
    expect(t.get('b', ErrorCodes.TOOL_PATCH_NO_MATCH)).toBe(0);
  });
});

describe('HEALING_TABLE buildHint', () => {
  it('TOOL_ARGS_INVALID_JSON 生成 JSON 修复提示', () => {
    const policy = HEALING_TABLE[ErrorCodes.TOOL_ARGS_INVALID_JSON]!;
    const hint = policy.buildHint({
      toolName: 'read_file',
      errorCode: ErrorCodes.TOOL_ARGS_INVALID_JSON,
      errorMessage: 'Unexpected token } in JSON at position 42',
      attempt: 1,
    });
    expect(hint).toContain('JSON 解析失败');
    expect(hint).toContain('Unexpected token');
    expect(hint).toContain('严格合法的 JSON');
    expect(hint).toContain('不要使用注释、尾随逗号或单引号');
  });

  it('TOOL_PATCH_UNIQUE_FAIL 提示增加上下文或 replace_all', () => {
    const policy = HEALING_TABLE[ErrorCodes.TOOL_PATCH_UNIQUE_FAIL]!;
    const hint = policy.buildHint({
      toolName: 'search_replace',
      errorCode: ErrorCodes.TOOL_PATCH_UNIQUE_FAIL,
      errorMessage: 'old_string 出现 3 次',
      attempt: 1,
    });
    expect(hint).toContain('多处匹配');
    expect(hint).toContain('上下文');
    expect(hint).toContain('replace_all=true');
  });

  it('TOOL_PATCH_NO_MATCH 提示先 read_file 校对', () => {
    const policy = HEALING_TABLE[ErrorCodes.TOOL_PATCH_NO_MATCH]!;
    const hint = policy.buildHint({
      toolName: 'search_replace',
      errorCode: ErrorCodes.TOOL_PATCH_NO_MATCH,
      errorMessage: 'no match found',
      attempt: 1,
    });
    expect(hint).toContain('未找到匹配');
    expect(hint).toContain('read_file');
    expect(hint).toContain('CRLF');
  });

  it('TOOL_ARGS_INVALID 包含 toolName', () => {
    const policy = HEALING_TABLE[ErrorCodes.TOOL_ARGS_INVALID]!;
    const hint = policy.buildHint({
      toolName: 'write_file',
      errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      errorMessage: 'path 必须是字符串',
      attempt: 1,
    });
    expect(hint).toContain('write_file');
    expect(hint).toContain('参数校验失败');
    expect(hint).toContain('schema');
  });

  it('TOOL_ARGS_MISSING_REQUIRED 包含 toolName + 字段提示', () => {
    const policy = HEALING_TABLE[ErrorCodes.TOOL_ARGS_MISSING_REQUIRED]!;
    const hint = policy.buildHint({
      toolName: 'write_file',
      errorCode: ErrorCodes.TOOL_ARGS_MISSING_REQUIRED,
      errorMessage: '缺少 path',
      attempt: 1,
    });
    expect(hint).toContain('write_file');
    expect(hint).toContain('缺少必填');
  });

  it('maxAttempts 设定符合预期（JSON/PATCH 2 次，ARGS_* 1 次）', () => {
    expect(HEALING_TABLE[ErrorCodes.TOOL_ARGS_INVALID_JSON]!.maxAttempts).toBe(2);
    expect(HEALING_TABLE[ErrorCodes.TOOL_PATCH_UNIQUE_FAIL]!.maxAttempts).toBe(2);
    expect(HEALING_TABLE[ErrorCodes.TOOL_PATCH_NO_MATCH]!.maxAttempts).toBe(2);
    expect(HEALING_TABLE[ErrorCodes.TOOL_ARGS_INVALID]!.maxAttempts).toBe(1);
    expect(HEALING_TABLE[ErrorCodes.TOOL_ARGS_MISSING_REQUIRED]!.maxAttempts).toBe(1);
  });
});

describe('tryHeal', () => {
  it('错误码未在表中 → 返回 null 且不计数', () => {
    const tracker = new HealingTracker();
    const out = tryHeal(
      tracker,
      {
        toolName: 'read_file',
        errorCode: ErrorCodes.PROVIDER_SERVER_5XX,
        errorMessage: '500',
      },
      'Error: boom',
    );
    expect(out).toBeNull();
    expect(tracker.get('read_file', ErrorCodes.PROVIDER_SERVER_5XX)).toBe(0);
  });

  it('首次调用返回拼接了 [Healing Hint 1/2] 的内容', () => {
    const tracker = new HealingTracker();
    const out = tryHeal(
      tracker,
      {
        toolName: 'read_file',
        errorCode: ErrorCodes.TOOL_ARGS_INVALID_JSON,
        errorMessage: 'Unexpected token',
      },
      'Error: 工具 read_file 的 arguments 不是合法 JSON：Unexpected token',
    );
    expect(out).not.toBeNull();
    expect(out).toContain('Error: 工具 read_file');
    expect(out).toContain('[Healing Hint 1/2]');
    expect(out).toContain('JSON 解析失败');
    expect(tracker.get('read_file', ErrorCodes.TOOL_ARGS_INVALID_JSON)).toBe(1);
  });

  it('超预算后返回 null 且计数不再增加', () => {
    const tracker = new HealingTracker();
    const ctx = {
      toolName: 'search_replace',
      errorCode: ErrorCodes.TOOL_PATCH_UNIQUE_FAIL,
      errorMessage: '多处匹配',
    };
    const a = tryHeal(tracker, ctx, 'orig');
    const b = tryHeal(tracker, ctx, 'orig');
    const c = tryHeal(tracker, ctx, 'orig');
    expect(a).toContain('[Healing Hint 1/2]');
    expect(b).toContain('[Healing Hint 2/2]');
    expect(c).toBeNull();
    // 超预算后不应再计数
    expect(tracker.get('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL)).toBe(2);
  });

  it('ARGS_INVALID（maxAttempts=1）第二次即返回 null', () => {
    const tracker = new HealingTracker();
    const ctx = {
      toolName: 'write_file',
      errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      errorMessage: 'bad arg',
    };
    expect(tryHeal(tracker, ctx, 'orig')).toContain('[Healing Hint 1/1]');
    expect(tryHeal(tracker, ctx, 'orig')).toBeNull();
  });

  it('拼接格式：原内容 trimEnd + 空行 + 标签 + hint', () => {
    const tracker = new HealingTracker();
    const out = tryHeal(
      tracker,
      {
        toolName: 'read_file',
        errorCode: ErrorCodes.TOOL_ARGS_INVALID_JSON,
        errorMessage: 'oops',
      },
      'Error: bad json\n\n\n',
    );
    // trimEnd 掉尾部空行，然后追加 \n\n[Healing...
    expect(out?.startsWith('Error: bad json\n\n[Healing Hint 1/2]\n')).toBe(true);
  });

  it('sanitize：超长 errorMessage 被裁剪到 ~400 字符且无换行噪音', () => {
    const long = 'x'.repeat(1000) + '\n\n\r\t' + 'y'.repeat(500);
    const tracker = new HealingTracker();
    const out = tryHeal(
      tracker,
      {
        toolName: 'read_file',
        errorCode: ErrorCodes.TOOL_ARGS_INVALID_JSON,
        errorMessage: long,
      },
      'orig',
    );
    expect(out).not.toBeNull();
    // 不应出现连续换行
    expect(out!.indexOf('\n\n\r\t')).toBe(-1);
    // 出现 sanitize 的省略符
    expect(out).toContain('…');
  });

  it('reset 后可重新 heal', () => {
    const tracker = new HealingTracker();
    const ctx = {
      toolName: 'search_replace',
      errorCode: ErrorCodes.TOOL_PATCH_UNIQUE_FAIL,
      errorMessage: 'dup',
    };
    tryHeal(tracker, ctx, 'o');
    tryHeal(tracker, ctx, 'o');
    expect(tryHeal(tracker, ctx, 'o')).toBeNull();
    tracker.reset('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    expect(tryHeal(tracker, ctx, 'o')).toContain('[Healing Hint 1/2]');
  });
});
