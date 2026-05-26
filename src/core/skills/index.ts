/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Skills 子系统 barrel export
 */
export * from './types.js';
export { parseSkillFile } from './parser.js';
export {
  SkillLoader,
  type SkillLoadResult,
  type SkillLoaderOptions,
} from './loader.js';
export { BUILTIN_SKILLS, BUILTIN_SKILL_NAMES } from './builtin.js';
export {
  SkillDedupTracker,
  DEFAULT_SKILL_DEDUP_MS,
  buildAlreadyLoadedReminder,
  type SkillDedupTrackerOptions,
} from './dedup.js';
