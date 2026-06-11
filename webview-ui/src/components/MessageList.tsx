import { useEffect, useRef, useCallback, useState } from 'react';
import type { UiMessage, TextPart } from '../state/reducer';
import { MessageItem, type OpenFileRequest } from './MessageItem';
import { streamController } from '../stream/StreamController';

export interface MessageListProps {
  messages: UiMessage[];
  onRevert?: (checkpointId: string) => void;
  onOpenFile?: (req: OpenFileRequest) => void;
  /** W-UI5 · bash 卡「在终端打开」 */
  onOpenTerminal?: (command: string) => void;
  /** W15.6 · hunk 级 Revert 回调 */
  onRevertHunk?: (relPath: string, hunkUnified: string, nonce: string) => void;
  /** W15.6 · 已被 revert 的 hunk nonce 集合 */
  revertedHunks?: Set<string>;
  /** 内联审批：等待审批的 toolCallId 集合 */
  pendingApprovalToolIds?: Set<string>;
  /** 内联审批响应回调 */
  onApprovalResponse?: (toolCallId: string, decision: 'allow_once' | 'remember' | 'deny' | 'redirect_terminal') => void;
  /** 当前流式消息的 streamId（用于 StreamController DOM 锚点绑定） */
  currentStreamMsgId?: string;
  /** 当前审批请求的风险级别 */
  riskLevel?: 'safe' | 'risky';
}

/**
 * MessageList — 消息列表（普通滚动容器）
 *
 * 使用 overflow-y:auto + ResizeObserver 监听内容高度变化，自动滚动到底部。
 * 避免 scrollIntoView 的"锚点跳动"问题和 RAF 合并的竞态条件。
 *
 * 滚动策略：
 * - ResizeObserver 监听列表容器及子元素高度变化 → scrollTop = scrollHeight
 * - React re-render（messages 变化）时也主动尝试滚动到底
 * - StreamController DOM 追加后回调 scrollToBottom
 * - 用户主动上滚 > 200px 时暂停自动跟随，新消息插入时打破该状态
 *
 * Step 2 增强：
 * - 阅读进度条（ReadingProgress）
 * - 流式消息无内容时显示骨架屏
 * - 修正数据模型引用 m.isStreaming → m.parts.some(...)
 */
export function MessageList({ messages, onRevert, onOpenFile, onOpenTerminal, onRevertHunk, revertedHunks, pendingApprovalToolIds, onApprovalResponse, currentStreamMsgId, riskLevel }: MessageListProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const messagesLenRef = useRef(messages.length);
  // Step 2: 阅读进度
  const [scrollProgress, setScrollProgress] = useState(0);

  // Step 2: 检测流式状态（修正数据模型引用）
  const isMsgStreaming = useCallback((m: UiMessage): boolean => {
    return m.parts.some((p): p is TextPart => p.kind === 'text' && !!p.isStreaming);
  }, []);

  // ── 检测用户是否主动上滚 ──
  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distFromBottom > 200;
    // Step 2: 阅读进度
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll > 0) {
      setScrollProgress(Math.round((el.scrollTop / maxScroll) * 100));
    }
  }, []);

  // ── 滚动到最底部（仅在用户未上滚时） ──
  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el || userScrolledUpRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // ── ResizeObserver 监听内容高度变化 → 自动向下滚动（替代脆弱的 scrollIntoView） ──
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const checkAndScroll = () => {
      // 用户上滚时不抢
      if (userScrolledUpRef.current) return;
      el.scrollTop = el.scrollHeight;
    };
    const ro = new ResizeObserver(checkAndScroll);
    // 观察列表的 scroll 容器本身以及其第一个子元素（内容包装器）
    ro.observe(el);
    // 也观察 message-list 的直接子元素（消息条目），因为 ResizeObserver 默认只监听到目标元素自身尺寸变化
    for (let i = 0; i < el.children.length; i++) {
      ro.observe(el.children[i]);
    }
    return () => ro.disconnect();
  }, []);

  // ── 新消息插入时：打破用户上滚状态 + 滚动到底 ──
  useEffect(() => {
    if (messages.length > messagesLenRef.current) {
      messagesLenRef.current = messages.length;
      userScrolledUpRef.current = false;
    } else {
      messagesLenRef.current = messages.length;
    }
    // 无论是否新消息，每次 messages 变化都尝试滚动到底部（兼容 tool 状态更新导致高度变化）
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // ── 挂载时注册 StreamController 内容变更回调 ──
  useEffect(() => {
    streamController.setOnContentChange(scrollToBottom);
    return () => {
      streamController.setOnContentChange(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (messages.length === 0) {
    return (
      <div className="message-list message-empty" role="log" aria-live="polite">
        输入消息与 DevSeeker 开始对话。支持：
        <br />
        · <code>@</code> 引用文件/符号添加上下文
        <br />
        · <code>/</code> 命令：<code>/fix</code> 修复 · <code>/refactor</code> 重构 · <code>/review</code> 评审 · <code>/commit</code> 提交
        <br />
        · 自然语言直接描述需求
      </div>
    );
  }

  return (
    <div
      className="message-list"
      role="log"
      aria-live="polite"
      ref={listRef}
      onScroll={handleScroll}
    >
      {/* Step 2: 阅读进度条 */}
      <div className="reading-progress" role="progressbar" aria-valuenow={scrollProgress} aria-label="消息阅读进度">
        <div className="reading-progress__bar" style={{ width: `${scrollProgress}%` }} />
      </div>
      {messages.map((m, idx) => {
        // Step 5: CSS content-visibility（带 feature-detection，避开 VSCode Webview 旧内核）
        const supportsCv = typeof CSS !== 'undefined' && CSS.supports?.('content-visibility', 'auto');
        const useCv = supportsCv && messages.length > 200 && Math.abs(idx - messages.length) > 30;
        return (
          <div key={m.id} style={useCv ? { contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' } as React.CSSProperties : undefined}>
            <MessageItem
              message={m}
              onRevert={onRevert}
              onOpenFile={onOpenFile}
              onOpenTerminal={onOpenTerminal}
              onRevertHunk={onRevertHunk}
              revertedHunks={revertedHunks}
              pendingApprovalToolIds={pendingApprovalToolIds}
              onApprovalResponse={onApprovalResponse}
              currentStreamMsgId={currentStreamMsgId}
              riskLevel={riskLevel}
              // Step 2: 流式消息无内容时显示骨架屏
              skeleton={isMsgStreaming(m) && m.parts.every((p) => p.kind !== 'text' || !p.text)}
            />
          </div>
        );
      })}
      {/* 底部锚点 —— 通过 scrollTop = scrollHeight 滚动，ResizeObserver 自动触发 */}
    </div>
  );
}
