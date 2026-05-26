/**
 * DiffPreview —— unified diff 着色渲染（DESIGN §M11.1）
 *
 * W15.6 升级：
 * - 按 hunk 分组渲染，每个 hunk 顶部有 Accept / Reject 浮条
 * - Accept：仅 UI 标记（文件已修改）
 * - Reject：向 extension 发送 revert_hunk 请求，回滚该 hunk
 *
 * 输入：unified diff 文本（含 `--- a/... / +++ b/...` 头 + `@@ hunks @@`）
 * 输出：按 hunk 分组的着色块（+绿 / -红 / ` ` 上下文淡色 / `@@` 灰蓝）
 */

import { useMemo, useState, useCallback } from 'react';
import type { ToolDiffPayload } from '../protocol';
import { parseUnifiedDiff, hunkStats } from '../../../src/core/diff/hunk-parser';

export interface DiffPreviewProps {
  diff: ToolDiffPayload;
  /** W15.6 · hunk 级 Reject 回调 */
  onRevertHunk?: (relPath: string, hunkUnified: string, nonce: string) => void;
  /** W15.6 · 已被 revert 的 hunk nonce 集合 */
  revertedHunks?: Set<string>;
}

export function DiffPreview({ diff, onRevertHunk, revertedHunks }: DiffPreviewProps): JSX.Element {
  const [open, setOpen] = useState(false);

  const parsed = useMemo(() => {
    if (!diff.unified) return null;
    return parseUnifiedDiff(diff.unified);
  }, [diff.unified]);

  // 如果无法解析（格式异常），回退到纯文本行渲染
  const fallbackLines = useMemo(() => {
    return diff.unified ? diff.unified.split('\n') : [];
  }, [diff.unified]);

  const handleReject = useCallback(
    (hunkIndex: number) => {
      if (!onRevertHunk || !parsed) return;
      const hunk = parsed.hunks[hunkIndex];
      if (!hunk) return;
      // 构造该 hunk 的 mini unified diff（含文件头 + 单个 hunk）
      const miniUnified = buildMiniUnified(parsed, hunk);
      const nonce = `${diff.toolCallId}:${hunkIndex}`;
      onRevertHunk(diff.relPath, miniUnified, nonce);
    },
    [onRevertHunk, parsed, diff.relPath, diff.toolCallId],
  );

  return (
    <div className="diff-preview">
      <button
        type="button"
        className="diff-preview__header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="diff-preview__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="diff-preview__path">
          {diff.created ? '+ ' : diff.deleted ? '- ' : ''}
          {diff.relPath}
        </span>
        <span className="diff-preview__stats">
          <span className="diff-preview__add">+{diff.added}</span>
          <span className="diff-preview__del">-{diff.removed}</span>
        </span>
      </button>
      {open && (
        <div className="diff-preview__body">
          {diff.truncated && (
            <div className="diff-preview__truncation-notice">
              Diff truncated: {diff.totalHunks} hunks total, showing first {diff.shownHunks}. Open the file in editor to see all changes.
            </div>
          )}
          {!parsed || parsed.hunks.length === 0 ? (
            <pre>
              {fallbackLines.map((line, i) => (
                <div key={i} className={`diff-line ${classifyLine(line)}`}>
                  {line || ' '}
                </div>
              ))}
            </pre>
          ) : (
            parsed.hunks.map((hunk) => {
              const nonce = `${diff.toolCallId}:${hunk.index}`;
              const isReverted = revertedHunks?.has(nonce);
              const stats = hunkStats(hunk);
              return (
                <div key={hunk.index} className={`diff-hunk${isReverted ? ' diff-hunk--reverted' : ''}`}>
                  <div className="diff-hunk__header-bar">
                    <span className="diff-hunk__range">
                      @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
                      {hunk.header ? ` ${hunk.header}` : ''}
                    </span>
                    <span className="diff-hunk__stats">
                      {stats.added > 0 && <span className="diff-hunk__add">+{stats.added}</span>}
                      {stats.removed > 0 && <span className="diff-hunk__del">-{stats.removed}</span>}
                    </span>
                    {!isReverted && onRevertHunk && (
                      <span className="diff-hunk__actions">
                        <button
                          type="button"
                          className="diff-hunk__accept"
                          onClick={() => { /* Accept 仅 UI 标记，目前无额外动作 */ }}
                          title="接受该 hunk"
                        >
                          ✓
                        </button>
                        <button
                          type="button"
                          className="diff-hunk__reject"
                          onClick={() => handleReject(hunk.index)}
                          title="拒绝该 hunk（回滚此段修改）"
                        >
                          ✗
                        </button>
                      </span>
                    )}
                    {isReverted && (
                      <span className="diff-hunk__reverted-label">已回滚</span>
                    )}
                  </div>
                  <pre className="diff-hunk__lines">
                    {hunk.lines.map((line, i) => (
                      <div
                        key={i}
                        className={`diff-line diff-line--${line.type}`}
                      >
                        {line.raw}
                      </div>
                    ))}
                  </pre>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function classifyLine(line: string): string {
  if (line.startsWith('@@')) return 'diff-line--hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-line--header';
  if (line.startsWith('+')) return 'diff-line--add';
  if (line.startsWith('-')) return 'diff-line--del';
  return 'diff-line--ctx';
}

/** 构造单个 hunk 的 mini unified diff（供 revert_hunk 使用） */
function buildMiniUnified(parsed: NonNullable<ReturnType<typeof parseUnifiedDiff>>, hunk: { index: number }): string {
  const lines: string[] = [];
  if (parsed.oldPath) lines.push(`--- ${parsed.oldPath}`);
  if (parsed.newPath) lines.push(`+++ ${parsed.newPath}`);
  // 重新查找该 hunk 的完整原始文本
  // 简单做法：从完整的 unified diff 中提取该 hunk
  // 但为了正确性，我们从 parsed.hunks 中重建
  const fullHunk = parsed.hunks.find((h) => h.index === hunk.index);
  if (!fullHunk) return '';
  lines.push(`@@ -${fullHunk.oldStart},${fullHunk.oldCount} +${fullHunk.newStart},${fullHunk.newCount} @@${fullHunk.header ? ' ' + fullHunk.header : ''}`);
  for (const l of fullHunk.lines) {
    lines.push(l.raw);
  }
  return lines.join('\n');
}
