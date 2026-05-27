/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Memory 模块 barrel export
 */
export {
  WRITABLE_CATEGORIES,
  SYSTEM_CATEGORIES,
  ALL_CATEGORIES,
  CATEGORY_GROUPS,
  isValidCategory,
  isWritableCategory,
  type WritableCategory,
  type SystemCategory,
  type MemoryCategory,
} from './categories.js';
export type {
  MemoryRecord,
  MemoryScope,
  MemoryAction,
  SearchDepth,
  MemoryHit,
} from './types.js';
export { MemoryStore, extractKeywords, type MemoryStoreOptions } from './store.js';
export { MemoryManager, type IMemoryProvider, type MemoryManagerOptions, type ProviderToolSchema, type MemoryWriteAction, type MemoryQueryFilter } from './provider.js';
export { BuiltinMemoryProvider } from './builtin-provider.js';
export { buildFrozenSnapshot } from './snapshot.js';
export { scanMemoryContent } from './scan.js';
export { migrateJsonlToMd, type MigrationResult } from './migrate-jsonl-to-md.js';
export { PrefetchEngine } from './prefetch.js';
export { renderMemoryOverview, renderTaskContextSection, enhanceWithVectorMatch } from './overview.js';
export {
  searchMemories,
  cosineSimilarity,
  type SearchInput,
  type SearchOutput,
  type ExploreResult,
} from './search.js';
export {
  BUILTIN_MEMORY_SEEDS,
  ensureSeedMemories,
  type MemorySeed,
  type EnsureSeedOptions,
  type EnsureSeedResult,
} from './seeds.js';
