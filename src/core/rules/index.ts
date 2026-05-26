/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Rules 子系统 barrel export
 */
export * from './types.js';
export { parseRuleFile } from './parser.js';
export { RuleLoader, type LoadResult, type RuleLoaderOptions } from './loader.js';
export { matchGlob, matchAnyGlob, globToRegex, toPosixPath } from './glob.js';
export {
  selectForPrompt,
  renderForSystemPrompt,
  listModelDecisionRules,
  type SelectContext,
} from './selector.js';