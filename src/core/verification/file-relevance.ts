/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 变更文件相关性判定（CVW §4.3 补充 · 纯文档放行）
 *
 * 背景：验证门此前只看「有没有编辑」（`editedFiles.size > 0`），
 * 编辑 README / 设计文档等纯文本文件也会走完整条链：
 * soft 提醒 → 要求跑类型检查/lint →（模型不服从时）hard 门派发 Verify 子代理。
 * 对纯文档变更而言不存在可自动化的验证动作，属无谓开销（多一轮 LLM + 可能的
 * 300s 子代理超时预算）。
 *
 * 分类原则（**保守**：宁可多验证，不可漏验证）：
 * - 只有明确不可能影响构建/测试产物的纯文档才判为可跳过；
 * - `.txt` 故意不整体算文档：requirements.txt / CMakeLists.txt 是构建输入，
 *   仅当文件名为 LICENSE / CHANGELOG 等文档名时才命中；
 * - `.json` / `.yml` / `.yaml` / `.sh` 等一律不算：可能是构建/运行配置。
 */

import { posix } from 'node:path';

/** 纯文档扩展名（保守集合，不含 .txt） */
const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.rst',
  '.adoc',
]);

/** 纯文档文件名（小写，无扩展名形式）；也用于 `.txt` 前缀判定（LICENSE.txt） */
const DOC_BASENAMES: ReadonlySet<string> = new Set([
  'license',
  'changelog',
  'authors',
  'notice',
  'copying',
]);

/**
 * 判定单个文件是否为纯文档（绝对或相对路径、正/反斜杠均可）。
 *
 * 命中规则（自上而下）：
 * 1. 无扩展名的文档名：`LICENSE` / `CHANGELOG`；
 * 2. 纯文档扩展名：`.md` / `.markdown` / `.mdx` / `.rst` / `.adoc`；
 * 3. `.txt` 且文件名词干为文档名：`LICENSE.txt` / `CHANGELOG.txt`。
 */
export function isDocumentationFile(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  const base = posix.basename(p).toLowerCase();
  const ext = posix.extname(base);
  if (DOC_BASENAMES.has(base)) return true;
  if (DOC_EXTENSIONS.has(ext)) return true;
  if (ext === '.txt' && DOC_BASENAMES.has(base.slice(0, -ext.length))) return true;
  return false;
}

/**
 * 判定编辑集是否「全部为纯文档」。
 *
 * - 空集返回 false（无编辑走零开销路径，不属于本判定语义）；
 * - 混合变更（文档 + 任何非文档）返回 false → 维持原有验证门行为。
 */
export function isDocOnlyChange(files: Iterable<string>): boolean {
  let seen = false;
  for (const f of files) {
    seen = true;
    if (!isDocumentationFile(f)) return false;
  }
  return seen;
}
