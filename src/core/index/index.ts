/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CodebaseIndex barrel export
 */

export {
  scanWorkspace,
  DEFAULT_INCLUDE_EXT,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_MAX_FILE_SIZE,
  hasIgnoredDirSegment,
  type ScannerOptions,
  type ScannedFile,
  type ScanResult,
} from './scanner.js';
export { chunkText, type ChunkOptions, type TextChunk } from './chunker.js';
export {
  DashScopeEmbedder,
  OpenAICompatibleEmbedder,
  OllamaEmbedder,
  OPENAI_DEFAULT_BASE,
  OPENAI_DIM_BY_MODEL,
  type Embedder,
  type EmbedResult,
  type EmbedOptions,
  type DashScopeEmbedderConfig,
  type OpenAICompatibleEmbedderConfig,
  type OllamaEmbedderConfig,
} from './embedder.js';
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
export {
  FusionSearcher,
  reciprocalRankFusion,
  routeQuery,
  type SearchSource,
  type FusionHit,
  type FusionSearchResult,
  type FusionSearcherOptions,
  type RouteDecision,
} from './fusion-searcher.js';
export {
  GraphIndex,
  GraphSearchSource,
  type SymbolRef,
  type SymbolKind,
  type CallChainNode,
  type GraphIndexOptions,
  type FileExtractionResult,
  type ExtractedSymbol,
  type ExtractedCall,
  type ExtractedImport,
  type HotSymbolRow,
} from './graph-index.js';
export { extractGraphData, extractGraphDataBatch } from './graph-extractor.js';
export {
  buildRepoMap,
  buildRepoMapFocus,
  type RepoMapGraphSource,
  type RepoMapOptions,
  type RepoMapStats,
  type RepoMapResult,
} from './repo-map.js';
