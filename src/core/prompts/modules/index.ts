/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Prompt Modules 汇出（V2 · M3.14 · 14 模块抽离）
 *
 * 14 模块清单（按注入位置）：
 *   L0 稳定区（9 个）：
 *     1. agent-identity         —— 三段式身份 + 角色 + 方法论（V2 升级）
 *     2. thinking-framework     —— <thinking> 先思再行（V2 新增）
 *     3. output-style           —— 输出效率 + markdown 引用（V2 新增）
 *     4. tool-contracts         —— 工具契约（V2 精简）
 *     5. general-behavior       —— 通用行为（V2 精简，移出分块细则）
 *     6. refactoring-sop        —— 跨文件重构 SOP（V2 精简为 1 条原则）
 *     7. i18n-comments          —— 中文注释/文档规范
 *     8. memory-policy          —— 记忆策略（V2 精简）
 *     9. web-research           —— 联网纪律（prompts/web-research.ts）
 *   L1 会话区：
 *    10. mode-section           —— 当前 Mode 指令（core/modes/index.ts）
 *    11. skills-manifest        —— workspace + builtin 技能清单
 *   L2 工作区：
 *    12. rules-section          —— always_on + glob 命中规则
 *    13. model-decision-index   —— 可按需 fetch 的规则目录
 *    14. memory-overview        —— 硬约束 + 软记忆标题
 *   L3 附件区：
 *    15. environment            —— EnvironmentProbe
 *    16. selected-codes / git-context / attachments —— 会话级附件
 */

export { AGENT_IDENTITY_MODULE } from './agent-identity.js';
export { THINKING_FRAMEWORK_MODULE } from './thinking-framework.js';
export { OUTPUT_STYLE_MODULE } from './output-style.js';
export { TOOL_CONTRACTS_MODULE } from './tool-contracts.js';
export { GENERAL_BEHAVIOR_MODULE } from './general-behavior.js';
export { REFACTORING_SOP_MODULE } from './refactoring-sop.js';
export { I18N_COMMENTS_MODULE } from './i18n-comments.js';
export { MEMORY_POLICY_MODULE } from './memory-policy.js';
export { HARMONYOS_ECOSYSTEM_MODULE } from './ecosystem-harmonyos.js';
export { VUE_ECOSYSTEM_MODULE } from './ecosystem-vue.js';
export { ELEMENT_PLUS_ECOSYSTEM_MODULE } from './ecosystem-element-plus.js';
export { TONGYI_ECOSYSTEM_MODULE } from './ecosystem-tongyi.js';
export { VLM_OCR_POLICY_MODULE } from './vlm-ocr-policy.js';
