import { Fragment, memo, useMemo, useRef, useState } from 'react';
import type { MessagePart, ToolCallPart, UiMessage } from '../state/reducer';
import type { ApprovalRequestPayload } from '../protocol';
import { ToolCard } from './ToolCard';
import { SubagentGroupBar } from './chat/SubagentGroupBar';
import { MarkdownRenderer } from './MarkdownRenderer';
import { streamController } from '../stream/StreamController';
import { motion } from '../lib/motion.js';
import { messageVariants } from '../lib/motion.js';

export interface OpenFileRequest {
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface MessageItemProps {
  message: UiMessage;
  onRevert?: (checkpointId: string) => void;
  onOpenFile?: (req: OpenFileRequest) => void;
  /** W-UI5 · bash 卡「在终端打开」 */
  onOpenTerminal?: (command: string) => void;
  /** W15.6 · hunk 级 Revert 回调 */
  onRevertHunk?: (relPath: string, hunkUnified: string, nonce: string) => void;
  /** W15.6 · 已被 revert 的 hunk nonce 集合 */
  revertedHunks?: Set<string>;
  /** 内联审批：全部待审批请求（toolCallId → payload） */
  pendingApprovals?: Record<string, ApprovalRequestPayload>;
  /** 内联审批响应回调 */
  onApprovalResponse?: (toolCallId: string, decision: 'allow_once' | 'remember' | 'deny' | 'redirect_terminal') => void;
  /** 当前流式消息的 streamId（StreamController DOM 锚点绑定用） */
  currentStreamMsgId?: string;
  /** Step 2: 流式消息无内容时显示骨架屏 */
  skeleton?: boolean;
}

const ROLE_LABEL: Record<UiMessage['role'], string> = {
  user: 'You',
  assistant: 'DevSeeker',
  tool: 'Tool',
  system: 'System',
};

function MessageItemImpl({ message, onRevert, onOpenFile, onOpenTerminal, onRevertHunk, revertedHunks, pendingApprovals, onApprovalResponse, currentStreamMsgId, skeleton }: MessageItemProps): JSX.Element {
  const hasAnyVisible = useMemo(() => message.parts.some(isVisible), [message.parts]);

  // 并行子代理分组视图：同一条消息内 ≥2 个子代理卡片时聚合展示（仅本地 UI 状态）
  const subagentPartIndices = useMemo(() => {
    const idx: number[] = [];
    message.parts.forEach((p, i) => {
      if (p.kind === 'tool' && p.subagent !== undefined) idx.push(i);
    });
    return idx;
  }, [message.parts]);
  const [groupCollapsed, setGroupCollapsed] = useState(false);

  if (!hasAnyVisible && !message.reasoning) return <></>;

  const isGrouped = subagentPartIndices.length >= 2;
  const firstSubagentIdx = subagentPartIndices[0] ?? -1;
  const groupStates = subagentPartIndices.map((pi) => (message.parts[pi] as ToolCallPart).subagent!).filter(Boolean);

  return (
    <motion.div
      className={`message message--${message.role}`}
      variants={messageVariants}
      initial="initial"
      animate="animate"
    >
      <div className="message__role">{ROLE_LABEL[message.role]}</div>
      {message.reasoning && (
        <details className="message__reasoning" open={false}>
          <summary className="message__reasoning-summary">
            <span className="message__reasoning-label">💭 深度思考</span>
            <span className="message__reasoning-meta">
              {message.reasoning.length.toLocaleString()} 字
            </span>
            <span className="message__reasoning-chevron">▾</span>
          </summary>
          <pre className="message__reasoning-body">{message.reasoning}</pre>
        </details>
      )}
      <div className="message__body">
        {/* 先渲染 tool part，再渲染 text part：tool card 在上、文字在下 */}
        {/* 这样 tool card 的固定高度先抢占位置，文字流式追加时不会造成视觉跳跃 */}
        {message.parts.map((part, i) => {
          if (part.kind !== 'tool') return null;
          // 分组折叠时隐藏子代理卡片（分组条保留）
          const hidePart = isGrouped && groupCollapsed && part.subagent !== undefined;
          return (
            <Fragment key={i}>
              {isGrouped && i === firstSubagentIdx && (
                <SubagentGroupBar
                  states={groupStates}
                  collapsed={groupCollapsed}
                  onToggle={() => setGroupCollapsed((v) => !v)}
                />
              )}
              {!hidePart && (
                <PartRenderer part={part} onRevert={onRevert} onOpenFile={onOpenFile} onOpenTerminal={onOpenTerminal} onRevertHunk={onRevertHunk} revertedHunks={revertedHunks} approvalPayload={pendingApprovals?.[part.toolCallId]} onApprovalResponse={onApprovalResponse} streamId={message.streamId ?? currentStreamMsgId ?? message.id} />
              )}
            </Fragment>
          );
        })}
        {/* text part 统一放在 tool part 下方 */}
        {message.parts.map((part, i) => {
          if (part.kind === 'tool') return null;
          return (
            <PartRenderer key={i} part={part} onRevert={onRevert} onOpenFile={onOpenFile} onOpenTerminal={onOpenTerminal} onRevertHunk={onRevertHunk} revertedHunks={revertedHunks} onApprovalResponse={onApprovalResponse} streamId={message.streamId ?? currentStreamMsgId ?? message.id} />
          );
        })}
      </div>
    </motion.div>
  );
}

function PartRenderer({
  part,
  onRevert,
  onOpenFile,
  onOpenTerminal,
  onRevertHunk,
  revertedHunks,
  approvalPayload,
  onApprovalResponse,
  streamId,
}: {
  part: MessagePart;
  onRevert?: (checkpointId: string) => void;
  onOpenFile?: (req: OpenFileRequest) => void;
  onOpenTerminal?: (command: string) => void;
  onRevertHunk?: (relPath: string, hunkUnified: string, nonce: string) => void;
  revertedHunks?: Set<string>;
  /** 该工具卡对应的待审批请求（undefined = 未等待审批） */
  approvalPayload?: ApprovalRequestPayload;
  onApprovalResponse?: (toolCallId: string, decision: 'allow_once' | 'remember' | 'deny' | 'redirect_terminal') => void;
  streamId?: string;
}): JSX.Element {
  if (part.kind === 'text') {
    const isStreaming = part.isStreaming;
    if (isStreaming) {
      // 方案 B：流式期间渲染 StreamController DOM 锚点，内容由 controller 直接写入
      return <StreamingAnchor streamId={streamId} />;
    }
    // 流结束后：渲染 MarkdownRenderer
    if (!part.text) return <></>;
    return (
      <MarkdownRenderer text={part.text} {...(onOpenFile ? { onOpenFile } : {})} />
    );
  }
  return (
    <ToolCard
      name={part.name}
      status={part.status}
      argsPreview={part.argsPreview}
      contentPreview={part.contentPreview}
      subagent={part.subagent}
      errorCode={part.errorCode}
      diff={part.diff}
      revertState={part.revertState}
      onRevert={onRevert}
      onRevertHunk={onRevertHunk}
      revertedHunks={revertedHunks}
      onOpenTerminal={onOpenTerminal}
      awaitingApproval={approvalPayload !== undefined}
      approvalPayload={approvalPayload}
      onApprovalResponse={
        approvalPayload !== undefined && onApprovalResponse
          ? (decision) => onApprovalResponse(part.toolCallId, decision)
          : undefined
      }
    />
  );
}

function isVisible(p: MessagePart): boolean {
  if (p.kind === 'text') return p.text.trim().length > 0;
  return true;
}

/**
 * StreamingAnchor — StreamController DOM 锚点
 *
 * 流式期间渲染一个空 <span>，streamController.ref(streamId) 注册 DOM 引用，
 * text_delta 由 controller 通过 appendChild 直接写入。
 * 流结束后此组件不再被渲染（由 MarkdownRenderer 替换），无需清理。
 */
function StreamingAnchor({ streamId }: { streamId?: string }): JSX.Element {
  const setRef = useMemo(() => {
    if (!streamId) return undefined;
    return streamController.ref(streamId);
  }, [streamId]);

  return (
    <span
      ref={(el) => {
        if (el && setRef) setRef(el);
      }}
      className="message__text message__text--streaming"
      data-stream-id={streamId}
      style={{ whiteSpace: 'pre-wrap', minHeight: '1.2em' }}
    />
  );
}

export const MessageItem = memo(MessageItemImpl);
