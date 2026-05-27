/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * web_research Prompt 模块单测（DESIGN §M12.9）
 *
 * 覆盖六条纪律 + prompt-injection 防御
 */

import { describe, it, expect } from 'vitest';
import { WEB_RESEARCH_PROMPT_MODULE } from '../../src/core/prompts/web-research.js';

describe('WEB_RESEARCH_PROMPT_MODULE', () => {
  it('is a non-empty string', () => {
    expect(typeof WEB_RESEARCH_PROMPT_MODULE).toBe('string');
    expect(WEB_RESEARCH_PROMPT_MODULE.length).toBeGreaterThan(100);
  });

  it('includes all six DESIGN §M12.9 clauses', () => {
    const p = WEB_RESEARCH_PROMPT_MODULE;
    // 1. 何时上网
    expect(p).toMatch(/When to go online/i);
    // 2. 先搜后取
    expect(p).toMatch(/Search-first/i);
    // 3. 并行抓取
    expect(p).toMatch(/Parallel fetch/i);
    // 4. 时效
    expect(p).toMatch(/freshness/i);
    // 5. 引用来源
    expect(p).toMatch(/Cite your sources/i);
    // 6. 失败兜底
    expect(p).toMatch(/Failure fallback/i);
  });

  it('names the three web tools', () => {
    expect(WEB_RESEARCH_PROMPT_MODULE).toMatch(/search_web/);
    expect(WEB_RESEARCH_PROMPT_MODULE).toMatch(/fetch_content/);
    expect(WEB_RESEARCH_PROMPT_MODULE).toMatch(/read_url/);
  });

  it('includes prompt-injection defense clause', () => {
    expect(WEB_RESEARCH_PROMPT_MODULE).toMatch(/Prompt-injection|<web_content>/i);
    expect(WEB_RESEARCH_PROMPT_MODULE).toMatch(/DATA, not instructions/i);
  });

  it('suggests OneYear timeRange for tech queries', () => {
    expect(WEB_RESEARCH_PROMPT_MODULE).toMatch(/OneYear/);
  });

  it('stays roughly under 500 tokens (≈ < 3500 chars)', () => {
    // 粗略检查，避免挤压其他 prompt 模块
    expect(WEB_RESEARCH_PROMPT_MODULE.length).toBeLessThan(3500);
  });
});
