/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * DynamicPromptModifier 单测（§8.12.1 升级版）
 *
 * 覆盖：
 * - record / clear / clearAll 基本操作
 * - 阈值控制：§8.12.1 阈值从 2→3
 * - buildConstraints 输出格式变为 <heuristic> XML
 * - detectPattern + markInjected 注入限1次
 * - snapshot 返回当前状态
 */

import { describe, it, expect } from 'vitest';
import {
  DynamicPromptModifier,
  type ErrorPattern,
} from '../../src/core/self-healing/dynamic-prompt-modifier.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

describe('DynamicPromptModifier (§8.12.1)', () => {
  it('初始状态为空', () => {
    const m = new DynamicPromptModifier();
    expect(m.hasConstraints()).toBe(false);
    expect(m.buildConstraints()).toEqual([]);
    expect(m.snapshot()).toEqual([]);
  });

  it('record 单条错误后 hasConstraints 为 false（未达阈值3）', () => {
    const m = new DynamicPromptModifier();
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    expect(m.hasConstraints()).toBe(false);
    expect(m.buildConstraints()).toEqual([]);
  });

  it('同一错误码重复 3 次后生成 <heuristic> 约束', () => {
    const m = new DynamicPromptModifier();
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    expect(m.hasConstraints()).toBe(true);
    const cs = m.buildConstraints();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toContain('<heuristic');
    expect(cs[0]).toContain('SEARCH_REPLACE_AMBIGUOUS');
    expect(cs[0]).toContain('count="3"');
    expect(cs[0]).toContain('上下文');
  });

  it('record 2 次时尚未达阈值', () => {
    const m = new DynamicPromptModifier();
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    expect(m.hasConstraints()).toBe(false);
    expect(m.buildConstraints()).toEqual([]);
  });

  it('不同工具/错误码独立计数', () => {
    const m = new DynamicPromptModifier();
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    m.record('bash', ErrorCodes.TOOL_ARGS_INVALID_JSON);
    // bash 只 1 次，未达阈值
    expect(m.buildConstraints()).toHaveLength(1);
    m.record('bash', ErrorCodes.TOOL_ARGS_INVALID_JSON);
    m.record('bash', ErrorCodes.TOOL_ARGS_INVALID_JSON);
    expect(m.buildConstraints()).toHaveLength(2);
  });

  it('clear(toolName) 清除该工具的所有模式', () => {
    const m = new DynamicPromptModifier();
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    m.record('bash', ErrorCodes.TOOL_ARGS_INVALID_JSON);
    m.record('bash', ErrorCodes.TOOL_ARGS_INVALID_JSON);
    m.record('bash', ErrorCodes.TOOL_ARGS_INVALID_JSON);
    expect(m.buildConstraints()).toHaveLength(2);
    m.clear('search_replace');
    expect(m.buildConstraints()).toHaveLength(1);
    expect(m.snapshot()[0].toolName).toBe('bash');
    expect(m.snapshot()[0].errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID_JSON);
  });

  it('clearAll 清空所有记录', () => {
    const m = new DynamicPromptModifier();
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    expect(m.hasConstraints()).toBe(true);
    m.clearAll();
    expect(m.hasConstraints()).toBe(false);
    expect(m.snapshot()).toEqual([]);
  });

  it('detectPattern 未达阈值返回 null', () => {
    const m = new DynamicPromptModifier();
    m.record('search_replace', ErrorCodes.TOOL_PATCH_NO_MATCH);
    expect(m.detectPattern('search_replace', ErrorCodes.TOOL_PATCH_NO_MATCH)).toBeNull();
  });

  it('detectPattern 达阈值且未注入过返回有效匹配', () => {
    const m = new DynamicPromptModifier();
    m.record('search_replace', ErrorCodes.TOOL_PATCH_NO_MATCH);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_NO_MATCH);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_NO_MATCH);
    const match = m.detectPattern('search_replace', ErrorCodes.TOOL_PATCH_NO_MATCH);
    expect(match).not.toBeNull();
    expect(match!.patternName).toBe('SEARCH_REPLACE_NO_MATCH');
    expect(match!.injected).toBe(false);
  });

  it('detectPattern 已注入过返回 injected=true', () => {
    const m = new DynamicPromptModifier();
    m.record('search_replace', ErrorCodes.TOOL_PATCH_NO_MATCH);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_NO_MATCH);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_NO_MATCH);
    const match1 = m.detectPattern('search_replace', ErrorCodes.TOOL_PATCH_NO_MATCH);
    expect(match1!.injected).toBe(false);
    m.markInjected('SEARCH_REPLACE_NO_MATCH');
    const match2 = m.detectPattern('search_replace', ErrorCodes.TOOL_PATCH_NO_MATCH);
    expect(match2).not.toBeNull();
    expect(match2!.injected).toBe(true);
  });

  it('snapshot 返回完整状态', () => {
    const m = new DynamicPromptModifier();
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    m.record('search_replace', ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    const snap = m.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].toolName).toBe('search_replace');
    expect(snap[0].errorCode).toBe(ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
    expect(snap[0].count).toBe(3);
    expect(typeof snap[0].firstAt).toBe('number');
  });

  it('未知错误码返回 null（不在预置 pattern 表中）', () => {
    const m = new DynamicPromptModifier();
    m.record('read_file', 'SOME_UNKNOWN_CODE');
    m.record('read_file', 'SOME_UNKNOWN_CODE');
    m.record('read_file', 'SOME_UNKNOWN_CODE');
    const cs = m.buildConstraints();
    // 不在 PATTERNS 表中 → constraintFor 返回 null
    expect(cs).toHaveLength(0);
    expect(m.detectPattern('read_file', 'SOME_UNKNOWN_CODE')).toBeNull();
  });
});
