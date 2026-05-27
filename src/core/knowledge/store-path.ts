/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W14.1 · 私有知识库 · 路径约定
 *
 * 约定目录：`<workspace>/.devseeker/knowledge/**\/*.md`（相对工作区）
 *   - 用户把团队 markdown 文档（架构说明、规范、onboarding…）放进该目录
 *   - `search_knowledge` 工具只在此目录下检索，与 `search_codebase` 分库
 *
 * 索引快照：`<workspace>/.devseeker/knowledge-index.json`
 *   - 独立于 `bm25-index.json` / `codebase-index.json`，避免 reindex 冲突
 *   - flavor 字段继承自 Bm25Index（`'bm25'`）
 */

import { join as joinPath } from 'node:path';

/** 知识库根目录（默认 `<ws>/.devseeker/knowledge`）。 */
export function defaultKnowledgeRoot(workspaceRoot: string): string {
  return joinPath(workspaceRoot, '.devseeker', 'knowledge');
}

/** 知识库 BM25 索引快照文件（默认 `<ws>/.devseeker/knowledge-index.json`）。 */
export function defaultKnowledgeIndexPath(workspaceRoot: string): string {
  return joinPath(workspaceRoot, '.devseeker', 'knowledge-index.json');
}
