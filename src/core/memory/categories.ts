/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Memory 分类注册表（W4 批次 2）
 *
 * 对齐   记忆体系 "22 可写 + 6 系统沉淀"：
 * - 可写：由 update_memory 工具创建 / 更新 / 删除
 * - 系统沉淀：由 Agent 内部流程自动产出，工具层不允许显式写入
 *
 * 参考：docs/SPEC/memory-model.md（未来补齐）
 */

/** 可写类别 —— 22 类 */
export const WRITABLE_CATEGORIES = [
  // user_* —— 用户画像与偏好（4）
  'user_info',
  'user_hobby',
  'user_communication',
  'user_behavior',
  // project_* —— 当前项目配置与说明（8）
  'project_tech_stack',
  'project_build_configuration',
  'project_dependency_configuration',
  'project_ide_configuration',
  'project_scm_configuration',
  'project_environment_configuration',
  'project_introduction',
  'project_rule',
  // development_* —— 开发规范（4）
  'development_code_specification',
  'development_practice_specification',
  'development_test_specification',
  'development_comment_specification',
  // experience —— 可显式写入的经验（6）
  'expert_experience',
  'learned_skill_experience',
  'common_pitfalls_experience',
  'tool_experience',
  'mcp_experience',
  'important_decision_experience',
] as const;

/** 系统沉淀类别 —— 6 类，工具层只读 */
export const SYSTEM_CATEGORIES = [
  'task_breakdown_experience',
  'task_flow_experience',
  'history_task_workflow',
  'history_task_reference_files',
  'plan_experience',
  'task_summary_experience',
] as const;

/** 所有合法类别（写入校验用） */
export const ALL_CATEGORIES = [...WRITABLE_CATEGORIES, ...SYSTEM_CATEGORIES] as const;

export type WritableCategory = (typeof WRITABLE_CATEGORIES)[number];
export type SystemCategory = (typeof SYSTEM_CATEGORIES)[number];
export type MemoryCategory = WritableCategory | SystemCategory;

const WRITABLE_SET: ReadonlySet<string> = new Set(WRITABLE_CATEGORIES);
const ALL_SET: ReadonlySet<string> = new Set(ALL_CATEGORIES);

export function isValidCategory(c: string): c is MemoryCategory {
  return ALL_SET.has(c);
}

export function isWritableCategory(c: string): c is WritableCategory {
  return WRITABLE_SET.has(c);
}

/** 大类根节点（用于 explore 模式的树形导航） */
export const CATEGORY_GROUPS: Record<string, readonly MemoryCategory[]> = {
  user: [
    'user_info',
    'user_hobby',
    'user_communication',
    'user_behavior',
  ],
  project: [
    'project_tech_stack',
    'project_build_configuration',
    'project_dependency_configuration',
    'project_ide_configuration',
    'project_scm_configuration',
    'project_environment_configuration',
    'project_introduction',
    'project_rule',
  ],
  development: [
    'development_code_specification',
    'development_practice_specification',
    'development_test_specification',
    'development_comment_specification',
  ],
  experience: [
    'expert_experience',
    'learned_skill_experience',
    'common_pitfalls_experience',
    'tool_experience',
    'mcp_experience',
    'important_decision_experience',
  ],
  system: [
    'task_breakdown_experience',
    'task_flow_experience',
    'history_task_workflow',
    'history_task_reference_files',
    'plan_experience',
    'task_summary_experience',
  ],
} as const;
