import { useMemo, useState } from 'react';
import type { ToolDiffPayload, TodoItem } from '../protocol';

/**
 * W-UI2 · 聚合后的变更文件项（按 relPath 去重，多次编辑累加行差，保留最新 checkpointId 以便 revert）
 */
export interface ChangedFileItem {
  relPath: string;
  added: number;
  removed: number;
  /** 最新一次 diff 的 checkpointId，用于 revert 到最近一次修改前 */
  latestCheckpointId?: string;
  /** 是否已被 revert（任一 diff 已 revert，UI 加 strike-through 提示） */
  reverted: boolean;
  /** 累计修改次数 */
  edits: number;
}

export interface ChangeSummaryProps {
  todos: TodoItem[];
  changedFiles: ChangedFileItem[];
  /** W-UI2 · 用户已 accept 的文件 relPath 列表 */
  acceptedFiles?: string[];
  /** W-UI2 · 用户已 reject 的文件 relPath 列表 */
  rejectedFiles?: string[];
  onOpenFile?: (req: { path: string }) => void;
  /** W-UI2 · 单文件 accept（纯UI） */
  onAcceptFile?: (relPath: string) => void;
  /** W-UI2 · 批量 accept 所有 pending 文件 */
  onAcceptAll?: (relPaths: string[]) => void;
  /** W-UI2 · 单文件 reject（回滚文件） */
  onRejectFile?: (relPath: string) => void;
  /** W-UI2 · 批量 reject 所有 pending 文件 */
  onRejectAll?: (relPaths: string[]) => void;
}

const STATUS_LABEL: Record<TodoItem['status'], string> = {
  PENDING: '待办',
  IN_PROGRESS: '进行中',
  COMPLETE: '完成',
  CANCELLED: '取消',
};

/**
 * W-UI2 · 双 accordion：Tasks（待办）+ Changed Files（变更文件）
 *
 * - 两个段都可折叠（默认展开）
 * - Tasks 段根据 status 渲染圆点 + 删除线
 * - Changed Files 段渲染路径 + `+N / -M` 徽章 + (可选) Revert 按钮
 * - 两段都为空时整个面板不渲染（避免占用消息流顶部空间）
 */
