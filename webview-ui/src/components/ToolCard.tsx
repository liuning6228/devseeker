import { useEffect, useRef, useState } from 'react';
import type { ToolDiffPayload } from '../protocol';
import { CopyButton } from './common/CopyButton.js';
import { ErrorRow } from './chat/ErrorRow.js';
import { DiffEditRow } from './chat/DiffEditRow.js';
import { CommandOutputRow } from './chat/CommandOutputRow.js';
import { TaskFeedbackButtons } from './chat/TaskFeedbackButtons.js';
import { Separator } from './ui/separator.js';

/** 文件读写类工具：只显示文件名+状态，不显示内容 */
const FILE_TOOLS = new Set(['read_file', 'write_file', 'append_file', 'search_replace', 'delete_file', 'create_file']);

/** 网络搜索类工具：只显示URL/查询词+状态+成功/失败 */
const WEB_TOOLS = new Set(['search_web', 'fetch_content', 'read_url']);

/** 从 argsPreview 中提取 file_path */
function extractFilePath(name: string, argsPreview?: string): string {
  if (!argsPreview) return '';
  try {
    const obj = JSON.parse(argsPreview);
    if (typeof obj?.file_path === 'string') return obj.file_path;
    if (typeof obj?.path === 'string') return obj.path;
  } catch { /* streaming JSON may be incomplete */ }
  const m = argsPreview.match(/"file_path"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  return '';
}

/** 从 argsPreview 中提取 URL 或搜索查询词 */
function extractWebInfo(name: string, argsPreview?: string): { url?: string; query?: string } {
  if (!argsPreview) return {};
  try {
    const obj = JSON.parse(argsPreview);
    if (name === 'search_web') {
      return { query: typeof obj?.query === 'string' ? obj.query : undefined };
    }
    return { url: typeof obj?.url === 'string' ? obj.url : undefined };
  } catch { /* streaming JSON may be incomplete */ }
  const urlM = argsPreview.match(/"url"\s*:\s*"([^"]+)"/);
  if (urlM) return { url: urlM[1] };
  const queryM = argsPreview.match(/"query"\s*:\s*"([^"]+)"/);
  if (queryM) return { query: queryM[1] };
  return {};
}

/** 从 argsPreview 中提取 command（bash 工具） */
function extractCommand(argsPreview?: string): string {
  if (!argsPreview) return '';
  try {
    const obj = JSON.parse(argsPreview);
    if (typeof obj?.command === 'string') return obj.command;
  } catch { /* argsPreview 可能是流式不完整 JSON */ }
  return '';
}

/** 从 unified diff 文本中解析 hunk 数组 */
function parseHunksFromDiff(unified: string): Array<{ content: string; added: number; removed: number }> {
  const hunks: Array<{ content: string; added: number; removed: number }> = [];
  const lines = unified.split('\n');
  let currentHunk: string[] = [];
  let added = 0;
  let removed = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (currentHunk.length > 0) {
        hunks.push({ content: currentHunk.join('\n'), added, removed });
      }
      currentHunk = [line];
      added = 0;
      removed = 0;
    } else if (currentHunk.length > 0) {
      currentHunk.push(line);
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  if (currentHunk.length > 0) {
    hunks.push({ content: currentHunk.join('\n'), added, removed });
  }
  return hunks;
}

export interface ToolCardProps {
  name: string;
  status: 'pending' | 'running' | 'success' | 'error';
  argsPreview?: string;
  contentPreview?: string;
  errorCode?: string;
  diff?: ToolDiffPayload;
  revertState?: { ok: boolean; message?: string };
  onRevert?: (checkpointId: string) => void;
  onRevertHunk?: (relPath: string, hunkUnified: string, nonce: string) => void;
  revertedHunks?: Set<string>;
  onOpenTerminal?: (command: string) => void;
  /** 内联审批：是否等待用户审批 */
  awaitingApproval?: boolean;
  /** 内联审批：风险级别（safe=默认终端运行，risky=默认沙箱运行） */
  riskLevel?: 'safe' | 'risky';
  /** 内联审批：用户点击同意/拒绝/记住 */
  onApprovalResponse?: (decision: 'allow_once' | 'remember' | 'deny' | 'redirect_terminal') => void;
}
/**
 * 正在处理指示器：旋转正方体 + 汉字（CSS 纯实现）
 */
function ProcessingIndicator(): JSX.Element {
  return (
    <span className="tool-card__processing">
      <span className="tool-card__cube" />
      <span className="tool-card__processing-text">正在处理...</span>
    </span>
  );
}

