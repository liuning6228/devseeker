/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CVW 验证协议 Prompt 模块单测（docs/verification-workflow-optimization-plan.md §4.4）
 *
 * 覆盖：
 * - 模块必含条款（分级决策树 / 报告格式 / 反作弊 / bash 超时语义）
 * - L1 挂载策略：只在可写模式（agent / debug）注入，只读模式（plan / ask）不注入
 * - 缓存契约：模块为静态文本，同输入必须字节恒等（滚动前缀缓存的前提）
 */

import { describe, it, expect } from 'vitest';
import { VERIFICATION_PROTOCOL_MODULE } from '../../src/core/prompts/modules/index.js';
import { buildL1ToolsMode } from '../../src/core/prompts/layers/tools-mode.js';

describe('VERIFICATION_PROTOCOL_MODULE', () => {
  it('声明"未验证不算完成"并说明门是程序化跟踪的', () => {
    expect(VERIFICATION_PROTOCOL_MODULE).toContain('not complete until it is verified');
    expect(VERIFICATION_PROTOCOL_MODULE).toContain('programmatically');
  });

  it('含五级降级决策树的关键分支', () => {
    const m = VERIFICATION_PROTOCOL_MODULE;
    expect(m).toContain('post-edit diagnostics');
    expect(m).toContain('affected tests');
    expect(m).toContain('smoke test');
    expect(m).toContain('cross-compile');
    expect(m).toContain('manual verification checklist');
  });

  it('嵌入式场景禁止执行交叉编译产物', () => {
    expect(VERIFICATION_PROTOCOL_MODULE).toContain('Never try to execute a cross-compiled artifact');
  });

  it('含 bash 超时语义（超时=切后台，不是被杀）', () => {
    const m = VERIFICATION_PROTOCOL_MODULE;
    expect(m).toContain('120s');
    expect(m).toContain('300s');
    expect(m).toContain('moved to background');
    expect(m).toContain('get_terminal_output');
  });

  it('明确禁止删/跳/弱化断言让测试变绿', () => {
    expect(VERIFICATION_PROTOCOL_MODULE)
      .toContain('Never make tests pass by deleting, skipping, or weakening assertions');
  });

  it('报告格式与 parseVerifyReport 的字段契约一致', () => {
    const m = VERIFICATION_PROTOCOL_MODULE;
    expect(m).toContain('Status:');
    expect(m).toContain('Commands run:');
    expect(m).toContain('Counts:');
    expect(m).toContain('First failure:');
    expect(m).toContain('Next step:');
  });

  it('不含任何动态内容（变更清单/命令由运行时注入，否则击穿 L1 缓存）', () => {
    expect(VERIFICATION_PROTOCOL_MODULE).not.toContain('[Verification Gate]');
    expect(VERIFICATION_PROTOCOL_MODULE).not.toMatch(/npx vitest run \S/);
  });
});

describe('buildL1ToolsMode · 验证协议挂载策略', () => {
  const FEATURE = '# Change Verification Protocol';

  it('agent 模式挂载', () => {
    expect(buildL1ToolsMode({ mode: 'agent', skills: [] })).toContain(FEATURE);
  });

  it('debug 模式挂载', () => {
    expect(buildL1ToolsMode({ mode: 'debug', skills: [] })).toContain(FEATURE);
  });

  it('plan / ask 只读模式不挂载（不会产生编辑）', () => {
    expect(buildL1ToolsMode({ mode: 'plan', skills: [] })).not.toContain(FEATURE);
    expect(buildL1ToolsMode({ mode: 'ask', skills: [] })).not.toContain(FEATURE);
  });

  it('同输入字节恒等（滚动前缀缓存前提）', () => {
    const a = buildL1ToolsMode({ mode: 'agent', skills: [] });
    const b = buildL1ToolsMode({ mode: 'agent', skills: [] });
    expect(a).toBe(b);
  });
});
