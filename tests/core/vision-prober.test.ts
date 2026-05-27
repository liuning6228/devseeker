/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * VisionNeedProber 单元测试 —— W22
 */
import { describe, it, expect } from 'vitest';
import { classifyVisionNeed } from '../../src/core/router/vision-prober.js';

describe('classifyVisionNeed', () => {
  // ── none ──
  it('no images -> none', () => {
    const r = classifyVisionNeed('hello', undefined);
    expect(r.need).toBe('none');
    expect(r.signals).toEqual([]);
  });

  it('empty images array -> none', () => {
    const r = classifyVisionNeed('hello', []);
    expect(r.need).toBe('none');
  });

  // ── strong ──
  it('image without text -> strong', () => {
    const r = classifyVisionNeed('', ['data:image/png;base64,xxx']);
    expect(r.need).toBe('strong');
    expect(r.signals).toContain('image-only');
  });

  it('strong vision keyword -> strong', () => {
    const r = classifyVisionNeed('描述这个UI布局', ['data:image/png;base64,xxx']);
    expect(r.need).toBe('strong');
    expect(r.signals).toContain('strong-vision-keyword');
  });

  it('English strong keyword -> strong', () => {
    const r = classifyVisionNeed('describe this screen layout', ['data:image/png;base64,xxx']);
    expect(r.need).toBe('strong');
  });

  it('photo keyword -> strong', () => {
    const r = classifyVisionNeed('这张照片里有什么', ['data:image/png;base64,xxx']);
    expect(r.need).toBe('strong');
  });

  it('chart keyword -> strong', () => {
    const r = classifyVisionNeed('解读这个图表', ['data:image/png;base64,xxx']);
    expect(r.need).toBe('strong');
  });

  // ── weak ──
  it('weak vision keyword -> weak', () => {
    const r = classifyVisionNeed('帮我读出这个错误', ['data:image/png;base64,xxx']);
    expect(r.need).toBe('weak');
    expect(r.signals).toContain('weak-vision-keyword');
  });

  it('English weak keyword -> weak', () => {
    const r = classifyVisionNeed('extract text from this error', ['data:image/png;base64,xxx']);
    expect(r.need).toBe('weak');
  });

  it('attached keyword -> weak', () => {
    const r = classifyVisionNeed('here is the error log', ['data:image/png;base64,xxx']);
    expect(r.need).toBe('weak');
  });

  it('ocr keyword -> weak', () => {
    const r = classifyVisionNeed('ocr this screenshot', ['data:image/png;base64,xxx']);
    expect(r.need).toBe('weak');
  });

  // ── default weak ──
  it('generic text with image -> weak', () => {
    const r = classifyVisionNeed('帮我看看这个', ['data:image/png;base64,xxx']);
    expect(r.need).toBe('weak');
    // '看这个' 匹配弱视觉关键词
    expect(r.signals).toContain('weak-vision-keyword');
  });

  it('no matching signals but has text -> weak default', () => {
    const r = classifyVisionNeed('写代码', ['data:image/png;base64,xxx']);
    expect(r.need).toBe('weak');
    expect(r.signals).toContain('default-weak');
  });
});
