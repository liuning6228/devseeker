import React from 'react';
import { FileCode, Check, X, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface DiffHunk {
  content: string;
  added: number;
  removed: number;
}

interface DiffEditRowProps {
  relPath: string;
  hunks: DiffHunk[];
  totalAdded: number;
  totalRemoved: number;
  isStreaming?: boolean;
  reverted?: boolean;
  onAccept?: () => void;
  onReject?: () => void;
  onRevert?: () => void;
}

/**
 * DiffEditRow — search_replace / write_file 的 diff 展示
 *
 * 渲染文件的 unified diff，支持
 * - 折叠/展开
 * - Accept / Reject 按钮
 * - Reverted 状态显示
 * - 行数统计（+绿/-红）
 */
export function DiffEditRow({
  relPath,
  hunks,
  totalAdded,
  totalRemoved,
  isStreaming,
  reverted,
  onAccept,
  onReject,
  onRevert,
}: DiffEditRowProps) {
  const [expanded, setExpanded] = React.useState(true);
  const [accepted, setAccepted] = React.useState(false);
  const [rejected, setRejected] = React.useState(false);

  const handleAccept = () => {
    setAccepted(true);
    setRejected(false);
    onAccept?.();
  };

  const handleReject = () => {
    setRejected(true);
    setAccepted(false);
    onReject?.();
  };

  const handleRevert = () => {
    setAccepted(false);
    setRejected(false);
    onRevert?.();
  };

  if (reverted) {
    return (
      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3">
        <div className="flex items-center gap-2 text-xs text-yellow-600">
          <RotateCcw className="h-3 w-3" />
          <span>已回滚：{relPath}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-vscode-input-border overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 bg-vscode-sidebar-bg/50">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FileCode className="h-3.5 w-3.5 text-vscode-fg/60 shrink-0" />
          <span className="text-sm text-vscode-fg truncate">{relPath}</span>
          <span className="inline-flex items-center gap-1 text-xs shrink-0">
            <span className="text-green-600">+{totalAdded}</span>
            <span className="text-red-600">-{totalRemoved}</span>
          </span>
          {isStreaming && (
            <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {accepted ? (
            <span className="text-xs text-green-600 px-2">已接受</span>
          ) : rejected ? (
            <span className="text-xs text-red-600 px-2">已拒绝</span>
          ) : (
            <>
              {onAccept && (
                <button
                  onClick={handleAccept}
                  className="p-1 rounded hover:bg-green-500/10 text-vscode-fg/60 hover:text-green-600 cursor-pointer"
                  title="接受"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
              )}
              {onReject && (
                <button
                  onClick={handleReject}
                  className="p-1 rounded hover:bg-red-500/10 text-vscode-fg/60 hover:text-red-600 cursor-pointer"
                  title="拒绝"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </>
          )}
          {(accepted || rejected) && onRevert && (
            <button
              onClick={handleRevert}
              className="p-1 rounded hover:bg-yellow-500/10 text-vscode-fg/60 hover:text-yellow-600 cursor-pointer"
              title="回滚"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1 rounded hover:bg-vscode-sidebar-bg cursor-pointer"
          >
            <svg
              className={cn('w-3 h-3 text-vscode-fg/60 transition-transform', expanded && 'rotate-180')}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>
      {/* Diff 内容 */}
      {expanded && hunks.length > 0 && (
        <div className="border-t border-vscode-input-border">
          {hunks.map((hunk, i) => (
            <DiffHunkBlock key={i} hunk={hunk} />
          ))}
        </div>
      )}
    </div>
  );
}

function DiffHunkBlock({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="text-xs font-mono leading-5">
      {hunk.content.split('\n').map((line, i) => {
        const char = line[0];
        const text = line.slice(1);
        if (char === '+') {
          return (
            <div key={i} className="bg-green-500/10 text-green-700 dark:text-green-400 px-3">
              <span className="select-none text-green-500/50 mr-2">+</span>{text}
            </div>
          );
        }
        if (char === '-') {
          return (
            <div key={i} className="bg-red-500/10 text-red-700 dark:text-red-400 px-3">
              <span className="select-none text-red-500/50 mr-2">-</span>{text}
            </div>
          );
        }
        if (line.startsWith('@@')) {
          return (
            <div key={i} className="bg-vscode-sidebar-bg text-vscode-fg/40 px-3 py-0.5">
              {line}
            </div>
          );
        }
        return (
          <div key={i} className="px-3 text-vscode-fg/60">
            <span className="select-none mr-2">&nbsp;</span>{text}
          </div>
        );
      })}
    </div>
  );
}
