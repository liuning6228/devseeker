/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ImageSanitizer —— VLLM 轮完成后，将历史消息中的 image_url 替换为文本摘要（W22）
 */

import type { Message } from '../../providers/types.js';

const IMAGE_PLACEHOLDER_TAG = '[VLM 识别摘要]';

export function extractVlmSummary(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    if (msg.toolCalls && msg.toolCalls.length > 0) continue;

    const content = typeof msg.content === 'string' ? msg.content : '';
    const trimmed = content.trim();
    if (trimmed.length > 50) {
      const paragraphs = trimmed.split('\n').map((s) => s.trim()).filter(Boolean);
      if (paragraphs.length > 0) return paragraphs[paragraphs.length - 1];
      return trimmed;
    }
  }
  return undefined;
}

export function sanitizeHistoryImages(messages: Message[], summary: string): number {
  if (!summary || summary.trim().length === 0) return -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (!Array.isArray(msg.content)) continue;

    const hasImage = msg.content.some((part: any) => part.type === 'image_url');
    if (!hasImage) continue;

    const newParts: Array<{ type: 'text'; text: string }> = [];
    for (const part of msg.content) {
      if ((part as any).type === 'image_url') {
        newParts.push({ type: 'text', text: `${IMAGE_PLACEHOLDER_TAG}\n${summary}` });
      } else if ((part as any).type === 'text') {
        newParts.push(part as { type: 'text'; text: string });
      }
    }

    const merged: Array<{ type: 'text'; text: string }> = [];
    for (const part of newParts) {
      if (merged.length > 0 && merged[merged.length - 1]!.type === 'text') {
        merged[merged.length - 1]!.text += '\n' + part.text;
      } else {
        merged.push(part);
      }
    }

    // eslint-disable-next-line no-param-reassign
    (msg as unknown as Record<string, unknown>).content = merged;
    return i;
  }
  return -1;
}

export function shouldSanitizeAfterTurn(providerId: string, messages: Message[]): boolean {
  if (!providerId.includes(':vllm:')) return false;

  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'assistant') return false;

  const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';
  if (content.trim().length < 50) return false;

  return hasRemainingImageUrl(messages);
}

export function hasRemainingImageUrl(messages: Message[]): boolean {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (!Array.isArray(msg.content)) continue;
    if (msg.content.some((part: any) => part.type === 'image_url')) return true;
  }
  return false;
}
