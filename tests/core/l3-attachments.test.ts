/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

import { describe, it, expect } from 'vitest';
import { buildL3Attachments } from '../../src/core/prompts/layers/attachments.js';

/**
 * L3 Attachments Layer 单测（B-P1-10 / B-P1-11）
 * 覆盖 selectedCodes、gitContext、environment 的稳定拼接顺序与空值语义。
 */

describe('buildL3Attachments', () => {
  it('空输入返回空串', () => {
    expect(buildL3Attachments()).toBe('');
    expect(buildL3Attachments({})).toBe('');
  });

  it('仅 environment 时透传', () => {
    const env = '<environment>\nplatform: win32\n</environment>';
    expect(buildL3Attachments({ environment: env })).toBe(env);
  });

  it('B-P1-10 · selectedCodes 拼出 <selected_codes> 块（多段按出现顺序）', () => {
    const out = buildL3Attachments({
      selectedCodes: [
        { filePath: 'src/a.ts', startLine: 10, endLine: 12, text: 'foo();' },
        { filePath: 'src/b.ts', startLine: 5, endLine: 5, text: 'bar();' },
      ],
    });
    expect(out).toContain('<selected_codes>');
    expect(out).toContain('</selected_codes>');
    expect(out).toContain('<selection path="src/a.ts:10-12">');
    expect(out).toContain('<selection path="src/b.ts:5">');
    // 保持顺序
    expect(out.indexOf('a.ts')).toBeLessThan(out.indexOf('b.ts'));
    expect(out).toContain('foo();');
    expect(out).toContain('bar();');
  });

  it('B-P1-11 · gitContext 原样追加', () => {
    const git = '<git_context>\nbranch: main\n</git_context>';
    expect(buildL3Attachments({ gitContext: git })).toBe(git);
  });

  it('environment + selectedCodes + gitContext 稳定顺序', () => {
    const out = buildL3Attachments({
      environment: '<environment>X</environment>',
      selectedCodes: [
        { filePath: 'p.ts', startLine: 1, endLine: 1, text: 'A' },
      ],
      gitContext: '<git_context>G</git_context>',
    });
    const envIdx = out.indexOf('<environment>');
    const selIdx = out.indexOf('<selected_codes>');
    const gitIdx = out.indexOf('<git_context>');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(selIdx).toBeGreaterThan(envIdx);
    expect(gitIdx).toBeGreaterThan(selIdx);
  });

  it('同输入两次调用字节级一致（稳定）', () => {
    const input = {
      environment: '<environment>Y</environment>',
      selectedCodes: [
        { filePath: 'x.ts', startLine: 3, endLine: 3, text: 'z' },
      ],
      gitContext: '<git_context>g</git_context>',
    };
    expect(buildL3Attachments(input)).toBe(buildL3Attachments(input));
  });

  it('空数组等价于 undefined（不输出块头）', () => {
    expect(buildL3Attachments({ selectedCodes: [] })).toBe('');
  });

  it('B-P1-13 · frameworkContext 紧随 environment 之后，selectedCodes 之前', () => {
    const out = buildL3Attachments({
      environment: '<environment>E</environment>',
      frameworkContext:
        '<current_open_file>\nsrc/a.ts\n</current_open_file>\n\n<open_tabs>\nsrc/a.ts\n</open_tabs>',
      selectedCodes: [{ filePath: 'src/a.ts', startLine: 1, endLine: 1, text: 'X' }],
      gitContext: '<git_context>G</git_context>',
    });
    const envIdx = out.indexOf('<environment>');
    const fwIdx = out.indexOf('<current_open_file>');
    const tabsIdx = out.indexOf('<open_tabs>');
    const selIdx = out.indexOf('<selected_codes>');
    const gitIdx = out.indexOf('<git_context>');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(fwIdx).toBeGreaterThan(envIdx);
    expect(tabsIdx).toBeGreaterThan(fwIdx);
    expect(selIdx).toBeGreaterThan(tabsIdx);
    expect(gitIdx).toBeGreaterThan(selIdx);
  });

  it('W13.2 · ecosystem 紧随 environment 之后、frameworkContext 之前', () => {
    const out = buildL3Attachments({
      environment: '<environment>E</environment>',
      ecosystem: '<ecosystem kind="harmonyos">RULES</ecosystem>',
      frameworkContext: '<current_open_file>\nsrc/a.ts\n</current_open_file>',
      gitContext: '<git_context>G</git_context>',
    });
    const envIdx = out.indexOf('<environment>');
    const ecoIdx = out.indexOf('<ecosystem');
    const fwIdx = out.indexOf('<current_open_file>');
    const gitIdx = out.indexOf('<git_context>');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(ecoIdx).toBeGreaterThan(envIdx);
    expect(fwIdx).toBeGreaterThan(ecoIdx);
    expect(gitIdx).toBeGreaterThan(fwIdx);
  });

  it('W13.2 · 空 ecosystem 字段不影响其他块顺序', () => {
    const withEmpty = buildL3Attachments({
      environment: '<environment>E</environment>',
      ecosystem: '',
      gitContext: '<git_context>G</git_context>',
    });
    const withoutField = buildL3Attachments({
      environment: '<environment>E</environment>',
      gitContext: '<git_context>G</git_context>',
    });
    expect(withEmpty).toBe(withoutField);
  });

  it('W13.3 · vlmOcrPolicy 紧随 ecosystem 之后、frameworkContext 之前', () => {
    const out = buildL3Attachments({
      environment: '<environment>E</environment>',
      ecosystem: '<ecosystem kind="harmonyos">RULES</ecosystem>',
      vlmOcrPolicy: '<vlm_policy kind="ocr">OCR</vlm_policy>',
      frameworkContext: '<current_open_file>\nsrc/a.ts\n</current_open_file>',
      gitContext: '<git_context>G</git_context>',
    });
    const envIdx = out.indexOf('<environment>');
    const ecoIdx = out.indexOf('<ecosystem');
    const vlmIdx = out.indexOf('<vlm_policy');
    const fwIdx = out.indexOf('<current_open_file>');
    const gitIdx = out.indexOf('<git_context>');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(ecoIdx).toBeGreaterThan(envIdx);
    expect(vlmIdx).toBeGreaterThan(ecoIdx);
    expect(fwIdx).toBeGreaterThan(vlmIdx);
    expect(gitIdx).toBeGreaterThan(fwIdx);
  });

  it('W13.3 · 空 vlmOcrPolicy 字段不影响其他块顺序', () => {
    const withEmpty = buildL3Attachments({
      environment: '<environment>E</environment>',
      vlmOcrPolicy: '',
      gitContext: '<git_context>G</git_context>',
    });
    const withoutField = buildL3Attachments({
      environment: '<environment>E</environment>',
      gitContext: '<git_context>G</git_context>',
    });
    expect(withEmpty).toBe(withoutField);
  });

  it('W13.3 · 无 ecosystem 但有 vlmOcrPolicy：紧随 environment', () => {
    // 图像会话但非鸿蒙/Vue 项目的典型场景
    const out = buildL3Attachments({
      environment: '<environment>E</environment>',
      vlmOcrPolicy: '<vlm_policy kind="ocr">OCR</vlm_policy>',
      gitContext: '<git_context>G</git_context>',
    });
    const envIdx = out.indexOf('<environment>');
    const vlmIdx = out.indexOf('<vlm_policy');
    const gitIdx = out.indexOf('<git_context>');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(vlmIdx).toBeGreaterThan(envIdx);
    expect(gitIdx).toBeGreaterThan(vlmIdx);
  });
});
