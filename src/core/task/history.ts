/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 消息历史管理
 *
 * 策略（MVP 最简）：
 * - system 消息锚定在首位（缓存友好，DESIGN §M1.7）
 * - 其后追加 user / assistant / tool 消息，按时间顺序
 * - 工具调用配对：assistant.toolCalls[i] 必须紧跟同 toolCallId 的 tool 消息
 *
 * 后续迭代（M10）：滑动窗口 / 摘要 / 附件分流。
 */

import type { Message, ToolCall } from '../../providers/types.js';

export class MessageHistory {
  private readonly messages: Message[] = [];
  /** P0-7 · 最大保留轮次（user→assistant→tool 为一轮），超过则丢弃最旧轮次 */
  private static readonly MAX_TURNS = 20;

  constructor(systemPrompt?: string) {
    if (systemPrompt) {
      this.messages.push({ role: 'system', content: systemPrompt });
    }
  }

  /** P0-7 · 丢弃最旧轮次，保留 system + 最近 MAX_TURNS 轮 */
  private trimOldTurns(): void {
    const sysEnd = this.messages[0]?.role === 'system' ? 1 : 0;
    // 按 user 消息切分轮次
    const userIndices: number[] = [];
    for (let i = sysEnd; i < this.messages.length; i++) {
      if (this.messages[i].role === 'user') userIndices.push(i);
    }
    if (userIndices.length <= MessageHistory.MAX_TURNS) return;
    const keepFrom = userIndices[userIndices.length - MessageHistory.MAX_TURNS];
    this.messages.splice(sysEnd, keepFrom - sysEnd);
  }

  addSystem(content: string): void {
    // 仅当还没有 system 时允许插入到首位
    if (this.messages[0]?.role === 'system') {
      this.messages[0] = { role: 'system', content };
    } else {
      this.messages.unshift({ role: 'system', content });
    }
  }

  /**
   * 在现有 system prompt 末尾追加内容（不覆盖）。
   * 用于动态注入编辑上下文（§8.15.1）等运行时信息。
   * 若无 system 消息则创建一条。
   */
  addSystemSuffix(suffix: string): void {
    if (this.messages[0]?.role === 'system') {
      this.messages[0] = {
        ...this.messages[0],
        content: this.messages[0].content + '\n' + suffix,
      };
    } else {
      this.messages.unshift({ role: 'system', content: suffix });
    }
  }

  /**
   * 追加一条 user 消息。
   * @param text 用户文本（必填；仅图消息也需传空串或简短说明）
   * @param images 可选 image DataURL（`data:image/png;base64,...`）数组；
   *               非空时 content 会组装成 `ContentPart[]`（text + image_url...）
   *               → Provider 层/router 会据此路由到 vision 模型（W7c）
   */
  addUser(text: string, images?: readonly string[]): void {
    if (!images || images.length === 0) {
      this.messages.push({ role: 'user', content: text });
    } else {
      const parts: NonNullable<Message['content']> = [];
      if (text && text.length > 0) parts.push({ type: 'text', text });
      for (const url of images) {
        parts.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
      }
      this.messages.push({ role: 'user', content: parts });
    }
    this.trimOldTurns();
  }

  addAssistant(options: { content: string; toolCalls?: ToolCall[]; reasoningContent?: string }): void {
    this.messages.push({
      role: 'assistant',
      content: options.content,
      ...(options.toolCalls && options.toolCalls.length > 0 ? { toolCalls: options.toolCalls } : {}),
      ...(options.reasoningContent ? { reasoningContent: options.reasoningContent } : {}),
    });
    this.trimOldTurns();
  }

  addToolResult(toolCallId: string, content: string, name?: string): void {
    this.messages.push({
      role: 'tool',
      toolCallId,
      content,
      ...(name ? { name } : {}),
    });
  }

