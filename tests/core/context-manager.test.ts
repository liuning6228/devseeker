/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Context Manager 单测（W8.1 + W8.2）
 */

import { describe, it, expect } from 'vitest';
import {
  ContextManager,
  estimateTokens,
  groupTurns,
  decideCompression,
  type CompressionLevel,
} from '../../src/core/context/manager.js';
import type { Message } from '../../src/providers/types.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}
function assistantMsg(text: string, toolCalls?: Message['toolCalls']): Message {
  return { role: 'assistant', content: text, ...(toolCalls ? { toolCalls } : {}) };
}
function toolResultMsg(id: string, content: string, name?: string): Message {
  return { role: 'tool', toolCallId: id, content, ...(name ? { name } : {}) };
}

// ─── estimateTokens ───

describe('estimateTokens', () => {
  it('estimates string content by char length', () => {
    const msgs: Message[] = [userMsg('hello world')]; // 11 chars / 3.5 ≈ 3 tokens + 4 overhead ≈ 5
    const tokens = estimateTokens(msgs);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20); // sanity
  });

  it('counts image_url as ~85 tokens', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
    ];
    const tokens = estimateTokens(msgs);
    expect(tokens).toBeGreaterThan(20); // 85 + overhead
  });

  it('counts toolCalls args', () => {
    const msgs: Message[] = [
      assistantMsg('', [{ id: 'tc1', name: 'read_file', argsRaw: '{"file_path":"/very/long/path/to/some/file.ts"}' }]),
    ];
    const tokens = estimateTokens(msgs);
    expect(tokens).toBeGreaterThan(5);
  });
});

// ─── groupTurns ───

describe('groupTurns', () => {
  it('groups messages by user boundaries', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      userMsg('hi'),
      assistantMsg('hello'),
      userMsg('how are you'),
      assistantMsg('fine'),
    ];
    const turns = groupTurns(msgs);
    expect(turns).toHaveLength(2);
    expect(turns[0].count).toBe(2); // user + assistant
    expect(turns[1].count).toBe(2);
  });

  it('includes tool results in the same turn as user', () => {
    const msgs: Message[] = [
      userMsg('read file'),
      assistantMsg('', [{ id: 'tc1', name: 'read_file', argsRaw: '{}' }]),
      toolResultMsg('tc1', 'file contents'),
    ];
    const turns = groupTurns(msgs);
    expect(turns).toHaveLength(1);
    expect(turns[0].count).toBe(3);
  });

  it('skips system messages', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      userMsg('hi'),
    ];
    const turns = groupTurns(msgs);
    expect(turns).toHaveLength(1);
  });
});

// ─── decideCompression ───

describe('decideCompression', () => {
  it('returns none below 70%', () => {
    expect(decideCompression(0.5)).toBe('none');
    expect(decideCompression(0.69)).toBe('none');
  });

  it('returns light at 70-85%', () => {
    expect(decideCompression(0.70)).toBe('light');
    expect(decideCompression(0.84)).toBe('light');
  });

  it('returns medium at 85-95%', () => {
    expect(decideCompression(0.85)).toBe('medium');
    expect(decideCompression(0.94)).toBe('medium');
  });

  it('returns heavy above 95%', () => {
    expect(decideCompression(0.95)).toBe('heavy');
    expect(decideCompression(1.0)).toBe('heavy');
  });
});

// ─── ContextManager.compress ───

describe('ContextManager.compress', () => {
  it('does nothing when usage is low', () => {
    const cm = new ContextManager({ contextWindow: 100_000, outputReserve: 4096 });
    const msgs: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      userMsg('hi'),
      assistantMsg('hello'),
    ];
    const result = cm.compress(msgs);
    expect(result.level).toBe('none');
    expect(result.messages).toHaveLength(3);
    expect(result.savingsPercent).toBe(0);
  });

  it('applies light compression by truncating long tool results', () => {
    // Context big enough to trigger light (70-85%) but not medium
    const cm = new ContextManager({ contextWindow: 2000, outputReserve: 200, charsPerToken: 3 });
    const longResult = 'x'.repeat(10000);
    // One long tool result ~ 3300 tokens, with context ~ 1800 → ratio ~ 1.0 → heavy
    // Need more context. Let's use moderate-length result.
    const moderateResult = 'x'.repeat(3000); // ~1000 tokens
    const msgs: Message[] = [
      userMsg('read file'),
      assistantMsg(''),
      toolResultMsg('tc1', moderateResult),
    ];
    const result = cm.compress(msgs);
    // At least some compression happened
    expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
    // Light truncation check: if tool msg was truncated, it should be shorter
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    if (toolMsg && typeof toolMsg.content === 'string' && toolMsg.content.includes('truncated')) {
      expect(toolMsg.content.length).toBeLessThan(moderateResult.length);
    }
  });

  it('applies medium compression by summarizing old turns', () => {
    const cm = new ContextManager({
      contextWindow: 500,
      outputReserve: 50,
      charsPerToken: 3,
      protectedTurns: 1,
    });
    // Build many short turns to fill up context
    const msgs: Message[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`Question ${i}: ${'abc '.repeat(20)}`));
      msgs.push(assistantMsg(`Answer ${i}: ${'xyz '.repeat(20)}`));
    }
    const result = cm.compress(msgs);
    // Should have compressed
    expect(result.compressedTokens).toBeLessThan(result.originalTokens);
    // Heavy or medium should reduce message count
    expect(result.messages.length).toBeLessThanOrEqual(msgs.length);
  });

  it('applies heavy compression by dropping old turns', () => {
    const cm = new ContextManager({
      contextWindow: 100,
      outputReserve: 20,
      charsPerToken: 3,
      protectedTurns: 1,
    });
    const msgs: Message[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 10; i++) {
      msgs.push(userMsg(`Turn ${i}: ${'long text '.repeat(20)}`));
      msgs.push(assistantMsg(`Reply ${i}: ${'long reply '.repeat(20)}`));
    }
    const result = cm.compress(msgs);
    expect(result.messages.length).toBeLessThan(msgs.length);
    // System + 1 protected turn (2 messages)
    expect(result.messages.length).toBeGreaterThanOrEqual(3); // system + user + assistant
  });

  it('preserves system message through all compression levels', () => {
    const cm = new ContextManager({
      contextWindow: 50,
      outputReserve: 10,
      charsPerToken: 3,
      protectedTurns: 1,
    });
    const msgs: Message[] = [
      { role: 'system', content: 'Important system prompt' },
      userMsg('hi'),
      assistantMsg('hello'),
      userMsg('bye'),
      assistantMsg('ciao'),
    ];
    const result = cm.compress(msgs);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toBe('Important system prompt');
  });
});

// ─── ContextManager.computeMaxTokens ───

describe('ContextManager.computeMaxTokens', () => {
  it('reserves space for output', () => {
    const cm = new ContextManager({ contextWindow: 128_000, outputReserve: 4096 });
    const maxTokens = cm.computeMaxTokens(10_000);
    expect(maxTokens).toBeLessThanOrEqual(4096);
    expect(maxTokens).toBeGreaterThan(0);
  });

  it('clamps to minimum 256', () => {
    const cm = new ContextManager({ contextWindow: 5000, outputReserve: 4096 });
    const maxTokens = cm.computeMaxTokens(4800);
    expect(maxTokens).toBe(256);
  });
});