export function ChangeSummary({
  todos,
  changedFiles,
  acceptedFiles = [],
  rejectedFiles = [],
  onOpenFile,
  onAcceptFile,
  onAcceptAll,
  onRejectFile,
  onRejectAll,
}: ChangeSummaryProps): JSX.Element | null {
  const [tasksOpen, setTasksOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);

  const taskCount = todos.length;
  const fileCount = changedFiles.length;
  const runningCount = useMemo(
    () => todos.filter((t) => t.status === 'IN_PROGRESS').length,
    [todos],
  );
  const completeCount = useMemo(
    () => todos.filter((t) => t.status === 'COMPLETE').length,
    [todos],
  );
  const totalAdded = useMemo(
    () => changedFiles.reduce((s, f) => s + f.added, 0),
    [changedFiles],
  );
  const totalRemoved = useMemo(
    () => changedFiles.reduce((s, f) => s + f.removed, 0),
    [changedFiles],
  );

  // W-UI2 · 统计已接受 / 已拒绝 / 待处理
  const acceptedSet = useMemo(() => new Set(acceptedFiles), [acceptedFiles]);
  const rejectedSet = useMemo(() => new Set(rejectedFiles), [rejectedFiles]);
  const acceptedCount = useMemo(
    () => changedFiles.filter((f) => acceptedSet.has(f.relPath)).length,
    [changedFiles, acceptedSet],
  );
  const rejectedCount = useMemo(
    () => changedFiles.filter((f) => rejectedSet.has(f.relPath)).length,
    [changedFiles, rejectedSet],
  );
  const pendingFiles = useMemo(
    () => changedFiles.filter((f) => !acceptedSet.has(f.relPath) && !rejectedSet.has(f.relPath) && !f.reverted),
    [changedFiles, acceptedSet, rejectedSet],
  );
  const pendingCount = pendingFiles.length;

  if (taskCount === 0 && fileCount === 0) return null;

  return (
    <div className="change-summary" aria-label="会话工作区摘要">
      {taskCount > 0 && (
        <section className={`change-summary__section ${tasksOpen ? 'is-open' : ''}`}>
          <button
            type="button"
            className="change-summary__header"
            onClick={() => setTasksOpen((o) => !o)}
            aria-expanded={tasksOpen}
          >
            <span className="change-summary__chevron" aria-hidden="true">
              {tasksOpen ? '▾' : '▸'}
            </span>
            <span className="change-summary__title">Tasks</span>
            {taskCount > 0 && (
              <span className="change-summary__task-progress" title={`${completeCount}/${taskCount} 已完成`}>
                <span className="change-summary__task-progress-fill" style={{ width: `${Math.round((completeCount / taskCount) * 100)}%` }} />
              </span>
            )}
            <span className="change-summary__count">
              ✅ {completeCount}/{taskCount}
            </span>
            {runningCount > 0 && (
              <span
                className="change-summary__badge change-summary__badge--running"
                title={`${runningCount} 项进行中`}
              >
                ● {runningCount}
              </span>
            )}
          </button>
          {tasksOpen && (
            <ul className="change-summary__list change-summary__list--tasks">
              {todos.map((t) => (
                <li
                  key={t.id}
                  className={`change-summary__task change-summary__task--${t.status.toLowerCase()}`}
                  title={`${STATUS_LABEL[t.status]}: ${t.content}`}
                >
                  <span
                    className={`change-summary__dot change-summary__dot--${t.status.toLowerCase()}`}
                    aria-hidden="true"
                  />
                  <span className="change-summary__task-text">{t.content}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {fileCount > 0 && (
        <section className={`change-summary__section ${filesOpen ? 'is-open' : ''}`}>
          {/* W-UI2 · header 改为 div role=button 以支持内嵌 batch 按钮（HTML 禁止 button 嵌套 button） */}
          <div
            role="button"
            tabIndex={0}
            className="change-summary__header"
            onClick={() => setFilesOpen((o) => !o)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setFilesOpen((o) => !o);
              }
            }}
            aria-expanded={filesOpen}
          >
            <span className="change-summary__chevron" aria-hidden="true">
              {filesOpen ? '▾' : '▸'}
            </span>
            <span className="change-summary__title">Changed Files</span>
            <span className="change-summary__count">{fileCount}</span>
            <span
              className="change-summary__badge change-summary__badge--diff"
              title={`总计 +${totalAdded} / -${totalRemoved}`}
            >
              +{totalAdded} / -{totalRemoved}
            </span>
            {/* W-UI2 · 状态徽章：N 已接受 / M 待处理 */}
            {acceptedCount > 0 && (
              <span
                className="change-summary__badge change-summary__badge--accepted"
                title={`${acceptedCount} 项已接受`}
              >
                ✓ {acceptedCount} 已接受
              </span>
            )}
            {pendingCount > 0 && (
              <span
                className="change-summary__badge change-summary__badge--pending"
                title={`${pendingCount} 项待处理`}
              >
                ○ {pendingCount} 待处理
              </span>
            )}
            {/* W-UI2 · 批量 [Accept all] / [Reject all] */}
            {pendingCount > 0 && (
              <span className="change-summary__batch" onClick={(e) => e.stopPropagation()}>
                {onAcceptAll && (
                  <button
                    type="button"
                    className="change-summary__batch-btn change-summary__batch-btn--accept"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAcceptAll(pendingFiles.map((f) => f.relPath));
                    }}
                    title={`接受所有 ${pendingCount} 项待处理文件`}
                  >
                    ✓ Accept all
                  </button>
                )}
                {onRejectAll && (
                  <button
                    type="button"
                    className="change-summary__batch-btn change-summary__batch-btn--reject"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRejectAll(pendingFiles.map((f) => f.relPath));
                    }}
                    title={`拒绝所有 ${pendingCount} 项待处理文件（回滚到修改前）`}
                  >
                    ✗ Reject all
                  </button>
                )}
              </span>
            )}
          </div>
          {filesOpen && (
            <ul className="change-summary__list change-summary__list--files">
              {changedFiles.map((f) => {
                const isAccepted = acceptedSet.has(f.relPath);
                const isRejected = rejectedSet.has(f.relPath);
                const isReverted = f.reverted;
                const isPending = !isAccepted && !isRejected && !isReverted;
                return (
                  <li
                    key={f.relPath}
                    className={`change-summary__file ${isReverted ? 'is-reverted' : ''} ${isAccepted ? 'is-accepted' : ''} ${isRejected ? 'is-rejected' : ''}`}
                  >
                    <button
                      type="button"
                      className="change-summary__file-path"
                      onClick={() => onOpenFile?.({ path: f.relPath })}
                      title={`打开 ${f.relPath}（共 ${f.edits} 次修改）`}
                    >
                      {f.relPath}
                    </button>
                    <span
                      className="change-summary__file-diff"
                      title={`+${f.added} / -${f.removed}`}
                    >
                      <span className="change-summary__file-add">+{f.added}</span>
                      <span className="change-summary__file-del">-{f.removed}</span>
                    </span>
                    {/* W-UI2 · 状态标签 */}
                    {isAccepted && (
                      <span className="change-summary__file-status change-summary__file-status--accepted">已接受</span>
                    )}
                    {isRejected && (
                      <span className="change-summary__file-status change-summary__file-status--rejected">已拒绝</span>
                    )}
                    {isReverted && (
                      <span className="change-summary__file-status change-summary__file-status--reverted">已回滚</span>
                    )}
                    {/* W-UI2 · 行内 ✓ accept / ✗ reject 按钮（只在 pending 时） */}
                    {isPending && onAcceptFile && onRejectFile && (
                      <span className="change-summary__file-actions">
                        <button
                          type="button"
                          className="change-summary__file-accept"
                          onClick={() => onAcceptFile(f.relPath)}
                          title="接受该文件的修改"
                          aria-label="接受"
                        >
                          ✓ 接受
                        </button>
                        <button
                          type="button"
                          className="change-summary__file-reject"
                          onClick={() => onRejectFile(f.relPath)}
                          title="拒绝该文件的修改（回滚到修改前）"
                          aria-label="拒绝"
                        >
                          ✗ 拒绝
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * W-UI2 · 从 messages 中聚合变更文件清单。
 * - 同一 relPath 多次修改 → added/removed 累加，edits++，latestCheckpointId 取最后一次
 * - 若任一该文件的 diff 已 revert，则 reverted=true（UI 提示）
 */
export function aggregateChangedFiles(
  messages: ReadonlyArray<{
    parts: ReadonlyArray<
      | { kind: 'tool'; diff?: ToolDiffPayload; revertState?: { ok: boolean } }
      | { kind: 'text'; text: string }
    >;
  }>,
): ChangedFileItem[] {
  const map = new Map<string, ChangedFileItem>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.kind !== 'tool') continue;
      const diff = part.diff;
      if (!diff) continue;
      const prev = map.get(diff.relPath);
      const revertedNow = part.revertState?.ok === true;
      if (prev) {
        prev.added += diff.added;
        prev.removed += diff.removed;
        prev.edits += 1;
        prev.latestCheckpointId = diff.checkpointId ?? prev.latestCheckpointId;
        prev.reverted = prev.reverted || revertedNow;
      } else {
        map.set(diff.relPath, {
          relPath: diff.relPath,
          added: diff.added,
          removed: diff.removed,
          edits: 1,
          latestCheckpointId: diff.checkpointId,
          reverted: revertedNow,
        });
      }
    }
  }
  return Array.from(map.values());
}
