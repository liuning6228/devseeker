/**
 * StreamController — 流式文本实时渲染通道（方案 B）
 *
 * 职责：
 * 1. text_delta 直接 DOM 追加（跳过 React），每 chunk 立即写入，无 RAF 合并
 * 2. turn_start 时注册，分配 streamId
 * 3. task_end 时 finish()：保留已有 DOM 内容不变，仅移除 active 标记；
 *    返回最终文本交给 React 通过 TEXT_FINISH action 注入 reducer，
 *    由 finalizeStreaming 替换 text 后切换 MarkdownRenderer
 *
 * 修掉的 BUG：
 *   BUG 1: finish() 不再清空 DOM（sess.el.innerHTML = ''），保留已有内容
 *   BUG 2: 不再使用 RAF 合并 + 阈值，每 chunk 立即写入
 *   BUG 3: append 在 el 未挂载时自动回放（ref 挂上后 flush）
 *
 * 使用方式：
 *   // App.tsx onMessage 中
 *   streamController.register(streamId);               // turn_start 时
 *   streamController.append(streamId, chunk);          // text_delta 时
 *   const finalText = streamController.finish(sid);    // task_end 时
 *   dispatch({ type: 'TEXT_FINISH', text: finalText });
 *
 *   // MessageItem.tsx 渲染时
 *   <span ref={streamController.ref(streamId)} />
 */

export interface StreamSession {
  /** DOM 锚点元素 */
  el: HTMLElement | null;
  /** 已累积的完整文本 buffer */
  buffer: string;
  /** 已写入 DOM 的长度 */
  flushedLen: number;
  /** el 未挂载时暂存的 chunk */
  pendingChunks: string[];
}

export type OnContentChange = () => void;

export class StreamController {
  private sessions = new Map<string, StreamSession>();
  /** 内容变更回调（由 MessageList 注册，每次 DOM 写入后触发滚动到容器底部） */
  private onContentChange: OnContentChange | null = null;

  /** MessageList 注册内容变更回调 */
  setOnContentChange(cb: OnContentChange | null): void {
    this.onContentChange = cb;
  }

  /**
   * turn_start 时注册流式会话。
   */
  register(streamId: string): void {
    if (this.sessions.has(streamId)) return;
    this.sessions.set(streamId, {
      el: null,
      buffer: '',
      flushedLen: 0,
      pendingChunks: [],
    });
  }

  /**
   * 绑定 DOM 锚点。返回 ref callback，由 MessageItem 渲染时传入。
   * el 挂上后立即 flush 积压的 pendingChunks。
   */
  ref(streamId: string): (el: HTMLElement | null) => void {
    return (el: HTMLElement | null) => {
      const sess = this.sessions.get(streamId);
      if (!sess) return;
      sess.el = el;
      if (el && sess.pendingChunks.length > 0) {
        for (const chunk of sess.pendingChunks) {
          this.writeNow(sess, chunk);
        }
        sess.pendingChunks = [];
      }
    };
  }

  /**
   * 追加流式文本 chunk —— 直接 DOM 写入，无 RAF 合并。
   */
  append(streamId: string, chunk: string): void {
    const sess = this.sessions.get(streamId);
    if (!sess) return;

    // 修正 for 循环中丢失 append 的问题
    // 确保每段文本都写入
    sess.buffer += chunk;

    if (sess.el) {
      this.writeNow(sess, chunk);
    } else {
      // el 未挂载，暂存
      sess.pendingChunks.push(chunk);
    }
  }

  /**
   * 流式结束。
   * 不清理 DOM（保留已有内容），仅移除 data-stream-active 标记。
   * @returns 完整累积文本
   */
  finish(streamId: string): string | undefined {
    const sess = this.sessions.get(streamId);
    if (!sess) return undefined;

    // 确保所有 pending 数据已写入
    if (sess.pendingChunks.length > 0 && sess.el) {
      for (const chunk of sess.pendingChunks) {
        this.writeNow(sess, chunk);
      }
      sess.pendingChunks = [];
    }

    const finalText = sess.buffer;

    // BUG 1 修复：不清理 innerHTML，仅移除 active 标记
    if (sess.el) {
      sess.el.removeAttribute('data-stream-active');
    }

    this.sessions.delete(streamId);
    return finalText;
  }

  /** 取消流：保留已显示内容，不清除 */
  cancel(streamId: string): string | undefined {
    const sess = this.sessions.get(streamId);
    if (!sess) return undefined;
    const finalText = sess.buffer;
    if (sess.el) {
      sess.el.removeAttribute('data-stream-active');
    }
    this.sessions.delete(streamId);
    return finalText;
  }

  /** 获取当前 buffer（调试用） */
  getBuffer(streamId: string): string | undefined {
    return this.sessions.get(streamId)?.buffer;
  }

  /** 清理所有会话（会话切换 / 清空历史时调用） */
  resetAll(): void {
    this.sessions.clear();
  }

  // ─────────── 内部 ───────────

  private writeNow(sess: StreamSession, chunk: string): void {
    if (!chunk || !sess.el) return;
    if (!sess.el.hasAttribute('data-stream-active')) {
      sess.el.setAttribute('data-stream-active', 'true');
    }
    sess.el.appendChild(document.createTextNode(chunk));
    sess.flushedLen = sess.buffer.length;
    // 通知 MessageList 内容尺寸变化，触发 scrollIntoView
    this.onContentChange?.();
  }

  /**
   * 手动触发一次虚拟列表重排（供外部在不需要追加内容但 DOM 尺寸变化时调用）。
   */
  notifyContentChange(): void {
    this.onContentChange?.();
  }

  get activeCount(): number {
    return this.sessions.size;
  }
}

/** 全局单例 */
export const streamController = new StreamController();