/** 精简版 ProcessingIndicator：只显示旋转方块，不显示汉字，用于 header 右侧空间不足的场景 */
function ProcessingIndicatorMini(): JSX.Element {
  return (
    <span className="tool-card__processing">
      <span className="tool-card__cube" />
    </span>
  );
}

/**
 * W-UI3 · 获取工具图标 emoji
 */
function getToolIcon(name: string): string {
  const ICONS: Record<string, string> = {
    read_file: '📖', write_file: '✏️', append_file: '✏️', search_replace: '🔄',
    delete_file: '🗑️', create_file: '📄', list_dir: '📁', bash: '💻',
    get_terminal_output: '💻', search_codebase: '🔍', search_web: '🌐',
    fetch_content: '📥', read_url: '🔗', search_memory: '🧠', update_memory: '🧠',
    search_symbol: '🔍', lsp: '🔧', goto_definition: '↪️', find_references: '🔗',
    document_symbol: '📋', workspace_symbol: '🔎', goto_implementation: '⬇️',
    call_hierarchy: '🌳', get_problems: '🚨', todo_write: '📋', git_status: '🌿',
    git_diff: '📝', git_log: '📜', Agent: '🤖', skill: '⚡',
    create_skill: '✨', create_agent: '✨', create_plan: '📋', switch_mode: '🔄',
    run_preview: '👁️', ask_user_question: '❓', fetch_rules: '📜',
    search_knowledge: '📚', search_file: '🔍', grep_code: '🔎',
  };
  return ICONS[name] ?? '🔧';
}

/**
 * W-UI3 · 生成 collapsed summary 文本
 */
function buildSummary(name: string, status: ToolCardProps['status'], argsPreview?: string): string {
  if (status === 'pending' || status === 'running') {
    return '';  // 状态由 header 的 ProcessingIndicator 指示，不依赖文字
  }
  // 成功/失败 → 工具名 + 状态
  const icon = status === 'success' ? '✓' : '✗';
  return `${icon} · ${name}`;
}

