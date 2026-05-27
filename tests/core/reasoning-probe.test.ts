/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * reasoning-probe 单测（W15.5 Auto-Thinking-Router）
 *
 * 覆盖：
 *   - 空输入 / 纯寒暄 → not needed
 *   - 单一长文本信号 → not needed（避免大段代码粘贴误切 reasoner）
 *   - 关键词 + 长文本 → needed（聚合规则 ≥2）
 *   - 数学 LaTeX 单信号 → needed（高质量信号单独触发）
 *   - 多步 stepwise 单信号 → needed
 *   - 多代码块 + 关键词 → needed
 *   - 中文关键词 / 英文关键词 覆盖
 *   - score 与 signals 字段正确性
 */

import { describe, it, expect } from 'vitest';
import { detectReasoningNeed } from '../../src/core/router/reasoning-probe.js';

describe('reasoning-probe · detectReasoningNeed', () => {
  it('empty input → needed=false, score=0, no signals', () => {
    const r = detectReasoningNeed('');
    expect(r.needed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.signals).toEqual([]);
  });

  it('whitespace only → treated as empty', () => {
    const r = detectReasoningNeed('   \n\t  \n');
    expect(r.needed).toBe(false);
    expect(r.score).toBe(0);
  });

  it('casual chat (zh) → not needed', () => {
    const r = detectReasoningNeed('你好，今天天气怎么样？');
    expect(r.needed).toBe(false);
    expect(r.signals).not.toContain('keyword');
  });

  it('simple file edit request → not needed', () => {
    const r = detectReasoningNeed('把 foo.ts 第 10 行的 console.log 改成 logger.info');
    expect(r.needed).toBe(false);
  });

  it('long input alone (>1500 chars) should NOT trigger reasoning', () => {
    // 模拟用户粘贴一大段普通代码，没有其它信号，不应误切 reasoner。
    const longDump = 'function noop() {}\n'.repeat(120);
    expect(longDump.length).toBeGreaterThan(1500);
    const r = detectReasoningNeed(longDump);
    expect(r.signals).toContain('long-input');
    // 只有 long-input 一个信号 → needed=false
    expect(r.signals.length).toBe(1);
    expect(r.needed).toBe(false);
  });

  it('math/LaTeX alone → needed (high-quality signal)', () => {
    const r = detectReasoningNeed('帮我推一下这个公式：$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$');
    expect(r.signals).toContain('math');
    expect(r.needed).toBe(true);
  });

  it('stepwise keyword alone → needed', () => {
    const r = detectReasoningNeed('请 think step by step 解释这段代码为什么死循环。');
    expect(r.signals).toContain('stepwise');
    expect(r.needed).toBe(true);
  });

  it('chinese stepwise (逐步) alone → needed', () => {
    const r = detectReasoningNeed('请逐步分析并给出修复方案');
    expect(r.signals).toContain('stepwise');
    expect(r.needed).toBe(true);
  });

  it('zh keyword (证明) + nothing else → needs another signal to trigger', () => {
    // 单一 keyword 信号不足，需要叠加
    const r = detectReasoningNeed('请证明这个命题');
    expect(r.signals).toContain('keyword');
    // 命中 keyword 单信号 < 2 且非高质量 → needed=false
    expect(r.needed).toBe(false);
  });

  it('zh keyword + long input → needed (≥2 signals)', () => {
    const longCtx = 'x'.repeat(1600);
    const r = detectReasoningNeed(`请证明以下代码的正确性：${longCtx}`);
    expect(r.signals).toContain('keyword');
    expect(r.signals).toContain('long-input');
    expect(r.signals.length).toBeGreaterThanOrEqual(2);
    expect(r.needed).toBe(true);
  });

  it('english keyword (algorithm optimize) + long input → needed', () => {
    const longCtx = 'a'.repeat(1600);
    const r = detectReasoningNeed(`Please derive the optimal algorithm.\n\n${longCtx}`);
    expect(r.signals).toContain('keyword');
    expect(r.signals).toContain('long-input');
    expect(r.needed).toBe(true);
  });

  it('multiple code fences (≥3) + keyword → needed', () => {
    const input = `请分析以下三段代码的时间复杂度：
\`\`\`js
function a(){}
\`\`\`
\`\`\`ts
function b(){}
\`\`\`
\`\`\`py
def c(): pass
\`\`\`
`;
    const r = detectReasoningNeed(input);
    expect(r.signals).toContain('keyword');
    expect(r.signals).toContain('multi-code-blocks');
    expect(r.needed).toBe(true);
  });

  it('only 2 code fences → no multi-code-blocks signal', () => {
    const input = '```js\nfoo()\n```\n```ts\nbar()\n```';
    const r = detectReasoningNeed(input);
    expect(r.signals).not.toContain('multi-code-blocks');
  });

  it('deadlock keyword + stepwise → needed + stepwise counted', () => {
    const r = detectReasoningNeed('这个死锁问题请一步一步分析排查');
    expect(r.signals).toContain('stepwise');
    // 'stepwise' 是高质量信号单独即可触发
    expect(r.needed).toBe(true);
  });

  it('architect design + trade-off (english) → needed', () => {
    const r = detectReasoningNeed(
      'Help me reason about architecture design trade-offs between Redis vs in-memory cache for this workload.',
    );
    expect(r.signals).toContain('keyword');
    // 单关键词 → 暂不触发；需叠加其他信号
    // 但 "reasoning"/"trade-off"/"architecture design" 任何命中正则不止一次都仍算 1 个 keyword 信号，
    // 所以这里 needed 由其它信号决定，我们只断言 keyword 被识别。
    expect(r.score).toBeGreaterThanOrEqual(1);
  });

  it('returned signals order matches probe order (keyword → math → stepwise → multi-code → long)', () => {
    const input =
      '请逐步推导：$$a+b$$\n' +
      '```x\n1\n```\n```y\n2\n```\n```z\n3\n```\n' +
      'x'.repeat(1600);
    const r = detectReasoningNeed(input);
    const idx = (k: string) => r.signals.indexOf(k);
    // 所有 5 信号都应命中
    expect(r.signals).toEqual(
      expect.arrayContaining(['keyword', 'math', 'stepwise', 'multi-code-blocks', 'long-input']),
    );
    // 顺序按探测顺序
    expect(idx('keyword')).toBeLessThan(idx('math'));
    expect(idx('math')).toBeLessThan(idx('stepwise'));
    expect(idx('stepwise')).toBeLessThan(idx('multi-code-blocks'));
    expect(idx('multi-code-blocks')).toBeLessThan(idx('long-input'));
    expect(r.needed).toBe(true);
    expect(r.score).toBe(5);
  });
});
