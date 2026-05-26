/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CodebaseIndex barrel export
 */

export {
  scanWorkspace,
  DEFAULT_INCLUDE_EXT,
  DEFAULT_MAX_FILE_SIZE,
  type ScannerOptions,
  type ScannedFile,
  type ScanResult,
} from './scanner.js';
export { chunkText, type ChunkOptions, type TextChunk } from './chunker.js';
export { DashScopeEmbedder, OllamaEmbedder, type Embedder, type EmbedResult, type EmbedOptions, type DashScopeEmbedderConfig, type OllamaEmbedderConfig } from './embedder.js';
export { LocalBertEmbedder, type LocalBertEmbedderConfig } from './local-bert-embedder.js';
export { WorkerEmbedder, type WorkerEmbedderConfig } from './worker-embedder.js';
export {
  InMemoryVectorStore,
  type VectorRecord,
  type SearchHit,
  type VectorStoreSnapshot,
} from './vector-store.js';
export {
  CodebaseIndex,
  defaultIndexStorePath,
  type CodebaseIndexOptions,
  type IndexProgress,
  type IndexReader,
  type CodebaseIndexLike,
  type SearchResult,
  type ReindexStats,
} from './codebase-index.js';
export {
  Bm25CodebaseIndex,
  defaultBm25IndexStorePath,
  type Bm25CodebaseIndexOptions,
} from './bm25-codebase-index.js';
export {
  keywordRerank,
  extractKeywords,
  type Rankable,
  type RerankOptions,
} from './reranker.js';
export {
  Bm25Index,
  tokenize as bm25Tokenize,
  type Bm25Record,
  type Bm25Hit,
  type Bm25Snapshot,
  type Bm25IndexOptions,
} from './bm25-index.js';
