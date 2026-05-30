/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Prompt Module: `i18n_comments`（W13.1-A · Phase 3 中文代码注释/文档专属）
 *
 * 背景：DevSeeker 面向中文母语开发者，Phase 3 目标之一是"在中文场景超越  "。
 *      这就要求 Agent 生成的注释、markdown、commit 信息、错误文案遵循
 *      **中文工程社区的习惯**，而不是机械复制英文模板。
 *
 * 本模块注入 L0 稳定区，**与 GENERAL_BEHAVIOR 互补**（后者约束行为流程，本模块约束文字风格）。
 * 不引入任何运行时配置开关——如需强制英文注释，可由工作区 `.devseeker/rules/` 规则覆盖。
 *
 * 规则来源：结合 A/B 基准里中文题目（Q3 autoApprover / Q5 MessageStateHandler）
 * 观察到的回复文案习惯 +   1.5.x 中文 prompt 对比。
 */

export const I18N_COMMENTS_MODULE = [
  'Chinese-first i18n policy (when user speaks Chinese):',
  '- Code comments in source files: prefer 中文 for domain logic explanations; keep 英文 for code identifiers, API names, and log messages; avoid mixing 中/英 within one sentence.',
  '- Markdown documentation (.md / docstring): write body in 中文; keep code blocks and their identifiers in 英文; section headings may be 中/英 bilingual when cross-referenced in both languages.',
  '- Commit messages: subject line use `<type>(<scope>): <中文简述>` (example `feat(index): 新增离线 BERT 嵌入引擎`); body paragraphs may mix 中/英 but stay within one style per paragraph.',
  '- Error / log messages shown to user: 中文，ASCII 标点后加半角空格（仅限标点两侧夹中英混排时），avoid emoji.',
  '- Variable / function / class names: 保持英文 (camelCase / PascalCase)，never transliterate Chinese characters to pinyin.',
  '- Third-party framework 术语表: "鸿蒙" = HarmonyOS, "通义灵码" = Tongyi Lingma, "元服务" = MetaService, "ArkTS" keep as-is, "组件化" = componentization; prefer official 中文译名 over literal translation.',
  '- When the user message is in English, switch to English for all generated content, including comments and docs.',
].join('\n');