export function ToolCard(props: ToolCardProps): JSX.Element {
  const {
    name, status, argsPreview, contentPreview, errorCode,
    diff, revertState, onRevert, onRevertHunk, revertedHunks,
    onOpenTerminal, awaitingApproval, riskLevel, onApprovalResponse,
  } = props;

  // W-UI3 · 默认 collapsed（success 折叠、error 展开、运行中折叠）
  // W-UI8 · bash 工具运行中自动展开，让用户看到终端输出
  const isShellTool = name === 'bash' || name === 'get_terminal_output';

  const [open, setOpen] = useState<boolean>(status === 'error');
  const [splitOpen, setSplitOpen] = useState<boolean>(false);
  const prevStatusRef = useRef(status);
  const prevApprovalRef = useRef(awaitingApproval);
  // 用于强制 CommandOutputRow 在 output 变化时重渲染的递增 key
  // React 默认的 batch 更新可能导致等值的 contentPreview 引用不被触发 re-render
  const outputVersionRef = useRef(0);
  const prevPreviewLenRef = useRef(0);
  if (isShellTool && contentPreview && contentPreview.length !== prevPreviewLenRef.current) {
    prevPreviewLenRef.current = contentPreview.length;
    outputVersionRef.current++;
  }
  useEffect(() => {
    const prev = prevStatusRef.current;
    const prevApproval = prevApprovalRef.current;
    if ((prev === 'running' || prev === 'pending') && status === 'success') {
      setOpen(false);
    }
    if (status === 'error' && prev !== 'error') {
      setOpen(true);
    }
    // W-UI8 · bash 工具 running/awaiting 时展开（显示 TerminalOutputRow）
    const statusTransitioned = prev !== status;
    const approvalAppeared = !prevApproval && awaitingApproval;
    if (isShellTool && (status === 'running' || awaitingApproval) && (statusTransitioned || approvalAppeared)) {
      setOpen(true);
    }
    prevStatusRef.current = status;
    prevApprovalRef.current = awaitingApproval;
  }, [status, awaitingApproval, isShellTool]);

  const checkpointId = diff?.checkpointId;
  const reverted = revertState?.ok === true;
  const canRevert = Boolean(checkpointId) && !reverted && onRevert;
  void onRevertHunk; void revertedHunks; void canRevert; void extractFilePath; void outputVersionRef;
  const isFileTool = FILE_TOOLS.has(name);
  const isWebTool = WEB_TOOLS.has(name);
  const filePath = isFileTool ? extractFilePath(name, argsPreview) : '';
  const webInfo = isWebTool ? extractWebInfo(name, argsPreview) : {};
  const isCompactTool = isFileTool || isWebTool;
  const bashCommand = extractCommand(argsPreview);
  const canOpenTerminal = Boolean(bashCommand) && !!onOpenTerminal;

  const showApprovalActions = awaitingApproval && isShellTool && onApprovalResponse;

  // W-UI3 · 左侧状态彩条颜色
  const statusColor = status === 'success' ? 'var(--vscode-terminal-ansiGreen, #4ec9b0)'
    : status === 'error' ? 'var(--vscode-terminal-ansiRed, #f44747)'
    : status === 'running' ? 'var(--vscode-terminal-ansiYellow, #cca700)'
    : 'var(--vscode-panel-border, rgba(128,128,128,0.3))';

  // W-UI3 · 摘要文本（pending 阶段不展示，避免内容跳动）
  const summary = status === 'pending' ? ''
    : isFileTool && filePath ? `${filePath}`
    : isWebTool && webInfo.query ? `🔍 ${webInfo.query}`
    : isWebTool && webInfo.url ? `🌐 ${webInfo.url}`
    : bashCommand ? `$ ${bashCommand}`
    : argsPreview ? argsPreview.slice(0, 60)
    : '';

  // ─── 审批面板模式（  风格）────────────────────
  // 改进：在审批面板中也复用 CommandOutputRow 展示命令+当前累积的 output，
  // 使用户在审批前就能看到命令以及（如果有的话）初始占位输出。
  if (showApprovalActions) {
    const isSafeCommand = riskLevel === 'safe';
    return (
      <div className="tool-card tool-card--awaiting-approval">
        <div className="tool-card__approval-panel">
          {/* 顶栏：safe 命令不显示风险警告，risky 命令显示 */}
          {!isSafeCommand && (
            <div className="tool-card__approval-topbar">
              <svg className="tool-card__approval-warning-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span className="tool-card__approval-warning-text">检测到潜在风险</span>
            </div>
          )}
          {/* 命令展示区（类输入框） */}
          <div className="tool-card__approval-command-box">
            <pre className="tool-card__approval-command-text">
              <code>{bashCommand}</code>
            </pre>
          </div>
          {/* 审批期间只展示命令，不重复展示 CommandOutputRow（命令已在 command-box 中） */}
          {contentPreview && (
            <pre className="tool-card__approval-output-preview">
              <code>{contentPreview}</code>
            </pre>
          )}
          {/* 底部操作栏 */}
          <div className="tool-card__approval-actions">
            <span
              className="tool-card__approval-btn-cancel"
              role="button"
              title="拒绝执行（取消）"
              onClick={(e) => {
                e.stopPropagation();
                onApprovalResponse!('deny');
              }}
            >
              取消
            </span>
            <span className="tool-card__approval-btn-split">
              {/* riskLevel=safe：默认主按钮是「终端运行」；risky 或 undefined：默认主按钮是「沙箱运行」 */}
              {riskLevel === 'safe' ? (
                <>
                  <span
                    className="tool-card__approval-btn-run"
                    role="button"
                    title="在 VS Code 终端中执行该命令（默认）"
                    onClick={(e) => {
                      e.stopPropagation();
                      // 注意：只发送 approval_response('redirect_terminal')，
                      // 不再额外调用 onOpenTerminal()。
                      // redirect_terminal 由 extension 侧处理（sendToUserTerminal + 返回提示文本）。
                      // 避免命令在用户终端重复执行（此前 ToolsCard 和 BashTool._runInUserTerminal 各一次）。
                      onApprovalResponse!('redirect_terminal');
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <path d="M8 9l3 3-3 3" />
                      <path d="M13 15h3" />
                    </svg>
                    终端运行
                  </span>
                  <span
                    className="tool-card__approval-run-arrow"
                    role="button"
                    title="更多运行方式"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSplitOpen((prev) => !prev);
                    }}
                  >
                    ▾
                  </span>
                </>
              ) : (
                <>
                  <span
                    className="tool-card__approval-btn-run"
                    role="button"
                    title="允许执行（仅本次）"
                    onClick={(e) => {
                      e.stopPropagation();
                      onApprovalResponse!('allow_once');
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5,3 19,12 5,21" />
                    </svg>
                    沙箱运行
                    <span className="tool-card__approval-shortcut">Ctrl+↓</span>
                  </span>
                  <span
                    className="tool-card__approval-run-arrow"
                    role="button"
                    title="更多运行方式"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSplitOpen((prev) => !prev);
                    }}
                  >
                    ▾
                  </span>
                </>
              )}
            </span>
          </div>
          {splitOpen && (
            <div className="tool-card__approval-dropdown">
              {riskLevel === 'safe' ? (
                <span
                  className="tool-card__approval-dropdown-item"
                  role="button"
                  title="在沙箱中执行该命令"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSplitOpen(false);
                    onApprovalResponse!('allow_once');
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5,3 19,12 5,21" />
                  </svg>
                  沙箱运行
                </span>
              ) : (
                <span
                  className="tool-card__approval-dropdown-item"
                  role="button"
                  title="在 VS Code 终端中执行该命令（跳过沙箱）"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSplitOpen(false);
                    // 只发送 redirect_terminal，由 extension 侧处理用户终端执行
                    onApprovalResponse!('redirect_terminal');
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M8 9l3 3-3 3" />
                    <path d="M13 15h3" />
                  </svg>
                  终端运行
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`tool-card tool-card--${status}${isShellTool ? ' tool-card--shell' : ''}${isCompactTool ? ' tool-card--compact' : ''}`}
      style={{ borderLeft: `3px solid ${statusColor}` }}
    >
      <div className="tool-card__header-row">
        <button
          type="button"
          className="tool-card__header"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className="tool-card__header-icon" aria-hidden="true">
            {getToolIcon(name)}
          </span>
          <span className="tool-card__tool-info">
            <span className="tool-card__name">{name}</span>
            {summary && <span className="tool-card__summary">{summary}</span>}
          </span>
          <span className="tool-card__status-badge">
            {status === 'success' && '✓'}
            {status === 'error' && '✗'}
            {status === 'pending' && <ProcessingIndicator />}
            {status === 'running' && <span className="tool-card__dot-pulse" />}
          </span>
          {diff && (
            <span className="tool-card__diff-badge" title={`${diff.added}+ / ${diff.removed}-`}>
              +{diff.added}/-{diff.removed}
            </span>
          )}
          <span className="tool-card__chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        </button>

        {/* header 右侧操作区：终端按钮 */}
        <span className="tool-card__header-actions">
          {canOpenTerminal && (
            <span
              className="tool-card__open-terminal"
              role="button"
              title="在 VS Code 原生终端中执行该命令（可编辑后再运行）"
              onClick={(e) => {
                e.stopPropagation();
                onOpenTerminal?.(bashCommand);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M8 9l3 3-3 3" />
                <path d="M13 15h3" />
              </svg>
            </span>
          )}
        </span>
      </div>

      {open && (
        <div className="tool-card__body">
          {/* 文件工具 → DiffEditRow */}
          {isFileTool && diff && (
            <DiffEditRow
              relPath={filePath}
              hunks={parseHunksFromDiff(diff.unified)}
              totalAdded={diff.added}
              totalRemoved={diff.removed}
              reverted={reverted}
            />
          )}

          {/* 错误工具 → ErrorRow */}
          {status === 'error' && contentPreview && (
            <ErrorRow
              code={errorCode}
              message={contentPreview}
              onRetry={canRevert ? () => onRevert?.(checkpointId!) : undefined}
              ctaLabel={canRevert ? '回滚' : undefined}
              ctaAction={canRevert ? () => onRevert?.(checkpointId!) : undefined}
            />
          )}

          {/* Shell 工具 → CommandOutputRow */}
          {isShellTool && bashCommand && (
            <CommandOutputRow
              key={`${name}-${outputVersionRef.current}`}
              command={bashCommand}
              output={contentPreview || ''}
              isStreaming={status === 'running'}
              onOpenTerminal={canOpenTerminal ? () => onOpenTerminal?.(bashCommand) : undefined}
            />
          )}

          {/* 通用 args 展示 */}
          {argsPreview && !isShellTool && !isFileTool && !isWebTool && (
            <div className="tool-card__section">
              <div className="flex items-center justify-between">
                <div className="tool-card__label">args</div>
                <CopyButton text={argsPreview} />
              </div>
              <pre className="tool-card__pre">{argsPreview}</pre>
            </div>
          )}

          {/* 通用 result 展示 */}
          {contentPreview && status !== 'error' && !isShellTool && !isFileTool && !isWebTool && (
            <div className="tool-card__section">
              <div className="flex items-center justify-between">
                <div className="tool-card__label">result</div>
                <CopyButton text={contentPreview} />
              </div>
              <pre className="tool-card__pre">{contentPreview}</pre>
            </div>
          )}

          {/* 反馈按钮 */}
          {status !== 'running' && status !== 'pending' && (
            <div className="px-3 py-1">
              <Separator className="mb-2" />
              <TaskFeedbackButtons />
            </div>
          )}
        </div>
      )}
    </div>
  );
}