  /**
   * 在最后一条 tool role 消息的 content 末尾追加文本。
   * 用于编辑后 LSP Diagnostics 注入（§8.13）。
   * 若不存在 tool 消息则静默跳过。
   */
  appendToLastToolResult(appendix: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'tool') {
        (m as { content: string }).content += appendix;
        return;
      }
    }
  }

  /** 返回副本（防止外部修改） */
  snapshot(): Message[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /**
   * 批量恢复消息（session 加载用）。
   * - system 消息若出现在非首位，按原顺序保留（外部负责合法性）
   * - 不去重；调用方保证干净输入
   * - W15.6b: 自动清理不完整的 tool_calls 配对（SSE 断裂残留）
   */
  restore(messages: Message[]): void {
    // 保留原 system，清其余
    const hasExistingSystem = this.messages[0]?.role === 'system';
    const existingSystem = hasExistingSystem ? this.messages[0] : undefined;
    this.messages.length = 0;
    // 若恢复的消息自带 system 就用新的；否则沿用原 system
    const firstIsSystem = messages[0]?.role === 'system';
    if (!firstIsSystem && existingSystem) {
      this.messages.push(existingSystem);
    }

    // W15.6b: 收集已有 tool 回复的 toolCallId
    const answeredToolIds = new Set<string>();
    for (const m of messages) {
      if (m.role === 'tool' && m.toolCallId) {
        answeredToolIds.add(m.toolCallId);
      }
    }

    for (const m of messages) {
      // W15.6b: assistant 有 toolCalls 但部分缺少 tool 回复 → 去掉 toolCalls
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        const unanswered = m.toolCalls.filter((tc) => !answeredToolIds.has(tc.id));
        if (unanswered.length > 0) {
          // 有未回复的 tool_call → 移除 toolCalls，只保留文本
          const { toolCalls, ...rest } = m;
          this.messages.push(rest);
          continue;
        }
      }
      this.messages.push({ ...m });
    }
  }

  size(): number {
    return this.messages.length;
  }

  clear(preserveSystem = true): void {
    if (preserveSystem && this.messages[0]?.role === 'system') {
      const sys = this.messages[0];
      this.messages.length = 0;
      this.messages.push(sys);
    } else {
      this.messages.length = 0;
    }
  }

  /**
   * 清理末尾不完整的 assistant + tool_calls 配对。
   * 场景：SSE 断裂后 BAD_REQUEST 重试前，末尾 assistant 有 toolCalls 但缺少对应 tool 回复。
   * 必须在注入续写 user 消息前调用，否则 API 会因配对不完整返回 400。
   */
  cleanupTrailingIncompleteToolCalls(): void {
    // 收集所有 tool 回复的 toolCallId
    const answeredToolIds = new Set<string>();
    for (const m of this.messages) {
      if (m.role === 'tool' && m.toolCallId) {
        answeredToolIds.add(m.toolCallId);
      }
    }
    // 从末尾向前清理不完整的 assistant.toolCalls
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        const unanswered = m.toolCalls.filter((tc) => !answeredToolIds.has(tc.id));
        if (unanswered.length > 0) {
          // 移除 toolCalls，只保留文本内容
          const { toolCalls, ...rest } = m;
          this.messages[i] = rest;
        }
        // 只处理最末尾的 assistant，处理完即停止
        break;
      }
      // 遇到 tool 消息继续向前找对应的 assistant
      if (m.role === 'tool') continue;
      // 遇到 user 消息停止（说明前面的配对是完整的）
      break;
    }
  }

  /**
   * P0-6: 移除历史末尾的 assistant 消息。
   * 用于 SSE 断裂重试场景——清除本轮不完整的 assistant 消息，
   * 让 LLM 重新生成（而非注入伪消息"请继续"污染历史）。
   * 如果末尾是 tool 消息，也一并移除（因为 tool 回复对应的 assistant 已被移除）。
   */
  removeTrailingAssistant(): void {
    // 从末尾向前，移除连续的 tool 消息 + assistant 消息
    while (this.messages.length > 0) {
      const last = this.messages[this.messages.length - 1];
      if (last.role === 'tool') {
        this.messages.pop();
        continue;
      }
      if (last.role === 'assistant') {
        this.messages.pop();
        // 移除 assistant 后停止（不移除更前面的 user/system）
        break;
      }
      // 遇到 user/system 停止
      break;
    }
  }
}
