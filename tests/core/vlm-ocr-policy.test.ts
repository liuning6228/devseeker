/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W13.3 · VLM OCR Policy 单测
 *
 * 覆盖：
 *   - VLM_OCR_POLICY_MODULE 正文关键段落与术语表断言
 *   - buildVlmOcrBlock(hasVision) 条件产出（true → 外层标签 + 模块；false → ''）
 *   - 块外层标签字节级稳定
 */
import { describe, it, expect } from 'vitest';
import {
  buildVlmOcrBlock,
  VLM_OCR_POLICY_MODULE,
} from '../../src/core/prompts/vlm-policy.js';

describe('W13.3 · buildVlmOcrBlock', () => {
  it('hasVision=false → 返回空字符串（零 token 成本）', () => {
    expect(buildVlmOcrBlock(false)).toBe('');
  });

  it('hasVision=true → 返回 <vlm_policy kind="ocr"> 包裹的模块正文', () => {
    const out = buildVlmOcrBlock(true);
    expect(out.startsWith('<vlm_policy kind="ocr">')).toBe(true);
    expect(out.endsWith('</vlm_policy>')).toBe(true);
    expect(out).toContain(VLM_OCR_POLICY_MODULE);
  });

  it('hasVision=true 调用两次字节级一致（无随机/时间依赖）', () => {
    expect(buildVlmOcrBlock(true)).toBe(buildVlmOcrBlock(true));
  });
});

describe('W13.3 · VLM_OCR_POLICY_MODULE 内容断言', () => {
  it('包含核心 section 标题', () => {
    expect(VLM_OCR_POLICY_MODULE).toContain('### 识图原则');
    expect(VLM_OCR_POLICY_MODULE).toContain('### 术语表');
    expect(VLM_OCR_POLICY_MODULE).toContain('### 输出模板');
    expect(VLM_OCR_POLICY_MODULE).toContain('### Pitfalls');
  });

  it('输出模板四段按序出现', () => {
    const verbatim = VLM_OCR_POLICY_MODULE.indexOf('## Verbatim Text');
    const paths = VLM_OCR_POLICY_MODULE.indexOf('## File Paths');
    const errors = VLM_OCR_POLICY_MODULE.indexOf('## Errors / Warnings');
    const context = VLM_OCR_POLICY_MODULE.indexOf('## Context');
    expect(verbatim).toBeGreaterThan(-1);
    expect(paths).toBeGreaterThan(verbatim);
    expect(errors).toBeGreaterThan(paths);
    expect(context).toBeGreaterThan(errors);
  });

  it('关键识图原则被提及', () => {
    expect(VLM_OCR_POLICY_MODULE).toContain('verbatim');
    expect(VLM_OCR_POLICY_MODULE).toContain('逐字复刻');
    expect(VLM_OCR_POLICY_MODULE).toContain('不意译');
    expect(VLM_OCR_POLICY_MODULE).toContain('(截断)');
    expect(VLM_OCR_POLICY_MODULE).toContain('(遮挡)');
    expect(VLM_OCR_POLICY_MODULE).toContain('(无法辨识)');
  });

  it('中文 IDE 术语表覆盖主要国产/主流工具', () => {
    // 国产 IDE
    expect(VLM_OCR_POLICY_MODULE).toContain('DevEco Studio');
    expect(VLM_OCR_POLICY_MODULE).toContain('HBuilderX');
    expect(VLM_OCR_POLICY_MODULE).toContain('通义灵码');
    expect(VLM_OCR_POLICY_MODULE).toContain('CodeGeeX');
    expect(VLM_OCR_POLICY_MODULE).toContain('Qoder');
    // 主流 IDE
    expect(VLM_OCR_POLICY_MODULE).toContain('VSCode');
    expect(VLM_OCR_POLICY_MODULE).toContain('IntelliJ');
  });

  it('报错关键字与日志级别覆盖中英文', () => {
    // 中文报错
    expect(VLM_OCR_POLICY_MODULE).toContain('未定义');
    expect(VLM_OCR_POLICY_MODULE).toContain('未找到');
    expect(VLM_OCR_POLICY_MODULE).toContain('语法错误');
    // 英文报错
    expect(VLM_OCR_POLICY_MODULE).toContain('NullPointerException');
    expect(VLM_OCR_POLICY_MODULE).toContain('TypeError');
    expect(VLM_OCR_POLICY_MODULE).toContain('ENOENT');
    // 日志级别
    expect(VLM_OCR_POLICY_MODULE).toContain('TRACE');
    expect(VLM_OCR_POLICY_MODULE).toContain('ERROR');
    expect(VLM_OCR_POLICY_MODULE).toContain('FATAL');
    expect(VLM_OCR_POLICY_MODULE).toContain('警告');
    expect(VLM_OCR_POLICY_MODULE).toContain('致命');
  });

  it('HarmonyOS/ArkTS 特有术语被提及（与 W13.2 生态对齐）', () => {
    expect(VLM_OCR_POLICY_MODULE).toContain('.ets');
    expect(VLM_OCR_POLICY_MODULE).toContain('UIAbility');
    expect(VLM_OCR_POLICY_MODULE).toContain('hvigorw');
    expect(VLM_OCR_POLICY_MODULE).toContain('ohpm');
  });

  it('Pitfalls 明示调用栈 / 颜色 / 模糊 / 高亮四大陷阱', () => {
    expect(VLM_OCR_POLICY_MODULE).toContain('切勿先 OCR 再翻译');
    expect(VLM_OCR_POLICY_MODULE).toContain('调用栈顺序');
    expect(VLM_OCR_POLICY_MODULE).toContain('颜色不等同于级别');
    expect(VLM_OCR_POLICY_MODULE).toContain('模糊 ≠ 推测');
    expect(VLM_OCR_POLICY_MODULE).toContain('代码高亮丢失');
  });
});
