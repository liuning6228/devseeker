/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-P2-9 · V2 M3.14 · Prompt 14 模块抽离断言
 * W13.1-A · Phase 3 新增 I18N_COMMENTS_MODULE（中文本地化）
 * V2 M3.14 · 新增 THINKING_FRAMEWORK_MODULE + OUTPUT_STYLE_MODULE
 *
 * 保证：
 *   1. L0 8 个新拆模块都非空 + 各自有唯一特征字串
 *   2. modules/index.ts 恰好汇出 8 个 L0 新模块常量
 *   3. DEFAULT_SYSTEM_PROMPT = 8 个模块按序 '\n\n' 拼接（字节级）
 *   4. PromptBuilder.build 得到的 full 字符串依旧包含 14 模块的关键特征串
 */
import { describe, expect, it } from 'vitest';

import {
  AGENT_IDENTITY_MODULE,
  THINKING_FRAMEWORK_MODULE,
  OUTPUT_STYLE_MODULE,
  TOOL_CONTRACTS_MODULE,
  GENERAL_BEHAVIOR_MODULE,
  MEMORY_POLICY_MODULE,
  REFACTORING_SOP_MODULE,
  I18N_COMMENTS_MODULE,
} from '../../src/core/prompts/modules/index.js';
import { DEFAULT_SYSTEM_PROMPT, buildL0Identity } from '../../src/core/prompts/layers/identity.js';
import { WEB_RESEARCH_PROMPT_MODULE } from '../../src/core/prompts/web-research.js';
import { PromptBuilder } from '../../src/core/prompts/builder.js';
import { buildEnvironmentBlock } from '../../src/core/prompts/environment-probe.js';
import { DEFAULT_MODE } from '../../src/core/modes/index.js';
import type { Skill } from '../../src/core/skills/types.js';
import type { Rule } from '../../src/core/rules/types.js';
import type { MemoryRecord } from '../../src/core/memory/types.js';

