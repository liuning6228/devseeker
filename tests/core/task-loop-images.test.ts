/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W7c · 图像输入链路单测
 *
 * 覆盖：
 * - `MessageHistory.addUser(text, images)` 组装 ContentPart[]（text + image_url...）
 * - 无 images 时 content 保持 string（向后兼容）
 * - 仅图消息（空 text + 非空 images）content 只含 image_url
 * - `TaskLoop.send(text, images)` 首次 createMessage 的 options.messages 末尾 user 消息带 image_url
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskLoop } from '../../src/core/task/loop.js';
import { MessageHistory } from '../../src/core/task/history.js';
import type { TaskEvent } from '../../src/core/task/events.js';
import type { IProvider } from '../../src/providers/base.js';
import type {
  Capability,
  CreateMessageOptions,
  Pricing,
  ProbeResult,
  StreamEvent,
  ContentPart,
} from '../../src/providers/types.js';
import { ToolRegistry } from '../../src/core/tools/index.js';
import { initLogger } from '../../src/infra/logger.js';
import * as os from 'node:os';
import * as path from 'node:path';

class ScriptedProvider implements IProvider {
  readonly id = 'fake-vision';
  readonly capabilities: readonly Capability[] = ['text', 'tool-use', 'vision'];
  readonly contextWindow = 32_000;
  readonly pricing: Pricing = { inputPerMillion: 0, outputPerMillion: 0, currency: 'CNY' };

  private readonly scripts: StreamEvent[][] = [];
  public calls: CreateMessageOptions[] = [];

  push(events: StreamEvent[]) {
    this.scripts.push(events);
  }
  createMessage(options: CreateMessageOptions): AsyncIterable<StreamEvent> {
    this.calls.push(options);
    const events = this.scripts.shift() ?? [];
    return (async function* () {
      for (const ev of events) yield ev;
    })();
  }
  async probe(): Promise<ProbeResult> {
    return { ok: true, latencyMs: 0 };
  }
  async countTokens(): Promise<number> {
    return 0;
  }
}

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const JPG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/...';

beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
});

describe('MessageHistory.addUser with images (W7c)', () => {
  it('no images → content stays string (backward compat)', () => {
    const history = new MessageHistory();
    history.addUser('hello');
    const snap = history.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('empty images array → also falls back to string', () => {
    const history = new MessageHistory();
    history.addUser('hi', []);
    expect(history.snapshot()[0]).toMatchObject({ role: 'user', content: 'hi' });
  });

  it('text + 1 image → ContentPart[] with text first and image_url after', () => {
    const history = new MessageHistory();
    history.addUser('describe this screenshot', [PNG_DATA_URL]);
    const msg = history.snapshot()[0];
    expect(msg.role).toBe('user');
    expect(Array.isArray(msg.content)).toBe(true);
    const parts = msg.content as ContentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: 'describe this screenshot' });
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: PNG_DATA_URL, detail: 'auto' },
    });
  });

  it('text + multiple images → parts preserve order (text, img1, img2, ...)', () => {
    const history = new MessageHistory();
    history.addUser('compare these', [PNG_DATA_URL, JPG_DATA_URL]);
    const parts = history.snapshot()[0].content as ContentPart[];
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect(parts[1]).toMatchObject({ type: 'image_url', image_url: { url: PNG_DATA_URL } });
    expect(parts[2]).toMatchObject({ type: 'image_url', image_url: { url: JPG_DATA_URL } });
  });

  it('empty text + images → ContentPart[] containing only image_url (no stray empty text)', () => {
    const history = new MessageHistory();
    history.addUser('', [PNG_DATA_URL]);
    const parts = history.snapshot()[0].content as ContentPart[];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'image_url' });
  });
});

describe('TaskLoop.send() with images (W7c)', () => {
  it('images propagate to provider.createMessage options.messages[last].content', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'I see a cat.' },
      { type: 'done', reason: 'stop' },
    ]);

    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'you are helpful',
      onEvent: (e) => events.push(e),
    });

    await loop.send('what is this?', [PNG_DATA_URL]);

    expect(provider.calls).toHaveLength(1);
    const sent = provider.calls[0].messages;
    const lastUser = sent[sent.length - 1];
    expect(lastUser.role).toBe('user');
    expect(Array.isArray(lastUser.content)).toBe(true);
    const parts = lastUser.content as ContentPart[];
    expect(parts[0]).toEqual({ type: 'text', text: 'what is this?' });
    expect(parts[1]).toMatchObject({
      type: 'image_url',
      image_url: { url: PNG_DATA_URL, detail: 'auto' },
    });

    // task_start event 仍然带纯 text userInput（Hook/emit 文本字段不受多模态影响）
    const start = events.find((e) => e.type === 'task_start');
    expect(start).toMatchObject({ type: 'task_start', userInput: 'what is this?' });
  });

  it('send without images → legacy string content (backward compat)', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', reason: 'stop' },
    ]);

    const loop = new TaskLoop({
      provider,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'sys',
      onEvent: () => {},
    });

    await loop.send('plain text');
    const lastUser = provider.calls[0].messages[provider.calls[0].messages.length - 1];
    expect(lastUser).toMatchObject({ role: 'user', content: 'plain text' });
  });
});
