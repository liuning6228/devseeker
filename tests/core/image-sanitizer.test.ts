/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ImageSanitizer 单元测试 —— W22
 */
import { describe, it, expect } from 'vitest';
import {
  extractVlmSummary,
  sanitizeHistoryImages,
  shouldSanitizeAfterTurn,
  hasRemainingImageUrl,
} from '../../src/core/messages/image-sanitizer.js';
import type { Message } from '../../src/providers/types.js';

// 辅助构造
function textMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: text };
}

function userWithImage(text: string, imageUrl: string): Message {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: imageUrl, detail: 'auto' } },
    ],
  };
}

function toolCallMsg(toolName: string): Message {
  return {
    role: 'assistant',
    content: 'I will help you.',
    toolCalls: [{ id: 'c1', name: toolName, argsRaw: '{}' }],
  };
}

describe('extractVlmSummary', () => {
  it('returns last paragraph from assistant message', () => {
    const msgs = [
      textMsg('user', 'hello'),
      textMsg('assistant', 'line1\n\nline2\n\n这是摘要文本。这里补充一些内容让总长度超过五十个字的上限。还不够再加点文字描述来确保足够长。这样肯定过了50字阈值。'),
    ];
    const r = extractVlmSummary(msgs);
    expect(r).toBeTruthy();
    expect(r!).toContain('这是摘要文本');
  });

  it('returns undefined if no assistant message', () => {
    expect(extractVlmSummary([textMsg('user', 'hi')])).toBeUndefined();
  });

  it('skips tool call messages', () => {
    const msgs = [textMsg('user', 'hi'), toolCallMsg('read_file')];
    expect(extractVlmSummary(msgs)).toBeUndefined();
  });

  it('returns full text if only one paragraph', () => {
    const longText = '描述：这是一个非常详细的图像描述。图中显示了一个完整的中文错误界面，包含完整的调用栈和错误码信息，长度超过五十字的目标。';
    const msgs = [textMsg('user', 'hi'), textMsg('assistant', longText)];
    const r = extractVlmSummary(msgs);
    expect(r).toBeTruthy();
    expect(r!.length).toBeGreaterThan(50);
  });

  it('returns undefined for short assistant text (<50 chars)', () => {
    const msgs = [textMsg('user', 'hi'), textMsg('assistant', 'ok done')];
    expect(extractVlmSummary(msgs)).toBeUndefined();
  });
});

describe('sanitizeHistoryImages', () => {
  it('replaces image_url with summary text', () => {
    const msgs: Message[] = [
      userWithImage('看这个错误', 'data:image/png;base64,xxx'),
    ];
    const idx = sanitizeHistoryImages(msgs, 'TypeError: x is not a function');
    expect(idx).toBe(0);
    expect(Array.isArray(msgs[0]!.content)).toBe(true);
    const parts = msgs[0]!.content as Array<{ type: string; text?: string }>;
    expect(parts.every((p) => p.type === 'text')).toBe(true);
    expect(parts[0]!.text).toContain('[VLM 识别摘要]');
  });

  it('returns -1 when no image_url found', () => {
    const msgs = [textMsg('user', 'no image')];
    expect(sanitizeHistoryImages(msgs, 'summary')).toBe(-1);
  });

  it('replaces multiple image_url in one message', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: '两张图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,a' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,b' } },
      ],
    };
    sanitizeHistoryImages([msg], 'sum');
    const parts = msg.content as Array<{ type: string }>;
    expect(parts.every((p) => p.type === 'text')).toBe(true);
  });

  it('empty summary returns -1', () => {
    const msgs = [userWithImage('x', 'data:image/png;base64,x')];
    expect(sanitizeHistoryImages(msgs, '')).toBe(-1);
  });
});

describe('shouldSanitizeAfterTurn', () => {
  it('false for non-vllm provider', () => {
    const msgs = [textMsg('user', 'hi'), textMsg('assistant', 'x'.repeat(60))];
    expect(shouldSanitizeAfterTurn('deepseek:llm:L1', msgs)).toBe(false);
  });

  it('true for vllm provider with long assistant text and remaining images', () => {
    const msgs: Message[] = [
      userWithImage('hi', 'data:image/png;base64,x'),
      textMsg('assistant', 'x'.repeat(60)),
    ];
    expect(shouldSanitizeAfterTurn('qwen:vllm:L1', msgs)).toBe(true);
  });

  it('false when no remaining image_url', () => {
    const msgs = [textMsg('user', 'no image'), textMsg('assistant', 'x'.repeat(60))];
    expect(shouldSanitizeAfterTurn('qwen:vllm:L1', msgs)).toBe(false);
  });
});

describe('hasRemainingImageUrl', () => {
  it('true when user message has image_url', () => {
    expect(hasRemainingImageUrl([userWithImage('x', 'data:image/png;base64,x')])).toBe(true);
  });

  it('false when all image_url replaced', () => {
    const msgs = [userWithImage('x', 'data:image/png;base64,x')];
    sanitizeHistoryImages(msgs, 'summary');
    expect(hasRemainingImageUrl(msgs)).toBe(false);
  });

  it('false when no user messages', () => {
    expect(hasRemainingImageUrl([])).toBe(false);
  });
});