describe('B-P2-9 · prompt modules抽离 · V2 M3.14', () => {
  it('L0 八个新模块都非空且互不重复', () => {
    const mods = [
      AGENT_IDENTITY_MODULE,
      THINKING_FRAMEWORK_MODULE,
      OUTPUT_STYLE_MODULE,
      TOOL_CONTRACTS_MODULE,
      GENERAL_BEHAVIOR_MODULE,
      REFACTORING_SOP_MODULE,
      I18N_COMMENTS_MODULE,
      MEMORY_POLICY_MODULE,
    ];
    for (const m of mods) expect(m.length).toBeGreaterThan(0);
    expect(new Set(mods).size).toBe(8);
  });

  it('每个模块含可识别特征串（V2 更新）', () => {
    // V2 三段式 identity
    expect(AGENT_IDENTITY_MODULE).toContain('DevSeeker');
    expect(AGENT_IDENTITY_MODULE).toContain('thinking collaborator');
    expect(AGENT_IDENTITY_MODULE).toContain('expert software engineer');
    // V2 新增 thinking-framework
    expect(THINKING_FRAMEWORK_MODULE).toContain('Thinking Before Acting');
    expect(THINKING_FRAMEWORK_MODULE).toContain('<thinking>');
    // V2 新增 output-style
    expect(OUTPUT_STYLE_MODULE).toContain('Output Style');
    expect(OUTPUT_STYLE_MODULE).toContain('emojis');
    // V2 精简版 tool-contracts
    expect(TOOL_CONTRACTS_MODULE).toContain('read_file');
    expect(TOOL_CONTRACTS_MODULE).toContain('get_problems');
    // V2 精简版 general-behavior
    expect(GENERAL_BEHAVIOR_MODULE.startsWith('Behavior:')).toBe(true);
    expect(GENERAL_BEHAVIOR_MODULE).toContain('get_problems');
    // V2 精简版 refactoring-sop（不再含 SOP 字眼，改为核心原则）
    expect(REFACTORING_SOP_MODULE).toContain('scan all references first');
    // V2 精简版 memory-policy（不再含 W7d1 标记）
    expect(MEMORY_POLICY_MODULE).toContain('Memory Policy:');
    expect(MEMORY_POLICY_MODULE).toContain('update_memory(create)');
    // i18n 不变
    expect(I18N_COMMENTS_MODULE).toContain('Chinese-first i18n policy');
    expect(I18N_COMMENTS_MODULE).toContain('鸿蒙');
    expect(I18N_COMMENTS_MODULE).toContain('通义灵码');
  });

  it('DEFAULT_SYSTEM_PROMPT 等价于 8 模块 \\n\\n 拼接（V2 顺序）', () => {
    const composed = [
      AGENT_IDENTITY_MODULE,
      THINKING_FRAMEWORK_MODULE,
      OUTPUT_STYLE_MODULE,
      TOOL_CONTRACTS_MODULE,
      GENERAL_BEHAVIOR_MODULE,
      REFACTORING_SOP_MODULE,
      I18N_COMMENTS_MODULE,
      MEMORY_POLICY_MODULE,
    ].join('\n\n');
    expect(DEFAULT_SYSTEM_PROMPT).toBe(composed);
  });

  it('buildL0Identity() = DEFAULT + \\n\\n + web-research（无 modelId 时）', () => {
    expect(buildL0Identity()).toBe(DEFAULT_SYSTEM_PROMPT + '\n\n' + WEB_RESEARCH_PROMPT_MODULE);
  });

  it('buildL0Identity("deepseek-chat") 包含 deepseek variant 专属段', () => {
    const result = buildL0Identity('deepseek-chat');
    expect(result).toContain('Model-specific Notes (DeepSeek)');
    expect(result).toContain('1M token context window');
  });

  it('PromptBuilder.build 的 full 应包含 14 个模块的特征串（V2 更新）', () => {
    const skill: Skill = {
      name: 'commit',
      description: 'create git commit',
      source: 'workspace',
      filePath: '/ws/.devseeker/skills/commit/SKILL.md',
      argumentsHint: '-m <msg>',
      body: '# Commit Skill',
    } as unknown as Skill;

    const rules: Rule[] = [
      {
        name: 'test-rule',
        kind: 'always_on',
        description: 'always-on test rule',
        filePath: '/ws/.qoder/rules/test.md',
        content: 'Always lint before push.',
      } as unknown as Rule,
    ];

    const memories: MemoryRecord[] = [
      {
        id: 'm1',
        title: '简短回答',
        content: '回答≤3 句',
        category: 'user_communication',
        keywords: ['简短'],
        scope: 'workspace',
        createdAt: 0,
        updatedAt: 0,
      } as unknown as MemoryRecord,
    ];

    const env = buildEnvironmentBlock({
      now: () => new Date('2026-05-02T10:00:00Z'),
      workspaceRoot: 'c:\\ws\\dualmind',
    });

    const { full } = PromptBuilder.build({
      mode: DEFAULT_MODE,
      skills: [skill],
      selectedRules: rules,
      allRules: rules,
      memories,
      attachments: {
        environment: env,
        selectedCodes: [
          { filePath: 'src/a.ts', startLine: 1, endLine: 3, text: 'const x = 1;' },
        ],
        gitContext: '<git_context>\nbranch: main\n</git_context>',
      },
    });

    // 1. agent-identity (V2 三段式)
    expect(full).toContain('DevSeeker');
    expect(full).toContain('thinking collaborator');
    // 2. thinking-framework (V2 新增)
    expect(full).toContain('Thinking Before Acting');
    expect(full).toContain('<thinking>');
    // 3. output-style (V2 新增)
    expect(full).toContain('Output Style');
    expect(full).toContain('emojis');
    // 4. tool-contracts
    expect(full).toContain('read_file');
    expect(full).toContain('get_problems');
    // 5. general-behavior
    expect(full).toContain('Prefer minimal diffs');
    // 6. refactoring-sop (V2 精简)
    expect(full).toContain('scan all references first');
    // 7. memory-policy (V2 精简)
    expect(full).toContain('Memory Policy:');
    // 8. web-research
    expect(full).toContain('Web Research');
    // 9. mode-section
    expect(full.toLowerCase()).toMatch(/agent|ask|debug|plan/);
    // 10. skills-manifest
    expect(full).toContain('Available Skills');
    expect(full).toContain('MUST invoke `skill()`');
    expect(full).toContain('Do NOT try to solve the task directly');
    expect(full).toContain('commit');
    // 11. rules-section
    expect(full).toContain('Always lint before push.');
    // 12. model-decision-index（无 md 规则时此段省略，这里不强断言）
    // 13. memory-overview
    expect(full).toContain('简短回答');
    // 14. environment
    expect(full).toContain('<environment>');
    // 15. selected-codes + git-context
    expect(full).toContain('<selected_codes>');
    expect(full).toContain('<git_context>');
  });
});
